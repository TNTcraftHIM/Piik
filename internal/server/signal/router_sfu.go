package signal

import (
	"context"
	"errors"

	"github.com/TNTcraftHIM/Screener/internal/server/protocol"
	"github.com/TNTcraftHIM/Screener/internal/server/route"
	"github.com/TNTcraftHIM/Screener/internal/server/sfu"
)

type drainKind string

const (
	drainPublication  drainKind = "publication"
	drainSubscription drainKind = "subscription"
)

// sfuDrainTask owns one asynchronous exact physical close.
type sfuDrainTask struct {
	kind      drainKind
	fence     sfu.SubscriptionFence
	operation *drainOperation
}

// drainOperation is the promise runSfuDrain tracked: done is closed after err
// is set, with mu held, so a waiter that relocks sees the settled task.
type drainOperation struct {
	done chan struct{}
	err  error
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

// releaseResources retires publications before their exact subscriptions.
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

// Reauthentication describes the existing physical connection without replacing it.
func (r *router) sendFreshSfuConfig(participant authenticatedRouteParticipant) {
	rm, _ := r.rooms.Get(participant.roomID)
	if r.sfu == nil || rm == nil || rm.controller == nil {
		return
	}
	snapshot := rm.controller.Snapshot()
	publication := snapshot.HostPublication
	if publication == nil || !publication.PhysicalActive {
		return
	}
	connectionID := publication.ConnectionID
	if participant.role == protocol.RoleViewer {
		edge, ok := snapshot.UpstreamByViewer.Get(participant.peerID)
		if !ok || edge.Kind != route.UpstreamSfu || !edge.PhysicalActive {
			return
		}
		connectionID = edge.ConnectionID
	}
	r.hooks.sendToSession(participant.sessionID, protocol.SfuConfigMessage{
		Type: "sfu-config", Revision: protocol.Int(snapshot.Revision),
		PublicationGeneration: publication.Generation, ConnectionID: connectionID,
	})
	if participant.role == protocol.RoleHost && publication.Resource != nil {
		if active, err := r.sfu.media.PublicationDemand(resourceFence(publication.Resource), connectionID); err == nil {
			count := protocol.Int(active)
			r.hooks.sendToSession(participant.sessionID, protocol.SfuSignalMessage{
				Type: "sfu-signal", Kind: "layers", Revision: protocol.Int(snapshot.Revision),
				PublicationGeneration: publication.Generation, ConnectionID: connectionID, ActiveCount: &count,
			})
		}
	}
}

// scheduleSfuPublicationDrain ports scheduleSfuPublicationDrain (O28: the
// sibling subscription tasks are deleted during the live iteration).
func (r *router) scheduleSfuPublicationDrain(fence sfu.ResourceFence) {
	for key, task := range r.sfuDrainTasks.All() {
		if task.kind == drainSubscription && task.fence.ResourceFence == fence {
			r.sfuDrainTasks.Delete(key)
		}
	}
	r.scheduleSfuDrain(drainPublication, sfu.SubscriptionFence{ResourceFence: fence})
}

// scheduleSfuSubscriptionDrain ports scheduleSfuSubscriptionDrain: a pending
// publication drain of the same room already removes every participant.
func (r *router) scheduleSfuSubscriptionDrain(fence sfu.SubscriptionFence) {
	if r.sfuDrainTasks.Has(sfu.SubscriptionFence{ResourceFence: fence.ResourceFence}) {
		return
	}
	r.scheduleSfuDrain(drainSubscription, fence)
}

// scheduleSfuDrain ports scheduleSfuDrain.
func (r *router) scheduleSfuDrain(kind drainKind, fence sfu.SubscriptionFence) {
	if r.sfu == nil {
		return
	}
	key := fence
	task, _ := r.sfuDrainTasks.Get(key)
	if task == nil {
		task = &sfuDrainTask{kind: kind, fence: fence}
		r.sfuDrainTasks.Set(key, task)
	}
	if task.operation == nil {
		// TS: void this.runSfuDrain(key, task).catch(() => undefined)
		r.runSfuDrain(key, task)
	}
}

// runSfuDrain performs physical close outside the authority mutex.
func (r *router) runSfuDrain(key sfu.SubscriptionFence, task *sfuDrainTask) *drainOperation {
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
	r.inflight++
	go func() {
		var err error
		if task.kind == drainPublication {
			err = fallback.media.ClosePublication(task.fence.ResourceFence)
		} else {
			err = fallback.media.CloseSubscription(task.fence, task.fence.ConnectionID)
		}
		r.mu.Lock()
		defer r.mu.Unlock()
		r.inflight--
		operation.err = r.settleSfuDrain(key, task, err)
		if task.operation == operation {
			task.operation = nil
		}
		close(operation.done)
	}()
	return operation
}

// A failed physical close remains charged until shutdown completes it.
func (r *router) settleSfuDrain(key sfu.SubscriptionFence, task *sfuDrainTask, err error) error {
	fallback := r.sfu
	if err == nil {
		if registered, _ := r.sfuDrainTasks.Get(key); registered != task {
			return nil
		}
		if task.kind == drainPublication && !fallback.admission.CompleteDrain(task.fence.ResourceFence) {
			err = errors.New("SFU drain has no matching resource generation")
		} else {
			if task.kind == drainSubscription {
				fallback.admission.CompleteSubscriptionDrain(task.fence)
			}
			r.sfuDrainTasks.Delete(key)
			r.wakeResourceWaiters()
			return nil
		}
	}
	return err
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
