package pcp

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"
)

// externalAddressTimeout bounds GetExternalAddress, which the NAT interface
// gives no context of its own.
const externalAddressTimeout = 10 * time.Second

// pinholeTimeout bounds every best-effort IPv6 pinhole operation. The IPv4
// mapping is what the caller asked for, and it waits on the pinhole so the
// outcome can be reported, so an unresponsive IPv6 server must not hold it for
// the full RFC 6887 §8.1.1 mapping schedule. It is a variable so tests can
// shorten it.
var pinholeTimeout = 5 * time.Second

var (
	// ErrNoNATFound is returned when no PCP-capable gateway can be found.
	ErrNoNATFound = errors.New("no NAT found")
	// ErrNoInternalAddress is returned when the local address for the gateway is unavailable.
	ErrNoInternalAddress = errors.New("no internal address")

	// errPinholeRolledBack marks a pinhole that was opened and then closed
	// again because the IPv4 mapping it accompanied failed.
	errPinholeRolledBack = errors.New("rolled back after the IPv4 mapping failed")
	// errPinholeLeftOpen marks a pinhole that the rollback failed to close, so
	// it stays open until its lifetime expires.
	errPinholeLeftOpen = errors.New("left open after the IPv4 mapping failed")
)

type natInterface interface {
	Type() string
	GetDeviceAddress() (net.IP, error)
	GetExternalAddress() (net.IP, error)
	GetInternalAddress() (net.IP, error)
	AddPortMapping(context.Context, string, int, string, time.Duration) (int, error)
	DeletePortMapping(context.Context, string, int) error
}

var _ natInterface = (*NAT)(nil)

// NAT implements the go-nat NAT interface using PCP.
// It supports dual-stack (IPv4 and IPv6) when available.
// All methods are safe for concurrent use.
//
// TODO: IPv6 pinholes use the local IPv6 address. If the address changes
// (e.g. due to SLAAC rotation or network change), the pinhole becomes stale
// and needs to be recreated with the new address.
type NAT struct {
	client  *Client
	client6 *Client

	mu         sync.Mutex
	pinholeErr error
}

// NewNAT creates a new NAT instance backed by PCP.
func NewNAT(gateway, localIP net.IP) *NAT {
	client := NewClient(gateway)
	client.SetLocalIP(localIP)
	return &NAT{
		client: client,
	}
}

// Type returns "PCP" as the NAT type.
func (n *NAT) Type() string {
	return "PCP"
}

// primary returns the IPv4 client when present, falling back to the IPv6
// client for v6-only discovery. Discovery always leaves at least one of the
// two set, so a nil result means the NAT was built by hand.
func (n *NAT) primary() (*Client, error) {
	if n.client != nil {
		return n.client, nil
	}
	if n.client6 != nil {
		return n.client6, nil
	}
	return nil, ErrNoNATFound
}

// GetDeviceAddress returns the gateway IP address.
func (n *NAT) GetDeviceAddress() (net.IP, error) {
	client, err := n.primary()
	if err != nil {
		return nil, err
	}
	return client.Gateway(), nil
}

// GetExternalAddress returns the external IP address.
func (n *NAT) GetExternalAddress() (net.IP, error) {
	client, err := n.primary()
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), externalAddressTimeout)
	defer cancel()
	return client.GetExternalAddress(ctx)
}

// GetInternalAddress returns the local IP address used to communicate with the gateway.
func (n *NAT) GetInternalAddress() (net.IP, error) {
	client, err := n.primary()
	if err != nil {
		return nil, err
	}

	addr, err := client.getLocalIP()
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrNoInternalAddress, err)
	}
	return append(net.IP(nil), addr.AsSlice()...), nil
}

// IPv6PinholeError returns the error from the most recent IPv6 pinhole
// operation, or nil when it succeeded. Pinholes are best effort and never fail
// AddPortMapping or DeletePortMapping on their own, so this is the only way to
// find out whether one was actually opened.
func (n *NAT) IPv6PinholeError() error {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.pinholeErr
}

func (n *NAT) setPinholeErr(err error) {
	if err != nil {
		err = fmt.Errorf("pcp ipv6: %w", err)
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	n.pinholeErr = err
}

// AddPortMapping creates a port mapping on IPv4 and, when an IPv6 gateway was
// also discovered, a firewall pinhole on IPv6. The pinhole complements the
// IPv4 mapping rather than replacing it, because a peer reaching this host may
// have no IPv6 connectivity at all, so its failure does not fail the call.
func (n *NAT) AddPortMapping(ctx context.Context, protocol string, internalPort int, _ string, timeout time.Duration) (int, error) {
	if n.client == nil {
		resp, err := n.client6.AddPortMapping(ctx, protocol, internalPort, timeout)
		n.setPinholeErr(err)
		if err != nil {
			return 0, fmt.Errorf("add mapping: %w", err)
		}
		return int(resp.ExternalPort), nil
	}

	client6 := n.client6

	var client6Done chan struct{}
	var err6 error
	if client6 != nil {
		client6Done = make(chan struct{})
		go func() {
			defer close(client6Done)
			pinholeCtx, cancel := context.WithTimeout(ctx, pinholeTimeout)
			defer cancel()
			_, err6 = client6.AddPortMapping(pinholeCtx, protocol, internalPort, timeout)
		}()
	}

	resp, err := n.client.AddPortMapping(ctx, protocol, internalPort, timeout)
	if client6Done != nil {
		<-client6Done
	}
	if err != nil {
		if err6 == nil && client6 != nil {
			err6 = errPinholeRolledBack
			if rollbackErr := rollbackPinhole(ctx, client6, protocol, internalPort); rollbackErr != nil {
				err6 = fmt.Errorf("%w: %w", errPinholeLeftOpen, rollbackErr)
			}
		}
		n.setPinholeErr(err6)
		return 0, fmt.Errorf("add mapping: %w", err)
	}

	n.setPinholeErr(err6)
	return int(resp.ExternalPort), nil
}

// rollbackPinhole closes an IPv6 pinhole opened alongside a failed IPv4
// mapping: the caller sees a failed mapping and will never delete it, so the
// pinhole would leak until its lifetime expires. Detached from ctx because the
// IPv4 failure may be the caller's deadline expiring.
func rollbackPinhole(ctx context.Context, client6 *Client, protocol string, internalPort int) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), pinholeTimeout)
	defer cancel()
	return client6.DeletePortMapping(ctx, protocol, internalPort)
}

// DeletePortMapping removes the IPv4 mapping and, when present, the IPv6
// pinhole. As with AddPortMapping, a pinhole failure is reported through
// IPv6PinholeError rather than failing the call: the IPv4 mapping the caller
// asked about is gone either way, and the pinhole expires on its own.
func (n *NAT) DeletePortMapping(ctx context.Context, protocol string, internalPort int) error {
	if n.client == nil {
		err := n.client6.DeletePortMapping(ctx, protocol, internalPort)
		n.setPinholeErr(err)
		if err != nil {
			return fmt.Errorf("delete mapping: %w", err)
		}
		return nil
	}

	var client6Done chan struct{}
	var err6 error
	if n.client6 != nil {
		client6Done = make(chan struct{})
		go func() {
			defer close(client6Done)
			pinholeCtx, cancel := context.WithTimeout(ctx, pinholeTimeout)
			defer cancel()
			err6 = n.client6.DeletePortMapping(pinholeCtx, protocol, internalPort)
		}()
	}

	err := n.client.DeletePortMapping(ctx, protocol, internalPort)
	if client6Done != nil {
		<-client6Done
	}

	n.setPinholeErr(err6)
	if err != nil {
		return fmt.Errorf("delete mapping: %w", err)
	}
	return nil
}

// CheckServerHealth sends an ANNOUNCE to verify the servers are still
// responsive. It reports the primary server's epoch and whether either stack
// lost state, since an IPv6 restart drops the pinhole even when IPv4 is
// healthy. An error is returned only when neither stack could be reached: one
// unreachable server is not evidence that it restarted, and reporting a
// restart would recreate a mapping that is very likely fine.
func (n *NAT) CheckServerHealth(ctx context.Context) (epoch uint32, serverRestarted bool, err error) {
	client, err := n.primary()
	if err != nil {
		return 0, false, err
	}

	dualStack := n.client6 != nil && n.client6 != client

	// Bounded and concurrent: announced in series on the caller's context, an
	// unresponsive IPv6 server runs the full retry schedule and leaves nothing
	// for the IPv4 gateway, which disables health checking altogether.
	var v6Done chan struct{}
	var epoch6 uint32
	var err6 error
	if dualStack {
		v6Done = make(chan struct{})
		go func() {
			defer close(v6Done)
			pinholeCtx, cancel := context.WithTimeout(ctx, pinholeTimeout)
			defer cancel()
			epoch6, err6 = n.client6.Announce(pinholeCtx)
		}()
	}

	epoch, err = client.Announce(ctx)
	restarted := err == nil && client.EpochStateLost()

	if !dualStack {
		if err != nil {
			return 0, false, fmt.Errorf("announce: %w", err)
		}
		return epoch, restarted, nil
	}

	<-v6Done
	restarted6 := err6 == nil && n.client6.EpochStateLost()

	switch {
	case err != nil && err6 != nil:
		return 0, false, fmt.Errorf("announce: %w; pcp ipv6: %w", err, err6)
	case err != nil:
		return epoch6, restarted6, nil
	}
	return epoch, restarted || restarted6, nil
}

// DiscoverPCP attempts to discover PCP-capable IPv4 and IPv6 gateways
// independently. It fails only when neither is found, so a v6-only network
// still yields a NAT that can open firewall pinholes.
func DiscoverPCP(ctx context.Context) (*NAT, error) {
	return discoverPCP(ctx, &defaultGatewayDiscoverer{})
}

func discoverPCP(ctx context.Context, gds gatewayDiscoverer) (*NAT, error) {
	type v6Result struct {
		client *Client
		err    error
	}
	v6Ch := make(chan v6Result, 1)
	go func() {
		client, err := discoverPCPIPv6(ctx, gds)
		v6Ch <- v6Result{client, err}
	}()

	result, v4Err := discoverPCPIPv4(ctx, gds)
	v6 := <-v6Ch

	if v4Err != nil && v6.err != nil {
		return nil, errors.Join(v4Err, v6.err)
	}
	if result == nil {
		result = &NAT{}
	}
	if v6.err == nil {
		result.client6 = v6.client
	}
	return result, nil
}

// DiscoverPCPIPv4 discovers a PCP-capable IPv4 gateway.
func DiscoverPCPIPv4(ctx context.Context) (*NAT, error) {
	return discoverPCPIPv4(ctx, &defaultGatewayDiscoverer{})
}

func discoverPCPIPv4(ctx context.Context, gds gatewayDiscoverer) (*NAT, error) {
	gateway, localIP, err := gds.Discover(ctx)
	if err != nil {
		return nil, fmt.Errorf("get default gateway: %w", err)
	}

	result := NewNAT(gateway, localIP)
	if _, err := result.client.Announce(ctx); err != nil {
		return nil, fmt.Errorf("PCP announce: %w", err)
	}
	return result, nil
}

// DiscoverPCPIPv6 discovers a PCP-capable IPv6 gateway for firewall pinholes.
func DiscoverPCPIPv6(ctx context.Context) (*Client, error) {
	return discoverPCPIPv6(ctx, &defaultGatewayDiscoverer{})
}

func discoverPCPIPv6(ctx context.Context, gds gatewayDiscoverer) (*Client, error) {
	gateway, localIP, zone, err := gds.DiscoverV6(ctx)
	if err != nil {
		return nil, fmt.Errorf("get default IPv6 gateway: %w", err)
	}

	client := NewClient(gateway)
	if zone != "" {
		client.gateway = client.gateway.WithZone(zone)
	}
	client.SetLocalIP(localIP)
	if _, err := client.Announce(ctx); err != nil {
		return nil, fmt.Errorf("PCP IPv6 announce: %w", err)
	}
	return client, nil
}

// Discover is an alias for DiscoverPCP.
func Discover(ctx context.Context) (*NAT, error) {
	return discoverPCP(ctx, &defaultGatewayDiscoverer{})
}
