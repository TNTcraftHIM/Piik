package mediaedge

import (
	"bytes"
	"encoding/hex"
	"sync/atomic"
	"testing"
	"time"

	"github.com/P4-aaaul/Silip/internal/app/nativecapture"
	"github.com/P4-aaaul/Silip/internal/media/encoded"
	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/logging"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/transport/v5/vnet"
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
	var configuration []byte
	for _, nal := range sfu.H264KeyFrame2x2[:2] {
		configuration = append(configuration, 0, 0, 0, 1)
		configuration = append(configuration, nal...)
	}
	if _, err = input.frame(configuration); err != nil {
		t.Fatal(err)
	}
	frame, err = input.frame([]byte{0, 0, 0, 1, 0x65, 0x88, 0x84})
	if err != nil || !frame.KeyFrame || !bytes.Contains(frame.Data, configuration[:4+len(input.sps)]) ||
		!bytes.Contains(frame.Data, input.pps) {
		t.Fatal("H264 IDR lost preceding decoder configuration")
	}
}

func TestRelayInputBoundsStalledAssemblyByMediaTime(t *testing.T) {
	for _, scenario := range []struct {
		name, codec string
		partial     bool
	}{
		{"vp8-missing", "vp8", false}, {"vp8-partial", "vp8", true},
		{"h264-missing", "h264", false}, {"h264-partial", "h264", true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			requests := 0
			input := relayVideoInput{codec: scenario.codec, onPacketDropped: func() { requests++ }}
			key, _ := hex.DecodeString("1000009d012aa0005a00")
			key = append([]byte{0x10}, key...)
			delta, fragment := []byte{0x10, 1, 0}, []byte{0x10, 1, 0}
			if scenario.codec == "h264" {
				key = []byte{0x78}
				for _, nal := range [][]byte{sfu.H264KeyFrame2x2[0], sfu.H264KeyFrame2x2[1], sfu.H264KeyFrame2x2IDR} {
					key = append(key, byte(len(nal)>>8), byte(len(nal)))
					key = append(key, nal...)
				}
				delta, fragment = []byte{0x61, 1, 0}, []byte{0x7c, 0x81, 1}
			}
			origin := uint32(0xffff0000) // Exercise media-clock wrap as well.
			push := func(sequence uint16, timestamp uint32, marker bool, payload []byte) {
				t.Helper()
				if err := input.push(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: sequence, Timestamp: timestamp, Marker: marker}, Payload: payload}); err != nil {
					t.Fatal(err)
				}
			}
			push(10, origin, true, key)
			if sample, _ := input.pop(); sample == nil {
				t.Fatal("no initial recovery")
			}
			if scenario.partial {
				push(11, origin+3000, false, fragment)
			}
			// Sequence 12 never arrives. At low packet rates the memory-sized
			// reorder window must not postpone keyframe feedback for minutes.
			for frame := uint32(2); frame <= 40; frame++ {
				push(uint16(11+frame), origin+frame*3000, true, delta)
				for sample, _ := input.pop(); sample != nil; sample, _ = input.pop() {
					if requests == 0 {
						t.Fatal("dependent frame escaped before loss notification")
					}
				}
				if frame < 30 && requests != 0 {
					t.Fatal("discarded within the reorder allowance")
				}
			}
			if requests == 0 {
				t.Fatal("missing media still blocked recovery after a second")
			}
			push(100, origin+123000, true, key)
			if sample, _ := input.pop(); sample == nil {
				t.Fatal("recovery remained blocked")
			}
		})
	}
}

func TestRelayInputKeepsReorderingAndQuietSource(t *testing.T) {
	requests := 0
	input := relayVideoInput{codec: "vp8", onPacketDropped: func() { requests++ }}
	key, _ := hex.DecodeString("1000009d012aa0005a00")
	push := func(sequence uint16, timestamp uint32, payload []byte) {
		t.Helper()
		if err := input.push(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: sequence, Timestamp: timestamp, Marker: true}, Payload: payload}); err != nil {
			t.Fatal(err)
		}
	}
	push(10, 0, append([]byte{0x10}, key...))
	if sample, _ := input.pop(); sample == nil {
		t.Fatal("no recovery")
	}
	push(12, 6000, []byte{0x10, 1, 0})
	if sample, _ := input.pop(); sample != nil {
		t.Fatal("sequence gap was ignored")
	}
	push(11, 3000, []byte{0x10, 1, 0})
	for _, timestamp := range []uint32{3000, 6000} {
		if sample, got := input.pop(); sample == nil || got != timestamp {
			t.Fatal("reordered frame was lost")
		}
	}
	push(13, 30*videoClockRate, []byte{0x10, 1, 0})
	if sample, _ := input.pop(); sample == nil || requests != 0 {
		t.Fatal("quiet input became packet loss")
	}
}

func TestRelayInputRetiredLossDoesNotRequestAnotherKeyFrame(t *testing.T) {
	for _, codec := range []string{"vp8", "h264"} {
		t.Run(codec, func(t *testing.T) {
			requests := 0
			input := relayVideoInput{codec: codec, onPacketDropped: func() { requests++ }}
			key := append([]byte{0x10}, sfu.VP8KeyFrame8x8...)
			delta, fragment := []byte{0x10, 1, 0}, []byte{0x10, 1, 0}
			if codec == "h264" {
				key = []byte{0x78}
				for _, nal := range [][]byte{sfu.H264KeyFrame2x2[0], sfu.H264KeyFrame2x2[1], sfu.H264KeyFrame2x2IDR} {
					key = append(key, byte(len(nal)>>8), byte(len(nal)))
					key = append(key, nal...)
				}
				delta, fragment = []byte{0x61, 1, 0}, []byte{0x7c, 0x81, 1}
			}
			push := func(sequence uint16, timestamp uint32, marker bool, payload []byte) {
				t.Helper()
				if err := input.push(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: sequence, Timestamp: timestamp, Marker: marker}, Payload: payload}); err != nil {
					t.Fatal(err)
				}
			}
			push(10, 0, true, key)
			if sample, _ := input.pop(); sample == nil {
				t.Fatal("no initial recovery")
			}
			push(11, 3000, false, fragment)
			push(13, 6000, true, delta) // The previous frame's final packet was lost.
			if sample, _ := input.pop(); sample != nil {
				t.Fatal("incomplete frame escaped")
			}
			push(14, 9000, true, key)
			if requests != 0 {
				t.Fatalf("retiring old loss requested another keyframe %d times", requests)
			}
			sample, timestamp := input.pop()
			if sample == nil || timestamp != 9000 {
				t.Fatal("replacement keyframe did not recover immediately")
			}
			frame, err := input.frame(sample.Data)
			if err != nil || !frame.KeyFrame || frame.Width == 0 || frame.Height == 0 {
				t.Fatalf("replacement recovery lost its decoder configuration: %+v, %v", frame, err)
			}
			// A lost packet in a subsequent keyframe must still request recovery.
			push(15, 12000, false, key)
			for index := uint32(0); index < 40; index++ {
				push(uint16(17+index), 15000+index*3000, true, delta)
				for sample, _ := input.pop(); sample != nil; sample, _ = input.pop() {
				}
			}
			if requests == 0 {
				t.Fatal("loss in the current keyframe no longer requests recovery")
			}
		})
	}
}

func TestRelayInputRejectsUnsafeH264Configuration(t *testing.T) {
	// Generated Constrained Baseline SPS: ID 0 is 5120x2880; ID 1 is
	// 160x90. A decoder may use either, regardless of which arrived last.
	const oversized = "6742c034da0050005a64"
	const small = "6742c015570a37e4c05a8303035280000003008000000301478b17c0"
	for _, test := range []struct {
		name string
		nals []string
	}{
		{"oversize-hidden-by-small-SPS", []string{oversized, small}},
		{"oversize-after-small-SPS", []string{small, oversized}},
		{"truncated-SPS", []string{small, "6742c015"}},
		{"truncated-VUI", []string{"6742c01eda0280b7fe5c0505050200"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			var data []byte
			for _, value := range test.nals {
				nal, err := hex.DecodeString(value)
				if err != nil {
					t.Fatal(err)
				}
				data = append(data, 0, 0, 0, 1)
				data = append(data, nal...)
			}
			input := relayVideoInput{codec: "h264"}
			if _, err := input.frame(data); err == nil {
				t.Fatal("unsafe configuration reached the native decoder boundary")
			}
		})
	}
	input := relayVideoInput{codec: "h264"}
	data, err := hex.DecodeString("00000001" + small)
	if err != nil {
		t.Fatal(err)
	}
	frame, err := input.frame(data)
	if err != nil || frame.Width != 160 || frame.Height != 90 {
		t.Fatalf("valid cropped SPS was rejected: %dx%d, %v", frame.Width, frame.Height, err)
	}
}

func TestRelayH264AllocationBounds(t *testing.T) {
	// Minimal Constrained Baseline parameter sets, including valid codec padding
	// and coded dimensions hidden behind a small crop. No decoder is allocated.
	for _, test := range []struct {
		name, sps     string
		width, height uint32
	}{
		{"1440p", "6742c033da00a002d640", 2560, 1440},
		{"padded-1080p", "6742c033da01e0089f95", 1920, 1080},
		{"portrait-within-bound", "6742c033da01100b5e5d", 1080, 1440},
		{"4k", "6742c033da00f0010f90", 3840, 2160},
		{"portrait-4k", "6742c033da008701e190", 2160, 3840},
		{"level-5.2-4k", "6742c034da00f0010f90", 3840, 2160},
		{"level-5.2-portrait-4k", "6742c034da008701e190", 2160, 3840},
		{"level-5.2-dci", "6742c034da0040004864", 4096, 2304},
		{"level-5.2-ultrawide", "6742c034da005000b590", 5120, 1440},
		{"level-5.2-portrait-ultrawide", "6742c034da0168028190", 1440, 5120},
		{"padded-4k", "6742c033da00f00111f894", 3840, 2160},
		{"4k-reference-buffer-limit", "6742c033f300780087c8", 3840, 2160},
		{"4k-reference-buffer-overflow", "6742c033f380780087c8", 0, 0},
		{"level-5.2-reference-buffer-overflow", "6742c034f380780087c8", 0, 0},
		{"level-5.2-cropped-storage-overflow", "6742c034da00f001e1f8034940", 0, 0},
		{"large-cropped-storage", "6742c033da00f001e1f8034940", 0, 0},
		{"crop-overflow", "6742c033da0a37e000000300100000030004", 0, 0},
		{"coded-size-overflow", "6742c033da000003000040000003000d90", 0, 0},
		{"excessive-references", "6742c033d84828d9", 0, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			data, err := hex.DecodeString(test.sps)
			if err != nil {
				t.Fatal(err)
			}
			width, height, err := relayH264Size(data)
			if (err == nil) != (test.width != 0) || width != test.width || height != test.height {
				t.Fatalf("picture = %dx%d, %v; want %dx%d", width, height, err, test.width, test.height)
			}
		})
	}
}

func FuzzRelayH264Size(f *testing.F) {
	for _, value := range []string{"6742c033da00f0010f90", "6742c033da008701e190", "6742c033da00f00111f894", "6742c015"} {
		data, err := hex.DecodeString(value)
		if err != nil {
			f.Fatal(err)
		}
		f.Add(data)
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		width, height, err := relayH264Size(data)
		if err == nil && !nativecapture.ValidVideoSize(width, height) {
			t.Fatalf("unbounded picture accepted: %dx%d", width, height)
		}
	})
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
	// Isolate packet-window capacity from host UDP receive-buffer overflow.
	// The production sender, SRTP transport and frame assembler still run here.
	router, err := vnet.NewRouter(&vnet.RouterConfig{CIDR: "10.0.0.0/24",
		QueueSize: encoded.MaxPacketWindow, LoggerFactory: logging.NewDefaultLoggerFactory()})
	check(err)
	sendNet, err := vnet.NewNet(&vnet.NetConfig{StaticIPs: []string{"10.0.0.1"}})
	check(err)
	receiveNet, err := vnet.NewNet(&vnet.NetConfig{StaticIPs: []string{"10.0.0.2"}})
	check(err)
	check(router.AddNet(sendNet))
	check(router.AddNet(receiveNet))
	check(router.Start())
	defer router.Stop()
	engine, err := NewEngine(EngineOptions{BindAddress: "127.0.0.1:0", IncludeLoopback: true, InitialBitrate: 12_000_000})
	check(err)
	defer engine.Close()
	engine.listenPacket = sendNet.ListenPacket
	engine.bindAddress = "10.0.0.1:0"
	engine.settings.SetNet(sendNet)
	engine.settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	engine.settings.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	source, err := engine.NewSource("h264", 1, 1, nil)
	check(err)
	defer source.Close()
	check(source.SetFormat(0, 2, 2))
	check(source.ConfigureOutputs([]uint32{12_000_000}))
	edge, err := engine.NewEdge(source, EdgeOptions{ConnectionID: "large-recovery"})
	check(err)
	defer edge.Close()
	media := &webrtc.MediaEngine{}
	check(media.RegisterDefaultCodecs())
	registry := &interceptor.Registry{}
	check(webrtc.RegisterDefaultInterceptors(media, registry))
	settings := webrtc.SettingEngine{}
	settings.SetNet(receiveNet)
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	receiver, err := webrtc.NewAPI(webrtc.WithMediaEngine(media), webrtc.WithInterceptorRegistry(registry),
		webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
	check(err)
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
	sps, pps := sfu.H264KeyFrame2x2[0], sfu.H264KeyFrame2x2[1]
	idr := sfu.H264KeyFrame2x2IDR
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
