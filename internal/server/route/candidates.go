package route

import (
	"errors"
	"slices"
	"sort"

	"github.com/TNTcraftHIM/Screener/internal/server/protocol"
)

// buildCandidates ports 2767: the full plan list filtered by the
// availability opportunity ledger.
func (c *Controller) buildCandidates(childPeerID string, sfuOnly bool) []CandidatePlan {
	plans := c.buildCandidatePlans(childPeerID, sfuOnly, true)
	out := make([]CandidatePlan, 0, len(plans))
	for _, plan := range plans {
		if c.candidateOpportunityAvailable(childPeerID, plan) {
			out = append(out, plan)
		}
	}
	return out
}

// buildCandidatePlans ports 2777: eligible parents sorted by (untried
// attempts when preferUntried) then depth, remaining capacity descending,
// stablePairRank, compareParticipant; the SFU tuple is spliced into index 1
// (§4.4 #28) and the list is deduped by tupleKey (§4.4 #29).
func (c *Controller) buildCandidatePlans(childPeerID string, sfuOnly, preferUntried bool) []CandidatePlan {
	descendants := c.descendantsOf(childPeerID)
	parents := []*participant{}
	for _, parent := range c.participants.Values() {
		if parent.sessionID != "" && !parent.departureConfirmed && parent.peerID != childPeerID &&
			!slices.Contains(descendants, parent.peerID) && c.sourceUsable(parent.peerID) && c.targetFits(parent.peerID, childPeerID) {
			parents = append(parents, parent)
		}
	}
	sort.SliceStable(parents, func(i, j int) bool {
		left, right := parents[i], parents[j]
		if preferUntried {
			if d := c.peerAttemptsStarted(childPeerID, left.peerID) - c.peerAttemptsStarted(childPeerID, right.peerID); d != 0 {
				return d < 0
			}
		}
		if d := c.depth(left.peerID) - c.depth(right.peerID); d != 0 {
			return d < 0
		}
		if d := c.remaining(right.peerID, childPeerID) - c.remaining(left.peerID, childPeerID); d != 0 {
			return d < 0
		}
		if d := stablePairRank(childPeerID, left.peerID) - stablePairRank(childPeerID, right.peerID); d != 0 {
			return d < 0
		}
		return compareParticipant(left, right) < 0
	})
	directCandidates := make([]CandidateTuple, 0, len(parents))
	for _, parent := range parents {
		directCandidates = append(directCandidates, CandidateTuple{Kind: UpstreamPeer, ParentPeerID: parent.peerID, Transport: TransportDirect})
	}
	var sfuCandidate *CandidateTuple
	if c.sfuEnabled {
		if c.hostPublication != nil && c.hostPublication.Usable && c.hostPublication.PhysicalActive {
			sfuCandidate = &CandidateTuple{Kind: UpstreamSfu, Publication: PublicationReuse}
		} else if c.hostPublication != nil || c.publicationFits(childPeerID, false) {
			publication := PublicationCreate
			if c.hostPublication != nil {
				publication = PublicationReplace
			}
			sfuCandidate = &CandidateTuple{Kind: UpstreamSfu, Publication: publication}
		}
	}
	var candidates []CandidateTuple
	switch {
	case sfuOnly:
		if sfuCandidate != nil {
			candidates = []CandidateTuple{*sfuCandidate}
		}
	case sfuCandidate != nil && len(directCandidates) > 0:
		candidates = append(candidates, directCandidates[0], *sfuCandidate)
		candidates = append(candidates, directCandidates[1:]...)
	case sfuCandidate != nil:
		candidates = []CandidateTuple{*sfuCandidate}
	default:
		candidates = directCandidates
	}
	seen := make(map[string]struct{}, len(candidates))
	plans := make([]CandidatePlan, 0, len(candidates))
	for _, tuple := range candidates {
		key := tupleKey(tuple)
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		plan := c.planCandidate(childPeerID, tuple)
		if plan != nil && c.candidateValid(childPeerID, *plan, nil) {
			plans = append(plans, *plan)
		}
	}
	return plans
}

// planCandidate ports 3947: decides none / overlap / bounded-gap from the
// producer's copy budget; nil when the producer is gone or over budget.
func (c *Controller) planCandidate(childPeerID string, tuple CandidateTuple) *CandidatePlan {
	if tuple.Kind == UpstreamSfu && tuple.Publication == PublicationReuse {
		// No producer on sfu/reuse (3949); endpointTransitionEquals compares it.
		return &CandidatePlan{Tuple: tuple, EndpointTransition: EndpointTransition{Kind: TransitionNone}}
	}
	producerPeerID := c.hostPeerID
	if tuple.Kind == UpstreamPeer {
		producerPeerID = tuple.ParentPeerID
	}
	producer, _ := c.participants.Get(producerPeerID)
	if producer == nil || producer.sessionID == "" || producer.departureConfirmed {
		return nil
	}
	copies := c.physicalCopies(producerPeerID)
	producer0 := producerPeerID
	if copies+1 <= producer.effectiveDownstreamCapacity {
		return &CandidatePlan{Tuple: tuple, EndpointTransition: EndpointTransition{Kind: TransitionNone, ProducerPeerID: &producer0}}
	}
	if copies+1 <= protocol.EndpointMediaCopyLimit(c.endpointMediaCopyCapacity, protocol.EndpointMediaCopyTransition) {
		return &CandidatePlan{Tuple: tuple, EndpointTransition: EndpointTransition{Kind: TransitionOverlap, ProducerPeerID: &producer0}}
	}
	retire := c.retirementFor(childPeerID, producerPeerID, tuple)
	if retire == nil || copies > producer.effectiveDownstreamCapacity {
		return nil
	}
	return &CandidatePlan{Tuple: tuple, EndpointTransition: EndpointTransition{Kind: TransitionBoundedGap, ProducerPeerID: &producer0, Retire: retire}}
}

// retirementFor ports 3969.
func (c *Controller) retirementFor(childPeerID, producerPeerID string, tuple CandidateTuple) *EndpointRetirement {
	old, _ := c.upstreamByViewer.Get(childPeerID)
	if old != nil && old.Kind == UpstreamPeer && old.ParentPeerID == producerPeerID && old.PhysicalActive {
		return &EndpointRetirement{
			Kind:            RetireEdge,
			ChildPeerID:     childPeerID,
			ChildSessionID:  old.ChildSessionID,
			ParentPeerID:    old.ParentPeerID,
			ParentSessionID: old.ParentSessionID,
			Transport:       old.Transport,
			ConnectionID:    old.ConnectionID,
		}
	}
	if producerPeerID != c.hostPeerID || c.hostPublication == nil || !c.hostPublication.PhysicalActive {
		return nil
	}
	replacesPublication := tuple.Kind == UpstreamSfu && tuple.Publication == PublicationReplace
	releasesLastPublication := tuple.Kind == UpstreamPeer && old != nil && old.Kind == UpstreamSfu && old.PhysicalActive &&
		c.sfuSubscriberCount() == 1
	if !replacesPublication && !releasesLastPublication {
		return nil
	}
	return &EndpointRetirement{
		Kind:          RetirePublication,
		HostSessionID: c.hostPublication.HostSessionID,
		Generation:    c.hostPublication.Generation,
		ConnectionID:  c.hostPublication.ConnectionID,
	}
}

// candidateValid ports 3903; att is the live attempt when validating it.
func (c *Controller) candidateValid(childPeerID string, plan CandidatePlan, att *attempt) bool {
	tuple := plan.Tuple
	child, _ := c.participants.Get(childPeerID)
	if child == nil || child.sessionID == "" || child.departureConfirmed || (att != nil && att.childSessionID != child.sessionID) {
		return false
	}
	if tuple.Kind == UpstreamPeer {
		parent, _ := c.participants.Get(tuple.ParentPeerID)
		if parent == nil || parent.sessionID == "" || parent.departureConfirmed || (att != nil && parent.sessionID != att.parentSessionID) ||
			slices.Contains(c.descendantsOf(childPeerID), parent.peerID) || !c.sourceUsable(parent.peerID) ||
			!c.targetFits(parent.peerID, childPeerID) {
			return false
		}
	} else {
		if !c.sfuEnabled {
			return false
		}
		if att != nil && att.hostSessionID != "" {
			host, _ := c.participants.Get(c.hostPeerID)
			if host == nil || !host.sessionIs(att.hostSessionID) {
				return false
			}
		}
		switch tuple.Publication {
		case PublicationReuse:
			if c.hostPublication == nil || !c.hostPublication.Usable || !c.hostPublication.PhysicalActive ||
				(att != nil && att.publicationGeneration != c.hostPublication.Generation) {
				return false
			}
		case PublicationReplace:
			if c.hostPublication == nil || c.hostPublication.Usable || !c.publicationFits(childPeerID, true) {
				return false
			}
		default:
			if c.hostPublication != nil || !c.publicationFits(childPeerID, false) {
				return false
			}
		}
	}
	currentPlan := c.planCandidate(childPeerID, tuple)
	return currentPlan != nil && endpointTransitionEquals(currentPlan.EndpointTransition, plan.EndpointTransition)
}

// operationCandidateValid ports 3934.
func (c *Controller) operationCandidateValid(op *operation, plan CandidatePlan, att *attempt) bool {
	return c.candidateValid(op.childPeerID, plan, att) &&
		((att != nil && att.connectionAttempt != nil) ||
			!isAvailabilityOperation(op.reason) ||
			c.candidateOpportunityAvailable(op.childPeerID, plan))
}

// physicalCopies ports 3999.
func (c *Controller) physicalCopies(peerID string) int {
	copies := 0
	for _, edge := range c.upstreamByViewer.Values() {
		if edge.Kind == UpstreamPeer && edge.ParentPeerID == peerID && edge.PhysicalActive {
			copies++
		}
	}
	if peerID == c.hostPeerID && c.hostPublication != nil && c.hostPublication.PhysicalActive {
		copies++
	}
	return copies
}

// assertReservation ports 4006: panics on a reservation kind that does not
// match the tuple or a missing overlap for an overlap transition.
func assertReservation(tuple CandidateTuple, reservation CandidateReservation, overlap bool) {
	expected := ReservationSfuCreate
	switch {
	case tuple.Kind == UpstreamPeer:
		expected = ReservationDirect
	case tuple.Publication == PublicationReuse:
		expected = ReservationSfuReuse
	}
	if reservation.Kind != expected {
		panic(errors.New("Candidate reservation kind does not match tuple"))
	}
	if overlap && reservation.Overlap == nil {
		panic(errors.New("Candidate requires an endpoint overlap reservation"))
	}
}

// targetFits ports 4380; the parent must exist.
func (c *Controller) targetFits(parentPeerID, childPeerID string) bool {
	parent, _ := c.participants.Get(parentPeerID)
	edge, _ := c.upstreamByViewer.Get(childPeerID)
	already := edge != nil && edge.Kind == UpstreamPeer && edge.ParentPeerID == parentPeerID && edge.PhysicalActive
	releasesLastPublication := parent.role == protocol.RoleHost && edge != nil && edge.Kind == UpstreamSfu && edge.PhysicalActive &&
		c.sfuSubscriberCount() == 1
	slots := c.usedSlots(parentPeerID)
	if releasesLastPublication {
		slots--
	}
	if !already {
		slots++
	}
	return slots <= parent.effectiveDownstreamCapacity
}

// publicationFits ports 4390.
func (c *Controller) publicationFits(childPeerID string, replacing bool) bool {
	host, _ := c.participants.Get(c.hostPeerID)
	edge, _ := c.upstreamByViewer.Get(childPeerID)
	releasesHost := edge != nil && edge.Kind == UpstreamPeer && edge.ParentPeerID == c.hostPeerID && edge.PhysicalActive
	replacesPhysicalPublication := replacing && c.hostPublication != nil && c.hostPublication.PhysicalActive
	nextSlots := c.usedSlots(c.hostPeerID)
	if releasesHost {
		nextSlots--
	}
	if !replacesPhysicalPublication {
		nextSlots++
	}
	return host != nil && host.sessionID != "" && !host.departureConfirmed && nextSlots <= host.effectiveDownstreamCapacity
}

// hostHasPublicationSlot ports 4400.
func (c *Controller) hostHasPublicationSlot() bool {
	host, _ := c.participants.Get(c.hostPeerID)
	return host != nil && c.usedSlots(c.hostPeerID)+1 <= host.effectiveDownstreamCapacity
}

func (c *Controller) usedSlots(peerID string) int {
	return c.physicalCopies(peerID)
}

// remaining ports 4409 and may be negative; the parent must exist.
func (c *Controller) remaining(parentPeerID, childPeerID string) int64 {
	parent, _ := c.participants.Get(parentPeerID)
	edge, _ := c.upstreamByViewer.Get(childPeerID)
	already := edge != nil && edge.Kind == UpstreamPeer && edge.ParentPeerID == parentPeerID && edge.PhysicalActive
	value := int64(parent.effectiveDownstreamCapacity - c.usedSlots(parentPeerID))
	if !already {
		value--
	}
	return value
}

// depth ports 4416; a cycle yields MAX_SAFE_INTEGER (not MaxInt64) so the
// comparator subtraction cannot overflow.
func (c *Controller) depth(peerID string) int64 {
	if peerID == c.hostPeerID {
		return 1
	}
	depth := int64(1)
	seen := make(map[string]struct{})
	for {
		if _, visited := seen[peerID]; visited {
			return maxSafeInteger
		}
		seen[peerID] = struct{}{}
		edge, _ := c.upstreamByViewer.Get(peerID)
		if edge == nil || edge.Kind == UpstreamSfu {
			return depth + 1
		}
		depth++
		if edge.ParentPeerID == c.hostPeerID {
			return depth
		}
		peerID = edge.ParentPeerID
	}
}

// childrenOf ports 4352: direct peer children in upstreamByViewer order
// (§4.2 #17), the base order for every children-derived list.
func (c *Controller) childrenOf(parentPeerID string) []string {
	children := []string{}
	for childPeerID, edge := range c.upstreamByViewer.All() {
		if edge.Kind == UpstreamPeer && edge.ParentPeerID == parentPeerID {
			children = append(children, childPeerID)
		}
	}
	return children
}

// descendantsOf ports 4356: a DFS (the TS queue is popped from the end,
// §4.5 #49) returning the visit order without duplicates.
func (c *Controller) descendantsOf(peerID string) []string {
	descendants := []string{}
	seen := make(map[string]struct{})
	stack := []string{peerID}
	for len(stack) > 0 {
		last := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for _, child := range c.childrenOf(last) {
			if _, visited := seen[child]; visited {
				continue
			}
			seen[child] = struct{}{}
			descendants = append(descendants, child)
			stack = append(stack, child)
		}
	}
	return descendants
}

// withSelf ports `this.descendantsOf(peerId).add(peerId)`: the peer itself
// is appended last unless the walk already reached it (§4.5 #50).
func withSelf(descendants []string, peerID string) []string {
	if slices.Contains(descendants, peerID) {
		return descendants
	}
	return append(descendants, peerID)
}

// sourceUsable ports 4365: the whole upstream path is usable and active.
func (c *Controller) sourceUsable(peerID string) bool {
	if peerID == c.hostPeerID {
		return true
	}
	seen := make(map[string]struct{})
	for {
		if _, visited := seen[peerID]; visited {
			return false
		}
		seen[peerID] = struct{}{}
		edge, _ := c.upstreamByViewer.Get(peerID)
		if edge == nil || !edge.Usable || !edge.PhysicalActive {
			return false
		}
		if edge.Kind == UpstreamSfu {
			return c.hostPublication != nil && c.hostPublication.Usable &&
				c.hostPublication.PhysicalActive && c.hostPublication.Generation == edge.PublicationGeneration
		}
		if edge.ParentPeerID == c.hostPeerID {
			return true
		}
		peerID = edge.ParentPeerID
	}
}

// participantBlocked ports 3862.
func (c *Controller) participantBlocked(current *participant) bool {
	return current.availabilityExhausted && len(c.buildCandidates(current.peerID, false)) == 0
}

// availableViewers ports 3869: connected, non-departed viewers sorted by
// compareParticipant (a total order, so the map order does not leak).
func (c *Controller) availableViewers(includeBlocked bool) []*participant {
	viewers := []*participant{}
	for _, current := range c.participants.Values() {
		if current.role == protocol.RoleViewer && current.sessionID != "" && !current.departureConfirmed &&
			(includeBlocked || !c.participantBlocked(current)) {
			viewers = append(viewers, current)
		}
	}
	sort.SliceStable(viewers, func(i, j int) bool { return compareParticipant(viewers[i], viewers[j]) < 0 })
	return viewers
}

// overflowChildren ports 3876: per parent in participants order, the
// overflowing children newest-first (§4.1 #3).
func (c *Controller) overflowChildren() []string {
	result := []string{}
	for _, parent := range c.participants.Values() {
		overflow := []string{}
		for _, id := range c.overflowPeerChildren(parent.peerID) {
			child, _ := c.participants.Get(id)
			if child != nil && child.sessionID != "" && !child.departureConfirmed && !c.participantBlocked(child) {
				overflow = append(overflow, id)
			}
		}
		slices.Reverse(overflow)
		result = append(result, overflow...)
	}
	return result
}

// overflowPeerChildren ports 3889: the physically active direct children
// beyond the parent's capacity, oldest first kept.
func (c *Controller) overflowPeerChildren(parentPeerID string) []string {
	parent, _ := c.participants.Get(parentPeerID)
	if parent == nil {
		return []string{}
	}
	publicationCopies := 0
	if parent.role == protocol.RoleHost && c.hostPublication != nil && c.hostPublication.PhysicalActive {
		publicationCopies = 1
	}
	capacity := max(0, parent.effectiveDownstreamCapacity-publicationCopies)
	children := []string{}
	for _, id := range c.childrenOf(parentPeerID) {
		if edge, ok := c.upstreamByViewer.Get(id); ok && edge.Kind == UpstreamPeer && edge.PhysicalActive {
			children = append(children, id)
		}
	}
	sort.SliceStable(children, func(i, j int) bool {
		left, _ := c.participants.Get(children[i])
		right, _ := c.participants.Get(children[j])
		return compareParticipant(left, right) < 0
	})
	if capacity >= len(children) {
		return []string{}
	}
	return children[capacity:]
}

// tupleKey ports 4979.
func tupleKey(tuple CandidateTuple) string {
	if tuple.Kind == UpstreamPeer {
		key := "peer:" + tuple.ParentPeerID
		if tuple.Regenerate {
			key += ":regenerate"
		}
		return key
	}
	return "sfu:" + string(tuple.Publication)
}

// edgeTupleKey ports 4999.
func edgeTupleKey(edge *CommittedEdge) string {
	if edge.Kind == UpstreamPeer {
		return "peer:" + edge.ParentPeerID
	}
	return "sfu:reuse"
}

// endpointTransitionRank ports 5003.
func endpointTransitionRank(transition EndpointTransition) int {
	switch transition.Kind {
	case TransitionNone:
		return 0
	case TransitionOverlap:
		return 1
	default:
		return 2
	}
}

// cloneCandidatePlan ports 5020 (deep copy of the retirement).
func cloneCandidatePlan(plan CandidatePlan) CandidatePlan {
	clone := plan
	if plan.EndpointTransition.ProducerPeerID != nil {
		producer := *plan.EndpointTransition.ProducerPeerID
		clone.EndpointTransition.ProducerPeerID = &producer
	}
	if plan.EndpointTransition.Retire != nil {
		retire := *plan.EndpointTransition.Retire
		clone.EndpointTransition.Retire = &retire
	}
	return clone
}

// candidatePlanEquals ports 5029.
func candidatePlanEquals(left, right CandidatePlan) bool {
	return tupleKey(left.Tuple) == tupleKey(right.Tuple) &&
		endpointTransitionEquals(left.EndpointTransition, right.EndpointTransition)
}

func stringPtrEquals(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

// endpointTransitionEquals ports 5034; `undefined !== HOST` matters for the
// none producer, hence the pointer comparison.
func endpointTransitionEquals(left, right EndpointTransition) bool {
	if left.Kind != right.Kind {
		return false
	}
	if left.Kind == TransitionNone || left.Kind == TransitionOverlap {
		return stringPtrEquals(left.ProducerPeerID, right.ProducerPeerID)
	}
	if left.Kind != TransitionBoundedGap || !stringPtrEquals(left.ProducerPeerID, right.ProducerPeerID) ||
		left.Retire == nil || right.Retire == nil || left.Retire.Kind != right.Retire.Kind {
		return false
	}
	if left.Retire.Kind == RetirePublication {
		return left.Retire.HostSessionID == right.Retire.HostSessionID &&
			left.Retire.Generation == right.Retire.Generation &&
			left.Retire.ConnectionID == right.Retire.ConnectionID
	}
	if left.Retire.Kind == RetireEdge {
		return left.Retire.ChildPeerID == right.Retire.ChildPeerID &&
			left.Retire.ChildSessionID == right.Retire.ChildSessionID &&
			left.Retire.ParentPeerID == right.Retire.ParentPeerID &&
			left.Retire.ParentSessionID == right.Retire.ParentSessionID &&
			left.Retire.Transport == right.Retire.Transport &&
			left.Retire.ConnectionID == right.Retire.ConnectionID
	}
	return false
}

// reservationResources ports 5060 in order: edge (never for a borrowed
// sfu-reuse edge, which belongs to another holder), publication, overlap.
func reservationResources(reservation CandidateReservation) []*Resource {
	resources := []*Resource{}
	if reservation.Kind != ReservationDirect && !(reservation.Kind == ReservationSfuReuse && reservation.Borrowed) {
		resources = append(resources, reservation.Edge)
	}
	if reservation.Kind == ReservationSfuCreate {
		resources = append(resources, reservation.Publication)
	}
	if reservation.Overlap != nil {
		resources = append(resources, reservation.Overlap)
	}
	return resources
}
