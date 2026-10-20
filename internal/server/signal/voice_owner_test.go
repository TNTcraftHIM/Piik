package signal

import (
	"testing"

	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
)

func approvedVoiceOwnerRoom(t *testing.T) (*harness, *testClient, *testClient, authenticatedMessage, authenticatedMessage) {
	t.Helper()
	h := startHarness(t, harnessOptions{viewerDisconnectGraceMs: 30_000})
	host, viewer := openClient(t, h), openClient(t, h)
	hostID := authenticate(t, host, h.room, protocol.RoleHost, "owner_host_123456", -1, "", presenceOptions{roomSession: true, roomOnly: true})
	viewerID := authenticate(t, viewer, h.room, protocol.RoleViewer, "owner_viewer_123456", 1, "", presenceOptions{})
	for _, client := range []*testClient{host, viewer} {
		client.sendJSON(map[string]any{"type": "subscribe-room-voice"})
		nextVoiceState(t, client, nil)
	}
	voiceCommand(host, map[string]any{"action": "join"})
	voiceCommand(viewer, map[string]any{"action": "join"})
	nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool {
		for _, member := range state.Members {
			if member.PeerID == viewerID.PeerID {
				return member.Requested
			}
		}
		return false
	})
	voiceCommand(host, map[string]any{"action": "permission", "peerId": viewerID.PeerID, "listen": true, "speak": true})
	pending := nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool {
		return len(state.Connections) == 1 && state.Connections[0].Pending
	})
	for _, client := range []*testClient{host, viewer} {
		client.sendJSON(map[string]any{"type": "room-voice-transport", "connectionId": pending.Connections[0].ConnectionID, "state": "connected"})
	}
	nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool {
		return len(state.Connections) == 1 && !state.Connections[0].Pending
	})
	return h, host, viewer, hostID, viewerID
}

func TestVoiceOwnersRebindRoomOnlySessionsAndReleaseLastDisconnect(t *testing.T) {
	h, host, viewer, hostID, viewerID := approvedVoiceOwnerRoom(t)
	h.closeClient(viewer)
	viewer = openClient(t, h)
	reboundViewer := authenticate(t, viewer, h.room, protocol.RoleViewer, "owner_viewer_123456", 1, "", presenceOptions{})
	if reboundViewer.PeerID != viewerID.PeerID {
		t.Fatal("viewer identity did not survive grace")
	}
	viewer.sendJSON(map[string]any{"type": "subscribe-room-voice"})
	nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool { return len(state.Connections) == 1 })
	h.locked(func() {
		rm, _ := h.server.router.rooms.Get(h.room.RoomID)
		edge, ok := rm.controller.Snapshot().UpstreamByViewer.Get(viewerID.PeerID)
		peer, _ := h.store.GetConnectedViewer(h.room.RoomID, viewerID.PeerID)
		if !ok || edge.ChildSessionID != peer.SessionID || !h.server.voiceAllowed(h.room.RoomID, viewerID.PeerID) {
			t.Fatal("subscription did not rebind approved viewer route")
		}
	})
	h.closeClient(host)
	host = openClient(t, h)
	reboundHost := authenticate(t, host, h.room, protocol.RoleHost, "owner_host_123456", -1, "", presenceOptions{roomSession: true, roomOnly: true})
	if reboundHost.PeerID != hostID.PeerID {
		t.Fatal("host identity changed on room reconnect")
	}
	host.sendJSON(map[string]any{"type": "subscribe-room-voice"})
	nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool { return len(state.Connections) == 1 })
	h.locked(func() {
		rm, _ := h.server.router.rooms.Get(h.room.RoomID)
		edge, ok := rm.controller.Snapshot().UpstreamByViewer.Get(viewerID.PeerID)
		peer, _ := h.store.GetConnectedHost(h.room.RoomID)
		if !ok || edge.ParentSessionID != peer.SessionID {
			t.Fatal("subscription did not rebind room-only host route")
		}
	})
	h.closeClient(viewer)
	h.closeClient(host)
	h.locked(func() {
		if rm, _ := h.server.router.rooms.Get(h.room.RoomID); rm != nil && rm.controller != nil {
			t.Fatal("last disconnected voice participant retained idle room resources")
		}
	})
}

func TestVoiceOwnersOptInPreservesPausedPublication(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "owner_paused_host_123456", -1, "owner_paused_share_123456",
		presenceOptions{sharingPaused: boolPointer(true)})
	host.sendJSON(map[string]any{"type": "subscribe-room-voice"})
	nextVoiceState(t, host, nil)
	voiceCommand(host, map[string]any{"action": "join"})
	nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool {
		return len(state.Members) == 1 && state.Members[0].Listen
	})
	h.locked(func() {
		rm, _ := h.server.router.rooms.Get(h.room.RoomID)
		snapshot := rm.controller.Snapshot()
		if !snapshot.RoomMedia || !snapshot.VideoPaused || snapshot.VideoGeneration != "owner_paused_share_123456" {
			t.Fatal("voice opt-in resumed a paused screen publication")
		}
	})
}

func TestVoiceOwnersGrantRevocationRemovesPermanentMember(t *testing.T) {
	h, host, viewer, _, viewerID := approvedVoiceOwnerRoom(t)
	voiceCommand(viewer, map[string]any{"action": "publish"})
	nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool { return len(state.Publications) == 1 })
	h.updateRoomAccess(protocol.RevokeViewerGrantRequest{Action: "revoke-viewer-grant"})
	viewer.next("viewer-grant-revoked")
	expectCloseCode(t, viewer, 4004)
	state := nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool {
		return len(state.Members) == 1 && len(state.Publications) == 0
	})
	if len(state.Connections) != 0 {
		t.Fatal("revoked member retained a voice connection")
	}
	h.locked(func() {
		if _, exists := h.server.voices[h.room.RoomID].members[viewerID.PeerID]; exists {
			t.Fatal("permanently revoked identity retained voice permission")
		}
	})
}

func TestVoiceOwnersStopDropsVideoOnlyCandidateDemand(t *testing.T) {
	h, host, viewer, _, viewerID := approvedVoiceOwnerRoom(t)
	legacy := openClient(t, h)
	legacyID := authenticate(t, legacy, h.room, protocol.RoleViewer, "owner_legacy_123456", 0, "", presenceOptions{})
	host.sendJSON(map[string]any{"type": "start-sharing", "shareGeneration": "owner_share_123456",
		"qualitySettings": protocol.DefaultQualitySettings, "routePolicy": protocol.DefaultRoutePolicy, "sharingPaused": false})
	host.next("sharing-started")
	prepare := nextPreparedRoute(t, viewer)
	viewer.sendJSON(map[string]any{"type": "route-ready", "phase": "prepare", "revision": prepare.Revision})
	nextActiveRouteRevision(t, viewer, prepare.Revision)
	nextPreparedRoute(t, legacy)
	host.sendJSON(map[string]any{"type": "stop-sharing", "shareGeneration": "owner_share_123456"})
	viewer.next("sharing-stopped")
	if !waitFor(t, defaultWait, func() bool {
		settled := false
		h.locked(func() {
			rm, _ := h.server.router.rooms.Get(h.room.RoomID)
			snapshot := rm.controller.Snapshot()
			edge, ok := snapshot.UpstreamByViewer.Get(viewerID.PeerID)
			_, legacyEdge := snapshot.UpstreamByViewer.Get(legacyID.PeerID)
			settled = !rm.pumping && snapshot.Operation == nil && ok && edge.Usable && !edge.VideoReady && !legacyEdge
		})
		return settled
	}) {
		t.Fatal("video-only viewer retained voice candidate demand after share stop")
	}
}
