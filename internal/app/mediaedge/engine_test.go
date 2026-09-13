package mediaedge

import (
	"net"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/diagnostics"
	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/pion/rtp"
	"github.com/pion/turn/v5"
	"github.com/pion/webrtc/v4"
)

func TestEngineMediaAddressFamilies(t *testing.T) {
	for _, test := range []struct {
		name, bind, receiver string
		ipv6                 bool
	}{
		{name: "default-to-IPv4", receiver: "127.0.0.1:0"},
		{name: "explicit-IPv4", bind: "127.0.0.1:0", receiver: "127.0.0.1:0"},
		{name: "explicit-IPv6", bind: "[::1]:0", receiver: "[::1]:0", ipv6: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			if test.ipv6 {
				probe, err := net.ListenUDP("udp6", &net.UDPAddr{IP: net.IPv6loopback})
				if err != nil {
					t.Skipf("IPv6 loopback UDP is unavailable: %v", err)
				}
				_ = probe.Close()
			}
			engine, err := NewEngine(EngineOptions{BindAddress: test.bind, IncludeLoopback: true})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = engine.Close() })
			source, err := engine.NewSource("vp8", 1, 1, nil)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = source.Close() })
			edge, err := engine.NewEdge(source, EdgeOptions{ConnectionID: test.name})
			if err != nil {
				t.Fatal(err)
			}
			receiver := newReceiverWithAudio(t, false, test.receiver)
			t.Cleanup(func() { _ = receiver.Close() })
			packets := make(chan *rtp.Packet, 1)
			receiver.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
				if packet, _, readErr := track.ReadRTP(); readErr == nil {
					packets <- packet
				}
			})
			connectEdgeToReceiver(t, edge, receiver)
			pair, err := edge.sender.Transport().ICETransport().GetSelectedCandidatePair()
			if err != nil || pair == nil {
				t.Fatalf("selected ICE pair is unavailable: %v", err)
			}
			if (net.ParseIP(pair.Local.Address).To4() == nil) != test.ipv6 ||
				(net.ParseIP(pair.Remote.Address).To4() == nil) != test.ipv6 ||
				int(pair.Local.Port) != engine.localPort {
				t.Fatal("ICE selected a different address family or media socket")
			}
			for _, stats := range edge.connection.GetStats() {
				if candidate, ok := stats.(webrtc.ICECandidateStats); ok && candidate.Type == webrtc.StatsTypeLocalCandidate &&
					int(candidate.Port) != engine.localPort {
					t.Fatal("ICE candidate did not use the shared media port")
				}
			}
			if err = writeSourceFrame(source, sfu.VP8KeyFrame8x8, time.Second, time.Second/30); err != nil {
				t.Fatal(err)
			}
			if packet := waitPacket(t, packets); len(packet.Payload) == 0 || !packet.Marker {
				t.Fatal("direct ICE/DTLS transport did not deliver the video frame")
			}
			if err = engine.Close(); err != nil {
				t.Fatal(err)
			}
			if edge.State() != webrtc.PeerConnectionStateClosed {
				t.Fatal("engine shutdown retained its media edge")
			}
			address, err := net.ResolveUDPAddr("udp", engine.ListenAddress())
			if err != nil {
				t.Fatal(err)
			}
			reopened, err := net.ListenUDP("udp", address)
			if err != nil {
				t.Fatal("engine shutdown retained its UDP listener")
			}
			_ = reopened.Close()
		})
	}
}

func TestDefaultEngineSTUNUsesOnePortForBothFamilies(t *testing.T) {
	engine, err := NewEngine(EngineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close() })
	for _, test := range []struct {
		network string
		ip      net.IP
	}{
		{network: "udp4", ip: net.IPv4(127, 0, 0, 1)},
		{network: "udp6", ip: net.IPv6loopback},
	} {
		t.Run(test.network, func(t *testing.T) {
			bound, err := net.ResolveUDPAddr("udp", engine.ListenAddress())
			if err != nil {
				t.Fatal(err)
			}
			if test.network == "udp6" && bound.IP.To4() != nil {
				t.Skip("Go selected the supported IPv4-only wildcard socket")
			}
			listener, err := net.ListenUDP(test.network, &net.UDPAddr{IP: test.ip})
			if err != nil {
				if test.network == "udp6" {
					t.Skipf("IPv6 loopback UDP is unavailable: %v", err)
				}
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = listener.Close() })
			server, err := turn.NewServer(turn.ServerConfig{
				PacketConnConfigs: []turn.PacketConnConfig{{PacketConn: listener}},
				LoggerFactory:     diagnostics.PionLoggerFactory(),
			})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = server.Close() })
			mapped, err := engine.mux.GetXORMappedAddrContext(t.Context(), listener.LocalAddr(), time.Second)
			if err != nil {
				t.Fatal(err)
			}
			if mapped.Port != engine.localPort || !mapped.IP.Equal(test.ip) {
				t.Fatal("STUN observed a different socket or address family")
			}
			if test.network == "udp4" {
				observations := 0
				engine.surveySTUN(t.Context(), []webrtc.ICEServer{{URLs: []string{"stun:" + listener.LocalAddr().String()}}},
					func(mapped mappedAddress) {
						observations++
						if mapped.port != engine.localPort || net.ParseIP(mapped.address).To4() == nil {
							t.Error("Native survey did not retain its IPv4 media socket")
						}
					})
				if observations != 1 {
					t.Fatal("Native IPv4 survey did not emit its observation")
				}
			}
		})
	}
}
