package pcp

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"
)

type fakeGatewayDiscoverer struct{}

func (f *fakeGatewayDiscoverer) Discover(ctx context.Context) (net.IP, net.IP, error) {
	return nil, nil, errors.New("no IPv4 route")
}
func (f *fakeGatewayDiscoverer) DiscoverV6(ctx context.Context) (net.IP, net.IP, string, error) {
	return net.ParseIP("::1"), net.ParseIP("::1"), "", nil
}

// A v6 pinhole opened alongside a failed v4 mapping must be rolled back: the
// caller treats the whole mapping as failed and never deletes it.
func TestAddPortMappingRollsBackIPv6OnIPv4Failure(t *testing.T) {
	server4 := newFakePCPServer(t, "udp4", "127.0.0.1:5351")
	server6 := newFakePCPServer(t, "udp6", "[::1]:5351")

	// Seed the v4 mapping with a foreign nonce so the v4 MAP fails fast with
	// NOT_AUTHORIZED while the v6 pinhole succeeds.
	server4.mu.Lock()
	server4.mappings[mappingKey{proto: ProtoTCP, port: 1234}] = [12]byte{1}
	server4.mu.Unlock()

	client := NewClient(net.ParseIP("127.0.0.1"))
	client.SetLocalIP(net.ParseIP("127.0.0.1"))
	client6 := NewClient(net.ParseIP("::1"))
	client6.SetLocalIP(net.ParseIP("::1"))
	nat := &NAT{client: client, client6: client6}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := nat.AddPortMapping(ctx, "tcp", 1234, "", time.Minute); err == nil {
		t.Fatal("AddPortMapping() error = nil, want v4 NOT_AUTHORIZED")
	}
	if server6.hasMapping(ProtoTCP, 1234) {
		t.Fatal("v6 pinhole still open after failed v4 mapping")
	}
	if err := nat.IPv6PinholeError(); !errors.Is(err, errPinholeRolledBack) {
		t.Fatalf("IPv6PinholeError() = %v, want it to report the rollback", err)
	}
}

// When the rollback itself fails the pinhole stays open, so reporting that it
// was closed would be a lie the caller cannot check.
func TestAddPortMappingReportsPinholeLeftOpen(t *testing.T) {
	server4 := newFakePCPServer(t, "udp4", "127.0.0.1:5351")
	server6 := newFakePCPServer(t, "udp6", "[::1]:5351")

	// A foreign nonce fails the v4 MAP with NOT_AUTHORIZED. The v6 pinhole
	// opens, but the server then refuses to release it.
	server4.mu.Lock()
	server4.mappings[mappingKey{proto: ProtoTCP, port: 1234}] = [12]byte{1}
	server4.mu.Unlock()
	server6.mu.Lock()
	server6.refuseDeletes = true
	server6.mu.Unlock()

	client := NewClient(net.ParseIP("127.0.0.1"))
	client.SetLocalIP(net.ParseIP("127.0.0.1"))
	client6 := NewClient(net.ParseIP("::1"))
	client6.SetLocalIP(net.ParseIP("::1"))
	nat := &NAT{client: client, client6: client6}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := nat.AddPortMapping(ctx, "tcp", 1234, "", time.Minute); err == nil {
		t.Fatal("AddPortMapping() error = nil, want v4 NOT_AUTHORIZED")
	}

	pinholeErr := nat.IPv6PinholeError()
	if !errors.Is(pinholeErr, errPinholeLeftOpen) {
		t.Fatalf("IPv6PinholeError() = %v, want it to report the pinhole left open", pinholeErr)
	}
	var pcpErr *Error
	if !errors.As(pinholeErr, &pcpErr) || pcpErr.Code != ResultNoResources {
		t.Fatalf("IPv6PinholeError() = %v, want it to carry the delete failure", pinholeErr)
	}
	if !server6.hasMapping(ProtoTCP, 1234) {
		t.Fatal("fake server released a pinhole it refused to delete")
	}
}

// A failing v6 pinhole must not fail the call, since the IPv4 mapping the
// caller asked about is fine, but it must not be silently dropped either: the
// pinhole stays open and the caller needs to be able to see why.
func TestDeletePortMappingReportsIPv6Error(t *testing.T) {
	newFakePCPServer(t, "udp4", "127.0.0.1:5351")
	server6 := newFakePCPServer(t, "udp6", "[::1]:5351")

	// A pinhole whose nonce the client does not hold: the delete's fresh
	// nonce is answered with NOT_AUTHORIZED.
	server6.mu.Lock()
	server6.mappings[mappingKey{proto: ProtoTCP, port: 4321}] = [12]byte{1}
	server6.mu.Unlock()

	client := NewClient(net.ParseIP("127.0.0.1"))
	client.SetLocalIP(net.ParseIP("127.0.0.1"))
	client6 := NewClient(net.ParseIP("::1"))
	client6.SetLocalIP(net.ParseIP("::1"))
	nat := &NAT{client: client, client6: client6}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := nat.DeletePortMapping(ctx, "tcp", 4321); err != nil {
		t.Fatalf("DeletePortMapping() error = %v, want nil: an IPv6 pinhole does not fail the call", err)
	}

	pinholeErr := nat.IPv6PinholeError()
	if pinholeErr == nil {
		t.Fatal("IPv6PinholeError() = nil, want the v6 NOT_AUTHORIZED")
	}
	var pcpErr *Error
	if !errors.As(pinholeErr, &pcpErr) || pcpErr.Code != ResultNotAuthorized {
		t.Fatalf("IPv6PinholeError() = %v, want NOT_AUTHORIZED", pinholeErr)
	}
	if !server6.hasMapping(ProtoTCP, 4321) {
		t.Fatal("fake server dropped a mapping it answered with NOT_AUTHORIZED")
	}
}

// A dual-stack health check must announce on both servers, so that an IPv6
// restart is caught even when the IPv4 gateway is healthy.
func TestCheckServerHealthAnnouncesBothStacks(t *testing.T) {
	newFakePCPServer(t, "udp4", "127.0.0.1:5351")
	newFakePCPServer(t, "udp6", "[::1]:5351")

	client := NewClient(net.ParseIP("127.0.0.1"))
	client.SetLocalIP(net.ParseIP("127.0.0.1"))
	client6 := NewClient(net.ParseIP("::1"))
	client6.SetLocalIP(net.ParseIP("::1"))
	nat := &NAT{client: client, client6: client6}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	epoch, restarted, err := nat.CheckServerHealth(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if epoch == 0 {
		t.Fatal("CheckServerHealth() epoch = 0, want the IPv4 server's epoch")
	}
	if restarted {
		t.Fatal("CheckServerHealth() reported a restart on a first announce")
	}
	if client6.LastEpoch() == 0 {
		t.Fatal("IPv6 server was never announced to")
	}
}

// A successful IPv4 mapping must not wait out an unresponsive IPv6 server.
// Unbounded, the pinhole runs the full RFC 6887 §8.1.1 schedule and holds the
// mapping the caller actually asked for behind it for about 30 seconds.
func TestAddPortMappingDoesNotWaitOutAnUnresponsiveIPv6Server(t *testing.T) {
	newFakePCPServer(t, "udp4", "127.0.0.1:5351")
	server6 := newFakePCPServer(t, "udp6", "[::1]:5351")
	server6.mu.Lock()
	server6.silent = true
	server6.mu.Unlock()

	restore := pinholeTimeout
	pinholeTimeout = 50 * time.Millisecond
	t.Cleanup(func() { pinholeTimeout = restore })

	client := NewClient(net.ParseIP("127.0.0.1"))
	client.SetLocalIP(net.ParseIP("127.0.0.1"))
	client6 := NewClient(net.ParseIP("::1"))
	client6.SetLocalIP(net.ParseIP("::1"))
	nat := &NAT{client: client, client6: client6}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		if _, err := nat.AddPortMapping(ctx, "tcp", 1234, "", time.Minute); err != nil {
			t.Errorf("AddPortMapping() error = %v, want the IPv4 mapping to succeed", err)
		}
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("AddPortMapping is still waiting on the IPv6 pinhole")
	}

	if err := nat.IPv6PinholeError(); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("IPv6PinholeError() = %v, want the pinhole deadline", err)
	}
}

// A PCP-capable IPv6 gateway must be usable even when IPv4 discovery fails:
// v6-only networks still need firewall pinholes.
func TestDiscoverPCPIPv6WithoutIPv4(t *testing.T) {
	newFakePCPServer(t, "udp6", "[::1]:5351")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	nat, err := discoverPCP(ctx, &fakeGatewayDiscoverer{})
	if err != nil {
		t.Fatalf("DiscoverPCP() error = %v, want IPv6-only NAT when IPv4 discovery fails", err)
	}
	if nat.client6 == nil {
		t.Fatal("DiscoverPCP() NAT has no IPv6 client despite a working IPv6 gateway")
	}
}
