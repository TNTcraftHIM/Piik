package signal

// The SFU side of hybrid-media-router.ts: reservation commit and release
// (1734-1786), subscription reservation across a pending drain (1788),
// resource waiters (1811), fresh SFU configuration (1865), the host-offline
// probe (1903-2013) and the LiveKit drains (2015-2089).

import (
	"context"
	"errors"
	"time"

	"github.com/TNTcraftHIM/Screener/internal/server/protocol"
	"github.com/TNTcraftHIM/Screener/internal/server/route"
	"github.com/TNTcraftHIM/Screener/internal/server/sfu"
)

type drainKind string

const (
	drainPublication  drainKind = "publication"
	drainSubscription drainKind = "subscription"
)

// sfuDrainTask is SfuDrainTask; fence.ViewerPeerID is "" for a publication.
// operation is the in-flight drain (TS task.operation); retryGeneration is
// bumped by clearDrainRetry so a retry callback that lost the Stop race sees
// it is stale (D5).
type sfuDrainTask struct {
	kind            drainKind
	fence           sfu.SubscriptionFence
	operation       *drainOperation
	retryStop       func() bool
	retryGeneration uint64
}

// drainOperation is the promise runSfuDrain tracked: done is closed after err
// is set, with mu held, so a waiter that relocks sees the settled task.
type drainOperation struct {
	done chan struct{}
	err  error
}

// turn is one slot in the per managed-room-name FIFO.
//
// The TS LiveKitSfuRoomControl.serialize registered every operation
// synchronously at call time, so operations on one managed room ran in the
// order the router decided them. In Go the RoomControl call happens after mu
// is released, and two goroutines could reach LiveKit in the opposite order
// (a drain deciding after a create but deleting the room before it exists).
// takeTurn therefore reserves the slot while mu is still held; run waits for
// the predecessor outside mu, performs the call and releases the successor;
// dropTurn forgets the tail entry once mu is held again. The sfu package's
// own serialisation then sees calls already in decision order. Only the
// mutating calls (CreateRoom, DeleteRoom, DrainSubscription) take a turn:
// their relative order is the correctness property; HostParticipantExists
// is a read whose result is re-validated against the controller anyway, and
// the TS suite's fake control never queued a drain behind it.
type turn struct {
	name     string
	previous chan struct{}
	done     chan struct{}
}

// takeTurn reserves the next slot for roomName. mu must be held.
func (r *router) takeTurn(roomName string) *turn {
	done := make(chan struct{})
	current := &turn{name: roomName, previous: r.roomTurns[roomName], done: done}
	r.roomTurns[roomName] = done
	return current
}

// run performs op in turn order. mu must NOT be held.
func (t *turn) run(op func()) {
	if t.previous != nil {
		<-t.previous
	}
	defer close(t.done)
	op()
}

// dropTurn removes the FIFO tail once it is this turn. mu must be held.
func (r *router) dropTurn(t *turn) {
	if r.roomTurns[t.name] == t.done {
		delete(r.roomTurns, t.name)
	}
}

// commitReservation ports commitReservation (O30: drained generations in
// admission order).
func (r *router) commitReservation(reservation route.CandidateReservation) bool {
	if reservation.Kind == route.ReservationDirect {
		return true
	}
	if reservation.Kind == route.ReservationSfuReuse {
		return reservation.Edge != nil &&
			reservation.Edge.Kind == route.ResourceSfuSubscription &&
			r.sfu != nil &&
			r.sfu.admission.CommitSubscription(subscriptionFence(reservation.Edge))
	}
	if reservation.Publication == nil || reservation.Publication.Kind != route.ResourceSfuPublication {
		return false
	}
	if r.sfu == nil {
		return false
	}
	draining, ok := r.sfu.admission.CommitPublication(resourceFence(reservation.Publication))
	if !ok {
		return false
	}
	for _, fence := range draining {
		r.scheduleSfuPublicationDrain(fence)
	}
	return true
}

func (r *router) releaseReservation(reservation route.CandidateReservation) {
	r.releaseResources(reservationResources(reservation))
}

// releaseResources ports releaseResources (O25). Publication drains own
// accounting; subscription drains only remove exact participants.
func (r *router) releaseResources(resources []*route.Resource) {
	for _, resource := range resources {
		if resource.Kind == route.ResourceSfuPublication {
			r.releaseResource(resource)
		}
	}
	for _, resource := range resources {
		if resource.Kind != route.ResourceSfuPublication {
			r.releaseResource(resource)
		}
	}
}

// releaseResource ports releaseResource: idempotent through Released.
func (r *router) releaseResource(resource *route.Resource) {
	if resource.Released {
		return
	}
	resource.Released = true
	switch resource.Kind {
	case route.ResourceOverlap:
		return
	case route.ResourceSfuSubscription:
		r.releaseSubscription(subscriptionFence(resource))
		return
	}
	if r.sfu != nil && r.sfu.admission.BeginDrain(resourceFence(resource)) {
		r.scheduleSfuPublicationDrain(resourceFence(resource))
	}
}

func (r *router) releaseSubscription(fence sfu.SubscriptionFence) bool {
	if r.sfu == nil {
		return false
	}
	accepted := r.sfu.admission.BeginSubscriptionDrain(fence)
	if accepted {
		r.scheduleSfuSubscriptionDrain(fence)
	}
	return accepted
}

// reserveSfuSubscription ports the synchronous tail of reserveSfuSubscription
// (1803-1808); the pending-drain wait before it (R10) lives in
// prepareCandidate, where the TS suspended.
func (r *router) reserveSfuSubscription(fence sfu.SubscriptionFence) bool {
	fallback := r.sfu
	if fallback == nil {
		return false
	}
	key := sfuDrainKey(drainSubscription, fence)
	if task, _ := r.sfuDrainTasks.Get(key); task != nil && task.kind == drainSubscription {
		r.clearDrainRetry(task)
		r.sfuDrainTasks.Delete(key)
	}
	return fallback.admission.ReserveSubscription(fence)
}

// wakeResourceWaiters ports wakeResourceWaiters (O29: snapshot order).
func (r *router) wakeResourceWaiters() {
	roomIDs := r.resourceWaiters.Keys()
	r.resourceWaiters.Clear()
	for _, roomID := range roomIDs {
		rm, _ := r.rooms.Get(roomID)
		if rm == nil || rm.controller == nil {
			continue
		}
		rm.controller.TouchExternalFacts()
		r.requestPump(roomID)
	}
}

// sendFreshSfuConfig ports sendFreshSfuConfig (R11). The pre-await guards run
// in the caller's critical section, as the TS ran them before its first
// await; the token is issued in a goroutine with mu released and the
// post-await guards re-run under mu with the pre-await snapshot. failed runs
// where the TS `.catch` ran and settled where `.finally` ran; both may be nil
// and both run under mu.
func (r *router) sendFreshSfuConfig(participant authenticatedRouteParticipant, failed, settled func()) {
	finish := func(err error) {
		if err != nil && failed != nil {
			failed()
		}
		if settled != nil {
			settled()
		}
	}
	fallback := r.sfu
	rm, _ := r.rooms.Get(participant.roomID)
	shareGeneration := r.hooks.shareGeneration(participant.roomID)
	if fallback == nil || rm == nil || rm.controller == nil {
		finish(nil)
		return
	}
	snapshot := rm.controller.Snapshot()
	publication := snapshot.HostPublication
	if publication == nil || !publication.PhysicalActive || shareGeneration == "" {
		finish(nil)
		return
	}
	isHost := participant.peerID == rm.hostPeerID
	if !isHost {
		edge, ok := snapshot.UpstreamByViewer.Get(participant.peerID)
		if !ok || edge.Kind != route.UpstreamSfu || !edge.PhysicalActive {
			finish(nil)
			return
		}
	}
	role := protocol.RoleViewer
	if isHost {
		role = protocol.RoleHost
	}
	request := sfu.TokenRequest{
		RoomID:                participant.roomID,
		Role:                  role,
		PeerID:                participant.peerID,
		ShareGeneration:       shareGeneration,
		PublicationGeneration: publication.Generation,
	}
	r.inflight++
	go func() {
		token, err := fallback.tokenIssuer.IssueToken(request)
		r.mu.Lock()
		defer r.mu.Unlock()
		r.inflight--
		if err != nil {
			finish(err)
			return
		}
		if rm.controller == nil {
			finish(nil)
			return
		}
		currentPublication := rm.controller.Publication()
		peer, connected := r.connectedPeer(participant.roomID, participant.peerID)
		if rm.controller.Revision() != snapshot.Revision ||
			currentPublication == nil ||
			currentPublication.Generation != publication.Generation ||
			!connected || peer.SessionID != participant.sessionID {
			finish(nil)
			return
		}
		r.hooks.sendToSession(participant.sessionID, protocol.SfuConfigMessage{
			Type:     "sfu-config",
			Revision: protocol.Int(snapshot.Revision),
			URL:      fallback.url,
			Token:    token,
		})
		finish(nil)
	}()
}

// activeHostPublication ports activeHostPublication.
func (r *router) activeHostPublication(roomID string) (hostOfflineCheck, bool) {
	rm, _ := r.rooms.Get(roomID)
	if rm == nil || rm.controller == nil {
		return hostOfflineCheck{}, false
	}
	publication := rm.controller.Publication()
	if publication == nil || !publication.PhysicalActive ||
		publication.Resource == nil || publication.Resource.Kind != route.ResourceSfuPublication {
		return hostOfflineCheck{}, false
	}
	return hostOfflineCheck{
		fence:         resourceFence(publication.Resource),
		hostSessionID: publication.HostSessionID,
		connectionID:  publication.ConnectionID,
	}, true
}

// scheduleHostOfflineCheck ports scheduleHostOfflineCheck (T7).
func (r *router) scheduleHostOfflineCheck(roomID, hostPeerID string) {
	r.cancelHostOfflineCheck(roomID)
	fallback := r.sfu
	publication, ok := r.activeHostPublication(roomID)
	if fallback == nil || !ok || r.closing {
		return
	}
	check := &publication
	check.hostPeerID = hostPeerID
	delay := fallback.hostOfflineCheckMs
	if delay == 0 {
		delay = defaultHostOfflineCheckMs
	}
	check.stop = r.afterFunc(time.Duration(delay)*time.Millisecond, func() {
		r.checkHostOffline(roomID, check)
	})
	r.hostOfflineChecks.Set(roomID, check)
}

// checkHostOffline ports checkHostOffline (R12) as the timer callback body.
// armed is the check the timer was armed with: a cleared TS timer never
// fired, so anything else registered for the room means return (D5).
func (r *router) checkHostOffline(roomID string, armed *hostOfflineCheck) {
	r.mu.Lock()
	defer r.mu.Unlock()
	check, _ := r.hostOfflineChecks.Get(roomID)
	fallback := r.sfu
	if check == nil || check != armed || fallback == nil || r.closing {
		return
	}
	if _, hostConnected := r.store.GetConnectedHost(roomID); hostConnected {
		r.cancelHostOfflineCheck(roomID)
		return
	}
	var exists bool
	var err error
	r.io(func() {
		exists, err = fallback.roomControl.HostParticipantExists(context.Background(), check.fence)
	})
	if err != nil {
		if registered, _ := r.hostOfflineChecks.Get(roomID); registered != check {
			return
		}
		r.hostOfflineChecks.Delete(roomID)
		r.scheduleHostOfflineCheck(roomID, check.hostPeerID)
		return
	}
	if registered, _ := r.hostOfflineChecks.Get(roomID); registered != check {
		return
	}
	r.hostOfflineChecks.Delete(roomID)
	if exists {
		r.scheduleHostOfflineCheck(roomID, check.hostPeerID)
		return
	}
	rm, _ := r.rooms.Get(roomID)
	if rm == nil || rm.controller == nil {
		return
	}
	controller := rm.controller
	snapshot := controller.Snapshot()
	publication := snapshot.HostPublication
	if publication == nil {
		return
	}
	// Hazard 9: six publication fields plus the fence triple; anything
	// short of that re-arms the check instead of retiring the publication.
	if publication.Resource == nil ||
		publication.Resource.Kind != route.ResourceSfuPublication ||
		resourceFence(publication.Resource) != check.fence ||
		publication.Generation != check.fence.PublicationGeneration ||
		publication.HostSessionID != check.hostSessionID ||
		publication.ConnectionID != check.connectionID ||
		!publication.PhysicalActive {
		r.scheduleHostOfflineCheck(roomID, check.hostPeerID)
		return
	}
	beforeRevision := snapshot.Revision
	controller.InvalidateHostPublication(route.PublicationGuard{
		HostSessionID: publication.HostSessionID,
		RouteRevision: snapshot.Revision,
		Generation:    publication.Generation,
		ConnectionID:  publication.ConnectionID,
	}, r.nowPtr())
	r.releaseResources(controller.RetireHostPublication(route.PublicationGuard{
		HostSessionID: publication.HostSessionID,
		RouteRevision: controller.Revision(),
		Generation:    publication.Generation,
		ConnectionID:  publication.ConnectionID,
	}))
	afterRetirement := controller.Publication()
	if afterRetirement != nil &&
		afterRetirement.Generation == publication.Generation &&
		afterRetirement.ConnectionID == publication.ConnectionID &&
		afterRetirement.PhysicalActive {
		if controller.Revision() != beforeRevision {
			r.broadcastActive(roomID, rm)
		}
		r.scheduleHostOfflineCheck(roomID, check.hostPeerID)
		r.requestPump(roomID)
		return
	}
	r.broadcastActive(roomID, rm)
	r.requestPump(roomID)
}

func (r *router) cancelHostOfflineCheck(roomID string) {
	if check, ok := r.hostOfflineChecks.Get(roomID); ok {
		check.stop()
	}
	r.hostOfflineChecks.Delete(roomID)
}

// scheduleSfuPublicationDrain ports scheduleSfuPublicationDrain (O28: the
// sibling subscription tasks are deleted during the live iteration).
func (r *router) scheduleSfuPublicationDrain(fence sfu.ResourceFence) {
	roomName := sfu.ManagedRoomName(fence)
	for key, task := range r.sfuDrainTasks.All() {
		if task.kind == drainSubscription && sfu.ManagedRoomName(task.fence.ResourceFence) == roomName {
			r.clearDrainRetry(task)
			r.sfuDrainTasks.Delete(key)
		}
	}
	r.scheduleSfuDrain(drainPublication, sfu.SubscriptionFence{ResourceFence: fence})
}

// scheduleSfuSubscriptionDrain ports scheduleSfuSubscriptionDrain: a pending
// publication drain of the same room already removes every participant.
func (r *router) scheduleSfuSubscriptionDrain(fence sfu.SubscriptionFence) {
	if r.sfuDrainTasks.Has(sfu.ManagedRoomName(fence.ResourceFence)) {
		return
	}
	r.scheduleSfuDrain(drainSubscription, fence)
}

// scheduleSfuDrain ports scheduleSfuDrain.
func (r *router) scheduleSfuDrain(kind drainKind, fence sfu.SubscriptionFence) {
	if r.sfu == nil {
		return
	}
	key := sfuDrainKey(kind, fence)
	task, _ := r.sfuDrainTasks.Get(key)
	if task == nil {
		task = &sfuDrainTask{kind: kind, fence: fence}
		r.sfuDrainTasks.Set(key, task)
	}
	if task.operation == nil && task.retryStop == nil {
		// TS: void this.runSfuDrain(key, task).catch(() => undefined)
		r.runSfuDrain(r.drainContext(), key, task)
	}
}

// runSfuDrain ports runSfuDrain (R13, R14). mu must be held; the returned
// operation is the tracked promise. The LiveKit call runs in a goroutine
// inside the room's FIFO turn taken here, and the post-await body runs under
// mu before done is closed.
func (r *router) runSfuDrain(ctx context.Context, key string, task *sfuDrainTask) *drainOperation {
	if task.operation != nil {
		return task.operation
	}
	operation := &drainOperation{done: make(chan struct{})}
	fallback := r.sfu
	if fallback == nil {
		close(operation.done)
		return operation
	}
	task.operation = operation
	turn := r.takeTurn(sfu.ManagedRoomName(task.fence.ResourceFence))
	r.inflight++
	go func() {
		var err error
		turn.run(func() {
			if task.kind == drainPublication {
				err = fallback.roomControl.DeleteRoom(ctx, task.fence.ResourceFence)
			} else {
				err = fallback.roomControl.DrainSubscription(ctx, task.fence)
			}
		})
		r.mu.Lock()
		defer r.mu.Unlock()
		r.inflight--
		r.dropTurn(turn)
		operation.err = r.settleSfuDrain(key, task, err)
		if task.operation == operation {
			task.operation = nil
		}
		close(operation.done)
	}()
	return operation
}

// settleSfuDrain is the post-await body of runSfuDrain: the try/catch after
// the LiveKit call. It returns the error the tracked promise rejected with.
func (r *router) settleSfuDrain(key string, task *sfuDrainTask, err error) error {
	fallback := r.sfu
	if err == nil {
		if registered, _ := r.sfuDrainTasks.Get(key); registered != task {
			return nil
		}
		if task.kind == drainPublication && !fallback.admission.CompleteDrain(task.fence.ResourceFence) {
			err = errors.New("LiveKit drain has no matching resource generation")
		} else {
			r.sfuDrainTasks.Delete(key)
			if task.kind == drainPublication {
				r.wakeResourceWaiters()
			} else {
				r.requestPump(task.fence.RoomID)
			}
			return nil
		}
	}
	// catch
	if registered, _ := r.sfuDrainTasks.Get(key); registered != task {
		return nil
	}
	if r.closing {
		return err
	}
	retryMs := fallback.drainRetryMs
	if retryMs == 0 {
		retryMs = defaultSfuDrainRetryMs
	}
	generation := task.retryGeneration
	task.retryStop = r.afterFunc(time.Duration(retryMs)*time.Millisecond, func() { // T8
		r.mu.Lock()
		defer r.mu.Unlock()
		if task.retryGeneration != generation || r.closing {
			return
		}
		task.retryStop = nil
		r.runSfuDrain(r.drainContext(), key, task)
	})
	return nil
}

// drainContext bounds the LiveKit drains: unbounded (the TS had none) until
// close installs its context (D6).
func (r *router) drainContext() context.Context {
	if r.closeCtx != nil {
		return r.closeCtx
	}
	return context.Background()
}

// clearDrainRetry is the clearTimeout(task.retryTimer) of the TS; bumping
// the generation retires a callback that already lost the Stop race.
func (r *router) clearDrainRetry(task *sfuDrainTask) {
	if task.retryStop != nil {
		task.retryStop()
		task.retryStop = nil
	}
	task.retryGeneration++
}

// awaitDrain is `await task.operation` inside close(): mu is released while
// waiting and re-acquired before returning; ctx bounds the wait (D6).
func (r *router) awaitDrain(ctx context.Context, operation *drainOperation) error {
	var err error
	r.io(func() {
		select {
		case <-operation.done:
			err = operation.err
		case <-ctx.Done():
			err = ctx.Err()
		}
	})
	return err
}

func sfuDrainKey(kind drainKind, fence sfu.SubscriptionFence) string {
	roomName := sfu.ManagedRoomName(fence.ResourceFence)
	if kind == drainPublication {
		return roomName
	}
	return roomName + "\x00viewer:" + fence.ViewerPeerID
}

// reservationResources ports reservationResources: a borrowed reuse edge
// belongs to another holder and is not released.
func reservationResources(reservation route.CandidateReservation) []*route.Resource {
	var resources []*route.Resource
	if reservation.Edge != nil && (reservation.Kind != route.ReservationSfuReuse || !reservation.Borrowed) {
		resources = append(resources, reservation.Edge)
	}
	if reservation.Publication != nil {
		resources = append(resources, reservation.Publication)
	}
	if reservation.Overlap != nil {
		resources = append(resources, reservation.Overlap)
	}
	return resources
}
