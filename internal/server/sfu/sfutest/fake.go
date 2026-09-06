// Package sfutest holds the SFU test double the TypeScript suite kept in
// tests/fake-sfu-room-control.ts, so the signaling, router and app tests can
// drive the LiveKit fallback without a LiveKit.
package sfutest

import (
	"context"
	"errors"
	"sort"
	"sync"

	"github.com/TNTcraftHIM/Screener/internal/server/ordered"
	"github.com/TNTcraftHIM/Screener/internal/server/sfu"
)

// FakeRoomControl is FakeSfuRoomControl. Every field is guarded: unlike the
// single-threaded TypeScript, the router calls it from goroutines while the
// test asserts. A barrier is a channel the test closes to release the call;
// a nil barrier does not block, which is the TypeScript `await undefined`.
type FakeRoomControl struct {
	mu sync.Mutex
	// Ordering site: initialize reports the room names in insertion order.
	rooms                     ordered.Map[string, map[string]struct{}]
	created                   []sfu.ResourceFence
	deleted                   []sfu.ResourceFence
	subscriptionDrainAttempts []sfu.SubscriptionFence
	drainedSubscriptions      []sfu.SubscriptionFence
	startupDeletedRoomNames   []string
	initializeCalls           int
	initializeBarrier         chan struct{}
	initializeError           error
	createBarrier             chan struct{}
	subscriptionDrainBarrier  chan struct{}
	failDelete                bool
	failHostCheck             bool
}

var _ sfu.RoomControl = (*FakeRoomControl)(nil)

// New returns an empty fake.
func New() *FakeRoomControl { return &FakeRoomControl{} }

// Initialize records the call, then clears every room.
func (fake *FakeRoomControl) Initialize(ctx context.Context) error {
	fake.mu.Lock()
	fake.initializeCalls++
	barrier := fake.initializeBarrier
	fake.mu.Unlock()

	if err := wait(ctx, barrier); err != nil {
		return err
	}

	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.initializeError != nil {
		return fake.initializeError
	}
	fake.startupDeletedRoomNames = append(fake.startupDeletedRoomNames, fake.rooms.Keys()...)
	fake.rooms.Clear()
	return nil
}

// CreateRoom refuses a room name that already exists.
func (fake *FakeRoomControl) CreateRoom(ctx context.Context, fence sfu.ResourceFence) error {
	fake.mu.Lock()
	barrier := fake.createBarrier
	fake.mu.Unlock()

	if err := wait(ctx, barrier); err != nil {
		return err
	}
	roomName := sfu.ManagedRoomName(fence)

	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.rooms.Has(roomName) {
		return errors.New("room already exists")
	}
	fake.rooms.Set(roomName, map[string]struct{}{})
	fake.created = append(fake.created, fence)
	return nil
}

// DeleteRoom removes the room, whether or not it existed.
func (fake *FakeRoomControl) DeleteRoom(ctx context.Context, fence sfu.ResourceFence) error {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.failDelete {
		return errors.New("room deletion failed")
	}
	fake.rooms.Delete(sfu.ManagedRoomName(fence))
	fake.deleted = append(fake.deleted, fence)
	return nil
}

// DrainSubscription records the attempt before waiting, then removes the viewer.
func (fake *FakeRoomControl) DrainSubscription(ctx context.Context, fence sfu.SubscriptionFence) error {
	fake.mu.Lock()
	fake.subscriptionDrainAttempts = append(fake.subscriptionDrainAttempts, fence)
	barrier := fake.subscriptionDrainBarrier
	fake.mu.Unlock()

	if err := wait(ctx, barrier); err != nil {
		return err
	}

	fake.mu.Lock()
	defer fake.mu.Unlock()
	if participants, ok := fake.rooms.Get(sfu.ManagedRoomName(fence.ResourceFence)); ok {
		delete(participants, "viewer:"+fence.ViewerPeerID)
	}
	fake.drainedSubscriptions = append(fake.drainedSubscriptions, fence)
	return nil
}

// HostParticipantExists reports whether "host" joined the fenced room.
func (fake *FakeRoomControl) HostParticipantExists(
	_ context.Context,
	fence sfu.ResourceFence,
) (bool, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.failHostCheck {
		return false, errors.New("host check failed")
	}
	participants, ok := fake.rooms.Get(sfu.ManagedRoomName(fence))
	if !ok {
		return false, nil
	}
	_, joined := participants["host"]
	return joined, nil
}

// SeedRoom creates the fenced room with the given identities present.
func (fake *FakeRoomControl) SeedRoom(fence sfu.ResourceFence, identities ...string) {
	participants := make(map[string]struct{}, len(identities))
	for _, identity := range identities {
		participants[identity] = struct{}{}
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.rooms.Set(sfu.ManagedRoomName(fence), participants)
}

// CanJoin reports whether the room name exists.
func (fake *FakeRoomControl) CanJoin(roomName string) bool {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return fake.rooms.Has(roomName)
}

// RoomCount is rooms.size.
func (fake *FakeRoomControl) RoomCount() int {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return fake.rooms.Len()
}

// Participants lists the identities in a room, sorted for a stable assertion.
func (fake *FakeRoomControl) Participants(roomName string) []string {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	participants, ok := fake.rooms.Get(roomName)
	if !ok {
		return nil
	}
	identities := make([]string, 0, len(participants))
	for identity := range participants {
		identities = append(identities, identity)
	}
	sort.Strings(identities)
	return identities
}

// InitializeCalls is initializeCalls.
func (fake *FakeRoomControl) InitializeCalls() int {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return fake.initializeCalls
}

// StartupDeletedRoomNames is startupDeletedRoomNames.
func (fake *FakeRoomControl) StartupDeletedRoomNames() []string {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return append([]string(nil), fake.startupDeletedRoomNames...)
}

// Created is created.
func (fake *FakeRoomControl) Created() []sfu.ResourceFence {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return append([]sfu.ResourceFence(nil), fake.created...)
}

// Deleted is deleted.
func (fake *FakeRoomControl) Deleted() []sfu.ResourceFence {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return append([]sfu.ResourceFence(nil), fake.deleted...)
}

// SubscriptionDrainAttempts is subscriptionDrainAttempts.
func (fake *FakeRoomControl) SubscriptionDrainAttempts() []sfu.SubscriptionFence {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return append([]sfu.SubscriptionFence(nil), fake.subscriptionDrainAttempts...)
}

// DrainedSubscriptions is drainedSubscriptions.
func (fake *FakeRoomControl) DrainedSubscriptions() []sfu.SubscriptionFence {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return append([]sfu.SubscriptionFence(nil), fake.drainedSubscriptions...)
}

// SetInitializeBarrier blocks Initialize until barrier is closed.
func (fake *FakeRoomControl) SetInitializeBarrier(barrier chan struct{}) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.initializeBarrier = barrier
}

// SetInitializeError makes Initialize fail after its barrier.
func (fake *FakeRoomControl) SetInitializeError(err error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.initializeError = err
}

// SetCreateBarrier blocks CreateRoom until barrier is closed.
func (fake *FakeRoomControl) SetCreateBarrier(barrier chan struct{}) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.createBarrier = barrier
}

// SetSubscriptionDrainBarrier blocks DrainSubscription until barrier is closed.
func (fake *FakeRoomControl) SetSubscriptionDrainBarrier(barrier chan struct{}) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.subscriptionDrainBarrier = barrier
}

// SetFailDelete makes DeleteRoom fail.
func (fake *FakeRoomControl) SetFailDelete(fail bool) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.failDelete = fail
}

// SetFailHostCheck makes HostParticipantExists fail.
func (fake *FakeRoomControl) SetFailHostCheck(fail bool) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.failHostCheck = fail
}

// wait is `await barrier` with the Go escape hatch a cancelled context needs.
func wait(ctx context.Context, barrier chan struct{}) error {
	if barrier == nil {
		return nil
	}
	select {
	case <-barrier:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
