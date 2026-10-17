// Package remoteinput owns the experimental desktop input grant.
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
	"runtime"
	"sort"
	"sync"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/TNTcraftHIM/Piik/internal/media/inputroute"
	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
	"github.com/pion/webrtc/v4"
)

const ChannelLabel = inputroute.Label

type bounds struct{ left, top, width, height int32 }

type inputEvent struct {
	Type     string  `json:"type"`
	Grant    string  `json:"grant,omitempty"`
	Intent   string  `json:"intent,omitempty"`
	Password string  `json:"password,omitempty"`
	X        float64 `json:"x,omitempty"`
	Y        float64 `json:"y,omitempty"`
	Button   int     `json:"button,omitempty"`
	Down     bool    `json:"down,omitempty"`
	Code     string  `json:"code,omitempty"`
	Text     string  `json:"text,omitempty"`
	Delta    int     `json:"delta,omitempty"`
	DX       int32   `json:"dx,omitempty"`
	DY       int32   `json:"dy,omitempty"`
}

type inputSink interface {
	Authorize() error
	Target(nativecapture.CaptureTarget, *nativecapture.Stream) (bounds, bool, error)
	Apply(bounds, inputEvent) error
	Reset() error
}

type View struct {
	ID     string `json:"id"`
	PeerID string `json:"peerId"`
	State  string `json:"state"`
}

// One manager covers both native sessions: they operate the same physical desktop.
type Manager struct {
	mu          sync.Mutex
	sink        inputSink
	connections map[endpointKey]*connection
	active      *connection
	closed      bool
	stop        context.CancelFunc
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
	policyChange  *PolicyChange
	password      [32]byte
	passwordRetry time.Time
}

type connection struct {
	owner     *Session
	edgeID    string
	epoch     string
	id        string
	requested bool
	requestID string
	intent    string
	grant     string
	suspended bool
	peerID    string
	secret    string
	cipher    *inputCipher
}

type endpointKey struct {
	owner *Session
	id    string
}

// New is inert in ordinary builds. The remotecontrol build tag selects the
// platform backend; it does not install a service, driver or startup entry.
func New(ctx context.Context, captureInput bool) (*Manager, error) {
	sink, err := newPlatformSink(captureInput)
	if err != nil || sink == nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	m := &Manager{sink: sink, connections: make(map[endpointKey]*connection), stop: cancel}
	if err := watchStopShortcut(ctx, func() { m.Revoke() }); err != nil {
		cancel()
		if closer, ok := sink.(io.Closer); ok {
			_ = closer.Close()
		}
		return nil, err
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
			case <-ticker.C:
				m.mu.Lock()
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
	s := &Session{manager: m, changed: make(chan struct{}, 1), mode: "off"}
	s.route = inputroute.New(s.receivePacket)
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
	if change == nil || s.policyChange != change {
		s.cancelPolicy()
	}
	s.applyPolicy("off", [32]byte{})
}

// The Linux Portal owns input and screen selection in the same OS session.
func (s *Session) UsesCaptureInput() bool { return s != nil && runtime.GOOS == "linux" }

func (s *Session) Attach(edgeID string, channel *webrtc.DataChannel) {
	s.route.AttachDown(edgeID, channel)
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
		if previous == m.active && previous != nil {
			m.release()
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
			if m.active == c {
				m.release()
			}
			delete(m.connections, id)
		}
	}
	s.notify()
	return nil
}

func (s *Session) receivePacket(edgeID string, packet inputroute.Packet) {
	m := s.manager
	m.mu.Lock()
	c := m.connections[endpointKey{s, packet.ID}]
	if c == nil || m.closed || s.closed {
		m.mu.Unlock()
		return
	}
	if packet.Closed {
		if c.edgeID == edgeID && c.epoch == packet.Epoch {
			m.revoke(c)
			c.edgeID = ""
		}
		m.mu.Unlock()
		return
	}
	plain, err := c.cipher.open(packet.Data, packet.Epoch)
	if err != nil {
		m.mu.Unlock()
		return
	}
	if c.edgeID != "" && (c.edgeID != edgeID || c.epoch != packet.Epoch) {
		m.revoke(c)
	}
	c.edgeID, c.epoch = edgeID, packet.Epoch
	m.mu.Unlock()
	m.receive(c, webrtc.DataChannelMessage{IsString: true, Data: plain}, packet.Epoch)
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
	data, _ := json.Marshal(struct {
		Platform string `json:"platform"`
		State    string `json:"state"`
		Grant    string `json:"grant,omitempty"`
		Intent   string `json:"intent,omitempty"`
		Mode     string `json:"mode"`
		Reason   string `json:"reason,omitempty"`
	}{runtime.GOOS, state, c.grant, c.intent, c.owner.mode, reason})
	c.owner.route.Reply(inputroute.Packet{ID: c.id, Epoch: c.epoch, Data: c.cipher.seal(data, c.epoch)})
}

func (s *Session) available() bool {
	return !s.closed && !s.paused && s.target.SourceID != ""
}

func (m *Manager) state(c *connection) string {
	if m.active == c {
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
	c := m.active
	if c == nil {
		return bounds{}, false
	}
	b, focused, err := m.sink.Target(c.owner.target, c.owner.capture)
	if err != nil {
		m.release()
		m.send(c, "failed")
		return bounds{}, false
	}
	suspended := !focused
	if c.suspended != suspended {
		c.suspended = suspended
		if !focused {
			_ = m.sink.Reset()
		}
		m.send(c, m.state(c))
		c.owner.notify()
	}
	return b, focused
}

func (m *Manager) release() {
	if c := m.active; c != nil {
		m.active = nil
		c.grant = ""
		c.suspended = false
		_ = m.sink.Reset()
		m.send(c, "ready")
		c.owner.notify()
	}
}

func (m *Manager) receive(c *connection, message webrtc.DataChannelMessage, epoch string) {
	if !message.IsString || len(message.Data) > 1024 {
		return
	}
	var event inputEvent
	decoder := json.NewDecoder(bytes.NewReader(message.Data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&event) != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || c.owner.closed || m.connections[endpointKey{c.owner, c.id}] != c || c.epoch != epoch {
		return
	}
	switch event.Type {
	case "sync":
		m.send(c, m.state(c))
	case "request":
		if !c.owner.available() || c.owner.mode == "off" || c.requested || c == m.active {
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
			if m.active != nil {
				m.reply(c, "ready", "busy")
				return
			}
			m.grant(c)
			return
		}
		c.requested = true
		m.send(c, "pending")
		c.owner.notify()
	case "release":
		if event.Intent != c.intent || (!c.requested && m.active != c) {
			return
		}
		c.requested = false
		if m.active == c {
			m.release()
		} else {
			m.send(c, "ready")
		}
		c.owner.notify()
	default:
		if m.active != c || c.grant == "" || event.Grant != c.grant || !c.owner.available() {
			return
		}
		if event.Type == "reset" {
			_ = m.sink.Reset()
			return
		}
		b, focused := m.refreshActive()
		if !focused {
			return
		}
		if err := m.sink.Apply(b, event); err != nil {
			m.release()
			m.send(c, "failed")
		}
	}
}

func (m *Manager) revoke(c *connection) {
	c.requested = false
	if m.active == c {
		m.release()
	} else {
		m.send(c, "ready")
	}
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
	if paused && m.active != nil && m.active.owner == s {
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

// Transport loss retires permission, not the media-owned channel. A recovered
// ICE connection can carry a new request, but never restore the previous grant.
func (s *Session) RevokeEdge(edgeID string) {
	if s == nil {
		return
	}
	m := s.manager
	m.mu.Lock()
	defer m.mu.Unlock()
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
	if m.active != nil && m.active.owner == s {
		m.release()
	}
	for id, c := range m.connections {
		if c.owner == s {
			delete(m.connections, id)
		}
	}
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
	if m.active != nil {
		m.active.owner.setPolicy("ask", [32]byte{})
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
	if closer, ok := m.sink.(io.Closer); ok {
		_ = closer.Close()
	}
	m.mu.Unlock()
	if m.stop != nil {
		m.stop()
	}
}

type State struct {
	Platform string `json:"platform"`
	Mode     string `json:"mode"`
	Requests []View `json:"requests"`
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
	for _, c := range m.connections {
		if c.owner == s && (c.requested || m.active == c) {
			state.Requests = append(state.Requests, View{c.requestID, c.peerID, m.state(c)})
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
	if m.closed || c == nil || !s.available() || c.edgeID == "" || (!c.requested && m.active != c) {
		return errors.New("request is no longer available")
	}
	defer s.notify()
	if !allow {
		if s.mode != "ask" {
			s.setPolicy("ask", [32]byte{})
			return nil
		}
		c.requested = false
		if m.active == c {
			m.release()
		} else {
			m.send(c, "ready")
		}
		return nil
	}
	m.grant(c)
	return nil
}

func (m *Manager) grant(c *connection) {
	m.release()
	token := make([]byte, 32)
	_, _ = rand.Read(token)
	c.grant, c.requested = hex.EncodeToString(token), false
	m.active = c
	m.refreshActive()
	if m.active == c {
		m.send(c, m.state(c))
	}
	c.owner.notify()
}
