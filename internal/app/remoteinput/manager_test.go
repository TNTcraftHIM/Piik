package remoteinput

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/pion/webrtc/v4"
)

type recordedInput struct {
	events   chan inputEvent
	resets   chan struct{}
	target   bounds
	geometry bounds
	focused  bool
}

func (s *recordedInput) Target(nativecapture.CaptureTarget) (bounds, bool, error) {
	return s.geometry, s.focused, nil
}

func (s *recordedInput) Apply(target bounds, event inputEvent) error {
	s.target = target
	s.events <- event
	return nil
}
func (s *recordedInput) Reset() error { s.resets <- struct{}{}; return nil }

// Exercise the consent/retirement owner over real SCTP channels. No OS input
// is injected by this test; the platform acceptance uses a dedicated window.
func TestAttendedGrantLifecycle(t *testing.T) {
	sink := &recordedInput{events: make(chan inputEvent, 20), resets: make(chan struct{}, 20), geometry: bounds{width: 1920, height: 1080}, focused: true}
	m := &Manager{sink: sink, connections: map[string]*connection{}}
	s := m.NewSession()
	s.SetTarget(nativecapture.CaptureTarget{Kind: "display", SourceID: "1"})
	t.Cleanup(m.Close)
	host, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = host.Close() })
	viewer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = viewer.Close() })
	channels := make(chan *webrtc.DataChannel, 2)
	type observedState struct{ peer, state string }
	states := make(chan observedState, 128)
	viewer.OnDataChannel(func(c *webrtc.DataChannel) {
		c.OnMessage(func(message webrtc.DataChannelMessage) {
			var value struct {
				State string `json:"state"`
			}
			if json.Unmarshal(message.Data, &value) == nil {
				states <- observedState{c.Label(), value.State}
			}
		})
		c.OnOpen(func() { channels <- c })
	})
	for _, id := range []string{"first", "second"} {
		c, err := host.CreateDataChannel(id, nil)
		if err != nil {
			t.Fatal(err)
		}
		s.Attach(id, c)
	}
	offer, err := host.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(host)
	if err = host.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gathered:
	case <-time.After(5 * time.Second):
		t.Fatal("offer gathering timed out")
	}
	if err = viewer.SetRemoteDescription(*host.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	answer, err := viewer.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered = webrtc.GatheringCompletePromise(viewer)
	if err = viewer.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gathered:
	case <-time.After(5 * time.Second):
		t.Fatal("answer gathering timed out")
	}
	if err = host.SetRemoteDescription(*viewer.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	peers := map[string]*webrtc.DataChannel{}
	for range 2 {
		select {
		case c := <-channels:
			peers[c.Label()] = c
		case <-time.After(5 * time.Second):
			t.Fatal("channel did not open")
		}
	}
	wait := func(check func() bool) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			m.mu.Lock()
			ok := check()
			m.mu.Unlock()
			if ok {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
		t.Fatal("grant state did not settle")
	}
	request := func(peer string) *connection {
		t.Helper()
		intent := make([]byte, 16)
		_, _ = rand.Read(intent)
		if err := peers[peer].SendText(`{"type":"request","intent":"` + hex.EncodeToString(intent) + `"}`); err != nil {
			t.Fatal(err)
		}
		var found *connection
		wait(func() bool {
			for _, c := range m.connections {
				if c.edgeID == peer && c.requested {
					found = c
					return true
				}
			}
			return false
		})
		return found
	}
	decide := func(c *connection, allow bool) string {
		t.Helper()
		if err := s.Decide(c.requestID, allow); err != nil {
			t.Fatal(err)
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		return c.grant
	}
	key := func(c *connection, grant string) {
		m.receive(c, webrtc.DataChannelMessage{IsString: true, Data: []byte(`{"type":"key","code":"KeyA","down":true,"grant":"` + grant + `"}`)})
	}
	<-s.Changes() // Drain display setup; the next notification must be a request.
	first := request("first")
	other := m.NewSession()
	other.SetTarget(nativecapture.CaptureTarget{Kind: "display", SourceID: "2"})
	if len(other.Views()) != 0 || other.Decide(first.requestID, true) == nil || other.Decide(first.requestID, false) == nil {
		t.Fatal("another Host session can view or decide this share's request")
	}
	select {
	case <-s.Changes():
		views := s.Views()
		if len(views) != 1 || views[0].ConnectionID != "first" || views[0].State != "pending" {
			t.Fatal("request not reflected in its Host snapshot")
		}
	default:
		t.Fatal("request did not notify its Host")
	}
	key(first, "")
	if len(sink.events) != 0 {
		t.Fatal("unapproved input accepted")
	}
	grant := decide(first, true)
	if s.Views()[0].State != "active" {
		t.Fatal("approval not reflected in Host snapshot")
	}
	if grant == "" {
		t.Fatal("missing grant")
	}
	key(first, grant)
	if len(sink.events) != 1 {
		t.Fatal("approved input missing")
	}
	second := request("second")
	grant2 := decide(second, true)
	key(first, grant)
	if len(sink.events) != 1 || len(sink.resets) != 1 {
		t.Fatal("takeover did not retire old input")
	}
	key(second, grant2)
	s.Pause(true)
	key(second, grant2)
	if len(sink.events) != 2 || len(sink.resets) != 2 {
		t.Fatal("pause did not release input")
	}
	// Wait for the paused status before resuming; a ready message from the
	// initial connection must not stand in for the actual resume notification.
	stateDeadline := time.After(3 * time.Second)
	waitState := func(want string) {
		t.Helper()
		for {
			select {
			case state := <-states:
				if state.peer == "second" && state.state == want {
					return
				}
			case <-stateDeadline:
				t.Fatalf("missing viewer state %q", want)
			}
		}
	}
	waitState("unavailable")
	s.Pause(false)
	waitState("ready")
	second = request("second")
	grant2 = decide(second, true)
	s.Disconnect("second")
	key(second, grant2)
	if len(sink.events) != 2 || len(sink.resets) != 3 {
		t.Fatal("disconnect kept a grant")
	}
	first = request("first")
	grant = decide(first, true)
	m.Revoke()
	key(first, grant)
	if len(sink.events) != 2 || len(sink.resets) != 4 {
		t.Fatal("local stop kept a grant")
	}
	first = request("first")
	grant = decide(first, true)
	s.SetTarget(nativecapture.CaptureTarget{})
	key(first, grant)
	if len(sink.events) != 2 || len(sink.resets) != 5 || s.available() {
		t.Fatal("source replacement kept input authority")
	}
	nextDisplay := bounds{left: 1920, width: 1280, height: 720}
	sink.geometry = nextDisplay
	s.SetTarget(nativecapture.CaptureTarget{Kind: "window", SourceID: "3"})
	first = request("first")
	oldRequest, oldIntent := first.requestID, first.intent
	m.receive(first, webrtc.DataChannelMessage{IsString: true, Data: []byte(`{"type":"release","intent":"` + oldIntent + `"}`)})
	first = request("first")
	if s.Decide(oldRequest, true) == nil {
		t.Fatal("late approval authorized a replacement request")
	}
	nextGrant := decide(first, true)
	m.receive(first, webrtc.DataChannelMessage{IsString: true, Data: []byte(`{"type":"release","intent":"` + oldIntent + `"}`)})
	key(first, grant)
	key(first, nextGrant)
	if len(sink.events) != 3 || nextGrant == grant || sink.target != nextDisplay {
		t.Fatal("replacement did not require fresh approval on the existing channel")
	}
	// A held key must be released when the Host leaves the shared window,
	// even when the Viewer sends nothing. Focus recovery retains the grant.
	m.mu.Lock()
	sink.focused = false
	m.refreshActive()
	m.refreshActive()
	m.mu.Unlock()
	key(first, nextGrant)
	if !first.suspended || s.Views()[0].State != "suspended" || len(sink.events) != 3 || len(sink.resets) != 6 {
		t.Fatal("window focus loss did not suspend and release held input once")
	}
	sink.focused = true
	sink.geometry = bounds{left: 100, top: 200, width: 640, height: 480}
	key(first, nextGrant)
	if first.suspended || len(sink.events) != 4 || sink.target != sink.geometry {
		t.Fatal("window movement/focus recovery did not use the current target")
	}
	s.Close()
	key(first, nextGrant)
	if len(sink.events) != 4 || len(sink.resets) != 7 || len(s.Views()) != 0 || s.Decide(first.requestID, true) == nil {
		t.Fatal("source retirement kept a grant")
	}
}
