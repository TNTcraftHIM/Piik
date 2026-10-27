package remoteinput

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/TNTcraftHIM/Piik/internal/diagnostics"
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
	targetErr error
	applyErr  error
	resetErr  error
}

func receiveTestInput(m *Manager, c *connection, plain []byte) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.receiveLocked(c, plain)
}

func revokeTestEdge(s *Session, edgeID string) {
	s.manager.mu.Lock()
	defer s.manager.mu.Unlock()
	s.revokeEdgeLocked(edgeID)
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
		header := make([]byte, 20)
		binary.BigEndian.PutUint64(header, c.cipher.received+1)
		_, _ = rand.Read(header[8:])
		data = c.cipher.aead.Seal(header, header[8:], data, inputAAD(0, header[:8], c.epoch))
		s.receivePacket(c.edgeID, inputroute.Packet{ID: c.id, Epoch: c.epoch, Data: base64.StdEncoding.EncodeToString(data)}, nil)
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
	revokeTestEdge(s, "root-edge")
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
	receiveTestInput(m, first, []byte(`{"type":"key","code":"KeyA","down":true,"grant":"`+oldGrant+`"}`))
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
	receiveTestInput(m, first, []byte(`{"type":"key","code":"KeyA","down":true,"grant":"`+revokedGrant+`"}`))
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
		s.receivePacket("same-root-relay", inputroute.Packet{ID: peer.EndpointID, Epoch: epoch, Data: base64.StdEncoding.EncodeToString(data)}, nil)
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
	s.receivePacket("same-root-relay", inputroute.Packet{ID: peer.EndpointID, Epoch: oldEpoch, Closed: true}, nil)
	if m.owner == nil || m.connections[endpointKey{s, peer.EndpointID}].grant != newGrant {
		t.Fatal("old descendant closure retired the new grant")
	}
	s.receivePacket("same-root-relay", inputroute.Packet{ID: peer.EndpointID, Epoch: newEpoch, Closed: true}, nil)
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
	return s.geometry, s.focused, s.targetErr
}

func (s *recordedInput) Apply(target bounds, event inputEvent) error {
	if s.applyErr != nil {
		return s.applyErr
	}
	s.target = target
	s.events <- event
	return nil
}
func (s *recordedInput) Reset() error {
	if s.resets != nil {
		s.resets <- struct{}{}
	}
	return s.resetErr
}

func TestInputFailureDiagnosticsPreserveExecutionAuthority(t *testing.T) {
	for _, stage := range []string{"target", "apply"} {
		t.Run(stage, func(t *testing.T) {
			var logs bytes.Buffer
			previous := slog.Default()
			slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
			t.Cleanup(func() { slog.SetDefault(previous) })
			sink := &recordedInput{events: make(chan inputEvent, 8), resets: make(chan struct{}, 8), focused: true}
			m := &Manager{sink: sink, connections: map[endpointKey]*connection{}}
			_, peers := coPlaySession(t, m, true)
			c := peers[0]
			sendTestInput(m, c, inputEvent{Type: "request", Intent: strings.Repeat("f", 32)})
			grant := c.grant
			if grant == "" {
				t.Fatal("control was not granted")
			}
			sendTestInput(m, c, inputEvent{Type: "key", Code: "KeyA", Down: true, Grant: grant})
			failure := errors.New("platform input failed")
			if stage == "target" {
				sink.targetErr = failure
			} else {
				sink.applyErr = failure
			}
			sendTestInput(m, c, inputEvent{Type: "text", Text: "private committed text", Grant: grant})
			if stage == "target" {
				if m.owner != nil || c.grant != "" || len(c.keys) != 0 {
					t.Fatal("invalid target retained authority")
				}
			} else if m.owner == nil || c.grant != grant || !c.inputFailed {
				t.Fatal("execution failure retired authorization or hid failure")
			}
			var record map[string]any
			if err := json.Unmarshal(logs.Bytes(), &record); err != nil {
				t.Fatalf("expected one failure record: %v", err)
			}
			if record["event"] != stage+"-failed" || record["connectionId"] != diagnostics.ID(c.edgeID) || record["inputGeneration"] != diagnostics.ID(c.epoch) {
				t.Fatalf("failure stage or generation missing: %v", record)
			}
			if stage == "apply" {
				if record["operation"] != "text" || record["sourceKind"] != c.owner.target.Kind {
					t.Fatal("failure lost its operation or target kind")
				}
				if _, ok := record["targetReady"].(bool); !ok {
					t.Fatal("failure lost its target observation")
				}
			}
			for _, private := range []string{grant, c.intent, c.edgeID, c.epoch, "KeyA", "private committed text"} {
				if strings.Contains(logs.String(), private) {
					t.Fatal("failure diagnostic recorded private input or authority")
				}
			}
		})
	}
}

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
	if state := s.State(); state.Simultaneous == nil || *state.Simultaneous {
		t.Fatal("new source enabled concurrent control by default")
	}
	if err := s.SetSimultaneous(true); err != nil {
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
	for _, c := range players {
		sendTestInput(m, c, inputEvent{Type: "request"})
	}
	if a.grant == "" || b.grant == "" || keyboard.grant == "" || len(pads.devices) != 0 {
		t.Fatal("one permission did not grant input without allocating gamepads")
	}
	reportA := gamepadReport{Buttons: 0x1000, LeftX: 12000}
	reportB := gamepadReport{Buttons: 0x2000, RightTrigger: 190}
	sendTestInput(m, a, inputEvent{Type: "gamepad-reset"})
	if len(pads.devices) != 0 {
		t.Fatal("reset allocated a gamepad")
	}
	sendTestInput(m, a, inputEvent{Type: "gamepad", Gamepad: &reportA})
	sendTestInput(m, b, inputEvent{Type: "gamepad", Gamepad: &reportB})
	first, second := pads.devices[0], pads.devices[1]
	if first.state != reportA || second.state != reportB {
		t.Fatal("gamepad reports crossed grant ownership")
	}
	for _, view := range s.State().Requests {
		if view.EndpointID == "" {
			t.Fatal("Host presentation lost the authenticated endpoint")
		}
	}
	sendTestInput(m, a, inputEvent{Type: "key", Code: "KeyA", Down: true})
	<-sink.events
	sendTestInput(m, a, inputEvent{Type: "gamepad-reset"})
	if first.state != (gamepadReport{}) || second.state != reportB || !a.keys["KeyA"] {
		t.Fatal("gamepad reset changed keys or another participant")
	}
	sendTestInput(m, a, inputEvent{Type: "gamepad", Gamepad: &reportA})
	sendTestInput(m, a, inputEvent{Type: "reset"})
	if first.state != (gamepadReport{}) || len(a.keys) != 0 {
		t.Fatal("whole input reset retained held input")
	}
	<-sink.events
	sink.focused = false
	m.refreshActive()
	if !a.suspended || !b.suspended || !keyboard.suspended || second.state != (gamepadReport{}) || first.closed || second.closed {
		t.Fatal("focus loss did not neutralize all input")
	}
	sendTestInput(m, b, inputEvent{Type: "gamepad", Gamepad: &reportB})
	if second.state != (gamepadReport{}) {
		t.Fatal("unfocused source accepted gamepad input")
	}
	sink.focused = true
	sendTestInput(m, b, inputEvent{Type: "gamepad", Gamepad: &reportB})
	if a.pad != first || b.pad != second || len(pads.devices) != 2 {
		t.Fatal("focus recovery replaced a player's virtual device")
	}
	sendTestInput(m, keyboard, inputEvent{Type: "key", Code: "KeyB", Down: true})
	<-sink.events
	s.receivePacket(a.edgeID, inputroute.Packet{ID: a.id, Epoch: a.epoch, Closed: true}, nil)
	if !first.closed || a.grant != "" || b.grant == "" || !keyboard.keys["KeyB"] {
		t.Fatal("one route loss affected another participant")
	}
	second.updateErr = errors.New("driver write failed")
	sendTestInput(m, b, inputEvent{Type: "gamepad", Gamepad: &reportB})
	if !second.closed || b.pad != nil || b.grant == "" || !b.padFailed || !keyboard.keys["KeyB"] {
		t.Fatal("gamepad failure changed healthy input authorization")
	}
	sendTestInput(m, b, inputEvent{Type: "gamepad", Gamepad: &reportB})
	if len(pads.devices) != 2 {
		t.Fatal("failed gamepad retried allocation")
	}
	sendTestInput(m, b, inputEvent{Type: "key", Code: "KeyC", Down: true})
	<-sink.events
	if !b.keys["KeyC"] {
		t.Fatal("gamepad failure disabled keyboard input")
	}
	a.edgeID = "replacement-edge"
	sendTestInput(m, a, inputEvent{Type: "request"})
	sendTestInput(m, a, inputEvent{Type: "gamepad", Gamepad: &reportA})
	third := pads.devices[2]
	s.SetTarget(nativecapture.CaptureTarget{Kind: "display", SourceID: "2"}, nil)
	if !third.closed || third.state != (gamepadReport{}) || a.grant != "" || keyboard.grant != "" || m.owner != nil {
		t.Fatal("source replacement retained input")
	}
	data, _ := json.Marshal(s.State())
	if strings.Contains(string(data), "gamepad") || strings.Contains(string(data), "device") {
		t.Fatal("baseline state gained extension fields")
	}
	m.Close()
	if !pads.closed {
		t.Fatal("Manager did not close gamepad backend")
	}
}

func TestGamepadStopReleasesOnlyItsDeviceAndSlot(t *testing.T) {
	sink := &recordedInput{events: make(chan inputEvent, 8), resets: make(chan struct{}, 8), focused: true}
	pads := &recordedGamepads{capacity: 1}
	m := &Manager{sink: sink, gamepads: pads, connections: map[endpointKey]*connection{}}
	_, players := coPlaySession(t, m, true, true)
	a, b := players[0], players[1]
	for _, c := range players {
		sendTestInput(m, c, inputEvent{Type: "request"})
	}
	report := gamepadReport{Buttons: 1}
	sendTestInput(m, a, inputEvent{Type: "key", Code: "KeyA", Down: true})
	sendTestInput(m, a, inputEvent{Type: "gamepad", Gamepad: &report})
	first := a.pad.(*recordedGamepad)
	sendTestInput(m, a, inputEvent{Type: "gamepad-reset"})
	if first.closed || first.state != (gamepadReport{}) {
		t.Fatal("focus reset retired the game-assigned device")
	}
	sendTestInput(m, a, inputEvent{Type: "gamepad-stop"})
	if !first.closed || a.pad != nil || a.grant == "" || !a.keys["KeyA"] || b.grant == "" {
		t.Fatal("device stop retained the device or retired keyboard authorization")
	}
	sendTestInput(m, b, inputEvent{Type: "gamepad", Gamepad: &report})
	if b.pad == nil || b.padFailed {
		t.Fatal("device stop did not free the backend slot for another participant")
	}
	sendTestInput(m, b, inputEvent{Type: "gamepad-stop"})
	sendTestInput(m, a, inputEvent{Type: "gamepad", Gamepad: &report})
	if a.pad == nil || a.pad == first || a.padFailed {
		t.Fatal("reconnected device did not reuse its existing grant")
	}
	m.Close()
}

func TestCoPlayGamepadAdmissionAndFailure(t *testing.T) {
	sink := &recordedInput{events: make(chan inputEvent, 32), resets: make(chan struct{}, 16), focused: true}
	pads := &recordedGamepads{capacity: 1}
	m := &Manager{sink: sink, gamepads: pads, connections: map[endpointKey]*connection{}}
	s, players := coPlaySession(t, m, true, true, false)
	if err := setTestPolicy(s, "ask", ""); err != nil {
		t.Fatal(err)
	}
	a, b, legacy := players[0], players[1], players[2]
	sendTestInput(m, a, inputEvent{Type: "request"})
	if !a.requested || a.pad != nil {
		t.Fatal("pending permission allocated a pad")
	}
	pads.openErr = errors.New("no driver slot")
	if err := s.Decide(a.requestID, true); err != nil {
		t.Fatal(err)
	}
	report := gamepadReport{Buttons: 1}
	sendTestInput(m, a, inputEvent{Type: "gamepad", Gamepad: &report})
	if a.grant == "" || !a.padFailed || a.pad != nil {
		t.Fatal("pad allocation failure revoked ordinary permission")
	}
	pads.openErr = nil
	sendTestInput(m, a, inputEvent{Type: "gamepad", Gamepad: &report})
	if len(pads.devices) != 0 {
		t.Fatal("failed grant retried gamepad allocation")
	}
	sendTestInput(m, a, inputEvent{Type: "release", Intent: a.intent})
	sendTestInput(m, a, inputEvent{Type: "request"})
	if err := s.Decide(a.requestID, true); err != nil {
		t.Fatal(err)
	}
	sendTestInput(m, a, inputEvent{Type: "gamepad", Gamepad: &report})
	if a.pad == nil || a.padFailed {
		t.Fatal("fresh grant did not reset gamepad failure")
	}
	sendTestInput(m, b, inputEvent{Type: "request"})
	if err := s.Decide(b.requestID, true); err != nil {
		t.Fatal(err)
	}
	sendTestInput(m, b, inputEvent{Type: "gamepad", Gamepad: &report})
	if b.grant == "" || !b.padFailed || len(pads.devices) != 1 {
		t.Fatal("capacity failure revoked keyboard authorization")
	}
	sendTestInput(m, b, inputEvent{Type: "key", Code: "KeyA", Down: true})
	<-sink.events
	m.release()
	sendTestInput(m, legacy, inputEvent{Type: "request"})
	if err := s.Decide(legacy.requestID, true); err != nil {
		t.Fatal(err)
	}
	sendTestInput(m, legacy, inputEvent{Type: "gamepad", Gamepad: &report})
	if legacy.pad != nil || legacy.grant == "" {
		t.Fatal("legacy input gained gamepad support or lost its baseline grant")
	}
	m.Revoke()
	for _, pad := range pads.devices {
		if !pad.closed || pad.state != (gamepadReport{}) {
			t.Fatal("panic stop retained gamepad input")
		}
	}
}

type blockedGamepadCreation struct {
	started chan struct{}
	finish  chan struct{}
	pad     *recordedGamepad
	opens   atomic.Int32
}

func (b *blockedGamepadCreation) Open() (gamepadDevice, error) {
	b.opens.Add(1)
	b.started <- struct{}{}
	<-b.finish
	return b.pad, nil
}

func (b *blockedGamepadCreation) Close() error { return nil }

func TestGamepadCreationDoesNotBlockCurrentInputOrRevocation(t *testing.T) {
	sink := &recordedInput{events: make(chan inputEvent, 16), resets: make(chan struct{}, 16), focused: true}
	backend := &blockedGamepadCreation{started: make(chan struct{}, 4), finish: make(chan struct{}), pad: &recordedGamepad{}}
	m := &Manager{sink: sink, gamepads: backend, connections: map[endpointKey]*connection{}}
	s, players := coPlaySession(t, m, true, true)
	a, b := players[0], players[1]
	for _, c := range players {
		sendTestInput(m, c, inputEvent{Type: "request"})
	}
	existing := &recordedGamepad{}
	a.pad = existing
	report := gamepadReport{Buttons: 1}
	push := func(c *connection) {
		m.mu.Lock()
		m.receiveGamepad(c, inputEvent{Type: "gamepad", Gamepad: &report})
		m.mu.Unlock()
	}
	push(b)
	select {
	case <-backend.started:
	case <-time.After(time.Second):
		t.Fatal("creation did not start")
	}
	defer func() {
		select {
		case <-backend.finish:
		default:
			close(backend.finish)
		}
	}()
	for range 32 {
		push(b)
	}
	progress := make(chan struct{})
	go func() {
		push(a)
		sendTestInput(m, a, inputEvent{Type: "key", Code: "KeyA", Down: true})
		m.Revoke()
		close(progress)
	}()
	select {
	case <-progress:
	case <-time.After(time.Second):
		t.Fatal("enumeration blocked current pad, keyboard or control-stop")
	}
	if !existing.closed || existing.state != (gamepadReport{}) || a.grant != "" || b.grant != "" {
		t.Fatal("control-stop retained current input")
	}
	sendTestInput(m, b, inputEvent{Type: "request"})
	if err := s.Decide(b.requestID, true); err != nil {
		t.Fatal(err)
	}
	push(b)
	if backend.opens.Load() != 1 {
		t.Fatal("full reports or a replacement grant started parallel creation")
	}
	close(backend.finish)
	deadline := time.Now().Add(time.Second)
	for {
		m.mu.Lock()
		opening := m.gamepadOpening
		m.mu.Unlock()
		if !opening {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("stale creation did not retire")
		}
		time.Sleep(time.Millisecond)
	}
	if !backend.pad.closed || b.pad != nil || b.grant == "" || b.padFailed {
		t.Fatal("stale creation attached to or changed a replacement grant")
	}
}

func TestGamepadStopDiscardsPendingCreationWithoutRetiringGrant(t *testing.T) {
	sink := &recordedInput{events: make(chan inputEvent, 8), resets: make(chan struct{}, 8), focused: true}
	backend := &blockedGamepadCreation{started: make(chan struct{}, 1), finish: make(chan struct{}), pad: &recordedGamepad{}}
	m := &Manager{sink: sink, gamepads: backend, connections: map[endpointKey]*connection{}}
	_, players := coPlaySession(t, m, true)
	c := players[0]
	sendTestInput(m, c, inputEvent{Type: "request"})
	grant := c.grant
	report := gamepadReport{Buttons: 1}
	m.mu.Lock()
	m.receiveGamepad(c, inputEvent{Type: "gamepad", Gamepad: &report})
	m.mu.Unlock()
	select {
	case <-backend.started:
	case <-time.After(time.Second):
		t.Fatal("device enumeration did not start")
	}
	sendTestInput(m, c, inputEvent{Type: "gamepad-stop"})
	close(backend.finish)
	deadline := time.Now().Add(time.Second)
	for {
		m.mu.Lock()
		opening := m.gamepadOpening
		m.mu.Unlock()
		if !opening {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("stopped enumeration did not finish")
		}
		time.Sleep(time.Millisecond)
	}
	if !backend.pad.closed || c.pad != nil || c.grant != grant || c.padFailed {
		t.Fatal("late enumeration revived the stopped device or changed its keyboard grant")
	}
	// A subsequent full report can create a fresh device under the same grant.
	pads := &recordedGamepads{}
	m.gamepads = pads
	sendTestInput(m, c, inputEvent{Type: "gamepad", Gamepad: &report})
	if c.pad == nil || c.pad.(*recordedGamepad).state != report || c.grant != grant {
		t.Fatal("reconnection could not create a fresh device")
	}
	m.Close()
}

func sendTestInput(m *Manager, c *connection, event inputEvent) {
	if event.Type == "request" && event.Intent == "" {
		event.Intent = strings.Repeat("f", 32)
	}
	if event.Grant == "" {
		event.Grant = c.grant
	}
	data, _ := json.Marshal(event)
	receiveTestInput(m, c, data)
	if event.Type == "gamepad" {
		// Unit reports model the next periodic full report after lazy creation;
		// production deliberately drops the report that started enumeration.
		deadline := time.Now().Add(time.Second)
		for {
			m.mu.Lock()
			opening := m.gamepadOpening
			m.mu.Unlock()
			if !opening {
				break
			}
			if time.Now().After(deadline) {
				panic("gamepad creation did not finish")
			}
			time.Sleep(time.Millisecond)
		}
		receiveTestInput(m, c, data)
	}
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
		sendTestInput(m, c, inputEvent{Type: "button", Button: 0, Down: true})
		sendTestInput(m, c, inputEvent{Type: "button", Button: 0, Down: true})
	}
	if len(sink.events) != 2 {
		t.Fatal("shared held input was injected twice")
	}
	for len(sink.events) > 0 {
		<-sink.events
	}
	for _, c := range players {
		sendTestInput(m, c, inputEvent{Type: "key", Code: "KeyA", Down: true})
		if len(sink.events) != 1 {
			t.Fatal("an existing holder's keyboard repeat was suppressed")
		}
		if event := <-sink.events; event.Type != "key" || event.Code != "KeyA" || !event.Down {
			t.Fatal("an existing holder's keyboard repeat was suppressed")
		}
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

func TestSimultaneousControlPreservesAuthorizationAndResetsForNewSource(t *testing.T) {
	sink := &recordedInput{events: make(chan inputEvent, 64), resets: make(chan struct{}, 16), focused: true}
	m := &Manager{sink: sink, gamepads: &recordedGamepads{}, connections: map[endpointKey]*connection{}}
	s, players := coPlaySession(t, m, true, true)
	if err := setTestPolicy(s, "password", "source-password"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetSimultaneous(false); err != nil {
		t.Fatal(err)
	}
	for _, c := range players {
		s.passwordRetry = time.Time{}
		sendTestInput(m, c, inputEvent{Type: "request", Password: "source-password"})
	}
	if players[0].grant == "" || players[1].grant != "" {
		t.Fatal("single control admitted multiple participants")
	}
	if state := s.State(); !state.CoPlay || state.Gamepad == nil || !*state.Gamepad || state.Requests[0].EndpointID == "" {
		t.Fatal("single control hid extended capabilities or participation")
	}
	if err := s.SetSimultaneous(true); err != nil {
		t.Fatal(err)
	}
	if players[0].grant != "" || len(s.State().Requests) != 0 || s.mode != "password" {
		t.Fatal("setting change retained grants or changed authorization")
	}
	for _, c := range players {
		s.passwordRetry = time.Time{}
		sendTestInput(m, c, inputEvent{Type: "request", Password: "source-password"})
	}
	if players[0].grant == "" || players[1].grant == "" {
		t.Fatal("setting change lost password or failed to admit both participants")
	}
	if err := setTestPolicy(s, "ask", ""); err != nil {
		t.Fatal(err)
	}
	if !*s.State().Simultaneous {
		t.Fatal("ordinary authorization update reset source concurrency")
	}
	s.SetTarget(nativecapture.CaptureTarget{Kind: "display", SourceID: "next"}, nil)
	change, err := s.BeginPolicy(t.Context(), "room", "", true)
	if err != nil {
		t.Fatal(err)
	}
	defer change.Close()
	if err := change.Apply(); err != nil {
		t.Fatal(err)
	}
	if *s.State().Simultaneous || !s.State().CoPlay {
		t.Fatal("new source inherited concurrency or lost negotiated support")
	}
	if err := setTestPolicy(s, "ask", ""); err != nil {
		t.Fatal(err)
	}
	for _, c := range players {
		sendTestInput(m, c, inputEvent{Type: "request"})
	}
	if err := s.Decide(players[0].requestID, true); err != nil {
		t.Fatal(err)
	}
	sendTestInput(m, players[0], inputEvent{Type: "key", Code: "KeyA", Down: true})
	<-sink.events
	if err := s.Decide(players[1].requestID, true); err != nil {
		t.Fatal(err)
	}
	if players[0].grant != "" || players[1].grant == "" || m.owner != s || len(players[0].keys) != 0 {
		t.Fatal("explicit Host approval did not hand over exclusive input")
	}
	other, otherPlayers := coPlaySession(t, m, true)
	if err := setTestPolicy(other, "ask", ""); err != nil {
		t.Fatal(err)
	}
	if err := other.SetSimultaneous(false); err != nil {
		t.Fatal(err)
	}
	sendTestInput(m, otherPlayers[0], inputEvent{Type: "request"})
	if err := other.Decide(otherPlayers[0].requestID, true); err == nil || players[1].grant == "" || m.owner != s {
		t.Fatal("explicit approval displaced another source")
	}
}

func TestCoPlayTextFollowsKeyboardGrants(t *testing.T) {
	sink := &recordedInput{events: make(chan inputEvent, 32), resets: make(chan struct{}, 16), focused: true}
	m := &Manager{sink: sink, gamepads: &recordedGamepads{}, connections: map[endpointKey]*connection{}}
	s, players := coPlaySession(t, m, true, true)
	a, b := players[0], players[1]
	sendTestInput(m, a, inputEvent{Type: "request"})
	sendTestInput(m, a, inputEvent{Type: "gamepad", Gamepad: &gamepadReport{Buttons: 1}})
	sendTestInput(m, a, inputEvent{Type: "key", Code: "ControlLeft", Down: true})
	<-sink.events
	sendTestInput(m, a, inputEvent{Type: "text", Text: "hello"})
	if (<-sink.events).Text != "hello" || len(a.keys) != 0 || len(sink.resets) != 1 || a.pad == nil {
		t.Fatal("single participant text did not reset its own held keyboard input")
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
	if (<-sink.events).Text != "restored" || a.grant == "" || a.pad == nil {
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
	revokeTestEdge(s, a.edgeID)
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
		grant        string
		inputFailed  *bool
	}
	states := make(chan observedState, 128)
	bindings := map[string]protocol.RemoteInputPeer{}
	ciphers := map[string]*inputCipher{}
	epochs := map[string]string{}
	for _, name := range []string{"first", "second"} {
		id, key := make([]byte, 16), make([]byte, 32)
		_, _ = rand.Read(id)
		_, _ = rand.Read(key)
		bindings[name] = protocol.RemoteInputPeer{PeerID: name + "-viewer", EndpointID: hex.EncodeToString(id), Secret: hex.EncodeToString(key)}
		ciphers[name], _ = newInputCipher(bindings[name].Secret)
		epochs[name] = bindings[name].EndpointID
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
				Grant        string   `json:"grant"`
				InputFailed  *bool    `json:"inputFailed"`
			}
			if json.Unmarshal(plain, &value) == nil {
				states <- observedState{c.Label(), value.State, value.Capabilities, value.CoPlay, value.Grant, value.InputFailed}
			}
		})
		c.OnOpen(func() { channels <- c })
	})
	losses := map[string]func(){}
	for _, id := range []string{"first", "second"} {
		c, err := host.CreateDataChannel(id, nil)
		if err != nil {
			t.Fatal(err)
		}
		losses[id] = s.Attach(id, c)
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
		epoch := epochs[peer]
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
		receiveTestInput(m, c, []byte(`{"type":"key","code":"KeyA","down":true,"grant":"`+grant+`"}`))
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
	losses["second"]()
	key(second, grant2)
	if len(sink.events) != 2 || len(sink.resets) != 3 {
		t.Fatal("disconnect kept a grant")
	}
	// ICE may recover on the same channel. It must accept a fresh request,
	// without reviving the old grant or a pending approval from before loss.
	second = request("second")
	staleRequest := second.requestID
	losses["second"]()
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
	receiveTestInput(m, first, []byte(`{"type":"release","intent":"`+oldIntent+`"}`))
	first = request("first")
	if s.Decide(oldRequest, true) == nil {
		t.Fatal("late approval authorized a replacement request")
	}
	nextGrant := decide(first, true)
	receiveTestInput(m, first, []byte(`{"type":"release","intent":"`+oldIntent+`"}`))
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
	if state := waitReply("first", true); *state.coPlay || len(state.capabilities) != 2 || state.capabilities[0] != "coPlay" || state.capabilities[1] != "inputFeedback" {
		t.Fatal("extended Guest did not receive the explicit single-controller capability state")
	}
	send("second", inputEvent{Type: "sync"})
	if state := waitReply("second", false); len(state.capabilities) != 0 {
		t.Fatal("one Guest opted another Guest into the extension")
	}
	// The old capabilities command does not opt a strict reader into new keys.
	m.mu.Lock()
	sink.applyErr = errors.New("execution temporarily refused")
	m.mu.Unlock()
	send("first", inputEvent{Type: "move", X: .4, Y: .3, Grant: nextGrant})
	wait(func() bool { return first.inputFailed })
	if state := waitReply("first", true); state.inputFailed != nil || state.grant != nextGrant || state.state != "active" {
		t.Fatal("legacy feedback changed JSON shape or retired its grant")
	}
	send("first", inputEvent{Type: "capabilities", InputFeedback: true})
	if state := waitReply("first", true); state.inputFailed == nil || !*state.inputFailed || state.grant != nextGrant {
		t.Fatal("explicit feedback opt-in did not report retained-grant failure")
	}
	m.mu.Lock()
	sink.applyErr = nil
	m.mu.Unlock()
	send("first", inputEvent{Type: "move", X: .2, Y: .3, Grant: nextGrant})
	wait(func() bool { return !first.inputFailed })
	if state := waitReply("first", true); state.inputFailed != nil || state.grant != nextGrant || state.state != "active" {
		t.Fatal("fresh input did not clear failure within the same grant")
	}
	// Replacing this endpoint's live epoch retires its opt-in along with its grant.
	epochs["first"] = strings.Repeat("a", 32)
	send("first", inputEvent{Type: "sync"})
	if state := waitReply("first", false); state.inputFailed != nil || state.grant != "" {
		t.Fatal("new epoch inherited grant or feedback fields")
	}
	first = request("first")
	nextGrant = decide(first, true)
	// Consume the active baseline reply before checking a later failure reply.
	for state := waitReply("first", false); state.state != "active"; state = waitReply("first", false) {
	}
	m.mu.Lock()
	sink.applyErr = errors.New("new epoch execution refused")
	m.mu.Unlock()
	send("first", inputEvent{Type: "move", X: .4, Y: .3, Grant: nextGrant})
	wait(func() bool { return first.inputFailed })
	if state := waitReply("first", false); state.inputFailed != nil || state.grant != nextGrant || state.state != "active" {
		t.Fatal("new legacy epoch received an unnegotiated feedback field")
	}
	m.mu.Lock()
	sink.applyErr = nil
	m.mu.Unlock()
	beforeCloseEvents, beforeCloseResets := len(sink.events), len(sink.resets)
	s.Close()
	key(first, nextGrant)
	if len(sink.events) != beforeCloseEvents || len(sink.resets) != beforeCloseResets+1 || len(s.State().Requests) != 0 || s.Decide(first.requestID, true) == nil {
		t.Fatal("source retirement kept a grant")
	}
}

func TestLateOldEpochCannotHideRelayedGrantFromBranchLoss(t *testing.T) {
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
	observed := make(chan inputroute.Packet, 10)
	s.route.Close()
	s.route = inputroute.New(func(edge string, p inputroute.Packet, current func() bool) {
		s.receivePacket(edge, p, current)
		observed <- p
	})
	rootChannel, relayUp := inputChannelPair(t)
	s.Attach("sfu-root", rootChannel)
	relay := inputroute.New(nil)
	t.Cleanup(relay.Close)
	relay.AttachUp(relayUp)
	viewer, branch := inputChannelPair(t)
	ready := make(chan struct{}, 10)
	viewer.OnMessage(func(message webrtc.DataChannelMessage) {
		var p inputroute.Packet
		if json.Unmarshal(message.Data, &p) == nil && p.Ready != nil && *p.Ready {
			ready <- struct{}{}
		}
	})
	loseBranch := relay.AttachDown("shared-branch", branch)
	relay.SetUpAvailable(true)
	select {
	case <-ready:
	case <-time.After(3 * time.Second):
		t.Fatal("relay not ready")
	}
	cipher, _ := newInputCipher(peer.Secret)
	encode := func(seq uint64, epoch string, event inputEvent) inputroute.Packet {
		header := make([]byte, 20)
		binary.BigEndian.PutUint64(header, seq)
		_, _ = rand.Read(header[8:])
		plain, _ := json.Marshal(event)
		data := cipher.aead.Seal(header, header[8:], plain, inputAAD(0, header[:8], epoch))
		return inputroute.Packet{ID: peer.EndpointID, Epoch: epoch, Data: base64.StdEncoding.EncodeToString(data)}
	}
	sendPacket := func(p inputroute.Packet) {
		t.Helper()
		data, _ := json.Marshal(p)
		if err := viewer.SendText(string(data)); err != nil {
			t.Fatal(err)
		}
		deadline := time.After(3 * time.Second)
		for {
			select {
			case got := <-observed:
				if got == p {
					return
				}
			case <-deadline:
				t.Fatal("packet did not reach actual manager")
			}
		}
	}
	approve := func() string {
		t.Helper()
		views := s.State().Requests
		if len(views) != 1 || views[0].State != "pending" {
			t.Fatalf("request state: %+v", views)
		}
		if err := s.Decide(views[0].ID, true); err != nil {
			t.Fatal(err)
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		return m.connections[endpointKey{s, peer.EndpointID}].grant
	}
	oldEpoch, newEpoch := strings.Repeat("c", 32), strings.Repeat("d", 32)
	sendPacket(encode(1, oldEpoch, inputEvent{Type: "request", Intent: oldEpoch}))
	oldGrant := approve()
	// Packet 2 was sent on the old longer branch before the route migrated.
	// The new shorter path overtakes it. Its lower sequence must be rejected.
	late := encode(2, oldEpoch, inputEvent{Type: "key", Code: "KeyA", Down: true, Grant: oldGrant})
	sendPacket(encode(3, newEpoch, inputEvent{Type: "request", Intent: newEpoch}))
	newGrant := approve()
	sendPacket(encode(4, newEpoch, inputEvent{Type: "key", Code: "KeyW", Down: true, Grant: newGrant}))
	sendPacket(late)
	m.mu.Lock()
	current := m.connections[endpointKey{s, peer.EndpointID}]
	if current.grant != newGrant || current.keys["KeyA"] || !current.keys["KeyW"] {
		m.mu.Unlock()
		t.Fatal("late old packet changed authority")
	}
	m.mu.Unlock()
	// The shared upstream branch then disconnects while the root SFU leg stays up.
	loseBranch()
	// On recovery, a sync is ordered behind all branch retirement packets. It
	// may report current availability but cannot restore the previous grant.
	sendPacket(encode(5, newEpoch, inputEvent{Type: "sync"}))
	m.mu.Lock()
	defer m.mu.Unlock()
	if current.grant != "" || current.keys["KeyW"] {
		t.Fatal("branch loss retained current grant and held key after a late old epoch")
	}
}

func waitInputChannel(t *testing.T, label string, ready func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if ready() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal(label)
}

func inputChannelPair(t *testing.T) (*webrtc.DataChannel, *webrtc.DataChannel) {
	t.Helper()
	settings := webrtc.SettingEngine{}
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	api := webrtc.NewAPI(webrtc.WithSettingEngine(settings))
	a, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Close() })
	b, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = b.Close() })
	remote := make(chan *webrtc.DataChannel, 1)
	b.OnDataChannel(func(c *webrtc.DataChannel) { remote <- c })
	local, err := a.CreateDataChannel(inputroute.Label, nil)
	if err != nil {
		t.Fatal(err)
	}
	offer, err := a.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gather := webrtc.GatheringCompletePromise(a)
	if err = a.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gather:
	case <-time.After(5 * time.Second):
		t.Fatal("offer gather")
	}
	if err = b.SetRemoteDescription(*a.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	answer, err := b.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gather = webrtc.GatheringCompletePromise(b)
	if err = b.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gather:
	case <-time.After(5 * time.Second):
		t.Fatal("answer gather")
	}
	if err = a.SetRemoteDescription(*b.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	var other *webrtc.DataChannel
	select {
	case other = <-remote:
	case <-time.After(5 * time.Second):
		t.Fatal("remote data channel")
	}
	waitInputChannel(t, "SCTP opens", func() bool {
		return local.ReadyState() == webrtc.DataChannelStateOpen && other.ReadyState() == webrtc.DataChannelStateOpen
	})
	return local, other
}

func TestInputRetirementOrdersAlreadyReadPackets(t *testing.T) {
	for _, retired := range []string{"channel", "ice", "explicit-close"} {
		t.Run(retired, func(t *testing.T) {
			sink := &recordedInput{events: make(chan inputEvent, 8), resets: make(chan struct{}, 8), focused: true}
			m := &Manager{sink: sink, connections: map[endpointKey]*connection{}}
			s := m.NewSession()
			t.Cleanup(s.Close)
			s.SetTarget(nativecapture.CaptureTarget{Kind: "display", SourceID: "1"}, nil)
			if err := setTestPolicy(s, "room", ""); err != nil {
				t.Fatal(err)
			}
			peer := protocol.RemoteInputPeer{PeerID: "viewer-route-test", EndpointID: strings.Repeat("a", 32), Secret: strings.Repeat("b", 64)}
			if err := s.SetPeers([]protocol.RemoteInputPeer{peer}); err != nil {
				t.Fatal(err)
			}
			var arm atomic.Bool
			entered, resume := make(chan struct{}), make(chan struct{})
			resumed := false
			defer func() {
				if !resumed {
					close(resume)
				}
			}()
			observed := make(chan inputroute.Packet, 8)
			s.route.Close()
			s.route = inputroute.New(func(edge string, p inputroute.Packet, current func() bool) {
				// This is the production handoff after Relay unlocks. Retirement
				// must invalidate the captured delivery before Manager accepts it.
				if (p.Data != "" || p.Closed) && arm.Swap(false) {
					close(entered)
					<-resume
				}
				s.receivePacket(edge, p, current)
				observed <- p
			})
			viewer, root := inputChannelPair(t)
			loseInput := s.Attach("root-edge", root)
			cipher, _ := newInputCipher(peer.Secret)
			epoch := strings.Repeat("c", 32)
			send := func(seq uint64, event inputEvent) {
				t.Helper()
				header := make([]byte, 20)
				binary.BigEndian.PutUint64(header, seq)
				_, _ = rand.Read(header[8:])
				plain, _ := json.Marshal(event)
				data := cipher.aead.Seal(header, header[8:], plain, inputAAD(0, header[:8], epoch))
				packet, _ := json.Marshal(inputroute.Packet{ID: peer.EndpointID, Epoch: epoch, Data: base64.StdEncoding.EncodeToString(data)})
				if err := viewer.SendText(string(packet)); err != nil {
					t.Fatal(err)
				}
			}
			waitData := func() {
				t.Helper()
				deadline := time.After(3 * time.Second)
				for {
					select {
					case p := <-observed:
						if p.Data != "" {
							return
						}
					case <-deadline:
						t.Fatal("input did not reach Manager")
					}
				}
			}
			initial := inputEvent{Type: "sync"}
			if retired == "explicit-close" {
				initial = inputEvent{Type: "request", Intent: strings.Repeat("d", 32)}
			}
			send(1, initial)
			waitData()
			arm.Store(true)
			if retired == "explicit-close" {
				if len(s.State().Requests) != 1 {
					t.Fatal("request was not approved")
				}
				data, _ := json.Marshal(inputroute.Packet{ID: peer.EndpointID, Epoch: epoch, Closed: true})
				if err := viewer.SendText(string(data)); err != nil {
					t.Fatal(err)
				}
			} else {
				send(2, inputEvent{Type: "request", Intent: strings.Repeat("d", 32)})
			}
			select {
			case <-entered:
			case <-time.After(3 * time.Second):
				t.Fatal("request was not read")
			}
			if retired != "ice" {
				if err := root.Close(); err != nil {
					t.Fatal(err)
				}
			} else {
				loseInput()
			}
			close(resume)
			resumed = true
			if retired == "explicit-close" {
				select {
				case <-observed:
				case <-time.After(3 * time.Second):
					t.Fatal("explicit retirement did not reach Manager")
				}
			} else {
				waitData()
			}
			if len(s.State().Requests) != 0 {
				t.Fatal("already-read packet retained or recreated authorization after retirement")
			}
			if retired == "ice" {
				send(3, inputEvent{Type: "request", Intent: strings.Repeat("e", 32)})
				waitData()
				views := s.State().Requests
				if len(views) != 1 || views[0].State != "active" {
					t.Fatalf("fresh request on recovered channel: %+v", views)
				}
			}
		})
	}
}
