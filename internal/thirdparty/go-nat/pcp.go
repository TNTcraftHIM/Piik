package nat

import (
	"context"
	"time"

	"github.com/netbirdio/go-nat/pcp"
)

// pcpProbeTimeout bounds PCP discovery. A PCP server sits on the local link
// and answers in milliseconds, so the RFC 6887 §8.1.1 retransmission schedule
// that Client uses for mapping requests, four attempts spread over roughly 30
// seconds, would only delay falling back to UPnP or NAT-PMP on the far more
// common networks that speak no PCP at all.
const pcpProbeTimeout = 2 * time.Second

func discoverPCP(ctx context.Context) <-chan NAT {
	results := make(chan NAT, 1)
	go func() {
		defer close(results)

		ctx, cancel := context.WithTimeout(ctx, pcpProbeTimeout)
		defer cancel()

		gateway, err := pcp.DiscoverPCP(ctx)
		if err == nil {
			results <- gateway
		}
	}()
	return results
}

func discoverPCPv4(ctx context.Context) <-chan NAT {
	results := make(chan NAT, 1)
	go func() {
		defer close(results)

		ctx, cancel := context.WithTimeout(ctx, pcpProbeTimeout)
		defer cancel()

		gateway, err := pcp.DiscoverPCPIPv4(ctx)
		if err == nil {
			results <- gateway
		}
	}()
	return results
}

func discoverPCPv6(ctx context.Context) <-chan pcpIPv6Client {
	results := make(chan pcpIPv6Client, 1)
	go func() {
		defer close(results)

		ctx, cancel := context.WithTimeout(ctx, pcpProbeTimeout)
		defer cancel()

		client, err := pcp.DiscoverPCPIPv6(ctx)
		if err == nil {
			results <- client
		}
	}()
	return results
}
