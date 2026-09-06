package route

import (
	"strings"

	"github.com/TNTcraftHIM/Screener/internal/server/ordered"
	"github.com/TNTcraftHIM/Screener/internal/server/protocol"
)

// candidateOpportunityBase ports 2900: the NUL-joined ledger key. A session
// change erases the key because the session is part of it.
func (c *Controller) candidateOpportunityBase(childPeerID string, plan CandidatePlan) string {
	childSessionID := ""
	if child, ok := c.participants.Get(childPeerID); ok {
		childSessionID = child.sessionID
	}
	if plan.Tuple.Kind == UpstreamPeer {
		parentSessionID := ""
		if parent, ok := c.participants.Get(plan.Tuple.ParentPeerID); ok {
			parentSessionID = parent.sessionID
		}
		return tupleKey(plan.Tuple) + "\x00" + childSessionID + "\x00" + parentSessionID
	}
	hostSessionID := ""
	if host, ok := c.participants.Get(c.hostPeerID); ok {
		hostSessionID = host.sessionID
	}
	return sfuOpportunityPrefix + childSessionID + "\x00" + hostSessionID
}

// candidateOpportunityAvailable ports 2823.
func (c *Controller) candidateOpportunityAvailable(childPeerID string, plan CandidatePlan) bool {
	child, _ := c.participants.Get(childPeerID)
	if child == nil {
		return true
	}
	consumed, ok := child.consumedCandidateOpportunities.Get(c.candidateOpportunityBase(childPeerID, plan))
	return !ok ||
		endpointTransitionRank(plan.EndpointTransition) < consumed.rank ||
		(c.natPredictionEnabled &&
			plan.Tuple.Kind == UpstreamPeer &&
			!consumed.exhausted &&
			consumed.startedAttempts < maxNatConnectionAttempts)
}

// startCandidateOpportunity ports 2842: counts one NAT attempt for a peer
// candidate of an availability or direct-convergence operation.
func (c *Controller) startCandidateOpportunity(op *operation, plan CandidatePlan) *ConnectionAttemptProgress {
	if !c.natPredictionEnabled ||
		plan.Tuple.Kind != UpstreamPeer ||
		(!isAvailabilityOperation(op.reason) && op.reason != DemandDirectConvergence) {
		return nil
	}
	child, _ := c.participants.Get(op.childPeerID)
	opportunities := &child.consumedCandidateOpportunities
	key := c.candidateOpportunityBase(op.childPeerID, plan)
	rank := endpointTransitionRank(plan.EndpointTransition)
	previous, ok := opportunities.Get(key)
	startedAttempts := 1
	if ok && previous.rank <= rank {
		startedAttempts = previous.startedAttempts + 1
	}
	newRank := rank
	if ok {
		newRank = min(previous.rank, rank)
	}
	// The new entry has no `exhausted` (2859-2862).
	opportunities.Set(key, candidateOpportunity{rank: newRank, startedAttempts: startedAttempts})
	op.peerAttemptStarted = true
	return &ConnectionAttemptProgress{Current: startedAttempts, Total: maxNatConnectionAttempts}
}

// peerAttemptsStarted ports 2867.
func (c *Controller) peerAttemptsStarted(childPeerID, parentPeerID string) int {
	if !c.natPredictionEnabled {
		return 0
	}
	plan := c.planCandidate(childPeerID, CandidateTuple{Kind: UpstreamPeer, ParentPeerID: parentPeerID, Transport: TransportDirect})
	if plan == nil {
		return 0
	}
	child, _ := c.participants.Get(childPeerID)
	if child == nil {
		return 0
	}
	opportunity, ok := child.consumedCandidateOpportunities.Get(c.candidateOpportunityBase(childPeerID, *plan))
	if ok && opportunity.rank <= endpointTransitionRank(plan.EndpointTransition) {
		return opportunity.startedAttempts
	}
	return 0
}

// viewerAttemptsStarted ports 2880: the sum over every peer key.
func (c *Controller) viewerAttemptsStarted(peerID string) int {
	if !c.natPredictionEnabled {
		return 0
	}
	current, _ := c.participants.Get(peerID)
	if current == nil {
		return 0
	}
	started := 0
	for key, opportunity := range current.consumedCandidateOpportunities.All() {
		if strings.HasPrefix(key, "peer:") {
			started += opportunity.startedAttempts
		}
	}
	return started
}

// hasRemainingNatOpportunity ports 2890.
func (c *Controller) hasRemainingNatOpportunity(op *operation) bool {
	if !isAvailabilityOperation(op.reason) || !op.peerAttemptStarted {
		return false
	}
	for _, plan := range c.buildCandidates(op.childPeerID, false) {
		if plan.Tuple.Kind == UpstreamPeer {
			return true
		}
	}
	return false
}

// consumeCandidateOpportunity ports 2916: exhausts the key at its best rank.
func (c *Controller) consumeCandidateOpportunity(childPeerID string, plan CandidatePlan) {
	child, _ := c.participants.Get(childPeerID)
	if child == nil {
		return
	}
	key := c.candidateOpportunityBase(childPeerID, plan)
	rank := endpointTransitionRank(plan.EndpointTransition)
	previous, ok := child.consumedCandidateOpportunities.Get(key)
	entry := candidateOpportunity{rank: rank, exhausted: true}
	if ok {
		entry.rank = min(previous.rank, rank)
		entry.startedAttempts = previous.startedAttempts
	}
	child.consumedCandidateOpportunities.Set(key, entry)
}

// qualityCandidateOpportunityAvailable ports 2934.
func (c *Controller) qualityCandidateOpportunityAvailable(childPeerID string, plan CandidatePlan) bool {
	observation := c.senderQualityObservations[childPeerID]
	if observation == nil {
		return true
	}
	consumed, ok := observation.consumedQualityCandidates.Get(c.candidateOpportunityBase(childPeerID, plan))
	return !ok || endpointTransitionRank(plan.EndpointTransition) < consumed
}

// consumeQualityCandidateOpportunity ports 2949.
func (c *Controller) consumeQualityCandidateOpportunity(op *operation, plan *CandidatePlan) {
	if op.reason != DemandQualityConvergence || plan == nil {
		return
	}
	observation := c.currentQualityOperationObservation(op)
	if observation == nil {
		return
	}
	consumeOpportunity(observation.consumedQualityCandidates,
		c.candidateOpportunityBase(op.childPeerID, *plan),
		endpointTransitionRank(plan.EndpointTransition))
}

// consumeQualityOperationCandidates ports 2967.
func (c *Controller) consumeQualityOperationCandidates(op *operation) {
	for index := range op.candidates {
		candidate := op.candidates[index]
		c.consumeQualityCandidateOpportunity(op, &candidate)
	}
}

// consumeActiveEdgeOpportunity ports 2975: an invalidated active edge
// exhausts its exact tuple at rank 0.
func (c *Controller) consumeActiveEdgeOpportunity(child *participant, edge *CommittedEdge) {
	if edge.Kind == UpstreamPeer {
		key := "peer:" + edge.ParentPeerID + "\x00" + child.sessionID + "\x00" + edge.ParentSessionID
		previous, _ := child.consumedCandidateOpportunities.Get(key)
		child.consumedCandidateOpportunities.Set(key, candidateOpportunity{
			rank:            0,
			startedAttempts: previous.startedAttempts,
			exhausted:       true,
		})
		return
	}
	c.consumeCandidateOpportunity(child.peerID, CandidatePlan{
		Tuple:              CandidateTuple{Kind: UpstreamSfu, Publication: PublicationReuse},
		EndpointTransition: EndpointTransition{Kind: TransitionNone},
	})
}

// consumeAvailabilityOperation ports 2993.
func (c *Controller) consumeAvailabilityOperation(op *operation) {
	if !isAvailabilityOperation(op.reason) {
		return
	}
	for _, plan := range op.candidates {
		if op.peerAttemptStarted && plan.Tuple.Kind == UpstreamPeer {
			continue
		}
		c.consumeCandidateOpportunity(op.childPeerID, plan)
	}
}

// consumeCurrentAvailabilityOpportunity ports 3003.
func (c *Controller) consumeCurrentAvailabilityOpportunity(op *operation) {
	if !isAvailabilityOperation(op.reason) {
		return
	}
	plan := op.planAt(op.cursor)
	if op.current != nil && op.current.connectionAttempt != nil && plan != nil && plan.Tuple.Kind == UpstreamPeer {
		return
	}
	if plan != nil {
		c.consumeCandidateOpportunity(op.childPeerID, *plan)
	}
}

// clearOpportunitiesForSessionChange ports 4561 (§4.1 #5, §4.5 #47): keys
// are snapshotted before deletion, which JS defines as safe in place.
func (c *Controller) clearOpportunitiesForSessionChange(peerID string, role protocol.Role) {
	if current, ok := c.participants.Get(peerID); ok {
		current.consumedCandidateOpportunities.Clear()
		current.availabilityExhausted = false
		current.bootstrapFailureReported = false
	}
	parentPrefix := "peer:" + peerID + "\x00"
	for _, child := range c.participants.Values() {
		for _, key := range child.consumedCandidateOpportunities.Keys() {
			if strings.HasPrefix(key, parentPrefix) ||
				(role == protocol.RoleHost && strings.HasPrefix(key, sfuOpportunityPrefix)) {
				child.consumedCandidateOpportunities.Delete(key)
			}
		}
		if role == protocol.RoleHost {
			child.bootstrapFailureReported = false
		}
	}
	if role == protocol.RoleHost {
		c.consumedSfuBootstrapOpportunities.Clear()
		return
	}
	carrierPrefix := peerID + "\x00"
	for _, key := range c.consumedSfuBootstrapOpportunities.Keys() {
		if strings.HasPrefix(key, carrierPrefix) {
			c.consumedSfuBootstrapOpportunities.Delete(key)
		}
	}
}

// clearSfuCandidateOpportunities ports 4597.
func (c *Controller) clearSfuCandidateOpportunities() {
	for _, current := range c.participants.Values() {
		for _, key := range current.consumedCandidateOpportunities.Keys() {
			if strings.HasPrefix(key, sfuOpportunityPrefix) {
				current.consumedCandidateOpportunities.Delete(key)
			}
		}
		current.bootstrapFailureReported = false
	}
	c.consumedSfuBootstrapOpportunities.Clear()
}

// consumeOpportunity ports 5011: keeps the best (lowest) rank.
func consumeOpportunity(consumed *ordered.Map[string, int], base string, rank int) {
	previous, ok := consumed.Get(base)
	if !ok || rank < previous {
		consumed.Set(base, rank)
	}
}
