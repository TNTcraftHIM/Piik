package mediaedge

import (
	"strings"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

func TestReceiverCodecMatchesTheSingleNegotiatedAnswer(t *testing.T) {
	for _, preferVP8 := range []bool{false, true} {
		engine, err := NewEngine(EngineOptions{BindAddress: "127.0.0.1:0", IncludeLoopback: true})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = engine.Close() })
		upstream, err := engine.api.NewPeerConnection(webrtc.Configuration{})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = upstream.Close() })
		transceiver, err := upstream.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo,
			webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
		if err != nil {
			t.Fatal(err)
		}
		preferences := []webrtc.RTPCodecParameters{videoCodecs["h264"], videoCodecs["vp8"]}
		want := "h264"
		if preferVP8 {
			preferences[0], preferences[1] = preferences[1], preferences[0]
			want = "vp8"
		}
		if err = transceiver.SetCodecPreferences(preferences); err != nil {
			t.Fatal(err)
		}
		offer, err := upstream.CreateOffer(nil)
		if err != nil {
			t.Fatal(err)
		}
		engine.bandwidth.mu.Lock()
		pendingBefore := len(engine.bandwidth.pending)
		engine.bandwidth.mu.Unlock()
		receiver, answer, err := engine.NewReceiver(ReceiverOptions{Offer: offer, EdgeCapacity: 1})
		if err != nil {
			t.Fatal(err)
		}
		engine.bandwidth.mu.Lock()
		pendingObservers := len(engine.bandwidth.pending)
		engine.bandwidth.mu.Unlock()
		if pendingObservers != pendingBefore {
			t.Fatalf("receiver changed pending bandwidth observers from %d to %d", pendingBefore, pendingObservers)
		}
		t.Cleanup(func() { _ = receiver.Close() })
		if receiver.Codec() != want || !strings.Contains(strings.ToLower(answer.SDP), want+"/90000") ||
			(strings.Contains(strings.ToLower(answer.SDP), "vp8/90000") && strings.Contains(strings.ToLower(answer.SDP), "h264/90000")) {
			t.Fatalf("receiver codec %q does not match its single-codec answer", receiver.Codec())
		}
	}
}

func TestReceiverForwardsEncodedVideoToANativeEdge(t *testing.T) {
	for _, codec := range []string{"h264", "vp8"} {
		t.Run(codec, func(t *testing.T) { testReceiverForwarding(t, codec) })
	}
}

func testReceiverForwarding(t *testing.T, codec string) {
	engine, err := NewEngine(EngineOptions{
		BindAddress:     "127.0.0.1:0",
		IncludeLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close() })

	upstreamEngine, err := NewEngine(EngineOptions{
		BindAddress:     "127.0.0.1:0",
		IncludeLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = upstreamEngine.Close() })
	upstream, err := upstreamEngine.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = upstream.Close() })
	track, err := webrtc.NewTrackLocalStaticRTP(
		videoCodecs[codec].RTPCodecCapability, "screen", "upstream",
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = upstream.AddTrack(track); err != nil {
		t.Fatal(err)
	}
	for _, transceiver := range upstream.GetTransceivers() {
		if transceiver.Kind() == webrtc.RTPCodecTypeVideo {
			if err = transceiver.SetCodecPreferences([]webrtc.RTPCodecParameters{videoCodecs[codec]}); err != nil {
				t.Fatal(err)
			}
		}
	}
	audioTrack, err := webrtc.NewTrackLocalStaticRTP(
		opusCapability, "audio", "upstream",
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = upstream.AddTrack(audioTrack); err != nil {
		t.Fatal(err)
	}
	var nativeReceiver *Receiver
	var upstreamCandidates []*webrtc.ICECandidateInit
	var receiverCandidates []*webrtc.ICECandidateInit
	remoteReady := false
	upstream.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate == nil {
			return
		}
		value := candidate.ToJSON()
		if nativeReceiver != nil && remoteReady {
			_ = nativeReceiver.AddRemoteCandidate(&value)
		} else {
			upstreamCandidates = append(upstreamCandidates, &value)
		}
	})
	upstreamGathered := webrtc.GatheringCompletePromise(upstream)
	offer, err := upstream.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = upstream.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	waitSignal(t, upstreamGathered, "upstream ICE gathering")

	nativeReceiver, answer, err := engine.NewReceiver(ReceiverOptions{
		Offer:        *upstream.LocalDescription(),
		EdgeCapacity: 1,
		Events: ReceiverEvents{
			LocalCandidate: func(candidate *webrtc.ICECandidateInit) {
				if candidate != nil {
					if remoteReady {
						_ = upstream.AddICECandidate(*candidate)
					} else {
						receiverCandidates = append(receiverCandidates, candidate)
					}
				}
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = nativeReceiver.Close() })
	if nativeReceiver.Codec() != codec || nativeReceiver.Source().Codec() != codec {
		t.Fatalf("native receiver/source selected %q instead of %q", nativeReceiver.Codec(), codec)
	}
	if err = upstream.SetRemoteDescription(answer); err != nil {
		t.Fatal(err)
	}
	remoteReady = true
	for _, candidate := range upstreamCandidates {
		_ = nativeReceiver.AddRemoteCandidate(candidate)
	}
	for _, candidate := range receiverCandidates {
		_ = upstream.AddICECandidate(*candidate)
	}
	waitConnected(t, upstream, "native receiver")

	downstream, packets, audioPackets, err := connectedReceiverForSources(
		t, engine, nativeReceiver.Source(), nativeReceiver.AudioSource(), "native-relay-edge",
	)
	t.Cleanup(func() { _ = downstream.Close() })
	if err != nil {
		t.Fatal(err)
	}
	want := &rtp.Packet{
		Header: rtp.Header{
			Version:        2,
			PayloadType:    uint8(videoCodecs[codec].PayloadType),
			SequenceNumber: 7,
			Timestamp:      90_000,
			SSRC:           42,
			Marker:         true,
		},
		Payload: []byte{0x65, 0x88, 0x84, 0x00},
	}
	if codec == "vp8" {
		want.Payload = []byte{0x10, 0x10, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01, 0}
	}
	if err = want.SetExtension(9, []byte{0xde, 0xad}); err != nil {
		t.Fatal(err)
	}
	if err = track.WriteRTP(want); err != nil {
		t.Fatal(err)
	}
	got := waitPacket(t, packets)
	if string(got.Payload) != string(want.Payload) || !got.Marker ||
		got.GetExtension(9) != nil {
		t.Fatalf("forwarded packet = %#v", got)
	}
	wantAudio := &rtp.Packet{
		Header: rtp.Header{
			Version: 2, PayloadType: 111, SequenceNumber: 8,
			Timestamp: 960, SSRC: 43, Marker: true,
		},
		Payload: []byte{0xf8, 0xff, 0xfe},
	}
	if err = wantAudio.SetExtension(9, []byte{0xbe, 0xef}); err != nil {
		t.Fatal(err)
	}
	if err = audioTrack.WriteRTP(wantAudio); err != nil {
		t.Fatal(err)
	}
	gotAudio := waitPacket(t, audioPackets)
	if string(gotAudio.Payload) != string(wantAudio.Payload) ||
		gotAudio.GetExtension(9) != nil {
		t.Fatalf("forwarded audio packet = %#v", gotAudio)
	}
	for index, input := range []struct {
		track   *webrtc.TrackLocalStaticRTP
		media   *rtp.Packet
		packets <-chan *rtp.Packet
	}{{track, want, packets}, {audioTrack, wantAudio, audioPackets}} {
		padding := &rtp.Packet{Header: input.media.Header, PaddingSize: 4}
		padding.Padding = true
		padding.SequenceNumber++
		padding.Marker = false
		if err = input.track.WriteRTP(padding); err != nil {
			t.Fatal(err)
		}
		if packet := waitPacket(t, input.packets); !packet.Padding || packet.PaddingSize != padding.PaddingSize || len(packet.Payload) != 0 {
			t.Fatalf("stream %d lost RTP padding continuity", index)
		}
		next := input.media.Clone()
		next.SequenceNumber += 2
		next.Timestamp += 3_000
		if err = input.track.WriteRTP(next); err != nil {
			t.Fatal(err)
		}
		if packet := waitPacket(t, input.packets); string(packet.Payload) != string(next.Payload) {
			t.Fatalf("stream %d stopped delivering media after padding", index)
		}
	}
}

func connectedReceiverForSources(
	t *testing.T,
	engine *Engine,
	source *Source,
	audio *AudioSource,
	connectionID string,
) (*Edge, <-chan *rtp.Packet, <-chan *rtp.Packet, error) {
	options := EdgeOptions{ConnectionID: connectionID, Audio: audio}
	edge, err := engine.NewEdge(source, options)
	if err != nil {
		return nil, nil, nil, err
	}
	receiver := newReceiverWithAudio(t, audio != nil)
	t.Cleanup(func() { _ = receiver.Close() })
	packets := make(chan *rtp.Packet, 4)
	audioPackets := make(chan *rtp.Packet, 4)
	receiver.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		go func() {
			for {
				packet, _, readErr := track.ReadRTP()
				if readErr != nil {
					return
				}
				if track.Kind() == webrtc.RTPCodecTypeAudio {
					audioPackets <- packet
				} else {
					packets <- packet
				}
			}
		}()
	})
	connectEdgeToReceiver(t, edge, receiver)
	return edge, packets, audioPackets, nil
}

func waitConnected(t *testing.T, connection *webrtc.PeerConnection, label string) {
	deadline := time.Now().Add(5 * time.Second)
	for connection.ConnectionState() != webrtc.PeerConnectionStateConnected {
		if time.Now().After(deadline) {
			t.Fatalf("%s state = %s", label, connection.ConnectionState())
		}
		time.Sleep(10 * time.Millisecond)
	}
}
