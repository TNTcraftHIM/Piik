package portmapping

import (
	"context"
	"sync"
	"time"

	nat "github.com/netbirdio/go-nat"
)

const (
	// Gateway discovery is link-local and must finish inside the existing
	// five-second direct-connection head start.
	attemptTimeout = 3 * time.Second
	deleteTimeout  = 2 * time.Second
	// RFC 6886 recommends a two-hour NAT-PMP lease; later edges renew it at
	// half-life without adding a background poller.
	leaseDuration = 2 * time.Hour
)

type gateway interface {
	AddPortMapping(context.Context, string, int, string, time.Duration) (int, error)
	DeletePortMapping(context.Context, string, int) error
}

var discoverGateway = func(ctx context.Context) (gateway, error) {
	return nat.DiscoverGateway(ctx)
}

// Mapping owns the best-effort lifetime of one UDP mapping. ICE remains fully
// functional when no mapping service is available.
type Mapping struct {
	localPort int
	cancel    context.CancelFunc
	ready     chan struct{}

	mu             sync.Mutex
	gateway        gateway
	attempted      bool
	mapped         bool
	externalPort   int
	deleteRequired bool
	renewAfter     time.Time
	closed         bool
}

func Start(localPort int) *Mapping {
	ctx, cancel := context.WithCancel(context.Background())
	mapping := &Mapping{
		localPort: localPort,
		cancel:    cancel,
		ready:     make(chan struct{}),
	}
	go mapping.discover(ctx)
	return mapping
}

func (mapping *Mapping) Prepare() int {
	<-mapping.ready
	mapping.mu.Lock()
	defer mapping.mu.Unlock()
	if mapping.closed || mapping.gateway == nil ||
		(mapping.attempted && !mapping.mapped) {
		return 0
	}
	if mapping.mapped && time.Now().Before(mapping.renewAfter) {
		return mapping.externalPort
	}
	ctx, cancel := context.WithTimeout(context.Background(), attemptTimeout)
	defer cancel()
	mapping.mapPortLocked(ctx)
	if !mapping.mapped {
		return 0
	}
	return mapping.externalPort
}

func (mapping *Mapping) Close() {
	mapping.cancel()
	<-mapping.ready
	mapping.mu.Lock()
	if mapping.closed {
		mapping.mu.Unlock()
		return
	}
	mapping.closed = true
	gateway := mapping.gateway
	deleteRequired := mapping.deleteRequired
	mapping.mapped = false
	mapping.externalPort = 0
	mapping.deleteRequired = false
	mapping.mu.Unlock()
	if gateway == nil || !deleteRequired {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), deleteTimeout)
	defer cancel()
	_ = gateway.DeletePortMapping(ctx, "udp", mapping.localPort)
}

func (mapping *Mapping) discover(parent context.Context) {
	defer close(mapping.ready)
	ctx, cancel := context.WithTimeout(parent, attemptTimeout)
	defer cancel()
	gateway, err := discoverGateway(ctx)
	if err != nil {
		return
	}
	mapping.mu.Lock()
	defer mapping.mu.Unlock()
	if mapping.closed || parent.Err() != nil {
		return
	}
	mapping.gateway = gateway
}

func (mapping *Mapping) mapPortLocked(ctx context.Context) {
	mapping.attempted = true
	externalPort, err := mapping.gateway.AddPortMapping(
		ctx, "udp", mapping.localPort, "Screener", leaseDuration,
	)
	if err != nil || externalPort < 1 || externalPort > 65535 {
		mapping.mapped = false
		mapping.externalPort = 0
		return
	}
	mapping.mapped = true
	mapping.externalPort = externalPort
	mapping.deleteRequired = true
	mapping.renewAfter = time.Now().Add(leaseDuration / 2)
}
