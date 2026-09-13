package portmapping

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/diagnostics"
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

	mu           sync.Mutex
	gateway      gateway
	attempted    bool
	mapped       bool
	externalPort int
	attemptDone  chan struct{}
	renewAfter   time.Time
	closed       bool
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
	attempted := mapping.attempted
	attemptDone := mapping.attemptDone
	mapping.mapped = false
	mapping.externalPort = 0
	mapping.mu.Unlock()
	if gateway == nil || !attempted {
		return
	}
	// A gateway call may still be finishing detached PCPv6 rollback. Allow
	// a brief settlement window before touching its mapping bookkeeping.
	if attemptDone != nil {
		select {
		case <-attemptDone:
		case <-time.After(deleteTimeout):
			return
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), deleteTimeout)
	defer cancel()
	err := gateway.DeletePortMapping(ctx, "udp", mapping.localPort)
	slog.Debug("nat-mapping", "event", "released", "localPort", mapping.localPort, diagnostics.Error(err))
}

func (mapping *Mapping) discover(parent context.Context) {
	defer close(mapping.ready)
	ctx, cancel := context.WithTimeout(parent, attemptTimeout)
	defer cancel()
	started := time.Now()
	gateway, err := discoverGateway(ctx)
	slog.Debug("nat-mapping", "event", "discovery", "localPort", mapping.localPort,
		"durationMs", time.Since(started).Milliseconds(), "available", err == nil, diagnostics.Error(err))
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
	// A request can succeed on the gateway even if its reply is lost. Close
	// must attempt cleanup once the request settles, including failed renewal.
	mapping.attempted = true
	// Keep the caller bounded even while a gateway finishes detached rollback.
	// The buffered result lets it settle after our wait ends. Failed attempts
	// are not retried by Prepare; Close waits before accessing its bookkeeping.
	type mappingResult struct {
		externalPort int
		err          error
	}
	result := make(chan mappingResult, 1)
	done := make(chan struct{})
	mapping.attemptDone = done
	go func() {
		defer close(done)
		externalPort, err := mapping.gateway.AddPortMapping(
			ctx, "udp", mapping.localPort, "Piik", leaseDuration,
		)
		result <- mappingResult{externalPort, err}
	}()
	var externalPort int
	var err error
	select {
	case outcome := <-result:
		externalPort, err = outcome.externalPort, outcome.err
	case <-ctx.Done():
		select {
		case outcome := <-result:
			externalPort, err = outcome.externalPort, outcome.err
		default:
			externalPort, err = 0, ctx.Err()
		}
	}
	slog.Debug("nat-mapping", "event", "mapping-result", "localPort", mapping.localPort,
		"externalPort", externalPort, "leaseSeconds", leaseDuration.Seconds(), diagnostics.Error(err))
	if err != nil || externalPort < 1 || externalPort > 65535 {
		mapping.mapped = false
		mapping.externalPort = 0
		return
	}
	mapping.mapped = true
	mapping.externalPort = externalPort
	mapping.renewAfter = time.Now().Add(leaseDuration / 2)
}
