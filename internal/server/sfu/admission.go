// Package sfu owns admitted physical publication and subscription resources.
package sfu

import (
	"regexp"

	"github.com/TNTcraftHIM/Screener/internal/server/ordered"
	"github.com/TNTcraftHIM/Screener/internal/server/protocol"
)

// ResourceFence is SfuResourceFence. It is a comparable value, so the
// TypeScript cloneFence/sameFence helpers are a plain copy and `==`.
type ResourceFence struct {
	RoomID                string
	ShareGeneration       string
	PublicationGeneration string
}

// SubscriptionFence is SfuSubscriptionFence, which extends SfuResourceFence.
// The embedded value is the `{ ...fence, viewerPeerId }` spread the router
// uses to derive one from a publication fence.
type SubscriptionFence struct {
	ResourceFence
	ViewerPeerID string
	ConnectionID string
}

// Usage is SfuResourceUsage.
type Usage struct {
	Ingress int
	Egress  int
}

// AdmissionOptions is SfuResourceAdmissionOptions.
type AdmissionOptions struct {
	IngressCapacity int
	EgressCapacity  int
}

// resourceState is the TypeScript ResourceState union.
type resourceState string

const (
	stateReserved  resourceState = "reserved"
	stateCommitted resourceState = "committed"
	stateDraining  resourceState = "draining"
)

type subscriptionEntry struct {
	fence SubscriptionFence
	state resourceState
}

type publicationEntry struct {
	fence ResourceFence
	state resourceState
	// Ordering site: subscriptions are only counted, looked up by viewer and
	// state-scanned, so their iteration order is never observable. A plain map
	// is enough here; the two maps above it are ordered.
	subscriptions map[string]*subscriptionEntry
}

// roomPublications is RoomResources.publications. Ordering site: commitPublication
// returns the drained generations and beginDrainRoom returns every generation in
// insertion order, both of which the router turns into drain tasks.
type roomPublications = ordered.Map[string, *publicationEntry]

// Admission is SfuResourceAdmission: the ingress/egress ledger for the embedded SFU. It is not safe for concurrent use; the signaling server calls it
// under its global mutex, exactly as Node's single thread did.
type Admission struct {
	// Ordering site: beginDrainAll walks the rooms in insertion order.
	rooms           ordered.Map[string, *roomPublications]
	ingressCapacity int
	egressCapacity  int
	ingressInUse    int
	egressInUse     int
}

// NewAdmission mirrors the SfuResourceAdmission constructor. An invalid
// capacity panics where the TypeScript throws: the capacities come from a
// constant and from validated configuration, so this is an assertion.
func NewAdmission(options AdmissionOptions) *Admission {
	assertPositiveSafeInteger(options.IngressCapacity, "SFU ingress capacity")
	assertPositiveSafeInteger(options.EgressCapacity, "SFU egress capacity")
	return &Admission{
		ingressCapacity: options.IngressCapacity,
		egressCapacity:  options.EgressCapacity,
	}
}

// ReservePublication ports reservePublication.
func (admission *Admission) ReservePublication(fence ResourceFence) bool {
	assertFence(fence)
	room, _ := admission.rooms.Get(fence.RoomID)
	var existing *publicationEntry
	if room != nil {
		existing, _ = room.Get(publicationKey(fence))
	}
	if existing != nil {
		return existing.state != stateDraining && existing.fence == fence
	}
	if admission.ingressInUse >= admission.ingressCapacity {
		return false
	}
	if room != nil {
		for _, publication := range room.All() {
			if publication.state == stateReserved {
				return false
			}
		}
	}

	resources := room
	if resources == nil {
		resources = &roomPublications{}
	}
	resources.Set(publicationKey(fence), &publicationEntry{
		fence:         fence,
		state:         stateReserved,
		subscriptions: map[string]*subscriptionEntry{},
	})
	admission.rooms.Set(fence.RoomID, resources)
	admission.ingressInUse++
	return true
}

// ReserveSubscription ports reserveSubscription.
func (admission *Admission) ReserveSubscription(fence SubscriptionFence) bool {
	assertSubscriptionFence(fence)
	publication := admission.publication(fence.ResourceFence)
	if publication == nil || publication.state == stateDraining {
		return false
	}
	key := fence.ViewerPeerID + "\x00" + fence.ConnectionID
	if existing, ok := publication.subscriptions[key]; ok {
		return existing.fence == fence && existing.state != stateDraining
	}
	if admission.egressInUse >= admission.egressCapacity {
		return false
	}

	publication.subscriptions[key] = &subscriptionEntry{
		fence: fence,
		state: stateReserved,
	}
	admission.egressInUse++
	return true
}

// CommitPublication ports commitPublication. The second result is false where
// the TypeScript returns null; an empty slice with true is its empty array.
func (admission *Admission) CommitPublication(fence ResourceFence) ([]ResourceFence, bool) {
	assertFence(fence)
	room, _ := admission.rooms.Get(fence.RoomID)
	var publication *publicationEntry
	if room != nil {
		publication, _ = room.Get(publicationKey(fence))
	}
	if room == nil || publication == nil || publication.fence != fence {
		return nil, false
	}
	if publication.state == stateCommitted {
		return nil, true
	}
	if publication.state != stateReserved {
		return nil, false
	}
	reserved := false
	for _, subscription := range publication.subscriptions {
		if subscription.state == stateReserved {
			reserved = true
			break
		}
	}
	if !reserved {
		return nil, false
	}

	var draining []ResourceFence
	for _, other := range room.All() {
		if other == publication || other.state != stateCommitted {
			continue
		}
		markDraining(other)
		draining = append(draining, other.fence)
	}
	publication.state = stateCommitted
	for _, subscription := range publication.subscriptions {
		if subscription.state == stateReserved {
			subscription.state = stateCommitted
		}
	}
	return draining, true
}

// CommitSubscription ports commitSubscription.
func (admission *Admission) CommitSubscription(fence SubscriptionFence) bool {
	assertSubscriptionFence(fence)
	publication := admission.publication(fence.ResourceFence)
	if publication == nil || publication.state != stateCommitted {
		return false
	}
	subscription, ok := publication.subscriptions[fence.ViewerPeerID+"\x00"+fence.ConnectionID]
	if !ok || subscription.fence != fence {
		return false
	}
	if subscription.state == stateCommitted {
		return true
	}
	if subscription.state != stateReserved {
		return false
	}
	subscription.state = stateCommitted
	return true
}

// BeginSubscriptionDrain ports beginSubscriptionDrain.
func (admission *Admission) BeginSubscriptionDrain(fence SubscriptionFence) bool {
	assertSubscriptionFence(fence)
	publication := admission.publication(fence.ResourceFence)
	if publication == nil {
		return false
	}
	subscription, ok := publication.subscriptions[fence.ViewerPeerID+"\x00"+fence.ConnectionID]
	if !ok || subscription.fence != fence {
		return false
	}
	subscription.state = stateDraining
	return true
}

// BeginDrain ports beginDrain.
func (admission *Admission) BeginDrain(fence ResourceFence) bool {
	assertFence(fence)
	publication := admission.publication(fence)
	if publication == nil {
		return false
	}
	markDraining(publication)
	return true
}

func (admission *Admission) HasPublication(fence ResourceFence) bool {
	publication := admission.publication(fence)
	return publication != nil && publication.state != stateDraining
}

func (admission *Admission) HasSubscription(fence SubscriptionFence) bool {
	publication := admission.publication(fence.ResourceFence)
	if publication == nil || publication.state == stateDraining {
		return false
	}
	entry := publication.subscriptions[fence.ViewerPeerID+"\x00"+fence.ConnectionID]
	return entry != nil && entry.fence == fence && entry.state != stateDraining
}

// In-process closure revokes this exact connection; no reusable token remains.
func (admission *Admission) CompleteSubscriptionDrain(fence SubscriptionFence) bool {
	publication := admission.publication(fence.ResourceFence)
	if publication == nil {
		return false
	}
	key := fence.ViewerPeerID + "\x00" + fence.ConnectionID
	entry := publication.subscriptions[key]
	if entry == nil || entry.fence != fence || entry.state != stateDraining {
		return false
	}
	delete(publication.subscriptions, key)
	admission.subtractEgress(1)
	return true
}

// CompleteDrain ports completeDrain.
func (admission *Admission) CompleteDrain(fence ResourceFence) bool {
	assertFence(fence)
	room, _ := admission.rooms.Get(fence.RoomID)
	key := publicationKey(fence)
	var publication *publicationEntry
	if room != nil {
		publication, _ = room.Get(key)
	}
	if room == nil || publication == nil ||
		publication.state != stateDraining || publication.fence != fence {
		return false
	}

	room.Delete(key)
	admission.ingressInUse--
	admission.subtractEgress(len(publication.subscriptions))
	admission.assertNoUnderflow()
	if room.Len() == 0 {
		admission.rooms.Delete(fence.RoomID)
	}
	return true
}

// BeginDrainRoom ports beginDrainRoom.
func (admission *Admission) BeginDrainRoom(roomID string) []ResourceFence {
	if roomID == "" {
		panic("SFU resource room ID is invalid")
	}
	room, _ := admission.rooms.Get(roomID)
	if room == nil {
		return nil
	}
	for _, publication := range room.All() {
		markDraining(publication)
	}
	fences := make([]ResourceFence, 0, room.Len())
	for _, publication := range room.All() {
		fences = append(fences, publication.fence)
	}
	return fences
}

// BeginDrainAll ports beginDrainAll.
func (admission *Admission) BeginDrainAll() []ResourceFence {
	var fences []ResourceFence
	for _, roomID := range admission.rooms.Keys() {
		fences = append(fences, admission.BeginDrainRoom(roomID)...)
	}
	return fences
}

// Usage ports usage().
func (admission *Admission) Usage() Usage {
	return Usage{Ingress: admission.ingressInUse, Egress: admission.egressInUse}
}

func (admission *Admission) publication(fence ResourceFence) *publicationEntry {
	room, ok := admission.rooms.Get(fence.RoomID)
	if !ok {
		return nil
	}
	publication, ok := room.Get(publicationKey(fence))
	if !ok || publication.fence != fence {
		return nil
	}
	return publication
}

func (admission *Admission) subtractEgress(count int) {
	admission.egressInUse -= count
	admission.assertNoUnderflow()
}

func (admission *Admission) assertNoUnderflow() {
	if admission.ingressInUse < 0 || admission.egressInUse < 0 {
		panic("SFU resource accounting underflow")
	}
}

func markDraining(publication *publicationEntry) {
	publication.state = stateDraining
	for _, subscription := range publication.subscriptions {
		subscription.state = stateDraining
	}
}

func publicationKey(fence ResourceFence) string {
	return fence.ShareGeneration + "\x00" + fence.PublicationGeneration
}

func assertFence(fence ResourceFence) {
	if fence.RoomID == "" || fence.ShareGeneration == "" ||
		fence.PublicationGeneration == "" {
		panic("SFU resource fence is invalid")
	}
}

func assertSubscriptionFence(fence SubscriptionFence) {
	assertFence(fence.ResourceFence)
	if fence.ViewerPeerID == "" {
		panic("SFU subscription fence is invalid")
	}
}

// assertPositiveSafeInteger ports assertPositiveSafeInteger. Go's int makes the
// TypeScript Number.isSafeInteger fractional case unrepresentable; only the
// range checks survive.
func assertPositiveSafeInteger(value int, name string) {
	if value <= 0 || int64(value) > protocol.MaxSafeInteger {
		panic(name + " must be a positive safe integer")
	}
}

var roomIDPattern = regexp.MustCompile(`^[1-9][0-9]{0,11}$`)

func validResourceFence(fence ResourceFence) bool {
	return roomIDPattern.MatchString(fence.RoomID) &&
		protocol.ValidOpaqueID(fence.ShareGeneration) &&
		protocol.ValidOpaqueID(fence.PublicationGeneration)
}
