package signal

import (
	"testing"

	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
)

func TestRouterFencesDelayedActiveFailureByPhysicalConnection(t *testing.T) {
	for _, transport := range []string{"peer", "sfu"} {
		for _, role := range []string{"host", "viewer"} {
			for _, report := range []string{"exact", "no-identity", "other-connection", "old-session", "future"} {
				t.Run(transport+"/"+role+"/"+report, func(t *testing.T) {
					h := newRouterHarness(t, routerHarnessOptions{capacity: 2, withSfu: transport == "sfu", fakeTimers: true})
					created := h.createRoom()
					host := h.connectHost(created, nil, "", "")
					viewer := h.connectViewer(created, "delayed-failure")
					h.locked(func() { h.doComplete(host); h.doComplete(viewer) })
					prepared := h.waitPreparedTransport(viewer.sessionID, "direct")
					if transport == "sfu" {
						h.routeFailed(viewer, routeFailedMessage(int64(prepared.Revision), "prepare", prepared.Candidate.ConnectionID))
						prepared = h.waitPreparedTransport(viewer.sessionID, "sfu")
					}
					h.routeReady(viewer, int64(prepared.Revision))
					var message protocol.RouteFailedMessage
					h.locked(func() {
						edge := h.doMustEdge(created.RoomID, viewer.peerID)
						id := edge.connectionID
						if transport == "sfu" && role == "host" {
							rm, _ := h.router.rooms.Get(created.RoomID)
							id = rm.controller.Snapshot().HostPublication.ConnectionID
						}
						message = routeFailedMessage(edge.revision, "active", id)
					})

					other := h.connectViewer(created, "unrelated-join")
					h.complete(other)
					candidate := h.waitPreparedTransport(other.sessionID, "direct")
					h.routeReady(other, int64(candidate.Revision))
					h.locked(func() {
						rm, _ := h.router.rooms.Get(created.RoomID)
						before := rm.controller.Snapshot()
						if before.Revision <= int64(message.Revision) {
							t.Fatal("another Viewer must advance the room revision")
						}
						participant := viewer
						if role == "host" {
							participant = host
						}
						switch report {
						case "no-identity":
							message.ConnectionID = nil
						case "other-connection":
							id := "retired_connection_12345678"
							message.ConnectionID = &id
						case "old-session":
							participant.sessionID = "retired_session_12345678"
						case "future":
							message.Revision = protocol.Int(before.Revision + 1)
						}
						h.router.handleRouteFailed(participant, message)
						after := rm.controller.Snapshot()
						edge, ok := after.UpstreamByViewer.Get(viewer.peerID)
						usable := ok && edge.Usable
						if transport == "sfu" && role == "host" {
							usable = after.HostPublication != nil && after.HostPublication.Usable
						}
						if usable != (report != "exact") {
							t.Fatalf("active usable=%v after %s report", usable, report)
						}
						unaffected, ok := after.UpstreamByViewer.Get(other.peerID)
						if !ok || !unaffected.Usable {
							t.Fatal("unrelated direct Viewer must remain usable")
						}
					})
				})
			}
		}
	}
}

func TestRouterActiveFailureDuringPeerPreparationKeepsItsSubject(t *testing.T) {
	for _, role := range []string{"host", "viewer"} {
		t.Run(role, func(t *testing.T) {
			capacity := 2
			if role == "viewer" {
				capacity = 1
			}
			h := newRouterHarness(t, routerHarnessOptions{capacity: capacity, withSfu: true, fakeTimers: true})
			created := h.createRoom()
			host := h.connectHost(created, nil, "", "")
			viewer := h.connectViewer(created, "sfu-ingress")
			h.locked(func() { h.doComplete(host); h.doComplete(viewer) })
			direct := h.waitPreparedTransport(viewer.sessionID, "direct")
			h.routeFailed(viewer, routeFailedMessage(int64(direct.Revision), "prepare", direct.Candidate.ConnectionID))
			sfu := h.waitPreparedTransport(viewer.sessionID, "sfu")
			h.routeReady(viewer, int64(sfu.Revision))
			if role == "viewer" {
				h.locked(func() { h.doRelay(viewer, 1) })
			}
			child := h.connectViewer(created, "preparing-child")
			h.complete(child)
			candidate := h.waitPreparedTransport(child.sessionID, "direct")
			h.locked(func() {
				rm, _ := h.router.rooms.Get(created.RoomID)
				before := rm.controller.Snapshot()
				participant := host
				id := before.HostPublication.ConnectionID
				if role == "viewer" {
					participant = viewer
					edge, _ := before.UpstreamByViewer.Get(viewer.peerID)
					id = edge.ConnectionID
				}
				if before.Operation.Current.Tuple.ParentPeerID != participant.peerID {
					t.Fatal("preparation must belong to the reporting parent")
				}
				h.router.handleRouteFailed(participant, routeFailedMessage(before.Revision, "active", id))
				after := rm.controller.Snapshot()
				if role == "host" {
					if after.HostPublication != nil && after.HostPublication.Usable {
						t.Fatal("failed publication remains usable")
					}
					if after.Operation == nil || after.Operation.Current == nil || after.Operation.Current.ConnectionID != candidate.Candidate.ConnectionID {
						t.Fatal("independent direct candidate was retired")
					}
				} else if edge, ok := after.UpstreamByViewer.Get(viewer.peerID); ok && edge.Usable {
					t.Fatal("failed subscriber remains usable")
				}
			})
		})
	}
}
