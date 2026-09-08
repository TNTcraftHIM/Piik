package nativecapture

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"slices"
	"testing"
	"time"
)

func TestReadFrameUsesTheBoundedVersionedEnvelope(t *testing.T) {
	payload := []byte{0, 0, 0, 1, 0x65}
	header := make([]byte, envelopeHeaderBytes)
	copy(header, "SMED")
	header[4] = 2
	header[5] = byte(FrameH264)
	header[6] = 1
	header[7] = 1
	binary.BigEndian.PutUint64(header[8:16], 123)
	binary.BigEndian.PutUint64(header[16:24], 333_333)
	binary.BigEndian.PutUint16(header[24:26], 1920)
	binary.BigEndian.PutUint16(header[26:28], 1080)
	binary.BigEndian.PutUint32(header[28:32], uint32(len(payload)))
	frame, err := readFrame(bytes.NewReader(append(header, payload...)))
	if err != nil {
		t.Fatal(err)
	}
	if frame.Kind != FrameH264 || !frame.KeyFrame || frame.Layer != 1 || frame.Width != 1920 || frame.Height != 1080 ||
		frame.Timestamp != 12_300*time.Nanosecond ||
		frame.Duration != 33_333_300*time.Nanosecond ||
		!bytes.Equal(frame.Data, payload) {
		t.Fatalf("frame = %+v", frame)
	}
	header[5] = byte(FrameVP8)
	frame, err = readFrame(bytes.NewReader(append(header, payload...)))
	if err != nil || frame.Kind != FrameVP8 || !frame.KeyFrame || !bytes.Equal(frame.Data, payload) {
		t.Fatalf("VP8 frame = %+v, %v", frame, err)
	}
}

func TestReadFrameRejectsInvalidKindsFlagsAndBounds(t *testing.T) {
	base := make([]byte, envelopeHeaderBytes+1)
	copy(base, "SMED")
	base[4] = 2
	base[5] = byte(FrameH264)
	binary.BigEndian.PutUint64(base[16:24], 1)
	binary.BigEndian.PutUint16(base[24:26], 1280)
	binary.BigEndian.PutUint16(base[26:28], 720)
	binary.BigEndian.PutUint32(base[28:32], 1)
	for _, mutate := range []func([]byte){
		func(value []byte) { value[4] = 1 },
		func(value []byte) { value[5] = 9 },
		func(value []byte) { value[6] = 2 },
		func(value []byte) { value[7] = maxOutputs },
		func(value []byte) { binary.BigEndian.PutUint16(value[24:26], 1279) },
		func(value []byte) { binary.BigEndian.PutUint64(value[8:16], ^uint64(0)) },
		func(value []byte) { binary.BigEndian.PutUint32(value[28:32], maxMediaBytes+1) },
	} {
		candidate := append([]byte(nil), base...)
		mutate(candidate)
		if _, err := readFrame(bytes.NewReader(candidate)); err == nil {
			t.Fatal("invalid native frame was accepted")
		}
	}
}

func TestMediaEnvelopeAcceptsFourMiBAndRejectsLargerFrames(t *testing.T) {
	const limit = 4 * 1024 * 1024
	frame := Frame{Kind: FrameH264, KeyFrame: true, Width: 2560, Height: 1440,
		Duration: time.Second / 60, Data: make([]byte, limit)}
	var output bytes.Buffer
	if err := writeFrame(&output, frame); err != nil {
		t.Fatal(err)
	}
	read, err := readFrame(bytes.NewReader(output.Bytes()))
	if err != nil || len(read.Data) != limit || read.Width != frame.Width || read.Height != frame.Height {
		t.Fatalf("4 MiB media envelope rejected: bytes=%d err=%v", len(read.Data), err)
	}
	frame.Data = append(frame.Data, 0)
	var rejected bytes.Buffer
	if err := writeFrame(&rejected, frame); err == nil || rejected.Len() != 0 {
		t.Fatal("oversized media wrote an envelope")
	}
	header := append([]byte(nil), output.Bytes()[:envelopeHeaderBytes]...)
	binary.BigEndian.PutUint32(header[28:32], limit+1)
	if _, err := readFrame(bytes.NewReader(header)); err == nil || errors.Is(err, io.EOF) {
		t.Fatal("oversized input was not rejected before payload allocation")
	}
}

func TestInputBeginAndUnavailableLayerHaveDistinctEnvelopes(t *testing.T) {
	header := make([]byte, envelopeHeaderBytes)
	copy(header, "SMED")
	header[4], header[5] = 2, byte(FrameBegin)
	binary.BigEndian.PutUint64(header[16:24], 333_333)
	frame, err := readFrame(bytes.NewReader(header))
	if err != nil || frame.Kind != FrameBegin || len(frame.Data) != 0 || frame.Duration <= 0 {
		t.Fatalf("begin = %+v, %v", frame, err)
	}
	header[5], header[7] = byte(FrameLayerUnavailable), 1
	binary.BigEndian.PutUint64(header[16:24], 0)
	payload := []byte("output encoder unavailable")
	binary.BigEndian.PutUint32(header[28:32], uint32(len(payload)))
	frame, err = readFrame(bytes.NewReader(append(header, payload...)))
	if err != nil || frame.Kind != FrameLayerUnavailable || frame.Layer != 1 || !bytes.Equal(frame.Data, payload) {
		t.Fatalf("unavailable = %+v, %v", frame, err)
	}
	binary.BigEndian.PutUint32(header[28:32], 1)
	if _, err = readFrame(bytes.NewReader(append(header, 0xff))); err == nil {
		t.Fatal("non-UTF8 output diagnostic was accepted")
	}
	for _, invalid := range []Frame{
		{Kind: FrameControl, Data: bytes.Repeat([]byte{'Q'}, 65)},
		{Kind: FrameControl, Data: []byte("Q\n")},
		{Kind: FrameControl, Data: []byte("Q"), Layer: 1},
		{Kind: FrameControl, Data: []byte("Q"), Timestamp: time.Second},
		{Kind: FrameControl, Data: []byte("Q"), KeyFrame: true},
	} {
		var output bytes.Buffer
		if err := writeFrame(&output, invalid); err == nil || output.Len() != 0 {
			t.Fatal("invalid control wrote a partial envelope")
		}
	}
}

func TestOutputProfilesAndControlFramesShareOneBoundedContract(t *testing.T) {
	profile := VideoProfile{Width: 854, Height: 480, Framerate: 30, Bitrate: 2_000_000, Preference: "balanced"}
	outputs := ScreenShareOutputs(profile)
	if !slices.Equal(outputs, []OutputProfile{
		{Width: 426, Height: 240, Framerate: 30, Bitrate: 500_000},
		{Width: 854, Height: 480, Framerate: 30, Bitrate: 2_000_000},
	}) || !outputs[0].Valid() || !outputs[1].Valid() {
		t.Fatalf("derived outputs = %+v", outputs)
	}
	derived := []OutputProfile{{Width: 160, Height: 90, Framerate: 30, Bitrate: 90_000}, {Width: 320, Height: 180, Framerate: 30, Bitrate: 300_000}}
	if _, err := appendOutputArguments([]string{"--protocol-v7"}, derived); err != nil {
		t.Fatal(err)
	}
	for _, slots := range [][]OutputProfile{{derived[1], derived[0]}, {derived[0], derived[0]},
		{derived[0], derived[1], derived[0], derived[0], derived[0], derived[0]}} {
		if _, err := appendOutputArguments(nil, slots); err != nil {
			t.Fatalf("independent output slots rejected: %v", err)
		}
	}
	for _, invalid := range [][]OutputProfile{nil, make([]OutputProfile, maxOutputs+1), {{}}} {
		if _, err := appendOutputArguments(nil, invalid); err == nil {
			t.Fatal("invalid derived output set was accepted")
		}
	}
	reader, writer := io.Pipe()
	done := make(chan error)
	close(done)
	stream := &Stream{key: writer, done: done, outputs: outputs, cancel: func() {}}
	control := make(chan []byte, 1)
	go func() {
		payload, _ := io.ReadAll(reader)
		_ = reader.Close()
		control <- payload
	}()
	for _, command := range []func() error{
		func() error { return stream.SetOutputActive(1, true) },
		func() error { return stream.SetOutputActive(1, true) },
		func() error { return stream.SetOutputActive(0, true) },
		func() error { return stream.SetOutputActive(1, false) },
		func() error { return stream.SetOutputActive(1, false) },
		func() error { return stream.SetOutputBitrate(0, 250_000) },
		func() error { return stream.SetOutputBitrate(0, 250_000) },
		func() error { return stream.RequestKeyFrame(0) },
		func() error { return stream.RequestKeyFrame(-1) },
		func() error {
			return stream.WriteFrame(Frame{Kind: FrameVP8, Layer: 0, Width: 160, Height: 90, Timestamp: time.Second, Duration: 33_333_300 * time.Nanosecond, KeyFrame: true, Data: []byte{1, 2, 3}})
		},
		stream.Close,
	} {
		if err := command(); err != nil {
			t.Fatal(err)
		}
	}
	frames := bytes.NewReader(<-control)
	var commands []string
	var encodedInputs int
	for frames.Len() > 0 {
		frame, err := readFrame(frames)
		if err != nil {
			t.Fatal(err)
		}
		if frame.Kind == FrameControl {
			commands = append(commands, string(frame.Data))
			continue
		}
		if frame.Kind != FrameVP8 || !frame.KeyFrame || frame.Width != 160 || frame.Height != 90 || frame.Timestamp != time.Second || !bytes.Equal(frame.Data, []byte{1, 2, 3}) {
			t.Fatalf("encoded input = %+v", frame)
		}
		encodedInputs++
	}
	if !slices.Equal(commands, []string{"A 1 1", "A 0 1", "A 1 0", "B 0 250000", "K 0", "K -1", "Q"}) || encodedInputs != 1 {
		t.Fatalf("controls = %q, encoded inputs = %d", commands, encodedInputs)
	}
	if !errors.Is(stream.RequestKeyFrame(0), io.ErrClosedPipe) || stream.SetOutputActive(2, true) == nil ||
		stream.SetOutputActive(-1, false) == nil || !errors.Is(stream.SetOutputActive(0, false), io.ErrClosedPipe) {
		t.Fatal("closed or invalid controls were accepted")
	}
}

func TestIndependentOutputEnvelopeUsesTheLastBoundedSlot(t *testing.T) {
	var output bytes.Buffer
	frame := Frame{Kind: FrameVP8, Layer: maxOutputs - 1, Width: 320, Height: 180,
		Timestamp: time.Second, Duration: time.Second / 30, Data: []byte{1}}
	if err := writeFrame(&output, frame); err != nil {
		t.Fatal(err)
	}
	decoded, err := readFrame(&output)
	if err != nil || decoded.Layer != maxOutputs-1 {
		t.Fatalf("last output slot = %+v, %v", decoded, err)
	}
}

func TestSourceListRejectsPrivateProtocolDrift(t *testing.T) {
	var targets []CaptureTarget
	if err := decodeStrictJSON([]byte(
		`[{"kind":"window","sourceId":"1","pid":2,"creationTime":"3","title":"Game","extra":true}]`,
	), &targets); err == nil {
		t.Fatal("unknown source-list field was accepted")
	}
}

func TestAudioReadyStateIsStrictAndExplicit(t *testing.T) {
	if err := validateAudioReadyFrame(Frame{
		Kind: FrameStatus,
		Data: []byte(`{"state":"active","audio":true}`),
	}); err != nil {
		t.Fatal(err)
	}
	for _, payload := range []string{
		`{"state":"active","audio":false}`,
		`{"state":"starting","audio":true}`,
		`{"state":"active","audio":true,"extra":true}`,
	} {
		if err := validateAudioReadyFrame(Frame{
			Kind: FrameStatus,
			Data: []byte(payload),
		}); err == nil {
			t.Fatalf("invalid audio state was accepted: %s", payload)
		}
	}
	if err := validateAudioReadyFrame(Frame{
		Kind: FramePCM,
		Data: []byte(`{"state":"active","audio":true}`),
	}); err == nil {
		t.Fatal("audio PCM was accepted as a ready frame")
	}
}

func TestCaptureTargetIdentityAndAudioScope(t *testing.T) {
	window := CaptureTarget{
		Kind: "window", SourceID: "123", PID: 42,
		CreationTime: "456", Title: "Game",
	}
	display := CaptureTarget{Kind: "display", SourceID: "789", Title: "Display 1"}
	picker := CaptureTarget{Kind: "picker", SourceID: "1", Title: "System picker"}
	if !window.Valid() || !display.Valid() ||
		!picker.Valid() {
		t.Fatal("valid capture targets were rejected")
	}
	for _, invalid := range []CaptureTarget{
		{Kind: "window", SourceID: "123", PID: 42, Title: "Game"},
		{Kind: "display", SourceID: "789", PID: 42, Title: "Display 1"},
		{Kind: "display", SourceID: "789", CreationTime: "456", Title: "Display 1"},
		{Kind: "picker", SourceID: "1", PID: 42, Title: "System picker"},
		{Kind: "other", SourceID: "789", Title: "Display 1"},
	} {
		if invalid.Valid() {
			t.Fatalf("invalid capture target was accepted: %+v", invalid)
		}
	}
	audio := Summary{ProcessAudio: true, SystemAudio: true}
	windowWithoutProcess := Summary{SystemAudio: true}
	if !audio.AudioFor("window") || !audio.AudioFor("display") ||
		!audio.AudioFor("picker") ||
		windowWithoutProcess.AudioFor("window") {
		t.Fatal("capture audio scope was not separated by target kind")
	}
}

func TestVideoProfileUsesTheProductBounds(t *testing.T) {
	for _, profile := range []VideoProfile{
		{Width: 854, Height: 480, Framerate: 15, Bitrate: 2_000_000, Preference: "maintain-resolution"},
		{Width: 1280, Height: 720, Framerate: 30, Bitrate: 3_000_000, Preference: "balanced"},
		{Width: 1920, Height: 1080, Framerate: 60, Bitrate: 8_000_000, Preference: "maintain-framerate"},
		{Width: 2560, Height: 1440, Framerate: 60, Bitrate: 12_000_000, Preference: "balanced"},
	} {
		if !profile.Valid() {
			t.Fatalf("valid profile rejected: %+v", profile)
		}
	}
	for _, profile := range []VideoProfile{
		{Width: 1920, Height: 1200, Framerate: 30, Bitrate: 5_000_000, Preference: "balanced"},
		{Width: 1920, Height: 1080, Framerate: 14, Bitrate: 5_000_000, Preference: "balanced"},
		{Width: 1920, Height: 1080, Framerate: 30, Bitrate: 12_000_001, Preference: "balanced"},
		{Width: 1920, Height: 1080, Framerate: 30, Bitrate: 5_000_000, Preference: "unknown"},
	} {
		if profile.Valid() {
			t.Fatalf("invalid profile accepted: %+v", profile)
		}
	}
}
