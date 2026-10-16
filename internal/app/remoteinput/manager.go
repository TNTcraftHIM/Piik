// Package remoteinput owns the experimental, attended desktop input grant.
// Only the local App launcher can approve a connection. Media routing remains
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
	"net/http"
	"sort"
	"sync"

	"github.com/pion/webrtc/v4"
)

const ChannelLabel = "piik-remote-input-prototype-v1"

type bounds struct{ left, top, width, height int32 }

type inputEvent struct {
	Type   string  `json:"type"`
	Grant  string  `json:"grant,omitempty"`
	Name   string  `json:"name,omitempty"`
	X      float64 `json:"x,omitempty"`
	Y      float64 `json:"y,omitempty"`
	Button int     `json:"button,omitempty"`
	Down   bool    `json:"down,omitempty"`
	Code   string  `json:"code,omitempty"`
	Delta  int     `json:"delta,omitempty"`
}

type inputSink interface {
	Apply(bounds, inputEvent) error
	Reset() error
}

type View struct {
	ID      string `json:"id"`
	Code    string `json:"code"`
	Name    string `json:"name"`
	Display string `json:"display"`
	Active  bool   `json:"active"`
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
	bounds  bounds
	display string
	paused  bool
	closed  bool
}

type connection struct {
	owner     *Session
	edgeID    string
	id        string
	name      string
	requested bool
	grant     string
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
	return m, nil
}

func (m *Manager) NewSession() *Session {
	if m == nil {
		return nil
	}
	return &Session{manager: m}
}

// The channel belongs to the sharing session; input permission belongs to its
// current display. Replacing a picture revokes the grant without losing the
// channel needed to request control of the next display.
func (s *Session) SetDisplay(displayID, title string) {
	if s == nil {
		return
	}
	var b bounds
	if displayID != "" {
		b, _ = displayBounds(displayID)
	}
	s.setDisplay(b, title)
}

func (s *Session) setDisplay(b bounds, title string) {
	m := s.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || s.closed {
		return
	}
	s.bounds, s.display = b, title
	if m.active != nil && m.active.owner == s {
		m.release()
	}
	for _, c := range m.connections {
		if c.owner == s {
			c.requested = false
			m.send(c, "ready")
		}
	}
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
		State string `json:"state"`
		Code  string `json:"code"`
		Grant string `json:"grant,omitempty"`
	}{state, c.id[:6], c.grant})
	_ = c.channel.SendText(string(data))
}

func (s *Session) available() bool {
	return !s.closed && s.bounds.width > 0 && s.bounds.height > 0
}

func (m *Manager) release() {
	if c := m.active; c != nil {
		m.active = nil
		c.grant = ""
		_ = m.sink.Reset()
		m.send(c, "ready")
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
		state := "ready"
		if m.active == c {
			state = "active"
		} else if c.requested {
			state = "pending"
		}
		m.send(c, state)
	case "request":
		if !c.owner.available() || c.owner.paused || len(event.Name) > 128 || c.requested || c == m.active {
			return
		}
		c.requested, c.name = true, event.Name
		m.send(c, "pending")
	case "release":
		if !c.requested && m.active != c {
			return
		}
		c.requested = false
		if m.active == c {
			m.release()
		} else {
			m.send(c, "ready")
		}
	default:
		if m.active != c || c.grant == "" || event.Grant != c.grant || c.owner.paused || !c.owner.available() {
			return
		}
		if event.Type == "reset" {
			_ = m.sink.Reset()
			return
		}
		if err := m.sink.Apply(c.owner.bounds, event); err != nil {
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
}

// A lost media connection also retires input. ICE recovery does not restore
// an old desktop grant, even when SCTP has not noticed the interruption yet.
func (s *Session) Disconnect(edgeID string) {
	if s == nil {
		return
	}
	m := s.manager
	m.mu.Lock()
	var channel *webrtc.DataChannel
	for id, c := range m.connections {
		if c.owner == s && c.edgeID == edgeID {
			if m.active == c {
				m.release()
			}
			delete(m.connections, id)
			channel = c.channel
			break
		}
	}
	m.mu.Unlock()
	if channel != nil {
		_ = channel.Close()
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

func (m *Manager) views() []View {
	views := []View{}
	for _, c := range m.connections {
		if c.requested || m.active == c {
			views = append(views, View{c.id, c.id[:6], c.name, c.owner.display, m.active == c})
		}
	}
	sort.Slice(views, func(i, j int) bool { return views[i].ID < views[j].ID })
	return views
}

func (m *Manager) decide(id string, allow bool) error {
	c := m.connections[id]
	if m.closed || c == nil || !c.owner.available() || c.owner.paused || c.channel.ReadyState() != webrtc.DataChannelStateOpen || (!c.requested && m.active != c) {
		return errors.New("request is no longer available")
	}
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
	m.send(c, "active")
	return nil
}

// ServeHTTP is mounted only behind the launcher's loopback Host/Origin checks.
// It is never exposed through the room server or public invitation tunnel.
func (m *Manager) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if m == nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	var choice struct {
		ID    string `json:"id"`
		Allow bool   `json:"allow"`
	}
	if r.Method == http.MethodPost {
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&choice) != nil || decoder.Decode(&struct{}{}) != io.EOF {
			http.Error(w, "invalid decision", 400)
			return
		}
	} else if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "method not allowed", 405)
		return
	}
	m.mu.Lock()
	if r.Method == http.MethodPost && m.decide(choice.ID, choice.Allow) != nil {
		m.mu.Unlock()
		http.Error(w, "request expired", 409)
		return
	}
	views := m.views()
	m.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(views)
}
