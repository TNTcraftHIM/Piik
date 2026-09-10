package forwarding

import (
	"context"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/media/encoded"
	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/logging"
	"github.com/pion/transport/v4/vnet"
	"github.com/pion/webrtc/v4"
)

// Explicit CPU-only network gate: synthetic VP8-shaped payload, actual Pion
// ICE/DTLS/RTP/TWCC, and the production allocator/pacer/probe driver. No decoder,
// capture device or physical network participates.
func TestTransportConstrainedDormantRecovery(t *testing.T) {
	if os.Getenv("PIIK_TRANSPORT_RECOVERY") == "" {
		t.Skip("set PIIK_TRANSPORT_RECOVERY=1 for the bounded virtual-network gate")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 32*time.Second)
	defer cancel()
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	log := logging.NewDefaultLoggerFactory()
	router, err := vnet.NewRouter(&vnet.RouterConfig{CIDR: "10.0.0.0/24", MinDelay: 20 * time.Millisecond, LoggerFactory: log})
	check(err)
	sendNet, err := vnet.NewNet(&vnet.NetConfig{StaticIPs: []string{"10.0.0.1"}})
	check(err)
	receiveNet, err := vnet.NewNet(&vnet.NetConfig{StaticIPs: []string{"10.0.0.2"}})
	check(err)
	link := vnet.NewTBFQueue(6_000_000, 2400, 7500)
	queue, err := vnet.NewQueue(receiveNet, link)
	check(err)
	defer queue.Close()
	check(router.AddNet(sendNet))
	check(router.AddNet(queue))
	check(router.Start())
	defer router.Stop()
	codec := webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000,
		RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}, {Type: webrtc.TypeRTCPFBTransportCC}},
	}, PayloadType: 96}
	source, err := NewEncodedSource(SourceOptions{ID: "recovery", StreamID: "recovery", Codec: codec,
		Formats: []LayerFormat{{Width: 8, Height: 8, Bitrate: 300_000}, {Width: 16, Height: 16, Bitrate: 1_200_000}}, MaxPackets: 500})
	check(err)
	defer source.Close()
	sendSettings := webrtc.SettingEngine{}
	sendSettings.SetNet(sendNet)
	sendSettings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	sendSettings.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	transport, err := NewTransport(TransportOptions{Source: source.Source, Settings: sendSettings,
		ConnectionID: "recovery-child", InitialBitrate: 1_200_000})
	check(err)
	defer transport.Close()
	receiveSettings := webrtc.SettingEngine{}
	receiveSettings.SetNet(receiveNet)
	receiveSettings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	receiveSettings.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	media := &webrtc.MediaEngine{}
	check(media.RegisterDefaultCodecs())
	registry := &interceptor.Registry{}
	check(webrtc.RegisterDefaultInterceptors(media, registry))
	check(webrtc.ConfigureTWCCSender(media, registry))
	receiver, err := webrtc.NewAPI(webrtc.WithMediaEngine(media), webrtc.WithInterceptorRegistry(registry),
		webrtc.WithSettingEngine(receiveSettings)).NewPeerConnection(webrtc.Configuration{})
	check(err)
	defer receiver.Close()
	var received atomic.Uint64
	receiver.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			packet, _, readErr := track.ReadRTP()
			if readErr != nil {
				return
			}
			received.Add(uint64(len(packet.Payload)))
		}
	})
	offer, err := transport.PC.CreateOffer(nil)
	check(err)
	gathered := webrtc.GatheringCompletePromise(transport.PC)
	check(transport.PC.SetLocalDescription(offer))
	select {
	case <-gathered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	check(receiver.SetRemoteDescription(*transport.PC.LocalDescription()))
	answer, err := receiver.CreateAnswer(nil)
	check(err)
	gathered = webrtc.GatheringCompletePromise(receiver)
	check(receiver.SetLocalDescription(answer))
	select {
	case <-gathered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	check(transport.PC.SetRemoteDescription(*receiver.LocalDescription()))
	for transport.PC.ConnectionState() != webrtc.PeerConnectionStateConnected {
		select {
		case <-time.After(5 * time.Millisecond):
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	check(transport.SetConnected())
	period := time.Second / 30
	ticker := time.NewTicker(period)
	defer ticker.Stop()
	start, lastReport := time.Now(), time.Now()
	var previousReceived uint64
	var dormant, recovered bool
	minimum := int64(1_200_000)
	for frame := 0; ; frame++ {
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		now := time.Now()
		elapsed := now.Sub(start)
		if elapsed >= 26*time.Second {
			break
		}
		capacity := 6_000_000
		if elapsed >= 4*time.Second && elapsed < 12*time.Second {
			capacity = 500_000
		}
		link.SetRate(capacity)
		state := transport.Output.State()
		_, observed := transport.TargetBitrate()
		high := !observed || state.Target == 1 || state.Prepare == 1 || !state.Paused && state.Current == 1
		if elapsed >= 7*time.Second && elapsed < 12*time.Second {
			dormant = dormant || !high
			minimum = min(minimum, state.VideoBudget)
		}
		pts := time.Duration(frame) * period
		check(source.BeginFrame(pts, now))
		transport.Output.BeginFrame()
		for layer, bitrate := range []int64{min(300_000, max(state.VideoBudget, 1)), 1_200_000} {
			if layer == 1 && !high {
				continue
			}
			data := make([]byte, max(len(sfu.VP8KeyFrame8x8), int(bitrate/8/30)))
			copy(data, sfu.VP8KeyFrame8x8)
			check(source.WriteFrame(layer, encoded.Frame{Data: data, PTS: pts, Duration: period}))
		}
		if now.Sub(lastReport) >= time.Second {
			bytes := received.Load()
			receivedBps := float64((bytes-previousReceived)*8) / now.Sub(lastReport).Seconds()
			transport.mu.Lock()
			t.Logf("%.1fs link=%d budget=%d target=%d current=%d high=%v receive=%.0f congestion=%v ready=%v probe=%d egress=%+v",
				elapsed.Seconds(), capacity, state.VideoBudget, state.Target, state.Current, high, receivedBps,
				transport.estimator.CongestionState(), transport.paddingReady, transport.probe.Id, transport.Egress())
			transport.mu.Unlock()
			if elapsed > 15*time.Second && state.Current == 1 && receivedBps > 800_000 {
				recovered = true
			}
			lastReport, previousReceived = now, bytes
		}
	}
	if !dormant || minimum >= 1_200_000 || !recovered {
		t.Fatalf("missing real constrained/dormant/released recovery: dormant=%v minimum=%d recovered=%v state=%+v",
			dormant, minimum, recovered, transport.Output.State())
	}
	check(transport.Close())
	if transport.prober.IsRunning() {
		t.Fatal("closed transport retained a probe")
	}
}
