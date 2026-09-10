package route

import "github.com/TNTcraftHIM/Piik/internal/server/protocol"

// recordDemand ports 4633: replaces the peer's timing record wholesale.
func (c *Controller) recordDemand(childPeerID string, nowMs int64, reason DemandReason) {
	c.routeTimings[childPeerID] = &routeTimingRecord{
		demandAtMs:      nowMs,
		reason:          reason,
		finalRoute:      FinalRouteWaiting,
		rejectionBucket: RejectionNone,
	}
}

// ensureDemand ports 4647.
func (c *Controller) ensureDemand(childPeerID string, nowMs int64, reason DemandReason) {
	if _, ok := c.routeTimings[childPeerID]; !ok {
		c.recordDemand(childPeerID, nowMs, reason)
	}
}

// startOperationTiming ports 4657.
func (c *Controller) startOperationTiming(childPeerID string, nowMs int64) {
	record := c.routeTimings[childPeerID]
	if record == nil {
		return
	}
	startedAt := nowMs
	record.operationStartedAtMs = &startedAt
	record.candidateStartedAtMs = nil
	record.firstDecodedFrameAtMs = nil
	record.finalAtMs = nil
	record.finalRoute = FinalRouteWaiting
	record.rejectionBucket = RejectionNone
}

// startCandidateTiming ports 4668.
func (c *Controller) startCandidateTiming(childPeerID string, nowMs int64) {
	record := c.routeTimings[childPeerID]
	if record == nil {
		return
	}
	startedAt := nowMs
	record.candidateStartedAtMs = &startedAt
	record.firstDecodedFrameAtMs = nil
	record.finalAtMs = nil
	record.finalRoute = FinalRouteWaiting
	record.rejectionBucket = RejectionNone
}

// noteRejection ports 4678.
func (c *Controller) noteRejection(childPeerID string, bucket RejectionBucket) {
	if record := c.routeTimings[childPeerID]; record != nil {
		record.rejectionBucket = bucket
	}
}

// clearCandidateTiming ports 4686.
func (c *Controller) clearCandidateTiming(childPeerID string) {
	record := c.routeTimings[childPeerID]
	if record == nil {
		return
	}
	record.candidateStartedAtMs = nil
	record.firstDecodedFrameAtMs = nil
	record.finalAtMs = nil
	record.finalRoute = FinalRouteWaiting
}

// finishTiming ports 4695.
func (c *Controller) finishTiming(childPeerID string, nowMs int64, finalRoute FinalRoute, rejectionBucket RejectionBucket, firstDecodedFrame bool) {
	record := c.routeTimings[childPeerID]
	if record == nil {
		return
	}
	if firstDecodedFrame {
		decodedAt := nowMs
		record.firstDecodedFrameAtMs = &decodedAt
	}
	finalAt := nowMs
	record.finalAtMs = &finalAt
	record.finalRoute = finalRoute
	record.rejectionBucket = rejectionBucket
}

// usableRoute ports 4710.
func (c *Controller) usableRoute(childPeerID string) bool {
	return c.currentFinalRoute(childPeerID) != FinalRouteWaiting
}

// currentFinalRoute ports 4714.
func (c *Controller) currentFinalRoute(childPeerID string) FinalRoute {
	edge, _ := c.upstreamByViewer.Get(childPeerID)
	if edge == nil || !edge.Usable || !edge.PhysicalActive {
		return FinalRouteWaiting
	}
	if edge.Kind == UpstreamPeer {
		if c.sourceUsable(edge.ParentPeerID) {
			return FinalRouteDirect
		}
		return FinalRouteWaiting
	}
	if c.hostPublication != nil && c.hostPublication.Usable &&
		c.hostPublication.PhysicalActive &&
		c.hostPublication.Generation == edge.PublicationGeneration {
		return FinalRouteSfu
	}
	return FinalRouteWaiting
}

// routeDemandReason ports 4729.
func (c *Controller) routeDemandReason(childPeerID string) DemandReason {
	edge, _ := c.upstreamByViewer.Get(childPeerID)
	if edge == nil {
		return DemandJoin
	}
	if edge.Kind == UpstreamPeer {
		if parent, ok := c.participants.Get(edge.ParentPeerID); ok && parent.departureConfirmed {
			return DemandParentDeparted
		}
		for _, overflowing := range c.overflowPeerChildren(edge.ParentPeerID) {
			if overflowing == childPeerID {
				return DemandCapacityReduction
			}
		}
	}
	return DemandEdgeUnavailable
}

// diagnosticParent ports 4448.
func (c *Controller) diagnosticParent(edge *CommittedEdge, ordinals map[string]int) protocol.RouteDiagnosticParent {
	if edge == nil || !edge.Usable || !edge.PhysicalActive {
		return protocol.RouteDiagnosticParent{Kind: "none"}
	}
	if edge.Kind == UpstreamSfu {
		if c.hostPublication != nil && c.hostPublication.Usable &&
			c.hostPublication.PhysicalActive &&
			c.hostPublication.Generation == edge.PublicationGeneration {
			return protocol.RouteDiagnosticParent{Kind: "sfu"}
		}
		return protocol.RouteDiagnosticParent{Kind: "none"}
	}
	if edge.ParentPeerID == c.hostPeerID {
		return protocol.RouteDiagnosticParent{Kind: "host"}
	}
	ordinal, ok := ordinals[edge.ParentPeerID]
	if !ok {
		return protocol.RouteDiagnosticParent{Kind: "none"}
	}
	return protocol.RouteDiagnosticParent{Kind: "viewer", Ordinal: protocol.Int(ordinal)}
}

// diagnosticQuality ports 4471: nil (TS null) unless the observation is
// fresh, non-empty and still describes the current edge.
func (c *Controller) diagnosticQuality(childPeerID string, edge *CommittedEdge, nowMs int64) *protocol.RouteDiagnosticQuality {
	observation := c.qualityObservations[childPeerID]
	current, _ := c.participants.Get(childPeerID)
	if c.paused ||
		observation == nil ||
		observation.eligibleWindows == 0 ||
		nowMs >= observation.lastAcceptedAtMs+qualityEvidenceExpiryMs ||
		current == nil || current.sessionID == "" ||
		!current.sessionIs(observation.childSessionID) ||
		edge == nil ||
		!edge.Usable ||
		!edge.PhysicalActive ||
		edge.ConnectionID != observation.connectionID ||
		!qualityObservationMatchesEdge(observation, edge) ||
		!c.sourceUsableForQuality(edge) {
		return nil
	}
	return &protocol.RouteDiagnosticQuality{
		EligibleWindows:    protocol.Int(observation.eligibleWindows),
		EligibleDurationMs: protocol.Int(observation.eligibleDurationMs),
		FreezeWindows:      protocol.Int(observation.freezeWindows),
		FreezeCount:        protocol.Int(observation.freezeCount),
		FreezeDurationMs:   protocol.Int(observation.freezeDurationMs),
		PauseCount:         protocol.Int(observation.pauseCount),
		PauseDurationMs:    protocol.Int(observation.pauseDurationMs),
	}
}

// elapsedMs ports 4964: nil (TS null) when the end precedes the start or
// the difference is not a safe integer; the inputs are integral so
// Math.floor is the identity.
func elapsedMs(startedAtMs, endedAtMs int64) *protocol.Int {
	elapsed := endedAtMs - startedAtMs
	if !isSafeInteger(elapsed) || elapsed < 0 {
		return nil
	}
	value := protocol.Int(elapsed)
	return &value
}
