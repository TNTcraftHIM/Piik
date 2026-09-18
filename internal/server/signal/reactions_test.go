package signal

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
)

func TestReactionsStayWithinOptedInCurrentShare(t *testing.T) {
	clock := newClock(10_000)
	h := startHarness(t, harnessOptions{now: clock.now})
	host, viewer, legacy, outsider := openClient(t, h), openClient(t, h), openClient(t, h), openClient(t, h)
	hostAuth := authenticate(t, host, h.room, protocol.RoleHost, "reaction-host", 1, "", presenceOptions{})
	viewerAuth := authenticate(t, viewer, h.room, protocol.RoleViewer, "reaction-viewer", -1, "", presenceOptions{})
	authenticate(t, legacy, h.room, protocol.RoleViewer, "reaction-legacy", -1, "", presenceOptions{})
	otherRoom := h.createRoom(protocol.CodeEntryOpen, "")
	otherAuth := authenticate(t, outsider, otherRoom, protocol.RoleHost, "reaction-outsider", 1, "", presenceOptions{})
	for _, client := range []*testClient{host, viewer, outsider} {
		client.sendJSON(map[string]any{"type": "subscribe-reactions"})
		client.sendJSON(map[string]any{"type": "signaling-challenge", "sequence": 1})
		client.next("signaling-challenge-response") // The subscription has reached the server.
	}
	send := func(client *testClient, target string) {
		client.sendJSON(map[string]any{"type": "reaction", "targetPeerId": target, "prop": "tomato"})
	}
	assertNoReaction := func(client *testClient) {
		t.Helper()
		if message, ok := client.tryNext("reaction", 40*time.Millisecond); ok {
			t.Fatalf("unexpected reaction: %s", message.raw)
		}
	}
	send(viewer, hostAuth.PeerID)
	var event protocol.ServerReactionMessage
	if err := json.Unmarshal(host.next("reaction").raw, &event); err != nil {
		t.Fatal(err)
	}
	if event.FromPeerID != viewerAuth.PeerID || event.TargetPeerID != hostAuth.PeerID || event.Prop != "tomato" {
		t.Fatalf("wrong room authority: %+v", event)
	}
	var echoed protocol.ServerReactionMessage
	if err := json.Unmarshal(viewer.next("reaction").raw, &echoed); err != nil {
		t.Fatal(err)
	}
	if echoed.ID != event.ID {
		t.Fatal("recipients did not receive the same event")
	}
	assertNoReaction(legacy)
	assertNoReaction(outsider)
	send(viewer, hostAuth.PeerID) // Rate bound; no queued replay.
	assertNoReaction(host)
	clock.advance(1200)
	send(viewer, otherAuth.PeerID) // Cross-room targeting is never broadcast.
	assertNoReaction(host)
	assertNoReaction(outsider)
	send(legacy, hostAuth.PeerID) // Old/non-opted clients do not participate.
	assertNoReaction(host)
	send(viewer, hostAuth.PeerID)
	host.next("reaction")
	viewer.next("reaction")
	host.sendJSON(map[string]any{"type": "stop-sharing", "shareGeneration": hostAuth.ShareGeneration})
	viewer.next("sharing-stopped")
	clock.advance(1200)
	send(viewer, viewerAuth.PeerID)
	assertNoReaction(viewer)
	if viewer.isClosed() {
		t.Fatal("an expired effect terminated the viewer session")
	}
}

func TestReactionCommandDoesNotAcceptForgedActorOrUnknownProps(t *testing.T) {
	for _, raw := range []string{
		`{"type":"reaction","targetPeerId":"target-peer","prop":"tomato","fromPeerId":"forged-peer"}`,
		`{"type":"reaction","targetPeerId":"target-peer","prop":"upload"}`,
		`{"type":"reaction","targetPeerId":"target-peer"}`,
		`{"type":"subscribe-reactions","roomId":"1234"}`,
	} {
		if _, err := protocol.DecodeClientMessage([]byte(raw)); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}
