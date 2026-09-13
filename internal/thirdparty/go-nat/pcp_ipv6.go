package nat

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/netbirdio/go-nat/pcp"
)

// pinholeTimeout bounds every best-effort IPv6 pinhole operation. The IPv4
// mapping is what the caller asked for, and it waits on the pinhole so the
// outcome can be reported, so an unresponsive IPv6 server must not hold it for
// the full RFC 6887 mapping retry schedule. It is a variable so tests can
// shorten it.
var pinholeTimeout = 5 * time.Second

var (
	// errPinholeRolledBack marks a pinhole that was opened and then closed
	// again because the IPv4 mapping it accompanied failed.
	errPinholeRolledBack = errors.New("rolled back after the IPv4 mapping failed")
	// errPinholeLeftOpen marks a pinhole that the rollback failed to close, so
	// it stays open until its lifetime expires.
	errPinholeLeftOpen = errors.New("left open after the IPv4 mapping failed")
)

// pcpIPv6Client is the part of pcp.Client needed for IPv6 pinholes. The
// interface keeps dual-stack behavior testable without network access.
type pcpIPv6Client interface {
	AddPortMapping(context.Context, string, int, time.Duration) (*pcp.MapResponse, error)
	DeletePortMapping(context.Context, string, int) error
	Announce(context.Context) (uint32, error)
	EpochStateLost() bool
}

// natWithPCPIPv6 adds best-effort PCPv6 pinholes to an IPv4 NAT. Pinholes
// complement the IPv4 mapping rather than replace it, because a peer reaching
// this host may have no IPv6 connectivity at all, so a pinhole failure never
// fails the call. Read IPv6PinholeError to find out what happened.
type natWithPCPIPv6 struct {
	NAT
	pcp6 pcpIPv6Client

	mu         sync.Mutex
	pinholeErr error
}

var (
	_ NAT                 = (*natWithPCPIPv6)(nil)
	_ HealthChecker       = (*natWithPCPIPv6)(nil)
	_ IPv6PinholeReporter = (*natWithPCPIPv6)(nil)
)

func newNATWithPCPIPv6(ipv4 NAT, pcp6 pcpIPv6Client) NAT {
	return &natWithPCPIPv6{NAT: ipv4, pcp6: pcp6}
}

// Type reports the IPv4 protocol with a PCPv6 suffix, so that a caller logging
// the gateway type can tell whether IPv6 pinholes are in play.
func (n *natWithPCPIPv6) Type() string {
	return n.NAT.Type() + "+PCPv6"
}

func (n *natWithPCPIPv6) IPv6PinholeError() error {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.pinholeErr
}

func (n *natWithPCPIPv6) setIPv6PinholeError(err error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.pinholeErr = err
}

func (n *natWithPCPIPv6) AddPortMapping(ctx context.Context, protocol string, internalPort int, description string, timeout time.Duration) (int, error) {
	pcp6Done := make(chan struct{})
	var pcp6Err error
	go func() {
		defer close(pcp6Done)
		pinholeCtx, cancel := context.WithTimeout(ctx, pinholeTimeout)
		defer cancel()
		_, pcp6Err = n.pcp6.AddPortMapping(pinholeCtx, protocol, internalPort, timeout)
	}()

	port, err := n.NAT.AddPortMapping(ctx, protocol, internalPort, description, timeout)
	<-pcp6Done

	if err != nil && pcp6Err == nil {
		pcp6Err = errPinholeRolledBack
		if rollbackErr := n.rollbackPinhole(ctx, protocol, internalPort); rollbackErr != nil {
			pcp6Err = fmt.Errorf("%w: %w", errPinholeLeftOpen, rollbackErr)
		}
	}

	n.setIPv6PinholeError(wrapPinholeErr(pcp6Err))
	return port, err
}

// rollbackPinhole closes a pinhole opened alongside an IPv4 mapping that then
// failed: the caller sees a failed mapping and will never delete it, so the
// pinhole would leak until its lifetime expires. Detached from ctx because the
// IPv4 failure may be the caller's deadline expiring.
func (n *natWithPCPIPv6) rollbackPinhole(ctx context.Context, protocol string, internalPort int) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), pinholeTimeout)
	defer cancel()
	return n.pcp6.DeletePortMapping(ctx, protocol, internalPort)
}

func (n *natWithPCPIPv6) DeletePortMapping(ctx context.Context, protocol string, internalPort int) error {
	pcp6Done := make(chan struct{})
	var pcp6Err error
	go func() {
		defer close(pcp6Done)
		pinholeCtx, cancel := context.WithTimeout(ctx, pinholeTimeout)
		defer cancel()
		pcp6Err = n.pcp6.DeletePortMapping(pinholeCtx, protocol, internalPort)
	}()

	err := n.NAT.DeletePortMapping(ctx, protocol, internalPort)
	<-pcp6Done

	n.setIPv6PinholeError(wrapPinholeErr(pcp6Err))
	return err
}

// CheckServerHealth reports the IPv4 gateway's epoch and whether either stack
// lost mapping state, since a PCPv6 server restart drops the pinhole even when
// the IPv4 gateway is healthy. An error is returned only when neither stack
// could be reached: one unreachable server is not evidence that it restarted,
// and reporting a restart would recreate a mapping that is very likely fine.
func (n *natWithPCPIPv6) CheckServerHealth(ctx context.Context) (uint32, bool, error) {
	// Bounded and concurrent: announced in series on the caller's context, an
	// unresponsive IPv6 server runs the full retry schedule and leaves nothing
	// for the IPv4 gateway, which disables health checking altogether.
	v6Done := make(chan struct{})
	var epoch6 uint32
	var err6 error
	go func() {
		defer close(v6Done)
		pinholeCtx, cancel := context.WithTimeout(ctx, pinholeTimeout)
		defer cancel()
		epoch6, err6 = n.pcp6.Announce(pinholeCtx)
	}()

	checker, ok := n.NAT.(HealthChecker)
	var epoch uint32
	var restarted bool
	var err error
	if ok {
		epoch, restarted, err = checker.CheckServerHealth(ctx)
	}

	<-v6Done
	restarted6 := err6 == nil && n.pcp6.EpochStateLost()

	if !ok {
		if err6 != nil {
			return 0, false, wrapPinholeErr(err6)
		}
		return epoch6, restarted6, nil
	}

	switch {
	case err != nil && err6 != nil:
		return 0, false, fmt.Errorf("%w; %w", err, wrapPinholeErr(err6))
	case err != nil:
		return epoch6, restarted6, nil
	}
	return epoch, restarted || restarted6, nil
}

func wrapPinholeErr(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("pcp ipv6: %w", err)
}
