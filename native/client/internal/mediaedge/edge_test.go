package mediaedge

import (
	"errors"
	"testing"
	"time"

	"github.com/pion/interceptor"
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
	if _, err = engine.NewEdge(source, EdgeOptions{ConnectionID: "edge-c"}); !errors.Is(err, ErrSourceCapacity) {
		t.Fatalf("third edge error = %v", err)
	}

	accessUnit := []byte{
		0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0x96, 0x54, 0x05, 0x01,
		0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80,
		0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00,
	}
	if err = source.WriteH264(accessUnit, time.Second/30); err != nil {
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
		packet, _, readErr := track.ReadRTP()
		if readErr == nil {
			packets <- packet
		}
	})

	gatherOffer := webrtc.GatheringCompletePromise(edge.connection)
	if _, err = edge.CreateOffer(); err != nil {
		t.Fatal(err)
	}
	waitSignal(t, gatherOffer, "offer ICE gathering")
	if err = receiver.SetRemoteDescription(*edge.connection.LocalDescription()); err != nil {
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
	return edge, receiver, packets
}

func newReceiver(t *testing.T) *webrtc.PeerConnection {
	t.Helper()
	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: h264Capability,
		PayloadType:        102,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		t.Fatal(err)
	}
	registry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(mediaEngine, registry); err != nil {
		t.Fatal(err)
	}
	settings := webrtc.SettingEngine{}
	settings.SetIncludeLoopbackCandidate(true)
	api := webrtc.NewAPI(
		webrtc.WithMediaEngine(mediaEngine),
		webrtc.WithInterceptorRegistry(registry),
		webrtc.WithSettingEngine(settings),
	)
	connection, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
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
