package portmapping

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type fakeGateway struct {
	mu      sync.Mutex
	added   []int
	deleted []int
	addErr  error
}

func (gateway *fakeGateway) AddPortMapping(
	_ context.Context,
	_ string,
	port int,
	_ string,
	_ time.Duration,
) (int, error) {
	gateway.mu.Lock()
	defer gateway.mu.Unlock()
	gateway.added = append(gateway.added, port)
	if gateway.addErr != nil {
		return 0, gateway.addErr
	}
	return port + 1, nil
}
func (gateway *fakeGateway) DeletePortMapping(
	_ context.Context,
	_ string,
	port int,
) error {
	gateway.mu.Lock()
	defer gateway.mu.Unlock()
	gateway.deleted = append(gateway.deleted, port)
	return nil
}

func TestMappingCreatesOnceAndReleases(t *testing.T) {
	original := discoverGateway
	t.Cleanup(func() { discoverGateway = original })
	fake := &fakeGateway{}
	discoverGateway = func(context.Context) (gateway, error) {
		return fake, nil
	}

	mapping := Start(43210)
	if port := mapping.Prepare(); port != 43211 {
		t.Fatalf("mapped port = %d, want 43211", port)
	}
	if port := mapping.Prepare(); port != 43211 {
		t.Fatalf("cached mapped port = %d, want 43211", port)
	}
	mapping.Close()
	mapping.Close()

	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.added) != 1 || fake.added[0] != 43210 {
		t.Fatalf("added ports = %v, want [43210]", fake.added)
	}
	if len(fake.deleted) != 1 || fake.deleted[0] != 43210 {
		t.Fatalf("deleted ports = %v, want [43210]", fake.deleted)
	}
}

func TestMappingAbsenceLeavesICEAvailable(t *testing.T) {
	original := discoverGateway
	t.Cleanup(func() { discoverGateway = original })
	discoverGateway = func(context.Context) (gateway, error) {
		return nil, errors.New("no mapping service")
	}

	mapping := Start(43210)
	mapping.Prepare()
	mapping.Close()
}

func TestMappingFailureIsNotRetriedForEveryEdge(t *testing.T) {
	original := discoverGateway
	t.Cleanup(func() { discoverGateway = original })
	fake := &fakeGateway{addErr: errors.New("mapping rejected")}
	discoverGateway = func(context.Context) (gateway, error) {
		return fake, nil
	}

	mapping := Start(43210)
	mapping.Prepare()
	mapping.Prepare()
	mapping.Close()

	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.added) != 1 || len(fake.deleted) != 0 {
		t.Fatalf("mapping calls = add %v delete %v", fake.added, fake.deleted)
	}
}

func TestRenewalFailureKeepsTheOriginalMappingOwnedUntilClose(t *testing.T) {
	original := discoverGateway
	t.Cleanup(func() { discoverGateway = original })
	fake := &fakeGateway{}
	discoverGateway = func(context.Context) (gateway, error) {
		return fake, nil
	}

	mapping := Start(43210)
	mapping.Prepare()
	mapping.mu.Lock()
	mapping.renewAfter = time.Now().Add(-time.Second)
	mapping.mu.Unlock()
	fake.mu.Lock()
	fake.addErr = errors.New("renewal rejected")
	fake.mu.Unlock()
	mapping.Prepare()
	mapping.Close()

	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.added) != 2 || len(fake.deleted) != 1 || fake.deleted[0] != 43210 {
		t.Fatalf("mapping calls = add %v delete %v", fake.added, fake.deleted)
	}
}

func TestMappingDiscoveryStopsWithTheShare(t *testing.T) {
	original := discoverGateway
	t.Cleanup(func() { discoverGateway = original })
	discoverGateway = func(ctx context.Context) (gateway, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}

	mapping := Start(43210)
	done := make(chan struct{})
	go func() {
		mapping.Close()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("mapping close did not cancel discovery")
	}
}
