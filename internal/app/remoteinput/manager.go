// Package remoteinput owns the experimental, attended desktop input grant.
// Only the owning Host control session can approve a connection. Media routing remains
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
	"sort"
	"sync"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/pion/webrtc/v4"
)

const ChannelLabel = "piik-remote-input-prototype-v1"

type bounds struct{ left, top, width, height int32 }

type inputEvent struct {
	Type   string  `json:"type"`
	Grant  string  `json:"grant,omitempty"`
	Intent string  `json:"intent,omitempty"`
	X      float64 `json:"x,omitempty"`
	Y      float64 `json:"y,omitempty"`
	Button int     `json:"button,omitempty"`
	Down   bool    `json:"down,omitempty"`
	Code   string  `json:"code,omitempty"`
	Delta  int     `json:"delta,omitempty"`
	DX     int32   `json:"dx,omitempty"`
	DY     int32   `json:"dy,omitempty"`
}

type inputSink interface {
	Target(nativecapture.CaptureTarget) (bounds, bool, error)
	Apply(bounds, inputEvent) error
	Reset() error
}

type View struct {
	ID           string `json:"id"`
	ConnectionID string `json:"connectionId"`
	State        string `json:"state"`
}

// One manager covers both native sessions: they operate the same physical desktop.
type Manager struct {
	mu          sync.Mutex
	sink        inputSink
	connections map[string]*connection
	active      *connection
	closed      bool
	stop        context.CancelFunc
}

type Session struct {
	manager *Manager
	target  nativecapture.CaptureTarget
	paused  bool
	closed  bool
	changed chan struct{}
}

type connection struct {
	owner     *Session
	edgeID    string
	id        string
	requested bool
	requestID string
	intent    string
	grant     string
	suspended bool
	channel   *webrtc.DataChannel
}

// New is inert in ordinary builds. The remotecontrol build tag selects the
// Windows prototype; it does not install a service, driver or startup entry.
func New(ctx context.Context) (*Manager, error) {
	sink, err := newPlatformSink()
	if err != nil || sink == nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	m := &Manager{sink: sink, connections: make(map[string]*connection), stop: cancel}
	if err := watchStopShortcut(ctx, func() { m.Revoke() }); err != nil {
		cancel()
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
	return &Session{manager: m, changed: make(chan struct{}, 1)}
}

// Changes coalesces notifications; Views reads the current grant owner. Input
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
func (s *Session) SetTarget(target nativecapture.CaptureTarget) {
	if s == nil {
		return
	}
	m := s.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || s.closed {
		return
	}
	if target.Kind != "display" && target.Kind != "window" {
		target = nativecapture.CaptureTarget{}
	}
	s.target = target
	if m.active != nil && m.active.owner == s {
		m.release()
	}
	for _, c := range m.connections {
		if c.owner == s {
			c.requested = false
			m.send(c, "ready")
		}
	}
	s.notify()
}

func (s *Session) Attach(edgeID string, channel *webrtc.DataChannel) {
	m := s.manager
	id := make([]byte, 16)
	_, _ = rand.Read(id)
	c := &connection{owner: s, edgeID: edgeID, id: hex.EncodeToString(id), channel: channel}
	m.mu.Lock()
	if m.closed || s.closed {
		m.mu.Unlock()
		_ = channel.Close()
		return
	}
	m.connections[c.id] = c
	m.mu.Unlock()
	channel.OnOpen(func() { m.mu.Lock(); defer m.mu.Unlock(); m.send(c, "ready") })
	channel.OnMessage(func(message webrtc.DataChannelMessage) { m.receive(c, message) })
	channel.OnClose(func() { m.remove(c) })
	channel.OnError(func(error) { m.remove(c) })
}

func (m *Manager) send(c *connection, state string) {
	if c.channel.ReadyState() != webrtc.DataChannelStateOpen {
		return
	}
	if state == "ready" && !c.owner.available() {
		state = "unavailable"
	}
	data, _ := json.Marshal(struct {
		State  string `json:"state"`
		Grant  string `json:"grant,omitempty"`
		Intent string `json:"intent,omitempty"`
	}{state, c.grant, c.intent})
	_ = c.channel.SendText(string(data))
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
	b, focused, err := m.sink.Target(c.owner.target)
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

func (m *Manager) receive(c *connection, message webrtc.DataChannelMessage) {
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
	if m.closed || c.owner.closed || m.connections[c.id] != c {
		return
	}
	switch event.Type {
	case "sync":
		m.send(c, m.state(c))
	case "request":
		if !c.owner.available() || c.requested || c == m.active {
			return
		}
		if intent, err := hex.DecodeString(event.Intent); err != nil || len(intent) != 16 {
			return
		}
		id := make([]byte, 16)
		_, _ = rand.Read(id)
		c.requestID, c.intent = hex.EncodeToString(id), event.Intent
		c.requested = true
		m.send(c, "pending")
		c.owner.notify()
	case "release":
		// A local App playback bridge may release its current endpoint without
		// knowing the Browser intent. Browser cancellations name their request.
		if (event.Intent != "" && event.Intent != c.intent) || (!c.requested && m.active != c) {
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

func (m *Manager) remove(c *connection) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.active == c {
		m.release()
	}
	delete(m.connections, c.id)
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
			c.requested = false
			if m.active == c {
				m.release()
			} else {
				m.send(c, "ready")
			}
			s.notify()
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
	if m.active != nil && m.active.owner == s {
		m.release()
	}
	var channels []*webrtc.DataChannel
	for id, c := range m.connections {
		if c.owner == s {
			delete(m.connections, id)
			channels = append(channels, c.channel)
		}
	}
	s.notify()
	m.mu.Unlock()
	for _, channel := range channels {
		_ = channel.Close()
	}
}

func (m *Manager) Revoke() {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.release()
}

func (m *Manager) Close() {
	if m == nil {
		return
	}
	m.mu.Lock()
	m.closed = true
	m.release()
	m.mu.Unlock()
	if m.stop != nil {
		m.stop()
	}
}

func (s *Session) Views() []View {
	views := []View{}
	if s == nil {
		return views
	}
	m := s.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, c := range m.connections {
		if c.owner == s && (c.requested || m.active == c) {
			views = append(views, View{c.requestID, c.edgeID, m.state(c)})
		}
	}
	sort.Slice(views, func(i, j int) bool { return views[i].ID < views[j].ID })
	return views
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
	if m.closed || c == nil || !s.available() || c.channel.ReadyState() != webrtc.DataChannelStateOpen || (!c.requested && m.active != c) {
		return errors.New("request is no longer available")
	}
	defer s.notify()
	if !allow {
		c.requested = false
		if m.active == c {
			m.release()
		} else {
			m.send(c, "ready")
		}
		return nil
	}
	m.release()
	token := make([]byte, 32)
	_, _ = rand.Read(token)
	c.grant, c.requested = hex.EncodeToString(token), false
	m.active = c
	m.refreshActive()
	if m.active == c {
		m.send(c, m.state(c))
	}
	return nil
}
