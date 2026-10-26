package app

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"time"
)

// Pion advertises literal candidates; a configured DDNS name is resolved once
// for this server lifetime, just like an explicitly configured public IPv4.
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
	return addresses[0].String(), nil
}
