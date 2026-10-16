package remoteinput

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

type recordedInput struct {
	events chan inputEvent
	resets chan struct{}
}

func (s *recordedInput) Apply(_ bounds, event inputEvent) error { s.events <- event; return nil }
func (s *recordedInput) Reset() error                           { s.resets <- struct{}{}; return nil }

// Exercise the consent/retirement owner over real SCTP channels. No OS input
// is injected by this test; the platform acceptance uses a dedicated window.
func TestAttendedGrantLifecycle(t *testing.T) {
	sink := &recordedInput{make(chan inputEvent, 20), make(chan struct{}, 20)}
	m := &Manager{sink: sink, connections: map[string]*connection{}}
	s := &Session{manager: m, display: "Test display"}
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
	viewer.OnDataChannel(func(c *webrtc.DataChannel) { c.OnOpen(func() { channels <- c }) })
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
		if err := peers[peer].SendText(`{"type":"request","name":"Viewer"}`); err != nil {
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
		response := httptest.NewRecorder()
		body, _ := json.Marshal(map[string]any{"id": c.id, "allow": allow})
		m.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(string(body))))
		if response.Code != http.StatusOK {
			t.Fatal(response.Code, response.Body.String())
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		return c.grant
	}
	key := func(c *connection, grant string) {
		m.receive(c, webrtc.DataChannelMessage{IsString: true, Data: []byte(`{"type":"key","code":"KeyA","down":true,"grant":"` + grant + `"}`)})
	}
	first := request("first")
	key(first, "")
	if len(sink.events) != 0 {
		t.Fatal("unapproved input accepted")
	}
	grant := decide(first, true)
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
	s.Pause(false)
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
	s.Close()
	key(first, grant)
	if len(sink.events) != 2 || len(sink.resets) != 5 {
		t.Fatal("source retirement kept a grant")
	}
}
