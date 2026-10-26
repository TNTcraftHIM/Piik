package app

import (
	"context"
	"net"
	"net/netip"
	"strings"
	"testing"

	"github.com/TNTcraftHIM/Piik/internal/media/forwarding"
	"github.com/TNTcraftHIM/Piik/internal/server/config"
	"github.com/TNTcraftHIM/Piik/internal/server/sfu"
)

func TestSFUPublicHostnameStartsTheExistingMediaRuntime(t *testing.T) {
	configuration := testConfig(t)
	configuration.SFU = &config.SFUConfig{ListenHost: "127.0.0.1", Port: 0, PublicIP: "localhost"}
	server := start(t, Options{Config: configuration})
	fence := sfu.ResourceFence{RoomID: "1234", ShareGeneration: "share_12345678", PublicationGeneration: "publication_12345678"}
	metadata := sfu.PublicationMedia{Codec: "vp8", RIDs: []string{""}, Formats: []forwarding.LayerFormat{{Width: 640, Height: 360, Bitrate: 1_000_000}}}
	if err := server.media.PreparePublication(fence, "publisher_12345678", metadata); err != nil {
		t.Fatalf("hostname-backed media initialization: %v", err)
	}
}

func TestSFUPublicAddressResolvesOnlyAtRuntime(t *testing.T) {
	for _, input := range []string{"", "198.51.100.5", "localhost"} {
		value, err := resolveSFUPublicIP(t.Context(), input)
		if err != nil {
			t.Fatal(err)
		}
		if input != "localhost" {
			if value != input {
				t.Fatalf("literal %q changed to %q", input, value)
			}
			continue
		}
		address, err := netip.ParseAddr(value)
		if err != nil || !address.Is4() || !address.IsLoopback() {
			t.Fatalf("localhost must resolve to a literal IPv4 candidate: %q, %v", value, err)
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := resolveSFUPublicIP(ctx, "unresolved.invalid"); err == nil || !strings.Contains(err.Error(), "SFU_PUBLIC_IP could not resolve") {
		t.Fatalf("DNS failure must identify the configured SFU address: %v", err)
	}
}

func TestSFUPublicDNSFailureClosesOwnedListeners(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	configuration := testConfig(t)
	configuration.SFU = &config.SFUConfig{ListenHost: "127.0.0.1", Port: 0, PublicIP: "unresolved.invalid"}
	server := newServer(t, Options{Config: configuration, Listeners: []net.Listener{listener}})
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err = server.Listen(ctx); err == nil || !strings.Contains(err.Error(), "SFU_PUBLIC_IP could not resolve") {
		t.Fatalf("startup must report the DNS failure: %v", err)
	}
	assertPortFree(t, listener.Addr().(*net.TCPAddr).Port)
}
