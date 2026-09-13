// Package nat implements NAT handling facilities
package nat

import (
	"context"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"net"
	"sync"
	"time"
)

var ErrNoExternalAddress = errors.New("no external address")
var ErrNoInternalAddress = errors.New("no internal address")
var ErrNoNATFound = errors.New("no NAT found")

// protocol is either "udp" or "tcp"
type NAT interface {
	// Type returns the kind of NAT port mapping service that is used
	Type() string

	// GetDeviceAddress returns the internal address of the gateway device.
	GetDeviceAddress() (addr net.IP, err error)

	// GetExternalAddress returns the external address of the gateway device.
	GetExternalAddress() (addr net.IP, err error)

	// GetInternalAddress returns the address of the local host.
	GetInternalAddress() (addr net.IP, err error)

	// AddPortMapping maps a port on the local host to an external port.
	AddPortMapping(ctx context.Context, protocol string, internalPort int, description string, timeout time.Duration) (mappedExternalPort int, err error)

	// DeletePortMapping removes a port mapping.
	DeletePortMapping(ctx context.Context, protocol string, internalPort int) (err error)
}

// HealthChecker is implemented by gateways that can report whether they still
// hold the mappings they were asked for, PCP being the only one today.
//
// Assert on this interface rather than on a concrete NAT type: a dual-stack
// gateway is a wrapper around the IPv4 NAT, so a type assertion misses it.
type HealthChecker interface {
	// CheckServerHealth reports the gateway's current epoch and whether it
	// appears to have lost state, in which case mappings must be recreated.
	CheckServerHealth(ctx context.Context) (epoch uint32, serverRestarted bool, err error)
}

// IPv6PinholeReporter is implemented by dual-stack gateways that open IPv6
// firewall pinholes alongside the IPv4 port mapping. Pinholes are best effort
// and never fail AddPortMapping or DeletePortMapping on their own, so this is
// the only way to find out whether one was actually opened.
type IPv6PinholeReporter interface {
	// IPv6PinholeError returns the error from the most recent IPv6 pinhole
	// operation, or nil when it succeeded.
	IPv6PinholeError() error
}

// DiscoverNATs returns all NATs discovered in the network.
// Callers choose between the returned protocols; use DiscoverGateway for
// PCP preference and automatic dual-stack mapping.
func DiscoverNATs(ctx context.Context) <-chan NAT {
	return mergeNATs(ctx, discoverFallbackNATs(ctx), discoverPCP(ctx))
}

func discoverFallbackNATs(ctx context.Context) <-chan NAT {
	return mergeNATs(ctx,
		discoverUPNP_IG1(ctx),
		discoverUPNP_IG2(ctx),
		discoverUPNP_Unicast(ctx),
		discoverUPNP_GenIGDev(ctx),
		discoverNATPMP(ctx),
	)
}

func mergeNATs(ctx context.Context, sources ...<-chan NAT) <-chan NAT {
	nats := make(chan NAT)
	var wg sync.WaitGroup

	for _, source := range sources {
		if source == nil {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case nat, ok := <-source:
					if !ok {
						return
					}
					select {
					case nats <- nat:
					case <-ctx.Done():
						return
					}
				case <-ctx.Done():
					return
				}
			}
		}()
	}

	go func() {
		wg.Wait()
		close(nats)
	}()
	return nats
}

// DiscoverGateway attempts to find a gateway device. It prefers PCP for IPv4,
// independently enables PCP for IPv6, then falls back to the first UPnP or
// NAT-PMP gateway discovered.
func DiscoverGateway(ctx context.Context) (NAT, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	return selectGateway(ctx, discoverPCPv4(ctx), discoverPCPv6(ctx), discoverFallbackNATs(ctx))
}

func selectGateway(ctx context.Context, pcp4s <-chan NAT, pcp6s <-chan pcpIPv6Client, fallbacks <-chan NAT) (NAT, error) {
	var found gatewaySelection

	// PCPv4 outranks the fallback protocols and PCPv6 is independent of both,
	// so neither PCP probe may be abandoned early. Fallback discovery only has
	// to yield its first result, or to finish empty-handed.
	settled := func() bool {
		return pcp4s == nil && pcp6s == nil &&
			(found.pcp4 != nil || found.fallback != nil || fallbacks == nil)
	}

	for !settled() {
		select {
		case gateway, ok := <-pcp4s:
			pcp4s = nil
			found.keepPCPv4(gateway, ok)
		case client, ok := <-pcp6s:
			pcp6s = nil
			found.keepPCPv6(client, ok)
		case gateway, ok := <-fallbacks:
			if !ok {
				fallbacks = nil
			}
			found.keepFallback(gateway, ok)
		case <-ctx.Done():
			// Sources publish into buffered channels, so a result discovered
			// just before the deadline is readable now. Take whatever is
			// there, then stop waiting on anything still in flight.
			for pcp4s != nil || pcp6s != nil || fallbacks != nil {
				select {
				case gateway, ok := <-pcp4s:
					pcp4s = nil
					found.keepPCPv4(gateway, ok)
				case client, ok := <-pcp6s:
					pcp6s = nil
					found.keepPCPv6(client, ok)
				case gateway, ok := <-fallbacks:
					if !ok {
						fallbacks = nil
					}
					found.keepFallback(gateway, ok)
				default:
					pcp4s, pcp6s, fallbacks = nil, nil, nil
				}
			}
		}
	}

	gateway, err := found.gateway()
	if err != nil && ctx.Err() != nil {
		// Nothing was found, but the deadline also passed, so the caller can
		// tell "this network has no NAT" from "the probes ran out of time".
		return nil, fmt.Errorf("%w: %w", err, ctx.Err())
	}
	return gateway, err
}

// gatewaySelection accumulates discovery results while selectGateway waits.
type gatewaySelection struct {
	pcp4     NAT
	pcp6     pcpIPv6Client
	fallback NAT
}

func (s *gatewaySelection) keepPCPv4(gateway NAT, ok bool) {
	if ok {
		s.pcp4 = gateway
	}
}

func (s *gatewaySelection) keepPCPv6(client pcpIPv6Client, ok bool) {
	if ok {
		s.pcp6 = client
	}
}

// keepFallback records the first fallback gateway offered; the rest are
// discarded, since any of them is as good as the others.
func (s *gatewaySelection) keepFallback(gateway NAT, ok bool) {
	if ok && s.fallback == nil {
		s.fallback = gateway
	}
}

func (s *gatewaySelection) gateway() (NAT, error) {
	gateway := s.pcp4
	if gateway == nil {
		gateway = s.fallback
	}
	if gateway == nil {
		return nil, ErrNoNATFound
	}
	if s.pcp6 != nil {
		gateway = newNATWithPCPIPv6(gateway, s.pcp6)
	}
	return gateway, nil
}

var (
	random   = rand.New(rand.NewSource(time.Now().UnixNano()))
	randomMu sync.Mutex
)

func randomPort() int {
	randomMu.Lock()
	defer randomMu.Unlock()
	return random.Intn(math.MaxUint16-10000) + 10000
}
