package app

import (
	"context"
	"net"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/media/forwarding"
	"github.com/TNTcraftHIM/Piik/internal/server/config"
	"github.com/TNTcraftHIM/Piik/internal/server/sfu"
	"github.com/pion/ice/v4"
	"golang.org/x/net/dns/dnsmessage"
)

func TestSFUPublicDNSRefreshChangesNewVoiceCandidates(t *testing.T) {
	dns, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var address atomic.Uint32
	address.Store(5)
	done := make(chan struct{})
	go func() {
		defer close(done)
		var buffer [1500]byte
		for {
			n, peer, err := dns.ReadFrom(buffer[:])
			if err != nil {
				return
			}
			var query dnsmessage.Message
			if query.Unpack(buffer[:n]) != nil {
				continue
			}
			reply := dnsmessage.Message{Header: dnsmessage.Header{ID: query.ID, Response: true, RecursionDesired: query.RecursionDesired, RecursionAvailable: true}, Questions: query.Questions}
			last := address.Load()
			if last == 0 {
				reply.RCode = dnsmessage.RCodeNameError
			} else {
				for _, question := range query.Questions {
					if question.Type == dnsmessage.TypeA {
						reply.Answers = append(reply.Answers, dnsmessage.Resource{
							Header: dnsmessage.ResourceHeader{Name: question.Name, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET},
							Body:   &dnsmessage.AResource{A: [4]byte{198, 51, 100, byte(last)}},
						})
					}
				}
			}
			if packet, err := reply.Pack(); err == nil {
				_, _ = dns.WriteTo(packet, peer)
			}
		}
	}()
	t.Cleanup(func() { _ = dns.Close(); <-done })
	resolver := net.DefaultResolver
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "udp4", dns.LocalAddr().String())
	}}
	t.Cleanup(func() { net.DefaultResolver = resolver })

	configuration := testConfig(t)
	configuration.SFU = &config.SFUConfig{ListenHost: "127.0.0.1", Port: 0, PublicIP: "sfu-refresh.test."}
	server := start(t, Options{Config: configuration})
	candidate := func(connection string) ice.Candidate {
		t.Helper()
		candidates := make(chan string, 1)
		plan := sfu.VoiceConnectionPlan{RoomID: "1234", PeerID: connection, SessionID: connection, ConnectionID: connection,
			Publish: []sfu.VoicePublication{{ID: connection, PeerID: connection}}}
		work, err := server.media.ConfigureVoice(plan, func(event sfu.VoiceMediaEvent) {
			if event.Candidate != nil {
				select {
				case candidates <- event.Candidate.Candidate:
				default:
				}
			}
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := work(); err != nil {
			t.Fatal(err)
		}
		select {
		case value := <-candidates:
			parsed, err := ice.UnmarshalCandidate(value)
			if err != nil {
				t.Fatal(err)
			}
			return parsed
		case <-time.After(5 * time.Second):
			t.Fatal("voice connection did not gather a real ICE candidate")
			return nil
		}
	}
	initial := candidate("initial")
	if initial.Address() != "198.51.100.5" || initial.Port() == 0 {
		t.Fatalf("initial DNS candidate: %s", initial)
	}
	address.Store(9)
	server.refreshSFUPublicIP(t.Context(), configuration.SFU.PublicIP)
	updated := candidate("updated")
	if updated.Address() != "198.51.100.9" || updated.Port() != initial.Port() {
		t.Fatalf("new connection must use refreshed IP on the same UDP listener: initial=%s updated=%s", initial, updated)
	}
	address.Store(0)
	server.refreshSFUPublicIP(t.Context(), configuration.SFU.PublicIP)
	retained := candidate("dns-failed")
	if retained.Address() != updated.Address() || retained.Port() != updated.Port() {
		t.Fatalf("DNS failure lost the last usable address: updated=%s retained=%s", updated, retained)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if err := server.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if server.stopSFUDNS != nil {
		t.Fatal("server shutdown did not retire its DNS refresh worker")
	}
}

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
