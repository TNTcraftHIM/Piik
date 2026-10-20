package signal

import (
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
	"github.com/TNTcraftHIM/Piik/internal/server/sfu"
	"github.com/TNTcraftHIM/Piik/internal/server/sfu/sfutest"
)

func nextVoiceState(t *testing.T, client *testClient, matches func(protocol.RoomVoiceStateMessage) bool) protocol.RoomVoiceStateMessage {
	t.Helper()
	for {
		message, err := protocol.DecodeServerMessage(client.next("room-voice-state").raw)
		if err != nil {
			t.Fatal(err)
		}
		state := message.(protocol.RoomVoiceStateMessage)
		if matches == nil || matches(state) {
			return state
		}
	}
}

func TestVoiceOnlySfuPreparesWithoutVideoPublication(t *testing.T) {
	h := startHarness(t, harnessOptions{sfuOnly: true, endpointMediaCopyCapacity: 1,
		sfu: &SfuFallback{Media: sfutest.New(), Admission: sfu.NewAdmission(sfu.AdmissionOptions{IngressCapacity: 1, EgressCapacity: 2})}})
	host, viewer := openClient(t, h), openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "voice_sfu_host_123", -1, "", presenceOptions{roomSession: true, roomOnly: true})
	actor := authenticate(t, viewer, h.room, protocol.RoleViewer, "voice_sfu_viewer_123", 1, "", presenceOptions{})
	for _, client := range []*testClient{host, viewer} {
		client.sendJSON(map[string]any{"type": "subscribe-room-voice"})
		nextVoiceState(t, client, nil)
	}
	voiceCommand(host, map[string]any{"action": "join"})
	voiceCommand(viewer, map[string]any{"action": "join"})
	nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool {
		for _, member := range state.Members {
			if member.PeerID == actor.PeerID {
				return member.Requested
			}
		}
		return false
	})
	voiceCommand(host, map[string]any{"action": "permission", "peerId": actor.PeerID, "listen": true, "speak": true})
	state := nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool { return len(state.Connections) > 0 })
	if len(state.Connections) != 1 || state.Connections[0].Transport != "sfu" || !state.Connections[0].Pending {
		t.Fatalf("invalid SFU preparation: %+v", state.Connections)
	}
}

func voiceCommand(client *testClient, command map[string]any) {
	client.sendJSON(map[string]any{"type": "room-voice-command", "command": command})
}

func TestVoiceOnlyRouteFailureDoesNotChangeVideoStatus(t *testing.T) {
	h, _, viewer, _, viewerID := approvedVoiceOwnerRoom(t)
	h.locked(func() {
		for _, state := range []string{"waiting", "failed"} {
			h.server.router.sendViewerRouteStatus(h.room.RoomID, viewerID.PeerID,
				protocol.RouteStatusMessage{Type: "route-status", Revision: 1, State: state, Reason: "route-exhausted"})
		}
	})
	viewer.next("room-voice-error")
	if _, ok := viewer.tryNext("route-status", 30*time.Millisecond); ok {
		t.Fatal("voice-only routing changed video status")
	}
}

func TestRoomCandidateWaitsForBothPictureAndVoice(t *testing.T) {
	for _, pictureFirst := range []bool{true, false} {
		name := "voice-first"
		if pictureFirst {
			name = "picture-first"
		}
		t.Run(name, func(t *testing.T) {
			h := startHarness(t, harnessOptions{})
			host, viewer := openClient(t, h), openClient(t, h)
			authenticate(t, host, h.room, protocol.RoleHost, "composite_host_123456", -1, "", presenceOptions{roomSession: true, roomOnly: true})
			host.sendJSON(map[string]any{"type": "subscribe-room-voice"})
			nextVoiceState(t, host, nil)
			voiceCommand(host, map[string]any{"action": "join"})
			host.sendJSON(map[string]any{"type": "start-sharing", "shareGeneration": "composite_video_123456",
				"qualitySettings": protocol.DefaultQualitySettings, "routePolicy": protocol.DefaultRoutePolicy, "sharingPaused": false})
			host.next("sharing-started")
			actor := authenticate(t, viewer, h.room, protocol.RoleViewer, "composite_viewer_123456", 1, "", presenceOptions{})
			viewer.sendJSON(map[string]any{"type": "subscribe-room-voice"})
			voiceCommand(viewer, map[string]any{"action": "join"})
			nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool {
				for _, member := range state.Members {
					if member.PeerID == actor.PeerID {
						return member.Requested
					}
				}
				return false
			})
			voiceCommand(host, map[string]any{"action": "permission", "peerId": actor.PeerID, "listen": true, "speak": true})
			pending := nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool {
				return len(state.Connections) == 1 && state.Connections[0].Pending
			})
			voice := pending.Connections[0]
			for prepared := nextPreparedRoute(t, viewer); prepared.Revision != int64(voice.Revision); prepared = nextPreparedRoute(t, viewer) {
			}
			picture := func() {
				viewer.sendJSON(map[string]any{"type": "route-ready", "phase": "prepare", "revision": voice.Revision})
			}
			audio := func() {
				for _, client := range []*testClient{host, viewer} {
					client.sendJSON(map[string]any{"type": "room-voice-transport", "connectionId": voice.ConnectionID, "state": "connected"})
				}
			}
			barriers := []*testClient{viewer}
			if pictureFirst {
				picture()
			} else {
				audio()
				barriers = append(barriers, host)
			}
			for _, client := range barriers {
				client.sendJSON(map[string]any{"type": "signaling-challenge", "sequence": 1})
				client.next("signaling-challenge-response")
			}
			h.locked(func() {
				rm, _ := h.server.router.rooms.Get(h.room.RoomID)
				if op := rm.controller.Operation(); op == nil || op.Current == nil || protocol.Int(op.Current.Revision) != voice.Revision {
					t.Fatal("only one media facet committed the room route")
				}
			})
			if pictureFirst {
				audio()
			} else {
				picture()
			}
			nextActiveRouteRevision(t, viewer, int64(voice.Revision))
			nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool {
				return len(state.Connections) == 1 && !state.Connections[0].Pending
			})
		})
	}
}

func TestRoomVoiceUsesNormalRoomAuthorityAndKeepsGraphAcrossVideo(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host, viewer, old := openClient(t, h), openClient(t, h), openClient(t, h)
	hostID := authenticate(t, host, h.room, protocol.RoleHost, "voice_host_123456", -1, "", presenceOptions{roomSession: true, roomOnly: true})
	viewerID := authenticate(t, viewer, h.room, protocol.RoleViewer, "voice_viewer_123456", 1, "", presenceOptions{})
	authenticate(t, old, h.room, protocol.RoleViewer, "voice_old_page_123456", 1, "", presenceOptions{})
	for _, client := range []*testClient{host, viewer} {
		client.sendJSON(map[string]any{"type": "subscribe-room-voice"})
		nextVoiceState(t, client, nil)
	}
	voiceCommand(viewer, map[string]any{"action": "join"})
	nextVoiceState(t, host, func(s protocol.RoomVoiceStateMessage) bool {
		for _, m := range s.Members {
			if m.PeerID == viewerID.PeerID {
				return m.Requested && !m.Listen
			}
		}
		return false
	})
	voiceCommand(viewer, map[string]any{"action": "publish"})
	viewer.next("room-voice-error")
	voiceCommand(host, map[string]any{"action": "join"})
	voiceCommand(host, map[string]any{"action": "permission", "peerId": viewerID.PeerID, "listen": true, "speak": true})
	pending := nextVoiceState(t, viewer, func(s protocol.RoomVoiceStateMessage) bool {
		return len(s.Connections) == 1 && s.Connections[0].Pending
	})
	voiceID := pending.Connections[0].ConnectionID
	for _, client := range []*testClient{host, viewer} {
		client.sendJSON(map[string]any{"type": "room-voice-transport", "connectionId": voiceID, "state": "connected"})
	}
	active := nextVoiceState(t, viewer, func(s protocol.RoomVoiceStateMessage) bool {
		return len(s.Connections) == 1 && !s.Connections[0].Pending
	})
	if active.Connections[0].ConnectionID != voiceID {
		t.Fatal("voice commit replaced the physical transport")
	}
	voiceCommand(host, map[string]any{"action": "publish"})
	publication := nextVoiceState(t, viewer, func(s protocol.RoomVoiceStateMessage) bool {
		return len(s.Publications) == 1 && len(s.Connections[0].Receive) == 1
	})
	pubID := publication.Publications[0].ID
	if publication.Publications[0].PeerID != hostID.PeerID {
		t.Fatal("publication sender was not authenticated")
	}
	voiceCommand(viewer, map[string]any{"action": "publish"})
	nextVoiceState(t, host, func(s protocol.RoomVoiceStateMessage) bool {
		return len(s.Publications) == 2 && len(s.Connections[0].Receive) == 1
	})
	voiceCommand(host, map[string]any{"action": "permission", "peerId": viewerID.PeerID, "listen": true, "speak": false})
	nextVoiceState(t, viewer, func(s protocol.RoomVoiceStateMessage) bool {
		return len(s.Publications) == 1 && s.Publications[0].ID == pubID
	})
	if _, ok := old.tryNext("room-voice-state", 30*time.Millisecond); ok {
		t.Fatal("voice sent to a page without capability opt-in")
	}

	h.server.mu.Lock()
	runtime, _ := h.server.router.rooms.Get(h.room.RoomID)
	logical := runtime.controller.Snapshot().UpstreamByViewer.Values()[0].ConnectionID
	h.server.mu.Unlock()
	host.sendJSON(map[string]any{"type": "start-sharing", "shareGeneration": "voice_video_generation_1",
		"qualitySettings": protocol.DefaultQualitySettings, "routePolicy": protocol.DefaultRoutePolicy, "sharingPaused": false})
	host.next("sharing-started")
	prepare := nextPreparedRoute(t, viewer)
	if prepare.Candidate.ConnectionID == logical {
		t.Fatal("video attachment reused room transport identity")
	}
	viewer.sendJSON(map[string]any{"type": "route-ready", "phase": "prepare", "revision": prepare.Revision})
	nextActiveRouteRevision(t, viewer, prepare.Revision)
	h.server.mu.Lock()
	edge, _ := runtime.controller.Snapshot().UpstreamByViewer.Get(viewerID.PeerID)
	h.server.mu.Unlock()
	if !edge.VideoReady || edge.ConnectionID != logical || edge.VideoConnectionID != prepare.Candidate.ConnectionID {
		t.Fatal("video did not attach to retained room edge")
	}
	host.sendJSON(map[string]any{"type": "stop-sharing", "shareGeneration": "voice_video_generation_1"})
	viewer.next("sharing-stopped")
	state := nextVoiceState(t, viewer, func(s protocol.RoomVoiceStateMessage) bool {
		return len(s.Publications) == 1 && len(s.Connections) == 1 && !s.Connections[0].Pending
	})
	if state.Connections[0].ConnectionID != voiceID || state.Publications[0].ID != pubID {
		t.Fatal("video stop retired room voice")
	}
	h.server.mu.Lock()
	edge, _ = runtime.controller.Snapshot().UpstreamByViewer.Get(viewerID.PeerID)
	h.server.mu.Unlock()
	if edge.VideoReady || edge.ConnectionID != logical || !edge.Usable {
		t.Fatal("video stop corrupted room graph")
	}
	// A late stop for a former source cannot retire a replacement microphone.
	voiceCommand(host, map[string]any{"action": "unpublish", "publicationId": pubID})
	nextVoiceState(t, viewer, func(s protocol.RoomVoiceStateMessage) bool { return len(s.Publications) == 0 })
	voiceCommand(host, map[string]any{"action": "publish"})
	newState := nextVoiceState(t, viewer, func(s protocol.RoomVoiceStateMessage) bool { return len(s.Publications) == 1 })
	voiceCommand(host, map[string]any{"action": "unpublish", "publicationId": pubID})
	last := nextVoiceState(t, viewer, func(s protocol.RoomVoiceStateMessage) bool {
		return len(s.Publications) == 1 && s.Publications[0].ID == newState.Publications[0].ID
	})
	if last.Publications[0].ID == pubID {
		t.Fatal("publication identity was reused")
	}

	viewer.sendJSON(map[string]any{"type": "signaling-challenge", "sequence": 42})
	viewer.next("signaling-challenge-response")
}
