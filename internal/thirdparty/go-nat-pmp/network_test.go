// Copyright 2026 Piik contributors. Licensed under Apache-2.0.
package natpmp

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"
)

func TestRequestCancellationAndDeadline(t *testing.T) {
	// The check runner serializes the gateway fixture packages on this endpoint.
	ip := net.IPv4(127, 0, 0, 1)
	for _, operation := range []string{"discovery", "mapping", "deletion"} {
		for _, cause := range []string{"cancel", "deadline", "client-timeout"} {
			t.Run(operation+"/"+cause, func(t *testing.T) {
				server, err := net.ListenUDP("udp4", &net.UDPAddr{IP: ip, Port: nAT_PMP_PORT})
				if err != nil {
					t.Fatal(err)
				}
				defer server.Close()
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				client := NewClient(ip)
				expected := error(context.Canceled)
				if cause == "deadline" {
					var deadlineCancel context.CancelFunc
					ctx, deadlineCancel = context.WithTimeout(ctx, 50*time.Millisecond)
					defer deadlineCancel()
					expected = context.DeadlineExceeded
				} else if cause == "client-timeout" {
					client = NewClientWithTimeout(ip, 50*time.Millisecond)
				}
				done := make(chan error, 1)
				go func() {
					var err error
					switch operation {
					case "discovery":
						_, err = client.GetExternalAddressContext(ctx)
					case "mapping":
						_, err = client.AddPortMappingContext(ctx, "udp", 43210, 45000, 7200)
					case "deletion":
						_, err = client.AddPortMappingContext(ctx, "udp", 43210, 0, 0)
					}
					done <- err
				}()
				_ = server.SetReadDeadline(time.Now().Add(time.Second))
				if _, _, err := server.ReadFromUDP(make([]byte, 64)); err != nil {
					t.Fatal(err)
				}
				if cause == "cancel" {
					cancel()
				}
				select {
				case err := <-done:
					if cause == "client-timeout" {
						if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
							t.Fatalf("client timeout error = %v", err)
						}
					} else if !errors.Is(err, expected) {
						t.Fatalf("error = %v, want %v", err, expected)
					}
				case <-time.After(time.Second):
					t.Fatal("socket request did not stop")
				}
				// Cancellation must end retransmissions, not only release the caller.
				_ = server.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
				if _, _, err := server.ReadFromUDP(make([]byte, 64)); err == nil {
					t.Fatal("received a retransmission after the call ended")
				}
			})
		}
	}
}
