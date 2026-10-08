package route

import "testing"

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
				noOperation(t, routes.Reconcile(0).Operation)
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
