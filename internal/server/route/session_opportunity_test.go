package route

import (
	"fmt"
	"testing"
)

func TestRetainedEdgeFailurePreservesNewSessionOpportunity(t *testing.T) {
	for _, upstream := range []UpstreamKind{UpstreamPeer, UpstreamSfu} {
		for _, changed := range []string{"none", "child", "host"} {
			t.Run(string(upstream)+"/"+changed, func(t *testing.T) {
				routes := newController(2, Options{SfuEnabled: true})
				addViewer(routes, A, 0, nil)
				if upstream == UpstreamSfu {
					routes.hydrateHostPublication("publication", res("publication_resource"), "")
					routes.hydrateEdge(A, sfuEdge("publication", "retained_connection", "subscription"))
				} else {
					routes.hydrateEdge(A, peerEdge(HOST, "retained_connection"))
				}
				switch changed {
				case "child":
					routes.UpsertParticipant(viewerInput(A, "replacement_child_session", 0), nil)
				case "host":
					routes.UpsertParticipant(hostInput("replacement_host_session", 2), nil)
				}
				// Reauthentication keeps healthy media and its physical identity.
				edge := edgeOf(t, routes, A)
				eq(t, edge.Usable, true)
				eq(t, edge.ConnectionID, "retained_connection")
				if upstream == UpstreamSfu && changed != "none" {
					eq(t, must(t, routes.Reconcile(0).Operation).Reason, DemandDirectConvergence)
				} else {
					noOperation(t, routes.Reconcile(0).Operation)
				}
				eq(t, routes.InvalidateEdge(EdgeGuard{
					ChildPeerID: A, ChildSessionID: edge.ChildSessionID,
					ParentSessionID: edge.ParentSessionID,
					RouteRevision:   routes.Snapshot().Revision, ConnectionID: edge.ConnectionID,
				}, ms(1)), true)
				operation := must(t, routes.Reconcile(1).Operation)
				eq(t, hasTuple(operation, func(tuple CandidateTuple) bool {
					return tuple.Kind == upstream
				}), changed != "none")
			})
		}
	}
}

func TestSessionRebindRestoresBoundedDirectAttemptsBehindSFU(t *testing.T) {
	for _, changed := range []string{"child", "host", "parent"} {
		t.Run(changed, func(t *testing.T) {
			routes := newController(3, Options{SfuEnabled: true, NatPredictionEnabled: true})
			addViewer(routes, A, 0, nil)
			routes.hydrateHostPublication("publication", res("publication"), "publisher")
			routes.hydrateEdge(A, sfuEdge("publication", "retained_sfu", "subscription"))
			parent := HOST
			rebound := hostInput("new_host_session", 3)
			if changed == "child" {
				rebound = viewerInput(A, "new_child_session", 0)
			} else if changed == "parent" {
				parent = B
				addViewer(routes, B, 2, nil)
				routes.hydrateEdge(B, peerEdge(HOST, "host_b"))
				rebound = viewerInput(B, "new_parent_session", 2)
			}
			// The previous sessions exhausted direct opportunities, not SFU media.
			for _, plan := range routes.buildCandidates(A, false) {
				if plan.Tuple.Kind == UpstreamPeer {
					routes.consumeCandidateOpportunity(A, plan)
				}
			}
			noOperation(t, routes.Reconcile(0).Operation)
			previous, _ := routes.participants.Get(rebound.PeerID)
			routes.DisconnectSession(rebound.PeerID, previous.sessionID)
			routes.Reconcile(1)
			routes.UpsertParticipant(rebound, ms(2))
			for attempt := 1; attempt <= 4; attempt++ {
				now := int64(3 + attempt*2)
				op := must(t, routes.Reconcile(now).Operation)
				eq(t, op.Reason, DemandDirectConvergence)
				eq(t, op.ChildPeerID, A)
				eq(t, op.Candidates[0].Tuple, peerTuple(parent))
				prepared := beginOperation(t, routes, BeginInput{NowMs: now,
					ConnectionID: fmt.Sprintf("retry_%d", attempt), Reservation: direct()})
				eq(t, attemptCurrent(t, prepared), attempt)
				routes.CandidateFailed(CandidateGuard{ChildPeerID: A, ChildSessionID: prepared.ChildSessionID,
					Revision: prepared.Current.Revision, ConnectionID: prepared.Current.ConnectionID}, now+1)
				eq(t, edgeOf(t, routes, A).ConnectionID, "retained_sfu")
				eq(t, edgeOf(t, routes, A).Usable, true)
			}
			noOperation(t, routes.Reconcile(20).Operation)
			// Duplicate session updates cannot reopen the exhausted budget.
			routes.UpsertParticipant(rebound, ms(21))
			noOperation(t, routes.Reconcile(22).Operation)
		})
	}
}

func TestRebuiltDirectConnectionConsumesCurrentSessionOpportunity(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true})
	addViewer(routes, A, 0, ms(0))
	routes.Reconcile(0)
	commitCurrent(t, routes, 1, "original_connection")
	routes.UpsertParticipant(viewerInput(A, "replacement_child_session", 0), nil)
	edge := edgeOf(t, routes, A)
	result := routes.AdoptDirectConnection(AdoptDirectConnectionInput{
		EdgeGuard: EdgeGuard{
			ChildPeerID: A, ChildSessionID: edge.ChildSessionID,
			ParentSessionID: edge.ParentSessionID, RouteRevision: routes.Snapshot().Revision,
			ConnectionID: edge.ConnectionID,
		},
		NewConnectionID: "rebuilt_connection",
	}, 3)
	eq(t, result.Accepted, true)
	eq(t, routes.InvalidateEdge(EdgeGuard{
		ChildPeerID: A, ChildSessionID: edge.ChildSessionID,
		ParentSessionID: edge.ParentSessionID, RouteRevision: result.ActiveRevision,
		ConnectionID: "rebuilt_connection",
	}, ms(4)), true)
	eq(t, hasTuple(must(t, routes.Reconcile(4).Operation), isPeer), false)
}
