package app

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/diagnostics"
)

// Pion advertises literal candidates, so DNS names resolve before creating peers.
func resolveSFUPublicIP(ctx context.Context, host string) (string, error) {
	if host == "" {
		return "", nil
	}
	if address, err := netip.ParseAddr(host); err == nil {
		return address.String(), nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip4", host)
	if err != nil {
		return "", fmt.Errorf("SFU_PUBLIC_IP could not resolve to IPv4: %w", err)
	}
	if len(addresses) == 0 {
		return "", fmt.Errorf("SFU_PUBLIC_IP has no IPv4 address: %s", host)
	}
	return addresses[0].Unmap().String(), nil
}

func (s *Server) startSFUDNSRefresh(host string) {
	if host == "" {
		return
	}
	if _, err := netip.ParseAddr(host); err == nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	s.stopSFUDNS = func() { cancel(); <-done }
	go func() {
		defer close(done)
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.refreshSFUPublicIP(ctx, host)
			}
		}
	}()
}

func (s *Server) refreshSFUPublicIP(ctx context.Context, host string) {
	address, err := resolveSFUPublicIP(ctx, host)
	if err != nil {
		if ctx.Err() == nil {
			s.logger.Debug("sfu-dns-refresh-failed", diagnostics.Error(err))
		}
		return
	}
	s.sfuPublicIP.Store(&address)
}
