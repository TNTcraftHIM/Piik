package signal

import (
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
)

func subscribeControl(t *testing.T, client *testClient) protocol.RoomControlReadyMessage {
	t.Helper()
	client.sendJSON(map[string]any{"type": "subscribe-room-control"})
	message, err := protocol.DecodeServerMessage(client.next("room-control-ready").raw)
	if err != nil {
		t.Fatal(err)
	}
	return message.(protocol.RoomControlReadyMessage)
}
func nextControl(t *testing.T, client *testClient, matches func(protocol.RoomControlStateMessage) bool) protocol.RoomControlStateMessage {
	t.Helper()
	for {
		message, err := protocol.DecodeServerMessage(client.next("room-control-state").raw)
		if err != nil {
			t.Fatal(err)
		}
		state := message.(protocol.RoomControlStateMessage)
		if matches(state) {
			return state
		}
	}
}
func controlCommand(client *testClient, command map[string]any) {
	client.sendJSON(map[string]any{"type": "room-control-command", "command": command})
}

func TestRoomControlTransferAndSinglePublisherKeepRoomIdentity(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host, viewer, legacy := openClient(t, h), openClient(t, h), openClient(t, h)
	const first = "first_presentation_generation"
	a := authenticate(t, host, h.room, protocol.RoleHost, "original_owner_client", 1, first, presenceOptions{roomSession: true, viewerPresence: true, displayName: "Owner"})
	b := authenticate(t, viewer, h.room, protocol.RoleViewer, "next_presenter_client", 1, "", presenceOptions{viewerPresence: true, displayName: "Member"})
	authenticate(t, legacy, h.room, protocol.RoleViewer, "legacy_watching_client", 1, "", presenceOptions{})
	subscribeControl(t, host)
	member := subscribeControl(t, viewer)
	claim := func(previous, next string) {
		viewer.sendJSON(map[string]any{"type": "claim-presentation", "requestId": "presentation_request", "previousGeneration": previous, "shareGeneration": next, "qualitySettings": protocol.DefaultQualitySettings, "routePolicy": protocol.DefaultRoutePolicy})
	}
	claim(first, "unauthorized_generation")
	expectMatch(t, viewer.next("room-control-error").raw, `{"code":"not-allowed"}`)
	controlCommand(host, map[string]any{"action": "grant-sharing", "peerId": b.PeerID, "allowed": true})
	nextControl(t, viewer, func(state protocol.RoomControlStateMessage) bool {
		for _, m := range state.Members {
			if m.PeerID == b.PeerID {
				return m.SharingAllowed
			}
		}
		return false
	})
	// Leave a live voice graph in place while the video root changes.
	host.sendJSON(map[string]any{"type": "subscribe-room-voice", "bitrate": true})
	viewer.sendJSON(map[string]any{"type": "subscribe-room-voice", "bitrate": true})
	voiceCommand(host, map[string]any{"action": "join"})
	nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool { return state.Enabled })
	voiceCommand(viewer, map[string]any{"action": "join"})
	nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool {
		for _, m := range state.Members {
			if m.PeerID == b.PeerID {
				return m.Joined
			}
		}
		return false
	})
	claim(first, "member_presentation_generation")
	expectMatch(t, viewer.next("room-role-changed").raw, `{"state":{"role":"host"}}`)
	expectMatch(t, host.next("room-role-changed").raw, `{"state":{"role":"viewer"}}`)
	state := nextControl(t, host, func(state protocol.RoomControlStateMessage) bool {
		return state.PresenterPeerID != nil && *state.PresenterPeerID == b.PeerID
	})
	if state.OwnerPeerID == nil || *state.OwnerPeerID != a.PeerID {
		t.Fatal("sharing changed ownership")
	}
	viewer.sendJSON(map[string]any{"type": "abandon-room"})
	expectMatch(t, viewer.next("error").raw, `{"code":"FORBIDDEN"}`)
	controlCommand(viewer, map[string]any{"action": "grant-sharing", "peerId": a.PeerID, "allowed": false})
	viewer.next("room-control-error")
	controlCommand(host, map[string]any{"action": "transfer-owner", "peerId": b.PeerID})
	offerMessage, err := protocol.DecodeServerMessage(viewer.next("room-ownership-offer").raw)
	if err != nil {
		t.Fatal(err)
	}
	offer := offerMessage.(protocol.RoomOwnershipOfferMessage)
	controlCommand(viewer, map[string]any{"action": "accept-transfer", "offerId": offer.OfferID})
	nextControl(t, host, func(state protocol.RoomControlStateMessage) bool {
		return state.OwnerPeerID != nil && *state.OwnerPeerID == b.PeerID && state.Transfer == nil
	})
	h.locked(func() {
		if h.server.activeHostShareGeneration(h.room.RoomID) != "member_presentation_generation" {
			t.Fatal("ownership interrupted video")
		}
		voice := h.server.voices[h.room.RoomID]
		if !voice.enabled() || !voice.members[a.PeerID].joined || !voice.members[b.PeerID].joined {
			t.Fatal("handoff interrupted voice membership")
		}
		if h.server.store.IsRoomOwner(h.room.RoomID, a.PeerID, voice.members[a.PeerID].sessionID) {
			t.Fatal("old owner retained management rights")
		}
	})
	if _, ok := legacy.tryNext("room-control-state", 20*time.Millisecond); ok {
		t.Fatal("unrequested capability reached legacy client")
	}
	// Scoped member credentials retain the same participant and current media role.
	h.closeClient(viewer)
	viewer = openClient(t, h)
	viewer.sendJSON(map[string]any{"type": "authenticate-member", "protocol": protocol.SignalingProtocol, "roomId": h.room.RoomID, "token": member.Token,
		"clientId": "next_presenter_client", "displayName": "Member", "shareGeneration": "member_presentation_generation", "routePolicy": protocol.DefaultRoutePolicy})
	reconnected := parseAuthenticated(t, viewer.next("authenticated").raw)
	if reconnected.PeerID != b.PeerID {
		t.Fatal("handoff lost participant identity")
	}
}

func TestRevokingActivePresentationStopsCaptureAndRejectsRestart(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host, viewer := openClient(t, h), openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "grant_owner_client", 1, "original_generation", presenceOptions{roomSession: true})
	b := authenticate(t, viewer, h.room, protocol.RoleViewer, "grant_member_client", 1, "", presenceOptions{})
	subscribeControl(t, host)
	subscribeControl(t, viewer)
	controlCommand(host, map[string]any{"action": "grant-sharing", "peerId": b.PeerID, "allowed": true})
	nextControl(t, viewer, func(state protocol.RoomControlStateMessage) bool {
		for _, m := range state.Members {
			if m.PeerID == b.PeerID {
				return m.SharingAllowed
			}
		}
		return false
	})
	viewer.sendJSON(map[string]any{"type": "claim-presentation", "requestId": "claim_generation", "previousGeneration": "original_generation", "shareGeneration": "authorized_generation", "qualitySettings": protocol.DefaultQualitySettings, "routePolicy": protocol.DefaultRoutePolicy})
	viewer.next("room-role-changed")
	host.next("room-role-changed")
	controlCommand(host, map[string]any{"action": "grant-sharing", "peerId": b.PeerID, "allowed": false})
	expectMatch(t, viewer.next("presentation-revoked").raw, `{"shareGeneration":"authorized_generation"}`)
	viewer.sendJSON(map[string]any{"type": "start-sharing", "shareGeneration": "revoked_generation", "routePolicy": protocol.DefaultRoutePolicy})
	viewer.next("sharing-start-failed")
	h.locked(func() {
		if h.server.activeHostShareGeneration(h.room.RoomID) != "" {
			t.Fatal("revoked publication remained active")
		}
	})
	h.updateRoomAccess(protocol.RotateViewerGrantRequest{Action: "rotate-viewer-grant"})
	viewer.next("viewer-grant-revoked")
	expectCloseCode(t, viewer, 4004)
	expectMatch(t, host.next("room-role-changed").raw, `{"state":{"role":"host","shareGeneration":null}}`)
	h.locked(func() {
		owner, ok := h.server.store.GetConnectedOwner(h.room.RoomID)
		root, rooted := h.server.store.GetConnectedHost(h.room.RoomID)
		if !ok || !rooted || owner.PeerID != root.PeerID {
			t.Fatal("revoking the presenting invite left an unavailable root")
		}
	})

}

func TestRoomControlAdmissionSurvivesOwnershipTransfer(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host, viewer := openClient(t, h), openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "admission_owner_client", 1, "", presenceOptions{roomSession: true})
	member := authenticate(t, viewer, h.room, protocol.RoleViewer, "admission_member_client", 1, "", presenceOptions{})
	subscribeControl(t, host)
	subscribeControl(t, viewer)
	password := "room-password"
	h.updateRoomAccess(protocol.SetCodeEntryPolicyRequest{Action: "set-code-entry-policy", Policy: protocol.CodeEntryPrivate})
	h.updateRoomAccess(protocol.SetViewerPasswordRequest{Action: "set-viewer-password", Password: &password})
	nextControl(t, viewer, func(state protocol.RoomControlStateMessage) bool {
		return state.CodeEntryPolicy == protocol.CodeEntryPrivate && state.ViewerPasswordEnabled
	})
	controlCommand(host, map[string]any{"action": "transfer-owner", "peerId": member.PeerID})
	message, err := protocol.DecodeServerMessage(viewer.next("room-ownership-offer").raw)
	if err != nil {
		t.Fatal(err)
	}
	offer := message.(protocol.RoomOwnershipOfferMessage)
	controlCommand(viewer, map[string]any{"action": "accept-transfer", "offerId": offer.OfferID})
	state := nextControl(t, viewer, func(state protocol.RoomControlStateMessage) bool {
		return state.OwnerPeerID != nil && *state.OwnerPeerID == member.PeerID && state.Transfer == nil
	})
	if state.CodeEntryPolicy != protocol.CodeEntryPrivate || !state.ViewerPasswordEnabled {
		t.Fatal("new owner did not receive current admission settings")
	}
	for _, request := range []protocol.RoomAccessUpdateRequest{
		protocol.SetCodeEntryPolicyRequest{Action: "set-code-entry-policy", Policy: protocol.CodeEntryOpen},
		protocol.SetViewerPasswordRequest{Action: "set-viewer-password", Password: nil},
	} {
		if _, err := h.server.UpdateRoomAccess(h.room.RoomID, offer.Token, request); err != nil {
			t.Fatal(err)
		}
	}
	nextControl(t, viewer, func(state protocol.RoomControlStateMessage) bool {
		return state.CodeEntryPolicy == protocol.CodeEntryOpen && !state.ViewerPasswordEnabled
	})
}
