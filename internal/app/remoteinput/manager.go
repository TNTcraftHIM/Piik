// Package remoteinput owns source-scoped desktop input grants.
// Only the owning Host control session can choose its authorization policy. Media routing remains
// outside this package; closing its exact source or connection releases input.
package remoteinput

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"runtime"
	"sort"
	"sync"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/TNTcraftHIM/Piik/internal/diagnostics"
	"github.com/TNTcraftHIM/Piik/internal/media/inputroute"
	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
	"github.com/pion/webrtc/v4"
)

const ChannelLabel = inputroute.Label

type bounds struct{ left, top, width, height int32 }

type inputEvent struct {
	Type          string         `json:"type"`
	Grant         string         `json:"grant,omitempty"`
	Intent        string         `json:"intent,omitempty"`
	Password      string         `json:"password,omitempty"`
	X             float64        `json:"x,omitempty"`
	Y             float64        `json:"y,omitempty"`
	Button        int            `json:"button,omitempty"`
	Down          bool           `json:"down,omitempty"`
	Code          string         `json:"code,omitempty"`
	Text          string         `json:"text,omitempty"`
	Delta         int            `json:"delta,omitempty"`
	DX            int32          `json:"dx,omitempty"`
	DY            int32          `json:"dy,omitempty"`
	Gamepad       *gamepadReport `json:"gamepad,omitempty"`
	InputFeedback bool           `json:"inputFeedback,omitempty"`
}

type inputSink interface {
	Authorize() error
	Target(nativecapture.CaptureTarget, *nativecapture.Stream) (bounds, bool, error)
	Apply(bounds, inputEvent) error
	Reset() error
}

type View struct {
	ID         string `json:"id"`
	PeerID     string `json:"peerId"`
	State      string `json:"state"`
	EndpointID string `json:"endpointId,omitempty"`
}

// One manager covers both native sessions: they operate the same physical desktop.
type Manager struct {
	mu             sync.Mutex
	sink           inputSink
	pendingKeys    map[string]bool
	pendingButtons map[int]bool
	gamepads       gamepadBackend
	gamepadOpening bool
	connections    map[endpointKey]*connection
	sessions       map[*Session]struct{}
	owner          *Session // The one source allowed to inject into the desktop.
	closed         bool
	stop           context.CancelFunc
	stopKey        int
	registerStop   func(int) (func(), error)
	stopShortcut   func()
}

type Session struct {
	manager       *Manager
	target        nativecapture.CaptureTarget
	capture       *nativecapture.Stream
	paused        bool
	closed        bool
	changed       chan struct{}
	route         *inputroute.Relay
	mode          string
	coPlay        bool
	simultaneous  bool
	policyChange  *PolicyChange
	password      [32]byte
	passwordRetry time.Time
}

type connection struct {
	owner         *Session
	edgeID        string
	epoch         string
	id            string
	requested     bool
	requestID     string
	intent        string
	grant         string
	suspended     bool
	inputFailed   bool
	inputFeedback bool
	peerID        string
	secret        string
	cipher        *inputCipher
	extended      bool
	keys          map[string]bool
	buttons       map[int]bool
	pad           gamepadDevice
	padFailed     bool
	padIntent     uint64
}

type endpointKey struct {
	owner *Session
	id    string
}

// New prepares the platform backend. Input remains disabled until the sharing
// session enables it; no service, driver or startup entry is installed.
func New(ctx context.Context, captureInput bool) (*Manager, error) {
	sink, err := newPlatformSink(captureInput)
	if err != nil || sink == nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	m := &Manager{sink: sink, connections: make(map[endpointKey]*connection), stop: cancel,
		stopKey: defaultStopKey}
	stopPressed := make(chan struct{}, 1)
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		m.registerStop = func(key int) (func(), error) {
			return watchStopShortcut(ctx, key, func() {
				select {
				case stopPressed <- struct{}{}:
				default:
				}
			})
		}
	}
	// Foreground changes must release held input even when the remote player
	// is holding a key without sending more events. Only an active grant polls.
	go func() {
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-stopPressed:
				m.Revoke()
			case <-ticker.C:
				m.mu.Lock()
				m.retryReleases()
				m.refreshActive()
				m.mu.Unlock()
			}
		}
	}()
	return m, nil
}

func (m *Manager) NewSession() *Session {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil
	}
	s := &Session{manager: m, changed: make(chan struct{}, 1), mode: "off"}
	s.route = inputroute.New(s.receivePacket)
	if m.sessions == nil {
		m.sessions = make(map[*Session]struct{})
	}
	m.sessions[s] = struct{}{}
	return s
}

// Changes coalesces notifications; State reads the current permission and grant owner. Input
// packets do not generate UI updates, and no callback runs under the input lock.
func (s *Session) Changes() <-chan struct{} {
	if s == nil {
		return nil
	}
	return s.changed
}

func (s *Session) notify() {
	select {
	case s.changed <- struct{}{}:
	default:
	}
}

// The channel belongs to the sharing session; input permission belongs to its
// current source. Replacing a picture revokes the grant without losing the
// channel needed to request control of the next source.
func (s *Session) SetTarget(target nativecapture.CaptureTarget, capture *nativecapture.Stream) {
	s.setTarget(target, capture, nil)
}

// A Portal permission change replaces its capture as part of that same intent.
// Always bind the installed picture, including after cancellation; only a still
// current change may survive this binding and subsequently enable input.
func (change *PolicyChange) SetTarget(target nativecapture.CaptureTarget, capture *nativecapture.Stream) {
	change.session.setTarget(target, capture, change)
}

func (s *Session) setTarget(target nativecapture.CaptureTarget, capture *nativecapture.Stream, change *PolicyChange) {
	if s == nil {
		return
	}
	m := s.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || s.closed {
		return
	}
	if target.Kind != "display" && target.Kind != "window" && !(s.UsesCaptureInput() && target.Kind == "picker") {
		target = nativecapture.CaptureTarget{}
	}
	s.target = target
	s.capture = capture
	s.simultaneous = false
	if change == nil || s.policyChange != change {
		s.cancelPolicy()
	}
	if m.owner == s {
		m.release()
	}
	s.applyPolicy("off", [32]byte{}, false)
}

// The Linux Portal owns input and screen selection in the same OS session.
func (s *Session) UsesCaptureInput() bool { return s != nil && runtime.GOOS == "linux" }

// Attach returns the transport-loss action for this exact input channel. It
// invalidates queued deliveries and grants together, retaining SCTP for recovery.
func (s *Session) Attach(edgeID string, channel *webrtc.DataChannel) func() {
	s.route.AttachDown(edgeID, channel)
	return func() {
		m := s.manager
		m.mu.Lock()
		defer m.mu.Unlock()
		if !s.closed && !m.closed && s.route.ResetDown(edgeID, channel) {
			s.revokeEdgeLocked(edgeID)
		}
	}
}

// Bindings come only from the owning Host's authenticated room connection.
// Receiving a packet from a relay never creates or names an input identity.
func (s *Session) SetPeers(peers []protocol.RemoteInputPeer) error {
	if s == nil {
		return errors.New("remote input is unavailable")
	}
	m := s.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || s.closed {
		return errors.New("remote input is closed")
	}
	retained := make(map[string]bool, len(peers))
	for _, peer := range peers {
		if !protocol.ValidInputKey(peer.EndpointID, peer.Secret) || !protocol.ValidOpaqueID(peer.PeerID) || retained[peer.EndpointID] {
			return errors.New("invalid input endpoint")
		}
		retained[peer.EndpointID] = true
	}
	for _, peer := range peers {
		previous := m.connections[endpointKey{s, peer.EndpointID}]
		if previous != nil && previous.secret == peer.Secret && previous.peerID == peer.PeerID {
			continue
		}
		if previous != nil {
			m.revoke(previous)
		}
		cipher, _ := newInputCipher(peer.Secret)
		c := &connection{owner: s, id: peer.EndpointID, peerID: peer.PeerID, secret: peer.Secret, cipher: cipher}
		m.connections[endpointKey{s, c.id}] = c
		// Signaling and the media return path can arrive in either order.
		// Ask this endpoint to sync only after its authenticated key is installed.
		ready := true
		s.route.Reply(inputroute.Packet{ID: c.id, Ready: &ready})
	}
	for id, c := range m.connections {
		if c.owner == s && !retained[id.id] {
			m.revoke(c)
			delete(m.connections, id)
		}
	}
	s.notify()
	return nil
}

func (s *Session) receivePacket(edgeID string, packet inputroute.Packet, current func() bool) {
	m := s.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.connections[endpointKey{s, packet.ID}]
	if c == nil || m.closed || s.closed {
		return
	}
	// Retirement may already have removed its relay record before the channel
	// closes. It still ends the matching epoch; only new input needs a live binding.
	if packet.Closed {
		if c.edgeID == edgeID && c.epoch == packet.Epoch {
			m.revoke(c)
			c.edgeID = ""
		}
		return
	}
	if current != nil && !current() {
		return
	}
	plain, err := c.cipher.open(packet.Data, packet.Epoch)
	if err != nil {
		return
	}
	if c.edgeID != "" && (c.edgeID != edgeID || c.epoch != packet.Epoch) {
		m.revoke(c)
	}
	if c.epoch != packet.Epoch {
		c.extended = false
		c.inputFeedback = false
	}
	c.edgeID, c.epoch = edgeID, packet.Epoch
	m.receiveLocked(c, plain)
}

func (m *Manager) send(c *connection, state string) {
	m.reply(c, state, "")
}

func (m *Manager) reply(c *connection, state, reason string) {
	if c.epoch == "" {
		return
	}
	if state == "ready" && (!c.owner.available() || c.owner.mode == "off") {
		state = "unavailable"
	}
	if reason == "gamepad" && !c.extended {
		reason = ""
	}
	value := struct {
		Platform     string   `json:"platform"`
		State        string   `json:"state"`
		Grant        string   `json:"grant,omitempty"`
		Intent       string   `json:"intent,omitempty"`
		Mode         string   `json:"mode"`
		Reason       string   `json:"reason,omitempty"`
		InputFailed  bool     `json:"inputFailed,omitempty"`
		Capabilities []string `json:"capabilities,omitempty"`
		CoPlay       *bool    `json:"coPlay,omitempty"`
	}{Platform: runtime.GOOS, State: state, Grant: c.grant, Intent: c.intent, Mode: c.owner.mode, Reason: reason, InputFailed: c.inputFailed && c.inputFeedback}
	if c.extended {
		coPlay := c.owner.coPlay
		value.Capabilities, value.CoPlay = []string{"coPlay", "inputFeedback"}, &coPlay
		if coPlay && m.singleController(c.owner) == c {
			value.Capabilities = append(value.Capabilities, "text")
		}
		if coPlay && m.gamepads != nil && !c.padFailed {
			value.Capabilities = append(value.Capabilities, "gamepad")
		}
	}
	data, _ := json.Marshal(value)
	c.owner.route.Reply(inputroute.Packet{ID: c.id, Epoch: c.epoch, Data: c.cipher.seal(data, c.epoch)})
}

func (s *Session) available() bool {
	return !s.closed && !s.paused && s.target.SourceID != ""
}

func (m *Manager) state(c *connection) string {
	if c.grant != "" {
		if c.suspended {
			return "suspended"
		}
		return "active"
	}
	if c.requested {
		return "pending"
	}
	return "ready"
}

// Caller holds mu. Source identity, geometry and focus are checked at the
// input owner, never inferred from a Browser's last displayed video frame.
func (m *Manager) refreshActive() (bounds, bool) {
	s := m.owner
	if s == nil {
		return bounds{}, false
	}
	b, focused, err := m.sink.Target(s.target, s.capture)
	if err != nil {
		var failed []*connection
		for _, c := range m.connections {
			if c.owner == s && c.grant != "" {
				slog.Debug("remote-input", "event", "target-failed", "sourceKind", s.target.Kind,
					"connectionId", diagnostics.ID(c.edgeID), "inputGeneration", diagnostics.ID(c.epoch), diagnostics.Error(err))
				failed = append(failed, c)
			}
		}
		m.release()
		for _, c := range failed {
			m.send(c, "failed")
		}
		return bounds{}, false
	}
	suspended := !focused
	changed := false
	for _, c := range m.connections {
		if c.owner == s && c.grant != "" && c.suspended != suspended {
			c.suspended = suspended
			changed = true
			m.send(c, m.state(c))
		}
	}
	if changed {
		if !focused {
			err := m.resetHeld(s)
			for _, c := range m.connections {
				if c.owner == s {
					if err != nil {
						m.noteInputResult(c, err)
					}
					if c.pad != nil {
						if err := c.pad.Update(gamepadReport{}); err != nil {
							m.failGamepad(c)
						}
					}
				}
			}
		}
		s.notify()
	}
	return b, focused
}

// release retires every input grant belonging to the desktop's source owner.
func (m *Manager) release() {
	if m.owner == nil {
		return
	}
	s := m.owner
	m.owner = nil
	_ = m.resetHeld(s)
	for _, c := range m.connections {
		if c.owner == s && c.grant != "" {
			if c.pad != nil {
				_ = c.pad.Close()
				c.pad = nil
			}
			c.grant, c.suspended = "", false
			c.inputFailed = false
			m.send(c, "ready")
		}
	}
	s.notify()
}

// clearHeld releases only this player's contribution. The other keyboard
// holders keep a shared key down until its final holder releases it.
func (m *Manager) clearHeld(c *connection) error {
	keys := c.keys
	c.keys = nil
	var err error
	for code := range keys {
		if !m.keyHeld(code) {
			err = errors.Join(err, m.releaseKey(code))
		}
	}
	buttons := c.buttons
	c.buttons = nil
	for button := range buttons {
		if !m.buttonHeld(button) {
			err = errors.Join(err, m.releaseButton(button))
		}
	}
	return err
}

func (m *Manager) keyHeld(code string) bool {
	for _, c := range m.connections {
		if c.keys[code] {
			return true
		}
	}
	return false
}

func (m *Manager) buttonHeld(button int) bool {
	for _, c := range m.connections {
		if c.buttons[button] {
			return true
		}
	}
	return false
}

func (m *Manager) singleController(s *Session) *connection {
	var single *connection
	for _, c := range m.connections {
		if c.owner == s && c.grant != "" {
			if single != nil {
				return nil
			}
			single = c
		}
	}
	return single
}

func (m *Manager) releaseConnection(c *connection) {
	if c.grant == "" {
		return
	}
	if !c.owner.coPlay {
		m.release()
		return
	}
	_ = m.clearHeld(c)
	if c.pad != nil {
		_ = c.pad.Close()
		c.pad = nil
	}
	c.grant, c.suspended = "", false
	c.inputFailed = false
	if remaining := m.singleController(c.owner); remaining != nil && remaining.extended {
		m.send(remaining, m.state(remaining))
	}
	for _, other := range m.connections {
		if other.owner == c.owner && other.grant != "" {
			return
		}
	}
	m.owner = nil
}

// Caller holds mu from delivery validation through the input action.
func (m *Manager) receiveLocked(c *connection, plain []byte) {
	if len(plain) > maxInputBytes {
		return
	}
	var event inputEvent
	decoder := json.NewDecoder(bytes.NewReader(plain))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&event) != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return
	}
	switch event.Type {
	case "sync":
		m.send(c, m.state(c))
	case "capabilities":
		c.extended = true
		c.inputFeedback = event.InputFeedback
		m.send(c, m.state(c))
	case "request":
		if !c.owner.available() || c.owner.mode == "off" || c.requested || c.grant != "" {
			return
		}
		if intent, err := hex.DecodeString(event.Intent); err != nil || len(intent) != 16 {
			return
		}
		id := make([]byte, 16)
		_, _ = rand.Read(id)
		c.requestID, c.intent = hex.EncodeToString(id), event.Intent
		if c.owner.mode != "ask" {
			if reason := c.owner.authorize(event.Password); reason != "" {
				m.reply(c, "ready", reason)
				return
			}
			// Automatic permission never displaces another controller, including
			// a controller of the App's other native session.
			if !m.canJoin(c) {
				m.reply(c, "ready", "busy")
				return
			}
			_ = m.grant(c)
			return
		}
		c.requested = true
		m.send(c, "pending")
		c.owner.notify()
	case "release":
		if event.Intent != c.intent || (!c.requested && c.grant == "") {
			return
		}
		c.requested = false
		m.releaseConnection(c)
		m.send(c, "ready")
		c.owner.notify()
	default:
		if c.grant == "" || event.Grant != c.grant || !c.owner.available() {
			return
		}
		if event.Type == "gamepad" || event.Type == "gamepad-reset" || event.Type == "gamepad-stop" {
			m.receiveGamepad(c, event)
			return
		}
		if event.Gamepad != nil {
			return
		}
		if event.Type == "reset" {
			m.receiveGamepad(c, inputEvent{Type: "gamepad-reset"})
			m.noteInputResult(c, m.clearHeld(c))
			return
		}
		if event.Type == "text" && c.owner.coPlay && m.singleController(c.owner) != c {
			// Committed text resets the sink and would release other players.
			return
		}
		b, focused := m.refreshActive()
		if !focused {
			return
		}
		var err error
		if event.Type == "text" {
			err = applyText(controllerTextSink{m, c}, b, event.Text)
		} else {
			err = m.applyHeld(c, b, event)
		}
		if err != nil {
			slog.Debug("remote-input", "event", "apply-failed", "connectionId", diagnostics.ID(c.edgeID), "inputGeneration", diagnostics.ID(c.epoch),
				"operation", event.Type, "sourceKind", c.owner.target.Kind, "targetReady", focused && b.width > 0 && b.height > 0, diagnostics.Error(err))
		}
		m.noteInputResult(c, err)
	}
}

func (m *Manager) revoke(c *connection) {
	c.requested = false
	m.releaseConnection(c)
	m.send(c, "ready")
	c.owner.notify()
}

func (s *Session) Pause(paused bool) {
	if s == nil {
		return
	}
	m := s.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	s.paused = paused
	if paused {
		s.cancelPolicy()
	}
	if paused && m.owner == s {
		m.release()
	}
	for _, c := range m.connections {
		if c.owner == s {
			if paused {
				c.requested = false
			}
			m.send(c, m.state(c))
		}
	}
	s.notify()
}

func (s *Session) revokeEdgeLocked(edgeID string) {
	m := s.manager
	for _, c := range m.connections {
		if c.owner == s && c.edgeID == edgeID {
			m.revoke(c)
		}
	}
}

func (s *Session) Close() {
	if s == nil {
		return
	}
	m := s.manager
	m.mu.Lock()
	s.closed = true
	s.cancelPolicy()
	if m.owner == s {
		m.release()
	}
	for id, c := range m.connections {
		if c.owner == s {
			delete(m.connections, id)
		}
	}
	delete(m.sessions, s)
	m.releaseIdleShortcut()
	s.notify()
	m.mu.Unlock()
	s.route.Close()
}

func (m *Manager) Revoke() {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return
	}
	for s := range m.sessions {
		if s.mode != "off" {
			s.setPolicy("ask", [32]byte{})
		} else {
			s.cancelPolicy()
		}
	}
}

func (m *Manager) Close() {
	if m == nil {
		return
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.closed = true
	m.release()
	m.retryReleases()
	if m.gamepads != nil {
		_ = m.gamepads.Close()
		m.gamepads = nil
	}
	stopShortcut := m.stopShortcut
	m.stopShortcut = nil
	if closer, ok := m.sink.(io.Closer); ok {
		_ = closer.Close()
	}
	m.mu.Unlock()
	if stopShortcut != nil {
		stopShortcut()
	}
	if m.stop != nil {
		m.stop()
	}
}

type State struct {
	Platform     string `json:"platform"`
	Mode         string `json:"mode"`
	Requests     []View `json:"requests"`
	CoPlay       bool   `json:"coPlay,omitempty"`
	Gamepad      *bool  `json:"gamepad,omitempty"`
	Simultaneous *bool  `json:"simultaneous,omitempty"`
}

func (s *Session) State() State {
	state := State{Platform: runtime.GOOS, Mode: "off", Requests: []View{}}
	if s == nil {
		return state
	}
	m := s.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	state.Mode = s.mode
	state.CoPlay = s.coPlay
	if s.coPlay {
		simultaneous := s.simultaneous
		state.Simultaneous = &simultaneous
		gamepad := m.gamepads != nil
		state.Gamepad = &gamepad
	}
	for _, c := range m.connections {
		if c.owner == s && (c.requested || c.grant != "") {
			view := View{ID: c.requestID, PeerID: c.peerID, State: m.state(c)}
			if s.coPlay {
				view.EndpointID = c.id
			}
			state.Requests = append(state.Requests, view)
		}
	}
	sort.Slice(state.Requests, func(i, j int) bool { return state.Requests[i].ID < state.Requests[j].ID })
	return state
}

func (s *Session) Decide(id string, allow bool) error {
	if s == nil {
		return errors.New("remote input is unavailable")
	}
	m := s.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	var c *connection
	for _, candidate := range m.connections {
		if candidate.owner == s && candidate.requestID == id {
			c = candidate
			break
		}
	}
	if m.closed || c == nil || !s.available() || c.edgeID == "" || (!c.requested && c.grant == "") {
		return errors.New("request is no longer available")
	}
	defer s.notify()
	if !allow {
		if s.mode != "ask" && !s.coPlay {
			s.setPolicy("ask", [32]byte{})
			return nil
		}
		m.revoke(c)
		return nil
	}
	// Explicit approval hands over this source's exclusive control. Automatic
	// admission still uses canJoin and never displaces an existing controller.
	if c.requested && s.coPlay && !s.simultaneous && m.owner == s {
		m.release()
	}
	return m.grant(c)
}

// Automatic permission never takes another source or changes a legacy Guest's
// full-control contract. An extended Guest can share only with extended peers.
func (m *Manager) canJoin(c *connection) bool {
	if m.owner == nil {
		return true
	}
	if m.owner != c.owner || !c.owner.coPlay || !c.owner.simultaneous || !c.extended {
		return false
	}
	for _, other := range m.connections {
		if other.grant != "" && !other.extended {
			return false
		}
	}
	return true
}

func (m *Manager) grant(c *connection) error {
	if c.grant != "" {
		return nil
	}
	if c.owner.coPlay {
		if !m.canJoin(c) {
			m.reply(c, m.state(c), "busy")
			return errors.New("remote input is busy")
		}
	} else {
		m.release()
	}
	token := make([]byte, 32)
	_, _ = rand.Read(token)
	previous := m.singleController(c.owner)
	c.grant, c.requested = hex.EncodeToString(token), false
	c.padFailed = false
	m.owner = c.owner
	if previous != nil && previous.extended {
		m.send(previous, m.state(previous))
	}
	m.refreshActive()
	if c.grant != "" {
		m.send(c, m.state(c))
	}
	c.owner.notify()
	return nil
}
