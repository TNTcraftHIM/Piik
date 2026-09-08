package route

import (
	"errors"
	"slices"
	"sort"
)

// validation is the private validateOrAdvance result. The TS `exhausted`
// flag was written (2454, 2588) but never read, so it is not ported.
type validation struct {
	released             []*Resource
	exhaustedChildPeerID string // "" = undefined
	expired              bool
	consumedGuard        bool
}

// failedPeerIDsFrom ports 4943: dedupe preserving argument order.
func failedPeerIDsFrom(results ...validation) []string {
	ids := make([]string, 0, len(results))
	for _, result := range results {
		if result.exhaustedChildPeerID != "" {
			ids = append(ids, result.exhaustedChildPeerID)
		}
	}
	return dedupeStrings(ids)
}

func isBackgroundConvergence(reason DemandReason) bool {
	return reason == DemandDirectConvergence ||
		reason == DemandQualityConvergence ||
		reason == DemandRootConvergence
}

func isAvailabilityOperation(reason DemandReason) bool {
	return reason != DemandSfuBootstrap && !isBackgroundConvergence(reason)
}

// operationRequiresNativeCandidateProof ports 3554 (nil-safe).
func operationRequiresNativeCandidateProof(op *operation) bool {
	if op == nil {
		return false
	}
	return op.reason == DemandRootConvergence ||
		(op.reason == DemandQualityConvergence && op.current != nil && op.current.tuple.Kind == UpstreamSfu)
}

// directHeadStartMs ports 3535: min(5000, max(1, floor(timeout / 2))).
func (c *Controller) directHeadStartMs() int64 {
	return min(maxDirectHeadStartMs, max(1, c.operationTimeoutMs/2))
}

// Reconcile validates or advances the current operation, prunes departed
// leaves and starts at most one new operation in strict priority
// (sfu-bootstrap carrier, next child, direct continuation, quality child,
// root convergence).
func (c *Controller) Reconcile(nowMs int64) ReconcileResult {
	released := []*Resource{}
	validation := c.validateOrAdvance(nowMs, nil)
	released = append(released, validation.released...)
	failedPeerIDs := failedPeerIDsFrom(validation)
	if c.operation != nil &&
		isBackgroundConvergence(c.operation.reason) &&
		(c.hasSfuBootstrapWork() || c.selectNextChild() != "") {
		c.debug(string(c.operation.reason)+"-preempted", "child", c.debugPeer(c.operation.childPeerID))
		released = append(released, c.abortOperation(&nowMs, RejectionAborted)...)
	}
	if c.paused || c.operation != nil {
		return ReconcileResult{
			Operation:      c.operationSnapshot(),
			RemovedPeerIDs: []string{},
			FailedPeerIDs:  failedPeerIDs,
			Released:       released,
		}
	}
	removedPeerIDs := c.pruneDepartedLeaves(&released)

	// The loop bound is a count, not an order (§4.1 #8).
	for remaining := c.participants.Len(); remaining > 0; remaining-- {
		bootstrap := c.takeSfuBootstrapCarrier(nowMs, &failedPeerIDs)
		routeChildPeerID := ""
		if bootstrap == nil {
			routeChildPeerID = c.selectNextChild()
		}
		var continuation *directContinuationPick
		if routeChildPeerID == "" && bootstrap == nil {
			continuation = c.selectDirectContinuation()
		}
		qualityChildPeerID := ""
		if routeChildPeerID == "" && bootstrap == nil && continuation == nil {
			qualityChildPeerID = c.selectQualityChild(nowMs)
		}
		var rootConvergence *rootConvergencePick
		if routeChildPeerID == "" && bootstrap == nil && continuation == nil && qualityChildPeerID == "" {
			rootConvergence = c.takeRootConvergenceIntent()
		}
		childPeerID := routeChildPeerID
		switch {
		case childPeerID != "":
		case bootstrap != nil:
			childPeerID = bootstrap.carrierPeerID
		case continuation != nil:
			childPeerID = continuation.childPeerID
		case qualityChildPeerID != "":
			childPeerID = qualityChildPeerID
		case rootConvergence != nil:
			childPeerID = rootConvergence.childPeerID
		}
		if childPeerID == "" {
			return ReconcileResult{RemovedPeerIDs: removedPeerIDs, FailedPeerIDs: failedPeerIDs, Released: released}
		}
		child, _ := c.participants.Get(childPeerID)
		var reason DemandReason
		switch {
		case continuation != nil:
			reason = DemandDirectConvergence
		case bootstrap != nil:
			reason = DemandSfuBootstrap
		case qualityChildPeerID != "":
			reason = DemandQualityConvergence
		case rootConvergence != nil:
			reason = DemandRootConvergence
		default:
			reason = c.routeDemandReason(childPeerID)
		}
		demandPeerID := childPeerID
		if bootstrap != nil {
			demandPeerID = bootstrap.demandPeerID
		}
		demand, _ := c.participants.Get(demandPeerID)
		c.ensureDemand(demandPeerID, nowMs, reason)
		var candidates []CandidatePlan
		switch {
		case continuation != nil:
			candidates = []CandidatePlan{continuation.plan}
		case qualityChildPeerID != "":
			candidates = c.buildQualityCandidates(childPeerID, nowMs)
		case rootConvergence != nil:
			candidates = []CandidatePlan{rootConvergence.plan}
		default:
			candidates = c.buildCandidates(childPeerID, bootstrap != nil)
		}
		if bootstrap == nil && continuation == nil && demand.sfuFirstAtNextRoute {
			// Ordering site §4.4 #30: the SFU candidate moves to the front.
			sfuIndex := slices.IndexFunc(candidates, func(candidate CandidatePlan) bool {
				return candidate.Tuple.Kind == UpstreamSfu
			})
			if sfuIndex > 0 {
				reordered := make([]CandidatePlan, 0, len(candidates))
				reordered = append(reordered, candidates[sfuIndex])
				reordered = append(reordered, candidates[:sfuIndex]...)
				reordered = append(reordered, candidates[sfuIndex+1:]...)
				candidates = reordered
			}
		}
		if reason == DemandSfuBootstrap {
			// Ordering site §4.4 #31: bootstrap sets drop bounded-gap candidates.
			filtered := make([]CandidatePlan, 0, len(candidates))
			for _, candidate := range candidates {
				if candidate.EndpointTransition.Kind != TransitionBoundedGap {
					filtered = append(filtered, candidate)
				}
			}
			candidates = filtered
		}
		if len(candidates) == 0 {
			c.debug("operation-unavailable", "child", c.debugPeer(childPeerID), "reason", reason)
			if isBackgroundConvergence(reason) {
				if reason == DemandDirectConvergence {
					c.directContinuations.Delete(childPeerID)
				}
				c.finishTiming(childPeerID, nowMs, c.currentFinalRoute(childPeerID), RejectionCandidateFailed, false)
				continue
			}
			if reason == DemandSfuBootstrap {
				if failedDemandPeerID := c.completeSfuBootstrapCarrier(childPeerID, nowMs, RejectionCandidateFailed, nil); failedDemandPeerID != "" {
					failedPeerIDs = append(failedPeerIDs, failedDemandPeerID)
				}
				continue
			}
			if c.retireInvalidOperationEdge(childPeerID, &released) {
				c.revision = c.allocateRevision()
				c.touchFacts()
			}
			child.availabilityExhausted = true
			bucket := RejectionCandidateFailed
			if reason == DemandCapacityReduction {
				bucket = RejectionEndpointCapacity
			}
			c.finishTiming(demandPeerID, nowMs, FinalRouteFailed, bucket, false)
			if c.bootstrapCandidateAvailable(demandPeerID) {
				continue
			}
			c.rememberUnavailableSfuBootstrap(demandPeerID)
			failedPeerIDs = append(failedPeerIDs, demandPeerID)
			continue
		}
		c.startOperationTiming(demandPeerID, nowMs)
		var qualitySource *senderQualityIdentity
		if reason == DemandQualityConvergence {
			qualitySource = c.currentQualityOperationSource(childPeerID)
		}
		c.operation = &operation{
			childPeerID:           childPeerID,
			childSessionID:        child.sessionID,
			demandPeerID:          demandPeerID,
			demandSessionID:       demand.sessionID,
			reason:                reason,
			baseRevision:          c.revision,
			candidates:            candidates,
			cursor:                0,
			deadlineAtMs:          nowMs + c.operationTimeoutMs,
			builtAtFactVersion:    c.factVersion,
			deferredParentPeerIDs: []string{},
			qualitySource:         qualitySource,
		}
		if debugEnabled() {
			routes := make([]debugCandidate, 0, len(candidates))
			for _, candidate := range candidates {
				routes = append(routes, debugCandidate{Route: c.debugTuple(candidate.Tuple), Transition: candidate.EndpointTransition.Kind})
			}
			c.debug("operation-started", "child", c.debugPeer(childPeerID), "reason", reason, "candidates", routes)
		}
		return ReconcileResult{
			Operation:      c.operationSnapshot(),
			RemovedPeerIDs: removedPeerIDs,
			FailedPeerIDs:  failedPeerIDs,
			Released:       released,
		}
	}
	return ReconcileResult{RemovedPeerIDs: removedPeerIDs, FailedPeerIDs: failedPeerIDs, Released: released}
}

// BeginCurrentCandidate starts the candidate at the guarded cursor with the
// caller's reservation; every rejection echoes the reservation back in
// Released. Panics on a reservation that does not match the tuple.
func (c *Controller) BeginCurrentCandidate(input BeginInput) BeginResult {
	validation := c.validateOrAdvance(input.NowMs, nil)
	op := c.operation
	if op == nil || op.current != nil || op.baseRevision != c.revision ||
		!c.cursorGuardMatches(input.Guard, op) {
		return BeginResult{
			Accepted:      false,
			Released:      concatResources(validation.released, reservationResources(input.Reservation)),
			FailedPeerIDs: failedPeerIDsFrom(validation),
		}
	}
	plan := op.planAt(op.cursor)
	if plan == nil || !c.operationCandidateValid(op, *plan, nil) {
		return BeginResult{
			Accepted:      false,
			Released:      concatResources(validation.released, reservationResources(input.Reservation)),
			FailedPeerIDs: failedPeerIDsFrom(validation),
		}
	}
	if plan.EndpointTransition.Kind == TransitionBoundedGap {
		return BeginResult{
			Accepted:      false,
			Operation:     c.operationSnapshot(),
			FailedPeerIDs: failedPeerIDsFrom(validation),
			Released:      concatResources(validation.released, reservationResources(input.Reservation)),
		}
	}
	tuple := plan.Tuple
	hostSessionID := ""
	if tuple.Kind == UpstreamSfu {
		if host, ok := c.participants.Get(c.hostPeerID); ok {
			hostSessionID = host.sessionID
		}
	}
	if tuple.Kind == UpstreamSfu && (input.HostSessionID == "" || input.HostSessionID != hostSessionID) {
		return BeginResult{
			Accepted:      false,
			Operation:     c.operationSnapshot(),
			FailedPeerIDs: failedPeerIDsFrom(validation),
			Released:      concatResources(validation.released, reservationResources(input.Reservation)),
		}
	}
	assertReservation(tuple, input.Reservation, plan.EndpointTransition.Kind == TransitionOverlap)
	publicationGeneration := ""
	if tuple.Kind == UpstreamSfu {
		if tuple.Publication == PublicationReuse {
			if c.hostPublication != nil {
				publicationGeneration = c.hostPublication.Generation
			}
		} else {
			publicationGeneration = input.PublicationGeneration
		}
	}
	if tuple.Kind == UpstreamSfu && publicationGeneration == "" {
		panic(errors.New("SFU candidate needs a publication generation"))
	}
	if tuple.Kind == UpstreamSfu && tuple.Publication != PublicationReuse && input.PublicationConnectionID == "" {
		panic(errors.New("SFU publication candidate needs an ingress connection identity"))
	}
	parentSessionID := ""
	if tuple.Kind == UpstreamPeer {
		if parent, ok := c.participants.Get(tuple.ParentPeerID); ok {
			parentSessionID = parent.sessionID
		}
	}
	attemptHostSessionID := ""
	if tuple.Kind == UpstreamSfu {
		attemptHostSessionID = input.HostSessionID
	}
	op.current = &attempt{
		tuple:                   tuple,
		revision:                c.allocateRevision(), // this.revision is NOT advanced here (1841)
		connectionID:            input.ConnectionID,
		childSessionID:          op.childSessionID,
		parentSessionID:         parentSessionID,
		hostSessionID:           attemptHostSessionID,
		publicationGeneration:   publicationGeneration,
		publicationConnectionID: input.PublicationConnectionID,
		reservation:             input.Reservation,
		startedAtMs:             input.NowMs,
		transportConnected:      false,
		mediaReady:              false,
		connectionAttempt:       c.startCandidateOpportunity(op, *plan),
	}
	if debugEnabled() {
		details := []any{
			"child", c.debugPeer(op.childPeerID),
			"candidate", c.debugTuple(tuple),
			"revision", op.current.revision,
			"cursor", op.cursor,
		}
		if op.current.connectionAttempt != nil {
			details = append(details, "connectionAttempt", *op.current.connectionAttempt)
		}
		c.debug("candidate-started", details...)
	}
	c.startCandidateTiming(op.demandPeerID, input.NowMs)
	return BeginResult{
		Accepted:      true,
		Operation:     c.operationSnapshot(),
		FailedPeerIDs: failedPeerIDsFrom(validation),
		Released:      validation.released,
	}
}

// NoteCurrentCandidateRejection records a rejection bucket for the guarded
// cursor while no attempt is live; true when the guard matched.
func (c *Controller) NoteCurrentCandidateRejection(guard CandidateCursorGuard, bucket RejectionBucket) bool {
	op := c.operation
	if op == nil || op.current != nil || !c.cursorGuardMatches(guard, op) {
		return false
	}
	c.noteRejection(op.demandPeerID, bucket)
	return true
}

// SkipCurrentCandidate consumes the guarded candidate and advances the
// cursor (TS defaulted bucket to "stale"; Go callers pass RejectionStale).
func (c *Controller) SkipCurrentCandidate(guard CandidateCursorGuard, nowMs int64, bucket RejectionBucket) BeginResult {
	validation := c.validateOrAdvance(nowMs, nil)
	op := c.operation
	if op == nil || op.current != nil || !c.cursorGuardMatches(guard, op) {
		return BeginResult{
			Accepted:      false,
			FailedPeerIDs: failedPeerIDsFrom(validation),
			Released:      validation.released,
		}
	}
	if bucket == RejectionCandidateFailed {
		if isAvailabilityOperation(op.reason) {
			c.consumeCandidateOpportunity(op.childPeerID, op.candidates[op.cursor])
		}
		c.promoteNextDirectWithinHeadStart(op, nowMs)
	}
	c.consumeQualityCandidateOpportunity(op, op.planAt(op.cursor))
	c.consumeDirectContinuationCandidate(op)
	c.noteRejection(op.demandPeerID, bucket)
	c.debug("candidate-rejected",
		"child", c.debugPeer(op.childPeerID),
		"candidate", c.debugTuple(op.candidates[op.cursor].Tuple),
		"bucket", bucket,
		"cursor", op.cursor)
	op.cursor++
	c.clearCandidateTiming(op.demandPeerID)
	advanced := c.validateOrAdvance(nowMs, nil)
	return BeginResult{
		Operation:     c.operationSnapshot(),
		Accepted:      true,
		FailedPeerIDs: failedPeerIDsFrom(validation, advanced),
		Released:      concatResources(validation.released, advanced.released),
	}
}

// RetireCurrentCandidateProducer performs the bounded-gap retirement of the
// guarded candidate's producer, advances the revision and replans the tail.
func (c *Controller) RetireCurrentCandidateProducer(guard CandidateCursorGuard, nowMs int64) BeginResult {
	validation := c.validateOrAdvance(nowMs, nil)
	op := c.operation
	if op == nil || op.current != nil || !c.cursorGuardMatches(guard, op) {
		return BeginResult{
			Accepted:      false,
			FailedPeerIDs: failedPeerIDsFrom(validation),
			Released:      validation.released,
		}
	}
	plan := op.planAt(op.cursor)
	if plan == nil || plan.EndpointTransition.Kind != TransitionBoundedGap {
		return BeginResult{
			Accepted:      false,
			Operation:     c.operationSnapshot(),
			FailedPeerIDs: failedPeerIDsFrom(validation),
			Released:      validation.released,
		}
	}
	released := concatResources(validation.released)
	retirement := plan.EndpointTransition.Retire
	var restoreTuple *CandidateTuple
	if retirement.Kind == RetireEdge {
		edge, _ := c.upstreamByViewer.Get(retirement.ChildPeerID)
		if edge == nil || edge.Kind != UpstreamPeer || !edge.PhysicalActive ||
			edge.ChildSessionID != retirement.ChildSessionID ||
			edge.ParentPeerID != retirement.ParentPeerID ||
			edge.ParentSessionID != retirement.ParentSessionID ||
			edge.Transport != retirement.Transport ||
			edge.ConnectionID != retirement.ConnectionID {
			return BeginResult{
				Accepted:      false,
				Operation:     c.operationSnapshot(),
				FailedPeerIDs: failedPeerIDsFrom(validation),
				Released:      released,
			}
		}
		if edge.Usable {
			restoreTuple = &CandidateTuple{Kind: UpstreamPeer, ParentPeerID: edge.ParentPeerID, Transport: edge.Transport}
		}
		edge.Usable = false
		edge.PhysicalActive = false
	} else {
		publication := c.hostPublication
		if publication == nil || !publication.PhysicalActive ||
			publication.HostSessionID != retirement.HostSessionID ||
			publication.Generation != retirement.Generation ||
			publication.ConnectionID != retirement.ConnectionID {
			return BeginResult{
				Accepted:      false,
				Operation:     c.operationSnapshot(),
				FailedPeerIDs: failedPeerIDsFrom(validation),
				Released:      released,
			}
		}
		released = append(released, c.removePublicationGeneration(retirement.Generation)...)
	}
	c.advanceActiveRevision(op)
	c.touchFacts()
	nextTuple := plan.Tuple
	if retirement.Kind == RetirePublication && plan.Tuple.Kind == UpstreamSfu && plan.Tuple.Publication == PublicationReplace {
		nextTuple.Publication = PublicationCreate
	}
	c.replanRemaining(op, &nextTuple, restoreTuple)
	if op.cursor >= len(op.candidates) {
		advanced := c.validateOrAdvance(nowMs, nil)
		return BeginResult{
			Accepted:      true,
			Operation:     c.operationSnapshot(),
			FailedPeerIDs: failedPeerIDsFrom(validation, advanced),
			Released:      concatResources(released, advanced.released),
		}
	}
	return BeginResult{
		Accepted:      true,
		Operation:     c.operationSnapshot(),
		FailedPeerIDs: failedPeerIDsFrom(validation),
		Released:      released,
	}
}

// CandidateReady is the commit gate for the guarded live attempt: commits
// when the required proof is present and commitReservation (nil = always
// true) accepts, fails the candidate otherwise.
func (c *Controller) CandidateReady(guard CandidateGuard, nowMs int64, commitReservation func(CandidateReservation) bool, proof CandidateProof) SettleResult {
	if commitReservation == nil {
		commitReservation = func(CandidateReservation) bool { return true }
	}
	validation := c.validateOrAdvance(nowMs, nil)
	op := c.operation
	var att *attempt
	if op != nil {
		att = op.current
	}
	if op == nil || att == nil || !c.guardMatches(guard, op, att) {
		return SettleResult{
			Accepted:       false,
			FailedPeerIDs:  failedPeerIDsFrom(validation),
			ActiveRevision: c.revision,
			Released:       validation.released,
		}
	}
	qualityPeer := op.reason == DemandQualityConvergence && att.tuple.Kind == UpstreamPeer
	relativeP2pProof := qualityPeer && proof.RelativeQualityApproved
	if relativeP2pProof && att.relativeQualityApprovedAtMs == nil {
		approvedAt := nowMs
		att.relativeQualityApprovedAtMs = &approvedAt
	}
	relativeP2pApproved := qualityPeer &&
		att.relativeQualityApprovedAtMs != nil &&
		nowMs < *att.relativeQualityApprovedAtMs+qualityEvidenceExpiryMs
	relativeP2pExpired := qualityPeer &&
		att.relativeQualityApprovedAtMs != nil &&
		!relativeP2pApproved
	relativeP2pPending := qualityPeer && !relativeP2pApproved
	if relativeP2pApproved && c.candidateSenderPersistentlyDegraded(att, nowMs) {
		return c.CandidateFailed(guard, nowMs)
	}
	nativeCandidateProof := operationRequiresNativeCandidateProof(op)
	if relativeP2pApproved || relativeP2pPending || nativeCandidateProof {
		att.mediaReady = true
		currentEdge, _ := c.upstreamByViewer.Get(op.childPeerID)
		if (op.reason == DemandQualityConvergence &&
			(currentEdge == nil || c.senderQualityState(op.childPeerID, currentEdge, nowMs) != SenderQualityDegraded)) ||
			(op.reason == DemandRootConvergence && !c.rootConvergenceOperationStillEligible(op)) {
			// TS 2086-2095: the object literal reads `activeRevision: this.revision`
			// before `released: [...this.abortOperation(...)]` advances it.
			activeRevision := c.revision
			return SettleResult{
				Accepted:       true,
				Committed:      false,
				FailedPeerIDs:  failedPeerIDsFrom(validation),
				ActiveRevision: activeRevision,
				Released:       concatResources(validation.released, c.abortOperation(&nowMs, RejectionAborted)),
			}
		}
	}
	if relativeP2pExpired {
		// A one-shot client proof cannot be renewed by a late sender sample.
		// Release this candidate so the existing bounded cursor can try the
		// next route instead of waiting for the whole operation deadline.
		return c.CandidateFailed(guard, nowMs)
	}
	if relativeP2pPending {
		return SettleResult{
			Accepted:       true,
			Committed:      false,
			FailedPeerIDs:  failedPeerIDsFrom(validation),
			ActiveRevision: c.revision,
			Released:       validation.released,
		}
	}
	if relativeP2pApproved &&
		(att.senderQualityState != SenderQualityHealthy ||
			att.senderQualityAcceptedAtMs == nil ||
			nowMs >= *att.senderQualityAcceptedAtMs+qualityEvidenceExpiryMs) {
		return SettleResult{
			Accepted:       true,
			Committed:      false,
			FailedPeerIDs:  failedPeerIDsFrom(validation),
			ActiveRevision: c.revision,
			Released:       validation.released,
		}
	}
	if nativeCandidateProof {
		sfuReuse := att.tuple.Kind == UpstreamSfu && att.tuple.Publication == PublicationReuse
		var candidateQualityState SenderQualityState
		if sfuReuse {
			candidateQualityState = c.sfuPublisherQualityState(att.publicationGeneration, nowMs)
		} else if att.senderQualityState != "" {
			candidateQualityState = att.senderQualityState
		} else {
			candidateQualityState = SenderQualityUnknown
		}
		candidateQualityReady := candidateQualityState == SenderQualityHealthy &&
			(att.tuple.Kind != UpstreamSfu ||
				att.tuple.Publication == PublicationReuse ||
				att.senderQualityConsecutiveHealthyWindows >= persistentDegradedWindows)
		if !candidateQualityReady && candidateQualityState != SenderQualityDegraded {
			return SettleResult{
				Accepted:       true,
				Committed:      false,
				FailedPeerIDs:  failedPeerIDsFrom(validation),
				ActiveRevision: c.revision,
				Released:       validation.released,
			}
		}
		if !sfuReuse &&
			(att.senderQualityAcceptedAtMs == nil ||
				nowMs >= *att.senderQualityAcceptedAtMs+qualityEvidenceExpiryMs) {
			return c.CandidateFailed(guard, nowMs)
		}
		if candidateQualityState == SenderQualityDegraded {
			return c.CandidateFailed(guard, nowMs)
		}
	}
	if !commitReservation(att.reservation) {
		c.consumeCurrentAvailabilityOpportunity(op)
		c.debug("candidate-commit-rejected",
			"child", c.debugPeer(op.childPeerID),
			"candidate", c.debugTuple(att.tuple),
			"revision", att.revision)
		c.promoteNextDirectWithinHeadStart(op, nowMs)
		c.noteRejection(op.demandPeerID, RejectionCandidateFailed)
		failed := c.validateOrAdvance(nowMs, &guard)
		return SettleResult{
			Accepted:       false,
			FailedPeerIDs:  failedPeerIDsFrom(validation, failed),
			ActiveRevision: c.revision,
			Released:       concatResources(validation.released, failed.released),
		}
	}
	if op.reason != DemandSfuBootstrap {
		finalRoute := FinalRouteSfu
		if att.tuple.Kind == UpstreamPeer {
			finalRoute = FinalRouteDirect
		}
		c.finishTiming(op.demandPeerID, nowMs, finalRoute, RejectionNone, true)
	}
	c.debug("candidate-ready",
		"child", c.debugPeer(op.childPeerID),
		"candidate", c.debugTuple(att.tuple),
		"revision", att.revision)
	// Ordering site §4.2 #16: displaced SFU children in map order.
	displacedSfuChildren := []string{}
	if att.tuple.Kind == UpstreamSfu && att.tuple.Publication == PublicationReplace {
		for childPeerID, edge := range c.upstreamByViewer.All() {
			if childPeerID != op.childPeerID && edge.Kind == UpstreamSfu && edge.PhysicalActive {
				displacedSfuChildren = append(displacedSfuChildren, childPeerID)
			}
		}
	}
	released := concatResources(validation.released, c.commitAttempt(op, att))
	for _, childPeerID := range displacedSfuChildren {
		c.ensureDemand(childPeerID, nowMs, DemandEdgeUnavailable)
	}
	return SettleResult{
		Accepted:       true,
		Committed:      true,
		FailedPeerIDs:  failedPeerIDsFrom(validation),
		ActiveRevision: c.revision,
		Released:       released,
	}
}

// CandidateTransportConnected marks the guarded peer attempt as connected so
// it survives the direct head start until the operation deadline.
func (c *Controller) CandidateTransportConnected(guard CandidateGuard, nowMs int64) SettleResult {
	validation := c.validateOrAdvance(nowMs, nil)
	op := c.operation
	var att *attempt
	if op != nil {
		att = op.current
	}
	if op == nil || att == nil || att.tuple.Kind != UpstreamPeer || !c.guardMatches(guard, op, att) {
		return SettleResult{
			Accepted:       false,
			FailedPeerIDs:  failedPeerIDsFrom(validation),
			ActiveRevision: c.revision,
			Released:       validation.released,
		}
	}
	att.transportConnected = true
	c.debug("candidate-transport-connected",
		"child", c.debugPeer(op.childPeerID),
		"candidate", c.debugTuple(att.tuple),
		"revision", att.revision)
	return SettleResult{
		Accepted:       true,
		FailedPeerIDs:  failedPeerIDsFrom(validation),
		ActiveRevision: c.revision,
		Released:       validation.released,
	}
}

// CandidateFailed fails the guarded live attempt, releasing its reservation
// and advancing the cursor; Accepted reports whether the guard was consumed.
func (c *Controller) CandidateFailed(guard CandidateGuard, nowMs int64) SettleResult {
	op := c.operation
	if op != nil && op.current != nil && c.guardMatches(guard, op, op.current) {
		c.consumeCurrentAvailabilityOpportunity(op)
		c.debug("candidate-failed",
			"child", c.debugPeer(op.childPeerID),
			"candidate", c.debugTuple(op.current.tuple),
			"revision", op.current.revision)
		c.promoteNextDirectWithinHeadStart(op, nowMs)
		c.noteRejection(op.demandPeerID, RejectionCandidateFailed)
	}
	validation := c.validateOrAdvance(nowMs, &guard)
	return SettleResult{
		Accepted:       validation.consumedGuard,
		FailedPeerIDs:  failedPeerIDsFrom(validation),
		ActiveRevision: c.revision,
		Released:       validation.released,
	}
}

// OperationExpired applies head-start and deadline expiry at nowMs;
// Accepted reports whether something expired.
func (c *Controller) OperationExpired(nowMs int64) SettleResult {
	if op := c.operation; op != nil && debugEnabled() {
		current := op.current
		noProgress := current != nil &&
			current.tuple.Kind == UpstreamPeer &&
			!current.transportConnected &&
			c.peerCandidateHasSuccessor(op) &&
			nowMs >= current.startedAtMs+c.directHeadStartMs() &&
			nowMs < op.deadlineAtMs
		event := "operation-deadline"
		if noProgress {
			event = "candidate-no-progress"
		}
		var candidate any
		if current != nil {
			candidate = c.debugTuple(current.tuple)
		}
		c.debug(event,
			"child", c.debugPeer(op.childPeerID),
			"candidate", candidate,
			"cursor", op.cursor,
			"candidateCount", len(op.candidates))
	}
	validation := c.validateOrAdvance(nowMs, nil)
	return SettleResult{
		Accepted:       validation.expired,
		FailedPeerIDs:  failedPeerIDsFrom(validation),
		ActiveRevision: c.revision,
		Released:       validation.released,
	}
}

// validateOrAdvance ports 2342: the single place that expires, replans and
// clears the operation. failedGuard names an attempt the caller failed.
func (c *Controller) validateOrAdvance(nowMs int64, failedGuard *CandidateGuard) validation {
	activeRevisionAtStart := c.revision
	result := validation{released: []*Resource{}}
	op := c.operation
	if op == nil {
		return result
	}
	if !c.bootstrapOperationOwned(op) {
		if op.current != nil {
			result.released = append(result.released, reservationResources(op.current.reservation)...)
			c.advanceActiveRevision(op)
		}
		c.finishTiming(op.demandPeerID, nowMs, c.currentFinalRoute(op.demandPeerID), RejectionStale, false)
		c.operation = nil
		return result
	}
	if op.reason == DemandQualityConvergence && !c.qualityOperationStillEligible(op, nowMs) {
		result.released = append(result.released, c.abortOperation(&nowMs, RejectionAborted)...)
		return result
	}
	if op.reason == DemandRootConvergence && !c.rootConvergenceOperationStillEligible(op) {
		result.released = append(result.released, c.abortOperation(&nowMs, RejectionAborted)...)
		return result
	}
	if nowMs >= op.deadlineAtMs {
		directConvergence := op.reason == DemandDirectConvergence
		sfuBootstrap := op.reason == DemandSfuBootstrap
		qualityConvergence := op.reason == DemandQualityConvergence
		backgroundConvergence := isBackgroundConvergence(op.reason)
		if directConvergence {
			c.consumeDirectContinuationCandidate(op)
		}
		if qualityConvergence {
			c.consumeQualityOperationCandidates(op)
		}
		if op.current != nil {
			result.released = append(result.released, reservationResources(op.current.reservation)...)
		}
		revisionAdvanced := op.current != nil
		if op.current != nil {
			c.advanceActiveRevision(op)
		}
		factsChanged := op.builtAtFactVersion != c.factVersion
		deadlineBucket := RejectionOperationDeadline
		if factsChanged {
			deadlineBucket = RejectionStale
		}
		failedBootstrapDemand := ""
		if sfuBootstrap {
			failedBootstrapDemand = c.completeSfuBootstrapCarrier(op.childPeerID, nowMs, deadlineBucket, op.planAtOrLast())
		}
		bootstrapAvailable := !backgroundConvergence && !sfuBootstrap && c.bootstrapCandidateAvailable(op.demandPeerID)
		if bootstrapAvailable {
			c.consumeCurrentAvailabilityOpportunity(op)
		} else {
			c.consumeAvailabilityOperation(op)
		}
		var exhausted bool
		if sfuBootstrap {
			exhausted = failedBootstrapDemand != ""
		} else {
			exhausted = !backgroundConvergence && !bootstrapAvailable && !c.hasRemainingNatOpportunity(op)
		}
		if bootstrapAvailable {
			c.stageSfuBootstrap(op)
		}
		if !sfuBootstrap {
			c.finishTiming(op.demandPeerID, nowMs, c.expiredFinalRoute(op, backgroundConvergence, exhausted), deadlineBucket, false)
		}
		c.blockAndClear(op, !backgroundConvergence && !sfuBootstrap, &result.released, revisionAdvanced)
		if exhausted && !sfuBootstrap {
			c.rememberUnavailableSfuBootstrap(op.demandPeerID)
		}
		result.expired = true
		if failedBootstrapDemand != "" {
			result.exhaustedChildPeerID = failedBootstrapDemand
		} else if exhausted {
			result.exhaustedChildPeerID = op.demandPeerID
		}
		return result
	}
	if c.advanceExpiredDirectHeadStart(op, nowMs, &result.released) {
		result.expired = true
	}
	child, _ := c.participants.Get(op.childPeerID)
	demand, _ := c.participants.Get(op.demandPeerID)
	if child == nil || !child.sessionIs(op.childSessionID) || demand == nil || !demand.sessionIs(op.demandSessionID) {
		if op.current != nil {
			result.released = append(result.released, reservationResources(op.current.reservation)...)
			c.advanceActiveRevision(op)
		}
		c.finishTiming(op.demandPeerID, nowMs, c.currentFinalRoute(op.demandPeerID), RejectionAborted, false)
		c.operation = nil
		return result
	}

	for c.operation != nil {
		op = c.operation
		att := op.current
		if att == nil && op.builtAtFactVersion != c.factVersion {
			c.replanRemaining(op, nil, nil)
		}
		if att != nil {
			guardFailed := failedGuard != nil && c.guardMatches(*failedGuard, op, att)
			plan := op.planAt(op.cursor)
			peerNoProgressExpired := att.tuple.Kind == UpstreamPeer &&
				!att.transportConnected &&
				c.peerCandidateHasSuccessor(op) &&
				nowMs >= att.startedAtMs+c.directHeadStartMs()
			if !guardFailed && !peerNoProgressExpired && plan != nil && c.operationCandidateValid(op, *plan, att) {
				return result
			}
			if !guardFailed {
				bucket := RejectionStale
				if peerNoProgressExpired {
					bucket = RejectionFirstFrameTimeout
				}
				c.noteRejection(op.demandPeerID, bucket)
			}
			if peerNoProgressExpired {
				result.expired = true
			}
			if guardFailed || peerNoProgressExpired {
				c.consumeQualityCandidateOpportunity(op, plan)
			}
			if op.reason == DemandDirectConvergence {
				c.consumeDirectContinuationCandidate(op)
			}
			result.released = append(result.released, reservationResources(att.reservation)...)
			c.advanceActiveRevision(op)
			op.current = nil
			op.cursor++
			c.clearCandidateTiming(op.demandPeerID)
			result.consumedGuard = guardFailed
			c.replanRemaining(op, nil, nil)
		}
		for op.cursor < len(op.candidates) && !c.operationCandidateValid(op, op.candidates[op.cursor], nil) {
			c.noteRejection(op.demandPeerID, RejectionStale)
			if op.reason == DemandDirectConvergence {
				c.consumeDirectContinuationCandidate(op)
			}
			op.cursor++
			c.clearCandidateTiming(op.demandPeerID)
		}
		if op.cursor < len(op.candidates) {
			return result
		}
		sfuBootstrap := op.reason == DemandSfuBootstrap
		backgroundConvergence := isBackgroundConvergence(op.reason)
		factsChanged := op.builtAtFactVersion != c.factVersion
		rejectionBucket := RejectionCandidateFailed
		if factsChanged {
			rejectionBucket = RejectionStale
		} else if record := c.routeTimings[op.demandPeerID]; record != nil && record.rejectionBucket != RejectionNone {
			rejectionBucket = record.rejectionBucket
		}
		failedBootstrapDemand := ""
		if sfuBootstrap {
			failedBootstrapDemand = c.completeSfuBootstrapCarrier(op.childPeerID, nowMs, rejectionBucket, op.planAtOrLast())
		}
		bootstrapAvailable := !backgroundConvergence && !sfuBootstrap && c.bootstrapCandidateAvailable(op.demandPeerID)
		if !bootstrapAvailable {
			c.consumeAvailabilityOperation(op)
		}
		var exhausted bool
		if sfuBootstrap {
			exhausted = failedBootstrapDemand != ""
		} else {
			exhausted = !backgroundConvergence && !bootstrapAvailable && !c.hasRemainingNatOpportunity(op)
		}
		if bootstrapAvailable {
			c.stageSfuBootstrap(op)
		}
		if !sfuBootstrap {
			c.finishTiming(op.demandPeerID, nowMs, c.expiredFinalRoute(op, backgroundConvergence, exhausted), rejectionBucket, false)
		}
		c.blockAndClear(op, !backgroundConvergence && !sfuBootstrap, &result.released, c.revision != activeRevisionAtStart)
		if failedBootstrapDemand != "" {
			result.exhaustedChildPeerID = failedBootstrapDemand
		} else if exhausted {
			result.exhaustedChildPeerID = op.demandPeerID
			c.rememberUnavailableSfuBootstrap(op.demandPeerID)
		}
	}
	return result
}

// expiredFinalRoute is the finalRoute expression shared by both
// validateOrAdvance terminal branches (2434-2438, 2573-2577).
func (c *Controller) expiredFinalRoute(op *operation, backgroundConvergence, exhausted bool) FinalRoute {
	if backgroundConvergence {
		return c.currentFinalRoute(op.demandPeerID)
	}
	if exhausted {
		return FinalRouteFailed
	}
	return FinalRouteWaiting
}

// commitAttempt ports 2600: installs the attempt as the child's committed
// edge and returns the resources committed before but not after, plus the
// overlap (§4.2 #14).
func (c *Controller) commitAttempt(op *operation, att *attempt) []*Resource {
	before := &resourceSet{}
	before.add(c.committedResources()...)
	old, _ := c.upstreamByViewer.Get(op.childPeerID)
	oldPeer := old != nil && old.Kind == UpstreamPeer
	sameParentRegeneration := op.reason == DemandQualityConvergence &&
		att.tuple.Kind == UpstreamPeer &&
		att.tuple.Regenerate &&
		oldPeer &&
		old.ParentPeerID == att.tuple.ParentPeerID
	createsHostRoot := att.tuple.Kind == UpstreamPeer &&
		att.tuple.ParentPeerID == c.hostPeerID &&
		!(oldPeer && old.ParentPeerID == c.hostPeerID)
	c.clearQualityForParticipant(op.childPeerID)

	if att.tuple.Kind == UpstreamSfu && att.tuple.Publication == PublicationReplace {
		// The return value is discarded on purpose (2616): the before/after
		// diff below picks those resources up.
		c.removePublicationGeneration(c.hostPublication.Generation)
	}

	if att.tuple.Kind == UpstreamPeer {
		parent, _ := c.participants.Get(att.tuple.ParentPeerID)
		if parent == nil || parent.sessionID == "" {
			panic(errors.New("Candidate parent session is unavailable"))
		}
		// Map.set keeps an existing child's position (§4.2 #15).
		c.upstreamByViewer.Set(op.childPeerID, &CommittedEdge{
			Kind:            UpstreamPeer,
			ChildSessionID:  op.childSessionID,
			ParentPeerID:    att.tuple.ParentPeerID,
			ParentSessionID: parent.sessionID,
			Transport:       TransportDirect,
			ConnectionID:    att.connectionID,
			Usable:          true,
			PhysicalActive:  true,
		})
		c.directContinuations.Delete(op.childPeerID)
	} else {
		generation := att.publicationGeneration
		if att.tuple.Publication != PublicationReuse {
			hostSessionID := ""
			if host, ok := c.participants.Get(c.hostPeerID); ok {
				hostSessionID = host.sessionID
			}
			if hostSessionID == "" || att.publicationConnectionID == "" {
				panic(errors.New("SFU publication identity is unavailable"))
			}
			if att.hostSessionID != hostSessionID {
				panic(errors.New("SFU publication Host session is stale"))
			}
			c.hostPublication = &HostPublication{
				Generation:     generation,
				HostSessionID:  hostSessionID,
				ConnectionID:   att.publicationConnectionID,
				Usable:         true,
				PhysicalActive: true,
				Resource:       att.reservation.Publication,
			}
		}
		c.upstreamByViewer.Set(op.childPeerID, &CommittedEdge{
			Kind:                  UpstreamSfu,
			ChildSessionID:        op.childSessionID,
			PublicationGeneration: generation,
			Transport:             TransportSfu,
			ConnectionID:          att.connectionID,
			Usable:                true,
			PhysicalActive:        true,
			Resource:              att.reservation.Edge,
		})
		var remainingParentPeerIDs []string
		if op.reason == DemandSfuBootstrap && oldPeer && old.Usable && old.PhysicalActive {
			remainingParentPeerIDs = []string{old.ParentPeerID}
		} else if op.reason != DemandDirectConvergence {
			start := op.cursor + 1
			if c.natPredictionEnabled {
				start = 0
			}
			for _, candidate := range op.candidates[min(start, len(op.candidates)):] {
				if c.natPredictionEnabled && !c.candidateOpportunityAvailable(op.childPeerID, candidate) {
					continue
				}
				if candidate.Tuple.Kind == UpstreamPeer {
					remainingParentPeerIDs = append(remainingParentPeerIDs, candidate.Tuple.ParentPeerID)
				}
			}
			remainingParentPeerIDs = append(remainingParentPeerIDs, op.deferredParentPeerIDs...)
		}
		if len(remainingParentPeerIDs) > 0 {
			// Ordering site §4.3 #27: dedupe preserving first occurrence.
			c.directContinuations.Set(op.childPeerID, &directContinuation{
				childSessionID:        op.childSessionID,
				sfuConnectionID:       att.connectionID,
				publicationGeneration: generation,
				parentPeerIDs:         dedupeStrings(remainingParentPeerIDs),
			})
		} else {
			c.directContinuations.Delete(op.childPeerID)
		}
	}
	producerPeerIDs := []string{}
	if oldPeer {
		producerPeerIDs = append(producerPeerIDs, old.ParentPeerID)
	}
	if att.tuple.Kind == UpstreamPeer {
		producerPeerIDs = append(producerPeerIDs, att.tuple.ParentPeerID)
	} else {
		producerPeerIDs = append(producerPeerIDs, c.hostPeerID)
	}
	for _, producerPeerID := range dedupeStrings(producerPeerIDs) {
		for _, childPeerID := range c.childrenOf(producerPeerID) {
			delete(c.senderQualityObservations, childPeerID)
			c.senderQualityBaselines[childPeerID] = true
		}
	}
	c.requireSenderQualityBaseline(op.childPeerID, true)
	if sameParentRegeneration {
		c.senderQualityBaselines[op.childPeerID] = false
	} else {
		c.senderQualityBaselines[op.childPeerID] = op.reason == DemandQualityConvergence || op.reason == DemandRootConvergence
	}
	if sameParentRegeneration &&
		att.tuple.Kind == UpstreamPeer &&
		att.parentSessionID != "" &&
		att.senderQualityIdentity != "" {
		c.senderQualityRegenerationBlocks[op.childPeerID] = senderQualityIdentity{
			childSessionID:  op.childSessionID,
			parentPeerID:    att.tuple.ParentPeerID,
			parentSessionID: att.parentSessionID,
			connectionID:    att.connectionID,
			senderIdentity:  att.senderQualityIdentity,
		}
	} else {
		delete(c.senderQualityRegenerationBlocks, op.childPeerID)
	}
	c.revision = att.revision
	c.operation = nil
	c.pruneRetiringSfuAnchors()
	c.touchFacts()
	if createsHostRoot {
		c.stageRootConvergence(op.childPeerID)
	}
	if current, ok := c.participants.Get(op.childPeerID); ok {
		current.availabilityExhausted = false
		current.bootstrapFailureReported = false
	}
	if old != nil && old.Kind == UpstreamSfu && !c.hasSfuSubscribers() && c.hostPublication != nil {
		c.hostPublication = nil
	}
	if op.reason == DemandSfuBootstrap && att.tuple.Kind == UpstreamSfu {
		if demand, ok := c.participants.Get(op.demandPeerID); ok && demand.sessionIs(op.demandSessionID) {
			demand.sfuFirstAtNextRoute = true
		}
		c.sfuBootstrapIntent = nil
	} else if c.usableRoute(op.demandPeerID) {
		c.clearSfuBootstrapForDemand(op.demandPeerID)
	}
	c.assertGraph()
	c.debug("route-committed",
		"child", c.debugPeer(op.childPeerID),
		"route", c.debugTuple(att.tuple),
		"revision", att.revision)
	after := &resourceSet{}
	after.add(c.committedResources()...)
	released := []*Resource{}
	for _, resource := range before.list {
		if !after.has(resource) {
			released = append(released, resource)
		}
	}
	if att.reservation.Overlap != nil {
		released = append(released, att.reservation.Overlap)
	}
	return released
}

// advanceActiveRevision ports 4088.
func (c *Controller) advanceActiveRevision(op *operation) {
	if op.reason == DemandQualityConvergence && op.current != nil {
		producerPeerID := c.hostPeerID
		if op.current.tuple.Kind == UpstreamPeer {
			producerPeerID = op.current.tuple.ParentPeerID
		}
		regeneratingChild := op.current.tuple.Kind == UpstreamPeer && op.current.tuple.Regenerate
		for _, childPeerID := range c.childrenOf(producerPeerID) {
			if regeneratingChild && childPeerID == op.childPeerID {
				// A failed same-edge trial must not turn the retained sender into a
				// global baseline block. Its exact candidate opportunity owns retry
				// damping while the retained sender identity remains current.
				continue
			}
			delete(c.senderQualityObservations, childPeerID)
			c.senderQualityBaselines[childPeerID] = true
		}
	}
	c.revision = c.allocateRevision()
	op.baseRevision = c.revision
}

// blockAndClear ports 4112.
func (c *Controller) blockAndClear(op *operation, block bool, released *[]*Resource, revisionAdvanced bool) {
	child, _ := c.participants.Get(op.childPeerID)
	c.operation = nil
	retiredInvalid := false
	if block && child != nil {
		retiredInvalid = c.retireInvalidOperationEdge(op.childPeerID, released)
	}
	if retiredInvalid && !revisionAdvanced {
		c.revision = c.allocateRevision()
	}
	if retiredInvalid {
		c.touchFacts()
	}
	if !block || child == nil {
		return
	}
	child.availabilityExhausted = true
}

// replanRemaining ports 4164: re-plans the suffix from the cursor, forcing
// firstTuple into the first slot and appending restoreTuple when absent.
func (c *Controller) replanRemaining(op *operation, firstTuple, restoreTuple *CandidateTuple) {
	// Ordering site §4.4 #34.
	cursor := min(op.cursor, len(op.candidates))
	prefix := append([]CandidatePlan{}, op.candidates[:cursor]...)
	tuples := make([]CandidateTuple, 0, len(op.candidates)-cursor+2)
	for _, candidate := range op.candidates[cursor:] {
		tuples = append(tuples, candidate.Tuple)
	}
	if firstTuple != nil {
		if len(tuples) == 0 {
			tuples = append(tuples, *firstTuple)
		} else {
			tuples[0] = *firstTuple
		}
	}
	if restoreTuple != nil {
		restoreKey := tupleKey(*restoreTuple)
		if !slices.ContainsFunc(tuples, func(tuple CandidateTuple) bool { return tupleKey(tuple) == restoreKey }) {
			tuples = append(tuples, *restoreTuple)
		}
	}
	replanned := prefix
	for _, tuple := range tuples {
		plan := c.planCandidate(op.childPeerID, tuple)
		if plan != nil && c.operationCandidateValid(op, *plan, nil) {
			replanned = append(replanned, *plan)
		}
	}
	op.candidates = replanned
	op.builtAtFactVersion = c.factVersion
}

// operationSnapshot ports 4190: a deep copy plus the derived wakeAtMs;
// Current omits ConnectionAttempt when undefined.
func (c *Controller) operationSnapshot() *OperationSnapshot {
	op := c.operation
	if op == nil {
		return nil
	}
	candidates := make([]CandidatePlan, 0, len(op.candidates))
	for _, candidate := range op.candidates {
		candidates = append(candidates, cloneCandidatePlan(candidate))
	}
	snapshot := &OperationSnapshot{
		ChildPeerID:    op.childPeerID,
		ChildSessionID: op.childSessionID,
		DemandPeerID:   op.demandPeerID,
		Reason:         op.reason,
		BaseRevision:   op.baseRevision,
		FactVersion:    op.builtAtFactVersion,
		Candidates:     candidates,
		Cursor:         op.cursor,
		DeadlineAtMs:   op.deadlineAtMs,
		WakeAtMs:       c.operationWakeAt(op),
	}
	if op.current != nil {
		current := &CurrentAttempt{
			Tuple:        op.current.tuple,
			Revision:     op.current.revision,
			ConnectionID: op.current.connectionID,
		}
		if op.current.connectionAttempt != nil {
			progress := *op.current.connectionAttempt
			current.ConnectionAttempt = &progress
		}
		snapshot.Current = current
	}
	return snapshot
}

// advanceExpiredDirectHeadStart ports 4208.
func (c *Controller) advanceExpiredDirectHeadStart(op *operation, nowMs int64, released *[]*Resource) bool {
	currentTuple := op.currentTuple()
	sfuIndex := c.foregroundSfuIndex(op)
	if currentTuple == nil || currentTuple.Kind != UpstreamPeer ||
		(op.current != nil && op.current.transportConnected) ||
		sfuIndex <= op.cursor {
		return false
	}
	headStartDeadlineAtMs := c.directHeadStartDeadlineAt(op)
	if nowMs < headStartDeadlineAtMs {
		return false
	}
	var activeCandidate any
	if op.current != nil {
		activeCandidate = c.debugTuple(op.current.tuple)
		c.noteRejection(op.demandPeerID, RejectionFirstFrameTimeout)
		c.consumeCurrentAvailabilityOpportunity(op)
		*released = append(*released, reservationResources(op.current.reservation)...)
		c.advanceActiveRevision(op)
		op.current = nil
		c.clearCandidateTiming(op.demandPeerID)
	}
	// Ordering site §4.4 #33: deferred parents keep candidate order.
	for _, candidate := range op.candidates[op.cursor:min(sfuIndex, len(op.candidates))] {
		if candidate.Tuple.Kind == UpstreamPeer {
			op.deferredParentPeerIDs = append(op.deferredParentPeerIDs, candidate.Tuple.ParentPeerID)
		}
	}
	op.cursor = sfuIndex
	c.debug("direct-head-start-expired",
		"child", c.debugPeer(op.childPeerID),
		"activeCandidate", activeCandidate,
		"cursor", op.cursor,
		"deadlineAtMs", headStartDeadlineAtMs,
		"observedAtMs", nowMs)
	return true
}

// operationWakeAt ports 4258.
func (c *Controller) operationWakeAt(op *operation) int64 {
	currentTuple := op.currentTuple()
	if currentTuple != nil && currentTuple.Kind == UpstreamPeer &&
		!(op.current != nil && op.current.transportConnected) &&
		c.foregroundSfuIndex(op) > op.cursor {
		return c.directHeadStartDeadlineAt(op)
	}
	if op.current != nil && op.current.tuple.Kind == UpstreamPeer &&
		!op.current.transportConnected &&
		c.peerCandidateHasSuccessor(op) {
		return min(op.deadlineAtMs, op.current.startedAtMs+c.directHeadStartMs())
	}
	return op.deadlineAtMs
}

// peerCandidateHasSuccessor ports 4281.
func (c *Controller) peerCandidateHasSuccessor(op *operation) bool {
	return op.cursor+1 < len(op.candidates) || c.foregroundSfuIndex(op) > op.cursor
}

// directHeadStartDeadlineAt ports 4290.
func (c *Controller) directHeadStartDeadlineAt(op *operation) int64 {
	return op.deadlineAtMs - c.operationTimeoutMs + c.directHeadStartMs()
}

// foregroundSfuIndex ports 4299: the index of the first SFU candidate at or
// after the cursor, the candidate count when a bootstrap carrier exists, -1
// otherwise (and always -1 for background convergence).
func (c *Controller) foregroundSfuIndex(op *operation) int {
	if isBackgroundConvergence(op.reason) {
		return -1
	}
	for index := max(op.cursor, 0); index < len(op.candidates); index++ {
		if op.candidates[index].Tuple.Kind == UpstreamSfu {
			return index
		}
	}
	if c.bootstrapCandidateAvailable(op.demandPeerID) {
		return len(op.candidates)
	}
	return -1
}

// promoteNextDirectWithinHeadStart ports 4314 (§4.4 #32).
func (c *Controller) promoteNextDirectWithinHeadStart(op *operation, nowMs int64) {
	sfuIndex := c.foregroundSfuIndex(op)
	if sfuIndex != op.cursor+1 || nowMs >= c.directHeadStartDeadlineAt(op) {
		return
	}
	nextDirectIndex := -1
	for index := sfuIndex + 1; index < len(op.candidates); index++ {
		if op.candidates[index].Tuple.Kind == UpstreamPeer {
			nextDirectIndex = index
			break
		}
	}
	if nextDirectIndex < 0 {
		return
	}
	nextDirect := op.candidates[nextDirectIndex]
	op.candidates = slices.Delete(op.candidates, nextDirectIndex, nextDirectIndex+1)
	op.candidates = slices.Insert(op.candidates, sfuIndex, nextDirect)
}

// guardMatches ports 4338.
func (c *Controller) guardMatches(guard CandidateGuard, op *operation, att *attempt) bool {
	return guard.ChildPeerID == op.childPeerID && guard.ChildSessionID == op.childSessionID &&
		guard.Revision == att.revision && guard.ConnectionID == att.connectionID
}

// cursorGuardMatches ports 4343.
func (c *Controller) cursorGuardMatches(guard CandidateCursorGuard, op *operation) bool {
	plan := op.planAt(op.cursor)
	return plan != nil &&
		guard.ChildPeerID == op.childPeerID &&
		guard.ChildSessionID == op.childSessionID && guard.BaseRevision == op.baseRevision &&
		guard.FactVersion == op.builtAtFactVersion && guard.Cursor == op.cursor &&
		candidatePlanEquals(guard.Plan, *plan)
}

// selectNextChild ports 3451: five priority buckets, first-occurrence
// dedupe, then a STABLE sort by started attempts (§4.5 #42).
func (c *Controller) selectNextChild() string {
	viewers := c.availableViewers(false)
	departedParents := []string{}
	unusable := []string{}
	staleSfu := []string{}
	withoutEdge := []string{}
	for _, viewer := range viewers {
		edge, _ := c.upstreamByViewer.Get(viewer.peerID)
		if edge != nil && edge.Kind == UpstreamPeer {
			if parent, ok := c.participants.Get(edge.ParentPeerID); ok && parent.departureConfirmed {
				departedParents = append(departedParents, viewer.peerID)
			}
		}
		if edge != nil && !edge.Usable {
			unusable = append(unusable, viewer.peerID)
		}
		if edge != nil && edge.Kind == UpstreamSfu &&
			(c.hostPublication == nil || !c.hostPublication.Usable || c.hostPublication.Generation != edge.PublicationGeneration) {
			staleSfu = append(staleSfu, viewer.peerID)
		}
		if edge == nil {
			withoutEdge = append(withoutEdge, viewer.peerID)
		}
	}
	overflow := c.overflowChildren()
	candidates := dedupeStrings(slices.Concat(departedParents, overflow, unusable, staleSfu, withoutEdge))
	sort.SliceStable(candidates, func(i, j int) bool {
		return c.viewerAttemptsStarted(candidates[i]) < c.viewerAttemptsStarted(candidates[j])
	})
	if len(candidates) == 0 {
		return ""
	}
	return candidates[0]
}

// directContinuationPick is the selectDirectContinuation result.
type directContinuationPick struct {
	childPeerID string
	plan        CandidatePlan
}

// selectDirectContinuation ports 3477 (§4.3 #23-25): a stable sort over
// the round-robin map order, then the first valid parent per child.
func (c *Controller) selectDirectContinuation() *directContinuationPick {
	type entry struct {
		childPeerID  string
		continuation *directContinuation
	}
	entries := []entry{}
	for childPeerID, continuation := range c.directContinuations.All() {
		entries = append(entries, entry{childPeerID, continuation})
	}
	sort.SliceStable(entries, func(i, j int) bool {
		return c.viewerAttemptsStarted(entries[i].childPeerID) < c.viewerAttemptsStarted(entries[j].childPeerID)
	})
	for _, current := range entries {
		childPeerID, continuation := current.childPeerID, current.continuation
		child, _ := c.participants.Get(childPeerID)
		edge, _ := c.upstreamByViewer.Get(childPeerID)
		if child == nil || child.sessionID == "" ||
			child.departureConfirmed ||
			!child.sessionIs(continuation.childSessionID) ||
			edge == nil || edge.Kind != UpstreamSfu ||
			!edge.Usable ||
			!edge.PhysicalActive ||
			edge.ConnectionID != continuation.sfuConnectionID ||
			edge.PublicationGeneration != continuation.publicationGeneration ||
			c.hostPublication == nil || !c.hostPublication.Usable ||
			!c.hostPublication.PhysicalActive ||
			c.hostPublication.Generation != continuation.publicationGeneration {
			c.directContinuations.Delete(childPeerID)
			continue
		}
		parents := append([]string{}, continuation.parentPeerIDs...)
		sort.SliceStable(parents, func(i, j int) bool {
			return c.peerAttemptsStarted(childPeerID, parents[i]) < c.peerAttemptsStarted(childPeerID, parents[j])
		})
		for _, parentPeerID := range parents {
			tuple := CandidateTuple{Kind: UpstreamPeer, ParentPeerID: parentPeerID, Transport: TransportDirect}
			plan := c.planCandidate(childPeerID, tuple)
			if plan != nil &&
				plan.EndpointTransition.Kind != TransitionBoundedGap &&
				c.candidateValid(childPeerID, *plan, nil) &&
				(!c.natPredictionEnabled || c.candidateOpportunityAvailable(childPeerID, *plan)) {
				return &directContinuationPick{childPeerID: childPeerID, plan: *plan}
			}
		}
		if len(continuation.parentPeerIDs) == 0 {
			c.directContinuations.Delete(childPeerID)
			c.debug("direct-convergence-complete", "child", c.debugPeer(childPeerID), "route", "sfu")
		}
	}
	return nil
}

// consumeDirectContinuationCandidate ports 3564: removes the tried parent
// from the retry order (re-appending it while NAT attempts remain) and
// moves the continuation to the tail of the round-robin (§4.3 #24, #26).
func (c *Controller) consumeDirectContinuationCandidate(op *operation) {
	tuple := op.currentTuple()
	if op.reason != DemandDirectConvergence || tuple == nil || tuple.Kind != UpstreamPeer {
		return
	}
	continuation, ok := c.directContinuations.Get(op.childPeerID)
	if !ok {
		return
	}
	index := slices.Index(continuation.parentPeerIDs, tuple.ParentPeerID)
	if index < 0 {
		return
	}
	continuation.parentPeerIDs = slices.Delete(continuation.parentPeerIDs, index, index+1)
	plan := op.planAt(op.cursor)
	if op.current != nil && op.current.connectionAttempt != nil &&
		plan != nil &&
		c.candidateOpportunityAvailable(op.childPeerID, *plan) {
		continuation.parentPeerIDs = append(continuation.parentPeerIDs, tuple.ParentPeerID)
	}
	c.debug("direct-convergence-advanced",
		"child", c.debugPeer(op.childPeerID),
		"parent", c.debugPeer(tuple.ParentPeerID),
		"remaining", len(continuation.parentPeerIDs))
	if len(continuation.parentPeerIDs) == 0 {
		c.directContinuations.Delete(op.childPeerID)
	} else {
		// TS delete + set: the entry moves to the tail (round-robin state).
		c.directContinuations.MoveToBack(op.childPeerID, continuation)
	}
}
