package sfutest

// The behaviour tests/fake-sfu-room-control.ts guarantees to the scenarios that
// use it, so a signaling or app test can rely on it the same way.

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Screener/internal/server/sfu"
)

func fence(publicationGeneration string) sfu.ResourceFence {
	return sfu.ResourceFence{
		RoomID:                "42",
		ShareGeneration:       "share_generation_12345678",
		PublicationGeneration: publicationGeneration,
	}
}

func TestFakeInitializeDrainsSeededRooms(t *testing.T) {
	fake := New()
	first := fence("publication_generation_12345678")
	second := fence("publication_generation_87654321")
	fake.SeedRoom(first, "host")
	fake.SeedRoom(second)
	barrier := make(chan struct{})
	fake.SetInitializeBarrier(barrier)

	done := make(chan error, 1)
	go func() { done <- fake.Initialize(context.Background()) }()
	// The call is counted before the barrier, which is what a startup test that
	// asserts "initialize was entered" observes.
	waitFor(t, "the initialize call", func() bool { return fake.InitializeCalls() == 1 })
	if fake.RoomCount() != 2 {
		t.Fatalf("rooms = %d, want the seeded pair", fake.RoomCount())
	}

	close(barrier)
	if err := <-done; err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	if names := fake.StartupDeletedRoomNames(); !slices.Equal(names,
		[]string{sfu.ManagedRoomName(first), sfu.ManagedRoomName(second)}) {
		t.Fatalf("startup deleted = %v, want both rooms in seeding order", names)
	}
	if fake.RoomCount() != 0 {
		t.Fatalf("rooms = %d, want none", fake.RoomCount())
	}
}

func TestFakeInitializeReportsInjectedFailure(t *testing.T) {
	fake := New()
	failure := errors.New("startup reconciliation failed")
	fake.SetInitializeError(failure)
	fake.SeedRoom(fence("publication_generation_12345678"))

	if err := fake.Initialize(context.Background()); !errors.Is(err, failure) {
		t.Fatalf("Initialize error = %v, want %v", err, failure)
	}
	if fake.RoomCount() != 1 {
		t.Fatal("a failed initialize must not clear the rooms")
	}
}

func TestFakeRecordsRoomLifecycle(t *testing.T) {
	fake := New()
	ctx := context.Background()
	current := fence("publication_generation_12345678")
	roomName := sfu.ManagedRoomName(current)

	if err := fake.CreateRoom(ctx, current); err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	if err := fake.CreateRoom(ctx, current); err == nil {
		t.Fatal("a duplicate room must be refused")
	}
	if !fake.CanJoin(roomName) {
		t.Fatal("the created room must accept a join")
	}
	if created := fake.Created(); !slices.Equal(created, []sfu.ResourceFence{current}) {
		t.Fatalf("created = %v", created)
	}

	fake.SetFailDelete(true)
	if err := fake.DeleteRoom(ctx, current); err == nil {
		t.Fatal("the injected delete failure must surface")
	}
	if !fake.CanJoin(roomName) || len(fake.Deleted()) != 0 {
		t.Fatal("a failed delete must change nothing")
	}
	fake.SetFailDelete(false)
	if err := fake.DeleteRoom(ctx, current); err != nil {
		t.Fatalf("DeleteRoom: %v", err)
	}
	if fake.CanJoin(roomName) {
		t.Fatal("the deleted room must not accept a join")
	}
	if deleted := fake.Deleted(); !slices.Equal(deleted, []sfu.ResourceFence{current}) {
		t.Fatalf("deleted = %v", deleted)
	}
}

func TestFakeDrainsOnlyTheExactViewer(t *testing.T) {
	fake := New()
	ctx := context.Background()
	current := fence("publication_generation_12345678")
	roomName := sfu.ManagedRoomName(current)
	fake.SeedRoom(current, "host", "viewer:viewer_peer_12345678", "viewer:other_peer_12345678")
	barrier := make(chan struct{})
	fake.SetSubscriptionDrainBarrier(barrier)

	subscription := sfu.SubscriptionFence{
		ResourceFence: current,
		ViewerPeerID:  "viewer_peer_12345678",
	}
	done := make(chan error, 1)
	go func() { done <- fake.DrainSubscription(ctx, subscription) }()
	// The attempt is recorded before the barrier; the removal is not.
	waitFor(t, "the drain attempt", func() bool {
		return len(fake.SubscriptionDrainAttempts()) == 1
	})
	if len(fake.DrainedSubscriptions()) != 0 {
		t.Fatal("the drain must not complete before its barrier")
	}

	close(barrier)
	if err := <-done; err != nil {
		t.Fatalf("DrainSubscription: %v", err)
	}
	if participants := fake.Participants(roomName); !slices.Equal(participants,
		[]string{"host", "viewer:other_peer_12345678"}) {
		t.Fatalf("participants = %v", participants)
	}
	if drained := fake.DrainedSubscriptions(); !slices.Equal(drained,
		[]sfu.SubscriptionFence{subscription}) {
		t.Fatalf("drained = %v", drained)
	}
}

func TestFakeHostParticipantExists(t *testing.T) {
	fake := New()
	ctx := context.Background()
	hosted := fence("publication_generation_12345678")
	empty := fence("publication_generation_87654321")
	fake.SeedRoom(hosted, "host")
	fake.SeedRoom(empty, "viewer:viewer_peer_12345678")

	for _, testCase := range []struct {
		fence sfu.ResourceFence
		want  bool
	}{{hosted, true}, {empty, false}, {fence("publication_generation_11112222"), false}} {
		exists, err := fake.HostParticipantExists(ctx, testCase.fence)
		if err != nil {
			t.Fatalf("HostParticipantExists: %v", err)
		}
		if exists != testCase.want {
			t.Fatalf("HostParticipantExists(%s) = %v, want %v",
				testCase.fence.PublicationGeneration, exists, testCase.want)
		}
	}

	fake.SetFailHostCheck(true)
	if _, err := fake.HostParticipantExists(ctx, hosted); err == nil {
		t.Fatal("the injected host-check failure must surface")
	}
}

func TestFakeReleasesBlockedCallsOnCancellation(t *testing.T) {
	fake := New()
	fake.SetCreateBarrier(make(chan struct{}))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := fake.CreateRoom(ctx, fence("publication_generation_12345678")); err == nil {
		t.Fatal("a cancelled context must release the barrier")
	}
}

// waitFor is vitest's vi.waitFor: poll until the condition holds.
func waitFor(t *testing.T, description string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", description)
}
