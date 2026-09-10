package mediaedge

import (
	"bytes"
	"encoding/hex"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/media/encoded"
	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
)

func TestRelayInputKeepsRecoveryAndEmitsACompleteQuietFrame(t *testing.T) {
	// A single complete access unit must not need a subsequent frame or timer.
	key, err := hex.DecodeString("1000009d012aa0005a00")
	if err != nil {
		t.Fatal(err)
	}
	input := relayVideoInput{codec: "vp8"}
	if err = input.push(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: 10, Timestamp: 0xfffffff0, Marker: true},
		Payload: append([]byte{0x10}, key...)}); err != nil {
		t.Fatal(err)
	}
	sample, timestamp := input.pop()
	if sample == nil || timestamp != 0xfffffff0 || !bytes.Equal(sample.Data, key) {
		t.Fatal("complete quiet frame waited for future input")
	}
	frame, err := input.frame(sample.Data)
	if err != nil || !frame.KeyFrame || frame.Width != 160 || frame.Height != 90 {
		t.Fatalf("VP8 recovery metadata = %+v, %v", frame, err)
	}
	frame, err = input.frame([]byte{1, 0, 0, 1})
	if err != nil || frame.KeyFrame || frame.Width != 160 || frame.Height != 90 {
		t.Fatal("delta frame lost the stream's dimensions")
	}

	input = relayVideoInput{codec: "h264"}
	configuration, _ := hex.DecodeString("000000016742c01eda0280b7fe5c050505020000000168ce06e2")
	if _, err = input.frame(configuration); err != nil {
		t.Fatal(err)
	}
	frame, err = input.frame([]byte{0, 0, 0, 1, 0x65, 0x88, 0x84})
	if err != nil || !frame.KeyFrame || !bytes.Contains(frame.Data, configuration[:4+len(input.sps)]) ||
		!bytes.Contains(frame.Data, input.pps) {
		t.Fatal("H264 IDR lost preceding decoder configuration")
	}
}

func TestLargeRecoveryUsesTheDefaultPacketWindow(t *testing.T) {
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	// Standard user-data SEI plus the library's valid H264 keyframe. The SEI
	// makes this AU exceed 500 RTP packets without a codec/GPU test dependency.
	var data []byte
	for _, nal := range sfu.H264KeyFrame2x2[:2] {
		data = append(data, 0, 0, 0, 1)
		data = append(data, nal...)
	}
	data = append(data, 0, 0, 0, 1, 0x06, 5)
	const userBytes = 1024 * 1024
	for size := userBytes; size >= 255; size -= 255 {
		data = append(data, 255)
	}
	data = append(data, userBytes%255)
	data = append(data, bytes.Repeat([]byte{0x55}, userBytes)...)
	data = append(data, 0x80, 0, 0, 0, 1)
	data = append(data, sfu.H264KeyFrame2x2IDR...)
	packetizer := encoded.NewPacketizer(&codecs.H264Payloader{}, h264PayloadType, videoPacketMTU)
	packets, err := packetizer.Packetize(data, 0, time.Second)
	check(err)
	if len(packets) <= 500 || len(packets) > encoded.MaxPacketWindow {
		t.Fatal("fixture does not exercise the packet window boundary")
	}
	engine, err := NewEngine(EngineOptions{BindAddress: "127.0.0.1:0", IncludeLoopback: true, InitialBitrate: 12_000_000})
	check(err)
	defer engine.Close()
	source, err := engine.NewSource("h264", 1, 1, nil)
	check(err)
	defer source.Close()
	check(source.SetFormat(0, 2, 2))
	check(source.ConfigureOutputs([]uint32{12_000_000}))
	edge, err := engine.NewEdge(source, EdgeOptions{ConnectionID: "large-recovery"})
	check(err)
	defer edge.Close()
	receiver := newReceiver(t)
	defer receiver.Close()
	var complete atomic.Bool
	receiver.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		input := relayVideoInput{codec: "h264"}
		var parts []byte
		var previous uint32
		for {
			packet, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			if err = input.push(packet); err != nil {
				t.Error(err)
				return
			}
			for {
				sample, timestamp := input.pop()
				if sample == nil {
					break
				}
				if timestamp != previous {
					parts = parts[:0]
					previous = timestamp
				}
				parts = append(parts, sample.Data...)
				if bytes.Equal(parts, data) {
					complete.Store(true)
				}
			}
		}
	})
	connectEdgeToReceiver(t, edge, receiver)
	for attempt := 1; attempt <= 4 && !complete.Load(); attempt++ {
		check(writeSourceFrame(source, data, time.Duration(attempt)*time.Second, time.Second))
		time.Sleep(time.Second)
	}
	if !complete.Load() || edge.transport.Egress().DroppedPackets != 0 {
		t.Fatalf("large recovery did not survive source, pacer and assembly: packets=%d complete=%v egress=%+v", len(packets), complete.Load(), edge.transport.Egress())
	}
}

func TestRelayAssemblyRecoversAtNewIndependentFrame(t *testing.T) {
	key, _ := hex.DecodeString("1000009d012aa0005a00")
	sps, _ := hex.DecodeString("6742c01eda0280b7fe5c0505050200")
	pps := []byte{0x68, 0xce, 0x06, 0xe2}
	idr := []byte{0x65, 0x88, 0x84}
	stap := []byte{0x78}
	for _, nal := range [][]byte{sps, pps, idr} {
		stap = append(stap, byte(len(nal)>>8), byte(len(nal)))
		stap = append(stap, nal...)
	}
	for _, check := range []struct {
		name, codec string
		recovery    [][]byte
	}{
		{"vp8", "vp8", [][]byte{append([]byte{0x10}, key...), {0x00, 0x01}}},
		{"h264-nals", "h264", [][]byte{sps, pps, idr}},
		{"h264-stap", "h264", [][]byte{stap}},
		{"h264-fu", "h264", [][]byte{append([]byte{0x7c, 0x87}, sps[1:5]...), append([]byte{0x7c, 0x47}, sps[5:]...), pps, idr}},
	} {
		t.Run(check.name, func(t *testing.T) {
			input := relayVideoInput{codec: check.codec}
			old := uint32(0xffffe000)
			fresh := uint32(0x1000)
			push := func(sequence uint16, timestamp uint32, marker bool, payload []byte) {
				t.Helper()
				if err := input.push(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: sequence, Timestamp: timestamp, Marker: marker}, Payload: payload}); err != nil {
					t.Fatal(err)
				}
			}
			for index, payload := range check.recovery {
				push(uint16(10+index), old, index+1 == len(check.recovery), payload)
			}
			if sample, _ := input.pop(); sample == nil {
				t.Fatal("initial complete recovery did not assemble")
			}
			for sample, _ := input.pop(); sample != nil; sample, _ = input.pop() {
			}
			// A missing sequence and partial frame must not block later independent recovery.
			partial := []byte{0x10, 0x01, 0x00}
			if check.codec == "h264" {
				partial = []byte{0x7c, 0x81, 0x01}
			}
			push(30, old+3000, false, partial)
			if sample, _ := input.pop(); sample != nil {
				t.Fatal("incomplete frame unexpectedly assembled")
			}
			for index, payload := range check.recovery {
				push(uint16(40+index), fresh, index+1 == len(check.recovery), payload)
				if index == 0 {
					push(40, fresh, index+1 == len(check.recovery), payload)
					push(10, old, false, payload)
				}
			}
			sample, timestamp := input.pop()
			if sample == nil || timestamp != fresh {
				t.Fatalf("new recovery remained blocked: sample=%v timestamp=%x recovery=%x", sample != nil, timestamp, input.recoveryTimestamp)
			}
			recovered := false
			for ; sample != nil; sample, timestamp = input.pop() {
				if timestamp != fresh {
					t.Fatal("old frame was replayed after recovery")
				}
				frame, err := input.frame(sample.Data)
				if err != nil {
					t.Fatal(err)
				}
				if frame.KeyFrame {
					if frame.Width == 0 || frame.Height == 0 {
						t.Fatal("recovered dimensions missing")
					}
					recovered = true
				}
			}
			if !recovered {
				t.Fatal("complete independent recovery was not assembled")
			}
		})
	}
}
