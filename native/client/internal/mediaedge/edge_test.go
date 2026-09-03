package mediaedge

import (
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Screener/native/client/internal/nativeaudio"
	"github.com/pion/interceptor"
	"github.com/pion/logging"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

func TestOneEncodedSourceFeedsTwoIndependentEdges(t *testing.T) {
	engine, err := NewEngine(EngineOptions{
		BindAddress:     "127.0.0.1:0",
		IncludeLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close() })
	keyFrames := make(chan struct{}, 1)
	source, err := engine.NewSource(2, func() {
		select {
		case keyFrames <- struct{}{}:
		default:
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = source.Close() })

	edgeA, receiverA, packetA := connectedReceiver(t, engine, source, "edge-a")
	edgeB, receiverB, packetB := connectedReceiver(t, engine, source, "edge-b")
	t.Cleanup(func() { _ = receiverA.Close() })
	t.Cleanup(func() { _ = receiverB.Close() })
	if edgeA.connection == edgeB.connection || engine.ListenAddress() == "" {
		t.Fatal("media edges did not keep independent transports")
	}
	if edgeA.bandwidth == edgeB.bandwidth {
		t.Fatal("media edges shared one bandwidth estimator")
	}
	if _, err = engine.NewEdge(source, EdgeOptions{ConnectionID: "edge-c"}); !errors.Is(err, ErrSourceCapacity) {
		t.Fatalf("third edge error = %v", err)
	}
	select {
	case <-keyFrames:
	case <-time.After(3 * time.Second):
		t.Fatal("connected edge did not request a recovery frame")
	}

	accessUnit := []byte{
		0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0x96, 0x54, 0x05, 0x01,
		0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80,
		0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00,
	}
	if err = source.WriteH264(accessUnit, time.Second, time.Second/30); err != nil {
		t.Fatal(err)
	}
	first := waitPacket(t, packetA)
	_ = waitPacket(t, packetB)
	if err = receiverA.WriteRTCP([]rtcp.Packet{
		&rtcp.PictureLossIndication{MediaSSRC: first.SSRC},
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-keyFrames:
	case <-time.After(3 * time.Second):
		t.Fatal("PLI did not reach the shared source")
	}

	if err = edgeA.Close(); err != nil {
		t.Fatal(err)
	}
	edgeC, err := engine.NewEdge(source, EdgeOptions{ConnectionID: "edge-c"})
	if err != nil {
		t.Fatalf("released source slot was not reusable: %v", err)
	}
	_ = edgeC.Close()
}

func TestRemoteCandidatesAreBoundedUntilTheAnswer(t *testing.T) {
	engine, err := NewEngine(EngineOptions{
		BindAddress:     "127.0.0.1:0",
		IncludeLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close() })
	source, err := engine.NewSource(1, nil)
	if err != nil {
		t.Fatal(err)
	}
	edge, err := engine.NewEdge(source, EdgeOptions{ConnectionID: "edge"})
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < maxPendingCandidates; index++ {
		if err = edge.AddRemoteCandidate(&webrtc.ICECandidateInit{
			Candidate: "candidate:1 1 udp 1 127.0.0.1 9 typ host",
		}); err != nil {
			t.Fatalf("candidate %d: %v", index, err)
		}
	}
	if err = edge.AddRemoteCandidate(&webrtc.ICECandidateInit{
		Candidate: "candidate:1 1 udp 1 127.0.0.1 9 typ host",
	}); err == nil {
		t.Fatal("unbounded candidate queue was accepted")
	}
}

func TestCaptureTimestampsDriveTheRTPClock(t *testing.T) {
	engine, err := NewEngine(EngineOptions{
		BindAddress: "127.0.0.1:0", IncludeLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close() })
	source, err := engine.NewSource(1, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = source.Close() })
	_, receiver, packets := connectedReceiver(t, engine, source, "timed-edge")
	t.Cleanup(func() { _ = receiver.Close() })
	accessUnit := []byte{0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00}
	start := 10 * time.Second
	frameDuration := time.Second / 30

	if err = source.WriteH264(accessUnit, start, frameDuration); err != nil {
		t.Fatal(err)
	}
	first := waitPacket(t, packets)
	if err = source.WriteH264(accessUnit, start+frameDuration, frameDuration); err != nil {
		t.Fatal(err)
	}
	second := waitPacket(t, packets)
	if got := second.Timestamp - first.Timestamp; got < 2_999 || got > 3_001 {
		t.Fatalf("steady timestamp delta = %d", got)
	}
	if err = source.WriteH264(accessUnit, start+5*time.Second, frameDuration); err != nil {
		t.Fatal(err)
	}
	third := waitPacket(t, packets)
	if got := third.Timestamp - second.Timestamp; got < 446_999 || got > 447_001 {
		t.Fatalf("sparse timestamp delta = %d", got)
	}
}

func TestOneLocalBridgeDoesNotConsumeRouteCapacity(t *testing.T) {
	engine, err := NewEngine(EngineOptions{
		BindAddress: "127.0.0.1:0", IncludeLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close() })
	source, err := engine.NewSource(1, nil)
	if err != nil {
		t.Fatal(err)
	}
	audio, err := engine.NewAudioSource(1, 128_000)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = audio.Close() })
	local, err := engine.NewEdge(source, EdgeOptions{
		ConnectionID: "local-preview", Local: true, Audio: audio,
	})
	if err != nil {
		t.Fatal(err)
	}
	route, err := engine.NewEdge(source, EdgeOptions{
		ConnectionID: "route-edge", Audio: audio,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = engine.NewEdge(source, EdgeOptions{
		ConnectionID: "second-local", Local: true,
	}); !errors.Is(err, ErrSourceCapacity) {
		t.Fatalf("second local edge error = %v", err)
	}
	if _, err = engine.NewEdge(source, EdgeOptions{
		ConnectionID: "second-route",
	}); !errors.Is(err, ErrSourceCapacity) {
		t.Fatalf("second route edge error = %v", err)
	}
	_ = local.Close()
	_ = route.Close()
	if replacement, replaceErr := engine.NewEdge(source, EdgeOptions{
		ConnectionID: "replacement-local", Local: true, Audio: audio,
	}); replaceErr != nil {
		t.Fatalf("released local slot was not reusable: %v", replaceErr)
	} else {
		_ = replacement.Close()
	}
}

func TestBandwidthObserverReceivesTransportFeedbackWithoutPacing(t *testing.T) {
	engine, err := NewEngine(EngineOptions{
		BindAddress: "127.0.0.1:0", IncludeLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close() })
	source, err := engine.NewSource(1, nil)
	if err != nil {
		t.Fatal(err)
	}
	edge, receiver, packets := connectedReceiver(t, engine, source, "quality-edge")
	t.Cleanup(func() { _ = receiver.Close() })
	if !strings.Contains(edge.connection.LocalDescription().SDP, "transport-cc") {
		t.Fatal("native media offer did not negotiate transport feedback")
	}
	source.SetFormat(1280, 720)
	started := time.Now()
	if _, ok := edge.QualitySample(started); ok {
		t.Fatal("first quality sample did not establish a baseline")
	}

	accessUnit := []byte{
		0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0x96, 0x54, 0x05, 0x01,
		0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80,
		0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00,
	}
	deadline := time.Now().Add(5 * time.Second)
	captureTimestamp := time.Second
	for time.Now().Before(deadline) {
		if err = source.WriteH264(
			accessUnit,
			captureTimestamp,
			time.Second/30,
		); err != nil {
			t.Fatal(err)
		}
		captureTimestamp += time.Second / 30
		select {
		case <-packets:
		default:
		}
		if bitrate, observed := edge.bandwidth.targetBitrate(); observed && time.Since(started) >= time.Second {
			if bitrate <= 0 {
				t.Fatalf("observed target bitrate = %d", bitrate)
			}
			sample, ok := edge.QualitySample(time.Now())
			if !ok || sample.State != "healthy" || sample.Reason == nil ||
				*sample.Reason != "none" || sample.IntervalFramesEncoded == 0 ||
				sample.RTPStatsID == "" || sample.TrackIdentifier == "" {
				t.Fatalf("quality sample = %+v, %v", sample, ok)
			}
			return
		}
		time.Sleep(time.Second / 30)
	}
	t.Fatal("transport feedback did not produce a bandwidth estimate")
}

func TestAudioUsesTheSamePeerConnectionAndCapacityAsVideo(t *testing.T) {
	engine, err := NewEngine(EngineOptions{BindAddress: "127.0.0.1:0", IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close() })
	video, err := engine.NewSource(1, nil)
	if err != nil {
		t.Fatal(err)
	}
	audio, err := engine.NewAudioSource(1, 128_000)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = video.Close(); _ = audio.Close() })
	edge, err := engine.NewEdge(video, EdgeOptions{
		ConnectionID: "audio-edge",
		Audio:        audio,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = edge.Close() })
	if edge.audioSender == nil {
		t.Fatal("audio sender was not attached")
	}
	if _, err = engine.NewEdge(video, EdgeOptions{ConnectionID: "video-only"}); !errors.Is(err, ErrSourceCapacity) {
		t.Fatalf("video capacity was not shared: %v", err)
	}
	if _, err = engine.NewEdge(video, EdgeOptions{ConnectionID: "audio-only", Audio: audio}); !errors.Is(err, ErrSourceCapacity) {
		t.Fatalf("audio capacity was not shared: %v", err)
	}
	offer, err := edge.CreateOffer()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(offer.SDP, "m=audio") || !strings.Contains(offer.SDP, "opus/48000") {
		t.Fatalf("same connection offer has no Opus section: %s", offer.SDP)
	}
}

func TestAudioSourceDeliversOpusOnTheVideoPeerConnection(t *testing.T) {
	engine, err := NewEngine(EngineOptions{BindAddress: "127.0.0.1:0", IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close() })
	video, err := engine.NewSource(1, nil)
	if err != nil {
		t.Fatal(err)
	}
	audio, err := engine.NewAudioSource(1, 128_000)
	if err != nil {
		t.Fatal(err)
	}
	edge, err := engine.NewEdge(video, EdgeOptions{ConnectionID: "audio-edge", Audio: audio})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = edge.Close(); _ = video.Close(); _ = audio.Close() })
	receiver := newAudioReceiver(t)
	t.Cleanup(func() { _ = receiver.Close() })
	audioPackets := make(chan *rtp.Packet, 1)
	receiver.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if track.Kind() != webrtc.RTPCodecTypeAudio {
			return
		}
		packet, _, readErr := track.ReadRTP()
		if readErr == nil {
			audioPackets <- packet
		}
	})
	connectEdgeToReceiver(t, edge, receiver)
	if err = audio.WritePCM(make([]byte, nativeaudio.FrameBytes), 20*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	select {
	case packet := <-audioPackets:
		if packet.PayloadType != 111 || len(packet.Payload) == 0 {
			t.Fatalf("unexpected Opus RTP packet: payload type %d, %d bytes", packet.PayloadType, len(packet.Payload))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for Opus RTP")
	}
}

func connectedReceiver(
	t *testing.T,
	engine *Engine,
	source *Source,
	connectionID string,
) (*Edge, *webrtc.PeerConnection, <-chan *rtp.Packet) {
	t.Helper()
	edge, err := engine.NewEdge(source, EdgeOptions{ConnectionID: connectionID})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = edge.Close() })
	receiver := newReceiver(t)
	packets := make(chan *rtp.Packet, 1)
	receiver.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		go func() {
			for {
				packet, _, readErr := track.ReadRTP()
				if readErr != nil {
					return
				}
				select {
				case packets <- packet:
				default:
				}
			}
		}()
	})

	connectEdgeToReceiver(t, edge, receiver)
	return edge, receiver, packets
}

func connectEdgeToReceiver(
	t *testing.T,
	edge *Edge,
	receiver *webrtc.PeerConnection,
) {
	t.Helper()
	gatherOffer := webrtc.GatheringCompletePromise(edge.connection)
	if _, err := edge.CreateOffer(); err != nil {
		t.Fatal(err)
	}
	waitSignal(t, gatherOffer, "offer ICE gathering")
	if err := receiver.SetRemoteDescription(*edge.connection.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	gatherAnswer := webrtc.GatheringCompletePromise(receiver)
	answer, err := receiver.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = receiver.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	waitSignal(t, gatherAnswer, "answer ICE gathering")
	if err = edge.SetAnswer(*receiver.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for edge.State() != webrtc.PeerConnectionStateConnected {
		if time.Now().After(deadline) {
			t.Fatalf("edge state = %s", edge.State())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func newReceiver(t *testing.T) *webrtc.PeerConnection {
	return newReceiverWithAudio(t, false)
}

func newAudioReceiver(t *testing.T) *webrtc.PeerConnection {
	return newReceiverWithAudio(t, true)
}

func newReceiverWithAudio(t *testing.T, includeAudio bool) *webrtc.PeerConnection {
	t.Helper()
	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: h264Capability,
		PayloadType:        102,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		t.Fatal(err)
	}
	if includeAudio {
		if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
			RTPCodecCapability: opusCapability,
			PayloadType:        111,
		}, webrtc.RTPCodecTypeAudio); err != nil {
			t.Fatal(err)
		}
	}
	registry := &interceptor.Registry{}
	if err := webrtc.ConfigureTWCCSender(mediaEngine, registry); err != nil {
		t.Fatal(err)
	}
	if err := webrtc.RegisterDefaultInterceptors(mediaEngine, registry); err != nil {
		t.Fatal(err)
	}
	settings := webrtc.SettingEngine{}
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	udp, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		t.Fatal(err)
	}
	mux := webrtc.NewICEUDPMux(logging.NewDefaultLoggerFactory().NewLogger("mediaedge-test"), udp)
	settings.SetICEUDPMux(mux)
	t.Cleanup(func() { _ = mux.Close() })
	api := webrtc.NewAPI(
		webrtc.WithMediaEngine(mediaEngine),
		webrtc.WithInterceptorRegistry(registry),
		webrtc.WithSettingEngine(settings),
	)
	connection, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	if includeAudio {
		if _, err = connection.AddTransceiverFromKind(
			webrtc.RTPCodecTypeAudio,
			webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly},
		); err != nil {
			t.Fatal(err)
		}
	}
	return connection
}

func waitSignal(t *testing.T, signal <-chan struct{}, label string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", label)
	}
}

func waitPacket(t *testing.T, packets <-chan *rtp.Packet) *rtp.Packet {
	t.Helper()
	select {
	case packet := <-packets:
		return packet
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for RTP")
		return nil
	}
}
