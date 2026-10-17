package remoteinput

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/TNTcraftHIM/Piik/internal/media/inputroute"
	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
	"github.com/pion/webrtc/v4"
)

type recordedInput struct {
	events   chan inputEvent
	resets   chan struct{}
	target   bounds
	geometry bounds
	focused  bool
}

func TestSourceAuthorizationPolicy(t *testing.T) {
	sink := &recordedInput{events: make(chan inputEvent, 20), resets: make(chan struct{}, 20), focused: true}
	m := &Manager{sink: sink, connections: map[endpointKey]*connection{}}
	s := m.NewSession()
	t.Cleanup(s.Close)
	s.SetTarget(nativecapture.CaptureTarget{Kind: "display", SourceID: "1"})
	peers := []protocol.RemoteInputPeer{
		{PeerID: "first-viewer", EndpointID: strings.Repeat("a", 32), Secret: strings.Repeat("b", 64)},
		{PeerID: "second-viewer", EndpointID: strings.Repeat("c", 32), Secret: strings.Repeat("d", 64)},
	}
	if err := s.SetPeers(peers); err != nil {
		t.Fatal(err)
	}
	first, second := m.connections[endpointKey{s, peers[0].EndpointID}], m.connections[endpointKey{s, peers[1].EndpointID}]
	for _, c := range []*connection{first, second} {
		c.edgeID, c.epoch = "root-edge", strings.Repeat("e", 32)
	}
	request := func(c *connection, password string) {
		t.Helper()
		data, _ := json.Marshal(inputEvent{Type: "request", Intent: strings.Repeat("f", 32), Password: password})
		m.receive(c, webrtc.DataChannelMessage{IsString: true, Data: data}, c.epoch)
	}
	request(first, "")
	if s.State().Mode != "off" || first.requested || m.active != nil {
		t.Fatal("ordinary sharing accepted a control request before opt-in")
	}
	if err := s.SetPolicy("ask", ""); err != nil {
		t.Fatal(err)
	}
	request(first, "")
	oldRequest := first.requestID
	if !first.requested || m.active != nil {
		t.Fatal("Ask each time did not require Host approval")
	}
	if err := s.SetPolicy("room", ""); err != nil {
		t.Fatal(err)
	}
	if m.active != nil || first.requested || s.Decide(oldRequest, true) == nil {
		t.Fatal("policy change inherited an old request")
	}
	request(first, "")
	if m.active != first {
		t.Fatal("explicit room policy did not grant control")
	}
	request(second, "")
	if m.active != first || second.requested {
		t.Fatal("automatic request displaced an active controller")
	}
	m.Revoke()
	if m.active != nil || s.State().Mode != "ask" {
		t.Fatal("local stop did not disable automatic access")
	}
	request(second, "")
	if !second.requested || m.active != nil {
		t.Fatal("local stop allowed automatic re-entry")
	}
	if s.SetPolicy("password", "") == nil {
		t.Fatal("password mode accepted an empty credential")
	}
	if err := s.SetPolicy("password", "shared-secret"); err != nil {
		t.Fatal(err)
	}
	request(first, "wrong")
	if m.active != nil || first.requested {
		t.Fatal("incorrect password acquired control")
	}
	request(second, "shared-secret")
	if m.active != nil {
		t.Fatal("changing endpoints bypassed password attempt pacing")
	}
	s.passwordRetry = time.Time{}
	request(first, "shared-secret")
	if m.active != first {
		t.Fatal("correct password did not authorize control")
	}
	if err := s.Decide(first.requestID, false); err != nil {
		t.Fatal(err)
	}
	if m.active != nil || s.State().Mode != "ask" {
		t.Fatal("Host stop left automatic access enabled")
	}
	if err := s.SetPolicy("room", ""); err != nil {
		t.Fatal(err)
	}
	request(first, "")
	s.RevokeEdge("root-edge")
	if m.active != nil {
		t.Fatal("route loss retained input")
	}
	request(first, "")
	if m.active != first {
		t.Fatal("room policy could not authorize a fresh request")
	}
	oldGrant := first.grant
	s.Pause(true)
	if err := s.SetPolicy("off", ""); err != nil {
		t.Fatal(err)
	}
	s.Pause(false)
	m.receive(first, webrtc.DataChannelMessage{IsString: true, Data: []byte(`{"type":"key","code":"KeyA","down":true,"grant":"` + oldGrant + `"}`)}, first.epoch)
	request(second, "")
	if m.active != nil || second.requested || len(sink.events) != 0 {
		t.Fatal("disabled remote control retained input or accepted a new request")
	}
	if err := s.SetPolicy("room", ""); err != nil {
		t.Fatal(err)
	}
	request(first, "")
	s.SetTarget(nativecapture.CaptureTarget{Kind: "display", SourceID: "2"})
	if m.active != nil || s.State().Mode != "off" {
		t.Fatal("source replacement inherited permission")
	}
	request(second, "")
	if second.requested || m.active != nil {
		t.Fatal("replacement source accepted input without opt-in")
	}
}

func TestRouteReplacementRequiresApprovalAndIgnoresOldClosure(t *testing.T) {
	sink := &recordedInput{events: make(chan inputEvent, 8), resets: make(chan struct{}, 8), focused: true}
	m := &Manager{sink: sink, connections: map[endpointKey]*connection{}}
	s := m.NewSession()
	t.Cleanup(s.Close)
	s.SetTarget(nativecapture.CaptureTarget{Kind: "display", SourceID: "1"})
	if err := s.SetPolicy("ask", ""); err != nil {
		t.Fatal(err)
	}
	peer := protocol.RemoteInputPeer{PeerID: "viewer-route-test", EndpointID: strings.Repeat("a", 32), Secret: strings.Repeat("b", 64)}
	if err := s.SetPeers([]protocol.RemoteInputPeer{peer}); err != nil {
		t.Fatal(err)
	}
	cipher, _ := newInputCipher(peer.Secret)
	request := func(epoch string) string {
		t.Helper()
		cipher.sent++
		header := make([]byte, 20)
		binary.BigEndian.PutUint64(header, cipher.sent)
		_, _ = rand.Read(header[8:])
		plain := []byte(`{"type":"request","intent":"` + epoch + `"}`)
		data := cipher.aead.Seal(header, header[8:], plain, inputAAD(0, header[:8], epoch))
		s.receivePacket("same-root-relay", inputroute.Packet{ID: peer.EndpointID, Epoch: epoch, Data: base64.StdEncoding.EncodeToString(data)})
		views := s.State().Requests
		if len(views) != 1 || views[0].State != "pending" {
			t.Fatal("new channel did not require fresh approval")
		}
		if err := s.Decide(views[0].ID, true); err != nil {
			t.Fatal(err)
		}
		return m.active.grant
	}
	oldEpoch, newEpoch := strings.Repeat("c", 32), strings.Repeat("d", 32)
	oldGrant := request(oldEpoch)
	newGrant := request(newEpoch)
	if oldGrant == newGrant || len(sink.resets) != 1 {
		t.Fatal("replacement retained old input")
	}
	s.receivePacket("same-root-relay", inputroute.Packet{ID: peer.EndpointID, Epoch: oldEpoch, Closed: true})
	m.receive(m.active, webrtc.DataChannelMessage{IsString: true, Data: []byte(`{"type":"release","intent":"` + newEpoch + `"}`)}, oldEpoch)
	if m.active == nil || m.active.grant != newGrant {
		t.Fatal("old descendant closure retired the new grant")
	}
	s.receivePacket("same-root-relay", inputroute.Packet{ID: peer.EndpointID, Epoch: newEpoch, Closed: true})
	if m.active != nil || len(sink.resets) != 2 {
		t.Fatal("current route loss did not release input")
	}
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
	m := &Manager{sink: sink, connections: map[endpointKey]*connection{}}
	s := m.NewSession()
	s.SetTarget(nativecapture.CaptureTarget{Kind: "display", SourceID: "1"})
	if err := s.SetPolicy("ask", ""); err != nil {
		t.Fatal(err)
	}
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
	bindings := map[string]protocol.RemoteInputPeer{}
	ciphers := map[string]*inputCipher{}
	for _, name := range []string{"first", "second"} {
		id, key := make([]byte, 16), make([]byte, 32)
		_, _ = rand.Read(id)
		_, _ = rand.Read(key)
		bindings[name] = protocol.RemoteInputPeer{PeerID: name + "-viewer", EndpointID: hex.EncodeToString(id), Secret: hex.EncodeToString(key)}
		ciphers[name], _ = newInputCipher(bindings[name].Secret)
	}
	if err := s.SetPeers([]protocol.RemoteInputPeer{bindings["first"], bindings["second"]}); err != nil {
		t.Fatal(err)
	}
	viewer.OnDataChannel(func(c *webrtc.DataChannel) {
		c.OnMessage(func(message webrtc.DataChannelMessage) {
			var packet inputroute.Packet
			if json.Unmarshal(message.Data, &packet) != nil || packet.ID != bindings[c.Label()].EndpointID {
				return
			}
			bytes, err := base64.StdEncoding.DecodeString(packet.Data)
			if err != nil || len(bytes) < 36 {
				return
			}
			plain, err := ciphers[c.Label()].aead.Open(nil, bytes[8:20], bytes[20:], inputAAD(1, bytes[:8], packet.Epoch))
			if err != nil {
				return
			}
			var value struct {
				State string `json:"state"`
			}
			if json.Unmarshal(plain, &value) == nil {
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
		cipher := ciphers[peer]
		cipher.sent++
		header := make([]byte, 20)
		binary.BigEndian.PutUint64(header, cipher.sent)
		_, _ = rand.Read(header[8:])
		plain := []byte(`{"type":"request","intent":"` + hex.EncodeToString(intent) + `"}`)
		epoch := bindings[peer].EndpointID
		data := cipher.aead.Seal(header, header[8:], plain, inputAAD(0, header[:8], epoch))
		packet, _ := json.Marshal(inputroute.Packet{ID: bindings[peer].EndpointID, Epoch: epoch, Data: base64.StdEncoding.EncodeToString(data)})
		if err := peers[peer].SendText(string(packet)); err != nil {
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
		m.receive(c, webrtc.DataChannelMessage{IsString: true, Data: []byte(`{"type":"key","code":"KeyA","down":true,"grant":"` + grant + `"}`)}, c.epoch)
	}
	<-s.Changes() // Drain display setup; the next notification must be a request.
	first := request("first")
	other := m.NewSession()
	other.SetTarget(nativecapture.CaptureTarget{Kind: "display", SourceID: "2"})
	if err := other.SetPeers([]protocol.RemoteInputPeer{bindings["first"]}); err != nil {
		t.Fatal("endpoint identity leaked across independent rooms", err)
	}
	if len(other.State().Requests) != 0 || other.Decide(first.requestID, true) == nil || other.Decide(first.requestID, false) == nil {
		t.Fatal("another Host session can view or decide this share's request")
	}
	select {
	case <-s.Changes():
		views := s.State().Requests
		if len(views) != 1 || views[0].PeerID != "first-viewer" || views[0].State != "pending" {
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
	if s.State().Requests[0].State != "active" {
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
	s.RevokeEdge("second")
	key(second, grant2)
	if len(sink.events) != 2 || len(sink.resets) != 3 {
		t.Fatal("disconnect kept a grant")
	}
	// ICE may recover on the same channel. It must accept a fresh request,
	// without reviving the old grant or a pending approval from before loss.
	second = request("second")
	staleRequest := second.requestID
	s.RevokeEdge("second")
	if s.Decide(staleRequest, true) == nil || len(s.State().Requests) != 0 {
		t.Fatal("transport loss kept a pending approval")
	}
	second = request("second")
	key(second, grant2)
	if len(sink.events) != 2 {
		t.Fatal("new request restored the disconnected grant")
	}
	decide(second, false)
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
	if err := s.SetPolicy("ask", ""); err != nil {
		t.Fatal(err)
	}
	first = request("first")
	oldRequest, oldIntent := first.requestID, first.intent
	m.receive(first, webrtc.DataChannelMessage{IsString: true, Data: []byte(`{"type":"release","intent":"` + oldIntent + `"}`)}, first.epoch)
	first = request("first")
	if s.Decide(oldRequest, true) == nil {
		t.Fatal("late approval authorized a replacement request")
	}
	nextGrant := decide(first, true)
	m.receive(first, webrtc.DataChannelMessage{IsString: true, Data: []byte(`{"type":"release","intent":"` + oldIntent + `"}`)}, first.epoch)
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
	if !first.suspended || s.State().Requests[0].State != "suspended" || len(sink.events) != 3 || len(sink.resets) != 6 {
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
	if len(sink.events) != 4 || len(sink.resets) != 7 || len(s.State().Requests) != 0 || s.Decide(first.requestID, true) == nil {
		t.Fatal("source retirement kept a grant")
	}
}
