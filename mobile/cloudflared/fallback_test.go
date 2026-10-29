//go:build silip_cloudflared

// Compiled by overlay into the pinned upstream supervisor package, not Silip.
package supervisor

import (
	"testing"
	"time"

	"github.com/cloudflare/cloudflared/connection"
	"github.com/cloudflare/cloudflared/retry"
	"github.com/quic-go/quic-go"
	"github.com/rs/zerolog"
)

func TestSilipExhaustedQuicHandshakeFallsBack(t *testing.T) {
	log := zerolog.Nop()
	for _, mode := range []string{"auto", "quic"} {
		t.Run(mode, func(t *testing.T) {
			selector, err := connection.NewProtocolSelector(mode, &log)
			if err != nil {
				t.Fatal(err)
			}
			failure := &connection.EdgeQuicDialError{Cause: &quic.HandshakeTimeoutError{}}
			rotate, classified := NewIPAddrFallback(0).ShouldGetNewAddress(0, failure)
			connectivity, ok := classified.(*ConnectivityError)
			if !rotate || !ok || !connectivity.HasReachedMaxRetries() {
				t.Fatal("first handshake did not exhaust the configured edge retry budget")
			}
			backoff := retry.NewBackoff(5, time.Millisecond, true)
			pending := &protocolFallback{backoff, connection.QUIC, false}
			pending.BackoffTimer() // Serve has waited its first backoff before selecting.
			selectNextProtocol(&log, pending, selector, failure)
			want := connection.QUIC
			if mode == "auto" {
				want = connection.HTTP2
			}
			if pending.protocol != want {
				t.Fatalf("protocol after first exhausted handshake = %s, want %s", pending.protocol, want)
			}
		})
	}
}
