package remoteinput

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/TNTcraftHIM/Piik/internal/media/inputroute"
	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
	"github.com/pion/webrtc/v4"
)

type recordedInput struct {
	authorize func() error
	events    chan inputEvent
	resets    chan struct{}
	target    bounds
	geometry  bounds
	focused   bool
}

func setTestPolicy(s *Session, mode, password string) error {
	change, err := s.BeginPolicy(context.Background(), mode, password, s.coPlay)
	if err != nil {
		return err
	}
	defer change.Close()
	return change.Apply()
}

func TestSourceAuthorizationPolicy(t *testing.T) {
	sink := &recordedInput{events: make(chan inputEvent, 20), resets: make(chan struct{}, 20), focused: true}
	m := &Manager{sink: sink, connections: map[endpointKey]*connection{}}
	s := m.NewSession()
	t.Cleanup(s.Close)
	s.SetTarget(nativecapture.CaptureTarget{Kind: "display", SourceID: "1"}, nil)
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
	if s.State().Mode != "off" || first.requested || m.owner != nil {
		t.Fatal("ordinary sharing accepted a control request before opt-in")
	}
	if err := setTestPolicy(s, "ask", ""); err != nil {
		t.Fatal(err)
	}
	request(first, "")
	oldRequest := first.requestID
	if !first.requested || m.owner != nil {
		t.Fatal("Ask each time did not require Host approval")
	}
	if err := setTestPolicy(s, "room", ""); err != nil {
		t.Fatal(err)
	}
	if m.owner != nil || first.requested || s.Decide(oldRequest, true) == nil {
		t.Fatal("policy change inherited an old request")
	}
	request(first, "")
	if first.grant == "" {
		t.Fatal("explicit room policy did not grant control")
	}
	request(second, "")
	if first.grant == "" || second.grant != "" || second.requested {
		t.Fatal("automatic request displaced an active controller")
	}
	m.Revoke()
	if m.owner != nil || s.State().Mode != "ask" {
		t.Fatal("local stop did not disable automatic access")
	}
	request(second, "")
	if !second.requested || m.owner != nil {
		t.Fatal("local stop allowed automatic re-entry")
	}
	if setTestPolicy(s, "password", "") == nil {
		t.Fatal("password mode accepted an empty credential")
	}
	if err := setTestPolicy(s, "password", "shared-secret"); err != nil {
		t.Fatal(err)
	}
	request(first, "wrong")
	if m.owner != nil || first.requested {
		t.Fatal("incorrect password acquired control")
	}
	request(second, "shared-secret")
	if m.owner != nil {
		t.Fatal("changing endpoints bypassed password attempt pacing")
	}
	s.passwordRetry = time.Time{}
	request(first, "shared-secret")
	if first.grant == "" {
		t.Fatal("correct password did not authorize control")
	}
	if err := s.Decide(first.requestID, false); err != nil {
		t.Fatal(err)
	}
	if m.owner != nil || s.State().Mode != "ask" {
		t.Fatal("Host stop left automatic access enabled")
	}
	if err := setTestPolicy(s, "room", ""); err != nil {
		t.Fatal(err)
	}
	request(first, "")
	s.RevokeEdge("root-edge")
	if m.owner != nil {
		t.Fatal("route loss retained input")
	}
	request(first, "")
	if first.grant == "" {
		t.Fatal("room policy could not authorize a fresh request")
	}
	oldGrant := first.grant
	s.Pause(true)
	if err := setTestPolicy(s, "off", ""); err != nil {
		t.Fatal(err)
	}
	s.Pause(false)
	m.receive(first, webrtc.DataChannelMessage{IsString: true, Data: []byte(`{"type":"key","code":"KeyA","down":true,"grant":"` + oldGrant + `"}`)}, first.epoch)
	request(second, "")
	if m.owner != nil || second.requested || len(sink.events) != 0 {
		t.Fatal("disabled remote control retained input or accepted a new request")
	}
	if err := setTestPolicy(s, "room", ""); err != nil {
		t.Fatal(err)
	}
	request(first, "")
	s.SetTarget(nativecapture.CaptureTarget{Kind: "display", SourceID: "2"}, nil)
	if m.owner != nil || s.State().Mode != "off" {
		t.Fatal("source replacement inherited permission")
	}
	request(second, "")
	if second.requested || m.owner != nil {
		t.Fatal("replacement source accepted input without opt-in")
	}
	if err := setTestPolicy(s, "room", ""); err != nil {
		t.Fatal(err)
	}
	request(first, "")
	revokedGrant := first.grant
	if err := s.SetPeers(peers[1:]); err != nil {
		t.Fatal(err)
	}
	if m.owner != nil || first.grant != "" || m.connections[endpointKey{s, first.id}] != nil {
		t.Fatal("room membership removal retained the active input grant")
	}
	m.receive(first, webrtc.DataChannelMessage{IsString: true, Data: []byte(`{"type":"key","code":"KeyA","down":true,"grant":"` + revokedGrant + `"}`)}, first.epoch)
	request(first, "")
	if m.owner != nil || first.requested || len(sink.events) != 0 {
		t.Fatal("removed endpoint regained input with its old grant or key")
	}
	request(second, "")
	if second.grant == "" {
		t.Fatal("membership removal interrupted the remaining authenticated endpoint")
	}
}

func TestRouteReplacementRequiresApprovalAndIgnoresOldClosure(t *testing.T) {
	sink := &recordedInput{events: make(chan inputEvent, 8), resets: make(chan struct{}, 8), focused: true}
	m := &Manager{sink: sink, connections: map[endpointKey]*connection{}}
	s := m.NewSession()
	t.Cleanup(s.Close)
	s.SetTarget(nativecapture.CaptureTarget{Kind: "display", SourceID: "1"}, nil)
	if err := setTestPolicy(s, "ask", ""); err != nil {
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
		return m.connections[endpointKey{s, peer.EndpointID}].grant
	}
	oldEpoch, newEpoch := strings.Repeat("c", 32), strings.Repeat("d", 32)
	oldGrant := request(oldEpoch)
	newGrant := request(newEpoch)
	if oldGrant == newGrant || len(sink.resets) != 1 {
		t.Fatal("replacement retained old input")
	}
	s.receivePacket("same-root-relay", inputroute.Packet{ID: peer.EndpointID, Epoch: oldEpoch, Closed: true})
	m.receive(m.connections[endpointKey{s, peer.EndpointID}], webrtc.DataChannelMessage{IsString: true, Data: []byte(`{"type":"release","intent":"` + newEpoch + `"}`)}, oldEpoch)
	if m.owner == nil || m.connections[endpointKey{s, peer.EndpointID}].grant != newGrant {
		t.Fatal("old descendant closure retired the new grant")
	}
	s.receivePacket("same-root-relay", inputroute.Packet{ID: peer.EndpointID, Epoch: newEpoch, Closed: true})
	if m.owner != nil || len(sink.resets) != 2 {
		t.Fatal("current route loss did not release input")
	}
}

func (s *recordedInput) Authorize() error {
	if s.authorize != nil {
		return s.authorize()
	}
	return nil
}

func TestOSPermissionCannotAuthorizeAReplacementSource(t *testing.T) {
	sink := &recordedInput{}
	m := &Manager{sink: sink, connections: map[endpointKey]*connection{}}
	s := m.NewSession()
	t.Cleanup(s.Close)
	s.SetTarget(nativecapture.CaptureTarget{Kind: "display", SourceID: "1"}, nil)
	sink.authorize = func() error {
		// Closing/replacing the share must remain possible while an OS dialog is open.
		s.SetTarget(nativecapture.CaptureTarget{Kind: "display", SourceID: "2"}, nil)
		return nil
	}
	if setTestPolicy(s, "room", "") == nil || s.State().Mode != "off" {
		t.Fatal("late OS permission enabled input on a replacement source")
	}
	sink.authorize = func() error { return setTestPolicy(s, "off", "") }
	if setTestPolicy(s, "room", "") == nil || s.State().Mode != "off" {
		t.Fatal("late OS permission undid Host revocation")
	}
}

func TestPreparedPolicyFollowsTheCommittedSourceAndHostIntent(t *testing.T) {
	for _, action := range []string{"complete", "off-before-work", "off-during-prepare", "pause-and-resume", "replace-source"} {
		t.Run(action, func(t *testing.T) {
			sink := &recordedInput{}
			m := &Manager{sink: sink, connections: map[endpointKey]*connection{}}
			s := m.NewSession()
			t.Cleanup(s.Close)
			s.SetTarget(nativecapture.CaptureTarget{Kind: "display", SourceID: "1"}, nil)
			change, err := s.BeginPolicy(t.Context(), "room", "", false)
			if err != nil {
				t.Fatal(err)
			}
			defer change.Close()
			if action == "off-before-work" {
				if err := setTestPolicy(s, "off", ""); err != nil {
					t.Fatal(err)
				}
			}
			// Portal capture replacement must retire input while preserving only
			// the same current Host intent through its own two source bindings.
			change.SetTarget(nativecapture.CaptureTarget{}, nil)
			switch action {
			case "off-during-prepare":
				if err := setTestPolicy(s, "off", ""); err != nil {
					t.Fatal(err)
				}
			case "pause-and-resume":
				s.Pause(true)
				s.Pause(false)
			case "replace-source":
				s.SetTarget(nativecapture.CaptureTarget{Kind: "display", SourceID: "2"}, nil)
			}
			installed := nativecapture.CaptureTarget{Kind: "display", SourceID: "3"}
			change.SetTarget(installed, nil)
			cancelled := action != "complete"
			if (change.Context().Err() != nil) != cancelled {
				t.Fatal("preparation cancellation did not follow the Host intent")
			}
			if (change.Apply() != nil) != cancelled {
				t.Fatal("late preparation changed a retired permission")
			}
			expected := "room"
			if cancelled {
				expected = "off"
			}
			if s.State().Mode != expected || s.target != installed {
				t.Fatal("policy or actual source binding diverged after preparation")
			}
			if err := setTestPolicy(s, "ask", ""); err != nil {
				t.Fatalf("new authorization could not use the committed source: %v", err)
			}
		})
	}
}

func (s *recordedInput) Target(nativecapture.CaptureTarget, *nativecapture.Stream) (bounds, bool, error) {
	return s.geometry, s.focused, nil
}

func (s *recordedInput) Apply(target bounds, event inputEvent) error {
	s.target = target
	s.events <- event
	return nil
}
func (s *recordedInput) Reset() error { s.resets <- struct{}{}; return nil }

func TestCommittedMultilineText(t *testing.T) {
	sink := &recordedInput{events: make(chan inputEvent, 16), resets: make(chan struct{}, 8)}
	longLine := strings.Repeat("\\\"", maxTextBytes/2)
	for _, text := range []string{longLine, "if (ready) {\r\n\tprint(\"中文 😀\");\n}"} {
		if err := applyText(sink, bounds{}, text); err != nil {
			t.Fatal(err)
		}
	}
	want := []inputEvent{
		{Type: "text", Text: longLine},
		{Type: "text", Text: "if (ready) {"},
		{Type: "key", Code: "Enter", Down: true}, {Type: "key", Code: "Enter"},
		{Type: "key", Code: "Tab", Down: true}, {Type: "key", Code: "Tab"},
		{Type: "text", Text: "print(\"中文 😀\");"},
		{Type: "key", Code: "Enter", Down: true}, {Type: "key", Code: "Enter"},
		{Type: "text", Text: "}"},
	}
	if len(sink.events) != len(want) {
		t.Fatalf("input events: %d, want %d", len(sink.events), len(want))
	}
	for _, event := range want {
		if actual := <-sink.events; actual != event {
			t.Fatalf("input: %+v, want %+v", actual, event)
		}
	}
	for _, text := range []string{"", strings.Repeat("x", maxTextBytes+1), "a\x00b", "a\x7fb", string([]byte{0xff})} {
		if err := applyText(sink, bounds{}, text); err == nil {
			t.Fatal("invalid text accepted")
		}
	}
	if len(sink.events) != 0 || len(sink.resets) != 2 {
		t.Fatal("invalid text applied partial input or reset held keys")
	}
}

func coPlaySession(t *testing.T, m *Manager, extended ...bool) (*Session, []*connection) {
	t.Helper()
	t.Cleanup(m.Close)
	s := m.NewSession()
	t.Cleanup(s.Close)
	s.SetTarget(nativecapture.CaptureTarget{Kind: "display", SourceID: "1"}, nil)
	change, err := s.BeginPolicy(t.Context(), "room", "", true)
	if err != nil {
		t.Fatal(err)
	}
	defer change.Close()
	if err := change.Apply(); err != nil {
		t.Fatal(err)
	}
	var peers []protocol.RemoteInputPeer
	for i := range extended {
		digit := hex.EncodeToString([]byte{byte(i + 1)})
		peers = append(peers, protocol.RemoteInputPeer{PeerID: "viewer-" + string(rune('a'+i)),
			EndpointID: strings.Repeat(digit, 16), Secret: strings.Repeat(digit, 32)})
	}
	if err := s.SetPeers(peers); err != nil {
		t.Fatal(err)
	}
	var connections []*connection
	for i, peer := range peers {
		c := m.connections[endpointKey{s, peer.EndpointID}]
		c.edgeID, c.epoch = c.id, strings.Repeat("e", 32)
		if extended[i] {
			sendTestInput(m, c, inputEvent{Type: "capabilities"})
		}
		connections = append(connections, c)
	}
	return s, connections
}

type recordedGamepad struct {
	state     gamepadReport
	updateErr error
	closed    bool
}

func (p *recordedGamepad) Update(report gamepadReport) error {
	if p.closed {
		return errors.New("recorded gamepad is closed")
	}
	if p.updateErr != nil {
		return p.updateErr
	}
	p.state = report
	return nil
}

func (p *recordedGamepad) Close() error {
	if p.closed {
		return nil
	}
	err := p.Update(gamepadReport{})
	p.closed = true
	return err
}

type recordedGamepads struct {
	devices  []*recordedGamepad
	capacity int
	openErr  error
	closed   bool
}

func (b *recordedGamepads) Open() (gamepadDevice, error) {
	if b.capacity > 0 {
		active := 0
		for _, device := range b.devices {
			if !device.closed {
				active++
			}
		}
		if active >= b.capacity {
			return nil, errors.New("backend device capacity reached")
		}
	}
	if b.openErr != nil {
		return nil, b.openErr
	}
	p := &recordedGamepad{}
	b.devices = append(b.devices, p)
	return p, nil
}

func (b *recordedGamepads) Close() error {
	b.closed = true
	for _, device := range b.devices {
		_ = device.Close()
	}
	return nil
}

func TestCoPlayGamepadGrantIsolationAndRetirement(t *testing.T) {
	sink := &recordedInput{events: make(chan inputEvent, 32), resets: make(chan struct{}, 16), focused: true}
	pads := &recordedGamepads{}
	m := &Manager{sink: sink, gamepads: pads, connections: map[endpointKey]*connection{}}
	s, players := coPlaySession(t, m, true, true, true)
	a, b, keyboard := players[0], players[1], players[2]
	sendTestInput(m, a, inputEvent{Type: "request", Device: "gamepad"})
	if a.grant == "" || a.pad == nil || m.owner != s {
		t.Fatal("first gamepad did not receive an independent grant without the pointer")
	}
	sendTestInput(m, keyboard, inputEvent{Type: "request"})
	sendTestInput(m, b, inputEvent{Type: "request", Device: "gamepad"})
	if keyboard.grant == "" || b.grant == "" || m.owner != s {
		t.Fatal("gamepad ownership blocked the first keyboard or sibling gamepad")
	}
	state := s.State()
	if state.Gamepad == nil || !*state.Gamepad {
		t.Fatal("Host state omitted the available gamepad backend")
	}
	for _, view := range state.Requests {
		if (view.Device == "gamepad") != (view.PeerID != keyboard.peerID) {
			t.Fatal("Host state confused keyboard and gamepad grants")
		}
		if view.EndpointID != map[string]string{a.peerID: a.id, b.peerID: b.id, keyboard.peerID: keyboard.id}[view.PeerID] {
			t.Fatal("co-play presentation lost its authenticated input endpoint")
		}
	}
	reportA := gamepadReport{Buttons: 0x1000, LeftX: 12000}
	reportB := gamepadReport{Buttons: 0x2000, RightTrigger: 190}
	sendTestInput(m, a, inputEvent{Type: "gamepad", Gamepad: &reportA})
	sendTestInput(m, b, inputEvent{Type: "gamepad", Gamepad: &reportB})
	first, second := pads.devices[0], pads.devices[1]
	if first.state != reportA || second.state != reportB {
		t.Fatal("gamepad reports crossed grant ownership")
	}
	for _, event := range []inputEvent{
		{Type: "key", Code: "KeyA", Down: true}, {Type: "button", Down: true},
		{Type: "move", X: 0.5, Y: 0.5}, {Type: "text", Text: "text"},
	} {
		sendTestInput(m, a, event)
	}
	sendTestInput(m, keyboard, inputEvent{Type: "gamepad", Gamepad: &reportB})
	if len(sink.events) != 0 || first.state != reportA || second.state != reportB {
		t.Fatal("gamepad permission crossed into keyboard/pointer input")
	}
	sendTestInput(m, a, inputEvent{Type: "reset"})
	if first.state != (gamepadReport{}) || second.state != reportB || keyboard.grant == "" {
		t.Fatal("reset changed another player's device")
	}
	sink.focused = false
	m.refreshActive()
	if !a.suspended || !b.suspended || !keyboard.suspended || second.state != (gamepadReport{}) {
		t.Fatal("source focus loss did not neutralize and suspend each gamepad")
	}
	sendTestInput(m, b, inputEvent{Type: "gamepad", Gamepad: &reportB})
	if second.state != (gamepadReport{}) {
		t.Fatal("unfocused source accepted gamepad input")
	}
	sink.focused = true
	sendTestInput(m, b, inputEvent{Type: "gamepad", Gamepad: &reportB})
	sendTestInput(m, keyboard, inputEvent{Type: "key", Code: "KeyB", Down: true})
	<-sink.events
	s.receivePacket(a.edgeID, inputroute.Packet{ID: a.id, Epoch: a.epoch, Closed: true})
	if !first.closed || a.pad != nil || a.grant != "" || b.grant == "" || !keyboard.keys["KeyB"] {
		t.Fatal("one route retirement changed a sibling grant")
	}
	second.updateErr = errors.New("driver write failed")
	sendTestInput(m, b, inputEvent{Type: "gamepad", Gamepad: &reportB})
	if !second.closed || b.pad != nil || b.grant != "" || keyboard.grant == "" || !keyboard.keys["KeyB"] {
		t.Fatal("one gamepad failure retired healthy input owners")
	}
	a.edgeID = "replacement-edge"
	sendTestInput(m, a, inputEvent{Type: "request", Device: "gamepad"})
	third := pads.devices[2]
	sendTestInput(m, a, inputEvent{Type: "gamepad", Gamepad: &reportA})
	s.SetTarget(nativecapture.CaptureTarget{Kind: "display", SourceID: "2"}, nil)
	if !third.closed || third.state != (gamepadReport{}) || a.grant != "" || keyboard.grant != "" || m.owner != nil {
		t.Fatal("source replacement retained a gamepad or keyboard grant")
	}
	data, _ := json.Marshal(s.State())
	if strings.Contains(string(data), "gamepad") || strings.Contains(string(data), "device") {
		t.Fatal("default Host state added gamepad fields to the published baseline")
	}
	m.Close()
	if !pads.closed {
		t.Fatal("Manager retirement did not close its gamepad backend")
	}
}

func TestCoPlayGamepadAdmissionAndFailure(t *testing.T) {
	sink := &recordedInput{events: make(chan inputEvent, 16), resets: make(chan struct{}, 16), focused: true}
	pads := &recordedGamepads{capacity: 5}
	m := &Manager{sink: sink, gamepads: pads, connections: map[endpointKey]*connection{}}
	s, players := coPlaySession(t, m, true, true, true, true, true, true, false)
	if err := setTestPolicy(s, "ask", ""); err != nil {
		t.Fatal(err)
	}
	a := players[0]
	sendTestInput(m, a, inputEvent{Type: "request", Device: "gamepad"})
	if !a.requested || a.pad != nil || s.State().Requests[0].Device != "gamepad" {
		t.Fatal("pending request created a device or lost its input kind")
	}
	pads.openErr = errors.New("no driver slot")
	for len(s.changed) > 0 {
		<-s.changed
	}
	if s.Decide(a.requestID, true) == nil || a.requested || a.grant != "" || len(s.State().Requests) != 0 || len(s.changed) == 0 {
		t.Fatal("failed device creation retained approval or omitted the Host notification")
	}
	pads.openErr = nil
	if err := setTestPolicy(s, "room", ""); err != nil {
		t.Fatal(err)
	}
	for _, c := range players[:6] {
		sendTestInput(m, c, inputEvent{Type: "request", Device: "gamepad"})
	}
	if len(pads.devices) != 5 || players[5].grant != "" || players[5].requested {
		t.Fatal("remote gamepad capacity was exceeded or a failed request retained authority")
	}
	legacy := players[6]
	sendTestInput(m, legacy, inputEvent{Type: "request", Device: "gamepad"})
	if legacy.grant != "" || len(pads.devices) != 5 {
		t.Fatal("legacy Guest acquired an unnegotiated gamepad")
	}
	sendTestInput(m, players[5], inputEvent{Type: "request", Device: "other"})
	if players[5].grant != "" {
		t.Fatal("unknown input-device kind acquired a grant")
	}
	sendTestInput(m, players[5], inputEvent{Type: "request"})
	if players[5].grant == "" {
		t.Fatal("full gamepad capacity blocked keyboard input")
	}
	_, other := coPlaySession(t, m, true)
	sendTestInput(m, other[0], inputEvent{Type: "request", Device: "gamepad"})
	if other[0].grant != "" || m.owner != s {
		t.Fatal("another source acquired a gamepad while the desktop was owned")
	}
	m.Revoke()
	for _, pad := range pads.devices {
		if !pad.closed || pad.state != (gamepadReport{}) {
			t.Fatal("Host panic stop retained a virtual gamepad")
		}
	}
	if m.owner != nil {
		t.Fatal("Host panic stop retained an input owner")
	}
}

func sendTestInput(m *Manager, c *connection, event inputEvent) {
	if event.Type == "request" && event.Intent == "" {
		event.Intent = strings.Repeat("f", 32)
	}
	if event.Grant == "" {
		event.Grant = c.grant
	}
	data, _ := json.Marshal(event)
	m.receive(c, webrtc.DataChannelMessage{IsString: true, Data: data}, c.epoch)
}

func TestCoPlaySharedKeyboardAndMouse(t *testing.T) {
	sink := &recordedInput{events: make(chan inputEvent, 64), resets: make(chan struct{}, 16), focused: true}
	m := &Manager{sink: sink, connections: map[endpointKey]*connection{}}
	s, players := coPlaySession(t, m, true, true)
	a, b := players[0], players[1]
	for _, c := range players {
		sendTestInput(m, c, inputEvent{Type: "request"})
	}
	if a.grant == "" || b.grant == "" || m.owner != s || len(s.State().Requests) != 2 {
		t.Fatal("co-play did not admit both players")
	}
	for _, c := range players {
		sendTestInput(m, c, inputEvent{Type: "key", Code: "KeyA", Down: true})
		sendTestInput(m, c, inputEvent{Type: "key", Code: "KeyA", Down: true})
		sendTestInput(m, c, inputEvent{Type: "button", Button: 0, Down: true})
		sendTestInput(m, c, inputEvent{Type: "button", Button: 0, Down: true})
	}
	if len(sink.events) != 2 {
		t.Fatal("shared held input was injected twice")
	}
	for len(sink.events) > 0 {
		<-sink.events
	}
	sendTestInput(m, a, inputEvent{Type: "key", Code: "KeyA"})
	sendTestInput(m, a, inputEvent{Type: "button", Button: 0})
	sendTestInput(m, b, inputEvent{Type: "text", Text: "hello"})
	if len(sink.events) != 0 || len(sink.resets) != 0 {
		t.Fatal("a player released another player's input or reset shared input through text")
	}
	for _, c := range players {
		sendTestInput(m, c, inputEvent{Type: "move", X: .5, Y: .5})
	}
	sendTestInput(m, b, inputEvent{Type: "relative", DX: 10, DY: -4})
	sendTestInput(m, a, inputEvent{Type: "wheel", Delta: 120})
	if len(sink.events) != 4 {
		t.Fatal("authorized players cannot share pointer movement and scrolling")
	}
	for len(sink.events) > 0 {
		<-sink.events
	}
	sendTestInput(m, a, inputEvent{Type: "key", Code: "KeyW", Down: true})
	sendTestInput(m, a, inputEvent{Type: "button", Button: 1, Down: true})
	for len(sink.events) > 0 {
		<-sink.events
	}
	if err := s.Decide(a.requestID, false); err != nil {
		t.Fatal(err)
	}
	if len(sink.events) != 2 {
		t.Fatal("personal revocation did not release only distinct held input")
	}
	for len(sink.events) > 0 {
		event := <-sink.events
		if event.Down || !(event.Type == "key" && event.Code == "KeyW" || event.Type == "button" && event.Button == 1) {
			t.Fatal("personal revocation changed a sibling's input")
		}
	}
	if b.grant == "" || !b.keys["KeyA"] || !b.buttons[0] || len(sink.resets) != 0 || s.mode != "room" {
		t.Fatal("revocation disrupted another player")
	}
	sendTestInput(m, b, inputEvent{Type: "reset"})
	if len(sink.events) != 2 {
		t.Fatal("final holder reset missed a key or mouse button")
	}
	for len(sink.events) > 0 {
		if (<-sink.events).Down {
			t.Fatal("reset pressed input")
		}
	}
	sendTestInput(m, b, inputEvent{Type: "key", Code: "KeyB", Down: true})
	<-sink.events
	m.Revoke()
	if b.grant != "" || m.owner != nil || len(sink.resets) != 1 || s.mode != "ask" {
		t.Fatal("Host stop left a player active")
	}
}

func TestCoPlayTextFollowsKeyboardGrants(t *testing.T) {
	sink := &recordedInput{events: make(chan inputEvent, 32), resets: make(chan struct{}, 16), focused: true}
	m := &Manager{sink: sink, gamepads: &recordedGamepads{}, connections: map[endpointKey]*connection{}}
	s, players := coPlaySession(t, m, true, true, true)
	a, b, pad := players[0], players[1], players[2]
	sendTestInput(m, a, inputEvent{Type: "request"})
	sendTestInput(m, pad, inputEvent{Type: "request", Device: "gamepad"})
	sendTestInput(m, a, inputEvent{Type: "key", Code: "ControlLeft", Down: true})
	<-sink.events
	sendTestInput(m, a, inputEvent{Type: "text", Text: "hello"})
	if (<-sink.events).Text != "hello" || len(a.keys) != 0 || len(sink.resets) != 1 || pad.grant == "" {
		t.Fatal("single keyboard text did not reset its own held input independently of a gamepad")
	}
	sendTestInput(m, b, inputEvent{Type: "request"})
	sendTestInput(m, b, inputEvent{Type: "key", Code: "KeyW", Down: true})
	<-sink.events
	sendTestInput(m, a, inputEvent{Type: "text", Text: "blocked"})
	if len(sink.events) != 0 || len(sink.resets) != 1 || !b.keys["KeyW"] {
		t.Fatal("text interrupted another keyboard player")
	}
	if err := s.Decide(b.requestID, false); err != nil {
		t.Fatal(err)
	}
	<-sink.events
	sendTestInput(m, a, inputEvent{Type: "text", Text: "restored"})
	if (<-sink.events).Text != "restored" || a.grant == "" || pad.grant == "" {
		t.Fatal("text did not resume after the other keyboard grant ended")
	}
}

func TestCoPlayRetirementAndLegacyAdmission(t *testing.T) {
	sink := &recordedInput{events: make(chan inputEvent, 64), resets: make(chan struct{}, 16), focused: true}
	m := &Manager{sink: sink, connections: map[endpointKey]*connection{}}
	s, players := coPlaySession(t, m, true, true, false)
	a, b, legacy := players[0], players[1], players[2]
	sendTestInput(m, legacy, inputEvent{Type: "request"})
	sendTestInput(m, a, inputEvent{Type: "request"})
	if legacy.grant == "" || a.grant != "" {
		t.Fatal("legacy client was admitted without exclusive full control")
	}
	sendTestInput(m, legacy, inputEvent{Type: "release", Intent: legacy.intent})
	for _, c := range []*connection{a, b} {
		sendTestInput(m, c, inputEvent{Type: "request"})
	}
	sendTestInput(m, legacy, inputEvent{Type: "request"})
	if a.grant == "" || b.grant == "" || legacy.grant != "" {
		t.Fatal("legacy guest entered a concurrent-input session")
	}
	other, others := coPlaySession(t, m, true)
	sendTestInput(m, others[0], inputEvent{Type: "request"})
	if others[0].grant != "" || other.Decide(a.requestID, false) == nil {
		t.Fatal("another native session acquired or changed the active desktop source")
	}
	for _, c := range []*connection{a, b} {
		sendTestInput(m, c, inputEvent{Type: "key", Code: "KeyA", Down: true})
	}
	<-sink.events
	s.RevokeEdge(a.edgeID)
	if a.grant != "" || b.grant == "" || len(sink.events) != 0 || m.owner != s {
		t.Fatal("one route loss released another player's held key")
	}
	sink.focused = false
	m.refreshActive()
	m.refreshActive()
	if !b.suspended || len(b.keys) != 0 || len(sink.resets) != 1 {
		t.Fatal("shared-input source did not suspend once")
	}
	sink.focused = true
	m.refreshActive()
	if b.suspended || len(sink.events) != 0 {
		t.Fatal("focus recovery replayed held keys")
	}
	sendTestInput(m, b, inputEvent{Type: "key", Code: "KeyB", Down: true})
	<-sink.events
	oldGrant := b.grant
	s.Pause(true)
	if b.grant != "" || len(sink.resets) != 2 {
		t.Fatal("pause retained co-play input")
	}
	s.Pause(false)
	sendTestInput(m, b, inputEvent{Type: "key", Code: "KeyC", Down: true, Grant: oldGrant})
	if len(sink.events) != 0 {
		t.Fatal("resume restored a stale grant")
	}
	sendTestInput(m, b, inputEvent{Type: "request"})
	s.SetTarget(nativecapture.CaptureTarget{Kind: "display", SourceID: "2"}, nil)
	if b.grant != "" || m.owner != nil || s.State().CoPlay || s.State().Mode != "off" {
		t.Fatal("source replacement inherited co-play authorization")
	}
	data, _ := json.Marshal(s.State())
	if strings.Contains(string(data), "coPlay") || strings.Contains(string(data), "pointer") {
		t.Fatal("default Host state added fields to the published baseline")
	}
}

// Exercise the consent/retirement owner over real SCTP channels. No OS input
// is injected by this test; the platform acceptance uses a dedicated window.
func TestAttendedGrantLifecycle(t *testing.T) {
	sink := &recordedInput{events: make(chan inputEvent, 20), resets: make(chan struct{}, 20), geometry: bounds{width: 1920, height: 1080}, focused: true}
	m := &Manager{sink: sink, connections: map[endpointKey]*connection{}}
	s := m.NewSession()
	s.SetTarget(nativecapture.CaptureTarget{Kind: "display", SourceID: "1"}, nil)
	if err := setTestPolicy(s, "ask", ""); err != nil {
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
	type observedState struct {
		peer, state  string
		capabilities []string
		coPlay       *bool
	}
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
				State        string   `json:"state"`
				Capabilities []string `json:"capabilities"`
				CoPlay       *bool    `json:"coPlay"`
			}
			if json.Unmarshal(plain, &value) == nil {
				states <- observedState{c.Label(), value.State, value.Capabilities, value.CoPlay}
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
	send := func(peer string, event inputEvent) {
		t.Helper()
		cipher := ciphers[peer]
		cipher.sent++
		header := make([]byte, 20)
		binary.BigEndian.PutUint64(header, cipher.sent)
		_, _ = rand.Read(header[8:])
		plain, _ := json.Marshal(event)
		epoch := bindings[peer].EndpointID
		data := cipher.aead.Seal(header, header[8:], plain, inputAAD(0, header[:8], epoch))
		packet, _ := json.Marshal(inputroute.Packet{ID: bindings[peer].EndpointID, Epoch: epoch, Data: base64.StdEncoding.EncodeToString(data)})
		if err := peers[peer].SendText(string(packet)); err != nil {
			t.Fatal(err)
		}
	}
	request := func(peer string) *connection {
		t.Helper()
		intent := make([]byte, 16)
		_, _ = rand.Read(intent)
		send(peer, inputEvent{Type: "request", Intent: hex.EncodeToString(intent)})
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
	other.SetTarget(nativecapture.CaptureTarget{Kind: "display", SourceID: "2"}, nil)
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
	s.SetTarget(nativecapture.CaptureTarget{}, nil)
	key(first, grant)
	if len(sink.events) != 2 || len(sink.resets) != 5 || s.available() {
		t.Fatal("source replacement kept input authority")
	}
	nextDisplay := bounds{left: 1920, width: 1280, height: 720}
	sink.geometry = nextDisplay
	s.SetTarget(nativecapture.CaptureTarget{Kind: "window", SourceID: "3"}, nil)
	if err := setTestPolicy(s, "ask", ""); err != nil {
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
	// Old strict readers get precisely the baseline until this exact Guest opts
	// into the extension, including when another Guest has already opted in.
	for len(states) > 0 {
		<-states
	}
	waitReply := func(peer string, extended bool) observedState {
		t.Helper()
		deadline := time.After(3 * time.Second)
		for {
			select {
			case state := <-states:
				if state.peer == peer && (state.coPlay != nil) == extended {
					return state
				}
			case <-deadline:
				t.Fatal("input state reply missing")
			}
		}
	}
	send("first", inputEvent{Type: "sync"})
	if state := waitReply("first", false); len(state.capabilities) != 0 {
		t.Fatal("baseline sync added unnegotiated fields")
	}
	send("first", inputEvent{Type: "capabilities"})
	if state := waitReply("first", true); *state.coPlay || len(state.capabilities) != 1 || state.capabilities[0] != "coPlay" {
		t.Fatal("extended Guest did not receive the explicit single-controller capability state")
	}
	send("second", inputEvent{Type: "sync"})
	if state := waitReply("second", false); len(state.capabilities) != 0 {
		t.Fatal("one Guest opted another Guest into the extension")
	}
	s.Close()
	key(first, nextGrant)
	if len(sink.events) != 4 || len(sink.resets) != 7 || len(s.State().Requests) != 0 || s.Decide(first.requestID, true) == nil {
		t.Fatal("source retirement kept a grant")
	}
}
