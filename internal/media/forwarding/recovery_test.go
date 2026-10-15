package forwarding

import (
	"context"
	"encoding/binary"
	"math"
	"math/rand/v2"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/app/nativeaudio"
	"github.com/TNTcraftHIM/Piik/internal/media/encoded"
	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/logging"
	"github.com/pion/transport/v5/vnet"
	"github.com/pion/webrtc/v4"
	rtmedia "github.com/pion/webrtc/v4/pkg/media"
	"github.com/thesyncim/gopus"
)

// Explicit CPU-only network gate: synthetic VP8-shaped payload, actual Pion
// ICE/DTLS/RTP/TWCC, and the production allocator/pacer/probe driver. The audio
// case adds real Opus encode/decode and live bitrate changes. No video decoder,
// capture device or physical network participates.
func TestTransportConstrainedDormantRecovery(t *testing.T) {
	if os.Getenv("PIIK_TRANSPORT_RECOVERY") == "" {
		t.Skip("set PIIK_TRANSPORT_RECOVERY=1 for the bounded virtual-network gate")
	}
	for _, scenario := range []string{"video-only", "numeric-audio", "within-lowest-output", "encoded-frame-bursts", "raw-forwarding"} {
		t.Run(scenario, func(t *testing.T) { checkTransportRecovery(t, scenario) })
	}
}

func checkTransportRecovery(t *testing.T, scenario string) {
	t.Helper()
	withAudio, recoverLowest := scenario == "numeric-audio", scenario == "within-lowest-output"
	bursts := scenario == "encoded-frame-bursts"
	raw := scenario == "raw-forwarding"
	duration, recoveredAt := 26*time.Second, 20*time.Second
	lowBitrate, highBitrate, linkCeiling, recoveredBitrate := 300_000, 1_200_000, 6_000_000, 800_000
	if recoverLowest {
		duration, recoveredAt = 50*time.Second, 44*time.Second
	}
	if bursts {
		// Average capacity comfortably fits the video, but a whole 5 Mbps/30 fps
		// frame exceeds this link's queue. A healthy-link control catches missing
		// pacing independently from congestion recovery.
		duration, recoveredAt = 12*time.Second, 4*time.Second
		lowBitrate, highBitrate, linkCeiling, recoveredBitrate = 1_200_000, 5_000_000, 12_000_000, 4_500_000
	}
	ctx, cancel := context.WithTimeout(t.Context(), duration+6*time.Second)
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
	link := vnet.NewTBFQueue(linkCeiling, 2400, 7500)
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
		Formats: []LayerFormat{{Width: 8, Height: 8, Bitrate: uint32(lowBitrate)}, {Width: 16, Height: 16, Bitrate: uint32(highBitrate)}}, MaxPackets: 500})
	check(err)
	defer source.Close()
	// The generated lowest output follows the supplied codec budget, as Native
	// capture does. Raw SFU forwarding cannot change an upstream encoder's rate.
	source.SetLowestLayerRateControlled(!raw)
	sendSettings := webrtc.SettingEngine{}
	sendSettings.SetNet(sendNet)
	sendSettings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	sendSettings.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	var audio *webrtc.TrackLocalStaticSample
	var encoder *nativeaudio.Encoder
	var audioTicks <-chan time.Time
	var pcm []byte
	if withAudio {
		audio, err = webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2,
			SDPFmtpLine: "minptime=10;useinbandfec=1",
		}, "audio", "recovery")
		check(err)
		encoder, err = nativeaudio.NewEncoder(320_000)
		check(err)
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		audioTicks = ticker.C
		pcm = make([]byte, nativeaudio.FrameBytes)
		random := rand.New(rand.NewPCG(42, 1))
		for frame := range nativeaudio.FrameSamples {
			for channel := range nativeaudio.Channels {
				value := 8000*math.Sin(2*math.Pi*float64(500+channel*1000)*float64(frame)/48000) + 4000*(random.Float64()*2-1)
				binary.LittleEndian.PutUint16(pcm[(frame*2+channel)*2:], uint16(int16(value)))
			}
		}
	}
	var audioTrack webrtc.TrackLocal
	if audio != nil {
		audioTrack = audio
	}
	transport, err := NewTransport(TransportOptions{Source: source.Source, Settings: sendSettings,
		ConnectionID: "recovery-child", InitialBitrate: highBitrate, Audio: audioTrack})
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
	receiver, err := webrtc.NewAPI(webrtc.WithMediaEngine(media), webrtc.WithInterceptorRegistry(registry),
		webrtc.WithSettingEngine(receiveSettings)).NewPeerConnection(webrtc.Configuration{})
	check(err)
	var readers sync.WaitGroup
	defer readers.Wait()
	defer receiver.Close()
	var received, audioDecoded, audioErrors atomic.Uint64
	receiver.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		readers.Add(1)
		defer readers.Done()
		if track.Kind() == webrtc.RTPCodecTypeAudio {
			decoder, err := gopus.NewDecoder(gopus.DefaultDecoderConfig(48000, 2))
			if err != nil {
				audioErrors.Add(1)
				return
			}
			pcm := make([]int16, nativeaudio.FrameSamples*nativeaudio.Channels)
			for {
				packet, _, err := track.ReadRTP()
				if err != nil {
					return
				}
				count, err := decoder.DecodeInt16(packet.Payload, pcm)
				if err != nil || count != nativeaudio.FrameSamples {
					audioErrors.Add(1)
					continue
				}
				var energy int64
				for _, sample := range pcm {
					energy += int64(sample) * int64(sample)
				}
				if energy > int64(len(pcm))*100 {
					audioDecoded.Add(1)
				}
			}
		}
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
	var previousReceived, previousAudio uint64
	var dormant bool
	var recoveredWindows, audioWindows, lowestWindows int
	minimum := int64(highBitrate)
	frame := 0
	for {
		select {
		case <-ticker.C:
		case <-audioTicks:
			bitrate := 320_000
			if elapsed := time.Since(start); elapsed >= 8*time.Second && elapsed < 16*time.Second {
				bitrate = 96_000
			}
			if encoder.Bitrate() != bitrate {
				check(encoder.SetBitrate(bitrate))
			}
			packet, err := encoder.Encode(pcm)
			check(err)
			check(audio.WriteSample(rtmedia.Sample{Data: packet, Duration: 20 * time.Millisecond}))
			continue
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		now := time.Now()
		elapsed := now.Sub(start)
		if elapsed >= duration {
			break
		}
		capacity := linkCeiling
		if !bursts && elapsed >= 4*time.Second && elapsed < 12*time.Second {
			capacity = 500_000
			if recoverLowest {
				capacity = 120_000
			}
		}
		if recoverLowest && elapsed >= 12*time.Second && elapsed < 28*time.Second {
			capacity = 800_000
		}
		link.SetRate(capacity)
		state := transport.Output.State()
		if state.VideoBudget > int64(linkCeiling) {
			t.Fatalf("probe promoted capacity beyond this fixture's link: %+v", state)
		}
		high := transport.RequiredActiveCount() > 1
		if elapsed >= 7*time.Second && elapsed < 12*time.Second {
			dormant = dormant || !high
			minimum = min(minimum, state.VideoBudget)
		}
		pts := time.Duration(frame) * period
		check(source.BeginFrame(pts, now))
		transport.Output.BeginFrame()
		lowest := int64(lowBitrate)
		if !raw {
			lowest = min(lowest, max(state.VideoBudget, 1))
		}
		for layer, bitrate := range []int64{lowest, int64(highBitrate)} {
			if layer == 1 && !high {
				continue
			}
			data := make([]byte, max(len(sfu.VP8KeyFrame8x8), int(source.CodecBudget(layer, bitrate)/8/30)))
			copy(data, sfu.VP8KeyFrame8x8)
			check(source.WriteFrame(layer, encoded.Frame{Data: data, PTS: pts, Duration: period}))
		}
		frame++
		if now.Sub(lastReport) >= time.Second {
			bytes := received.Load()
			receivedBps := float64((bytes-previousReceived)*8) / now.Sub(lastReport).Seconds()
			transport.mu.Lock()
			t.Logf("%.1fs link=%d budget=%d target=%d current=%d high=%v receive=%.0f congestion=%v ready=%v probe=%d egress=%+v",
				elapsed.Seconds(), capacity, state.VideoBudget, state.Target, state.Current, high, receivedBps,
				transport.estimator.CongestionState(), transport.paddingReady, transport.probe.Id, transport.Egress())
			transport.mu.Unlock()
			if bursts && elapsed >= 2*time.Second && (state.Target != 1 || state.Current != 1) {
				t.Fatalf("healthy capacity downgraded during source measurement: %+v", state)
			}
			if elapsed >= recoveredAt && state.Current == 1 && receivedBps > float64(recoveredBitrate) {
				recoveredWindows++
			}
			// Partial recovery must restore the current output before the larger
			// spatial output fits; only checking the final fast link misses this.
			if recoverLowest && capacity == 800_000 && state.Current == 0 &&
				state.VideoBudget >= 300_000 && state.VideoBudget < 1_200_000 && receivedBps > 250_000 {
				lowestWindows++
			}
			decoded := audioDecoded.Load()
			if withAudio {
				t.Logf("audio decoded=%d errors=%d bitrate=%d", decoded-previousAudio, audioErrors.Load(), encoder.Bitrate())
				if elapsed >= recoveredAt && decoded-previousAudio >= 35 {
					audioWindows++
				}
			}
			previousAudio = decoded
			lastReport, previousReceived = now, bytes
		}
	}
	if recoverLowest && lowestWindows < 5 {
		t.Fatalf("current output remained degraded after partial recovery: windows=%d minimum=%d", lowestWindows, minimum)
	}
	if !bursts && (!dormant || minimum >= int64(highBitrate)) || recoveredWindows < 5 || withAudio && (audioWindows < 5 || audioErrors.Load() != 0) {
		t.Fatalf("missing constrained/dormant/released recovery: dormant=%v minimum=%d videoWindows=%d audioWindows=%d audioErrors=%d state=%+v",
			dormant, minimum, recoveredWindows, audioWindows, audioErrors.Load(), transport.Output.State())
	}
	check(transport.Close())
	if transport.prober.IsRunning() {
		t.Fatal("closed transport retained a probe")
	}
}
