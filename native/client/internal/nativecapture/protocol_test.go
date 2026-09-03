package nativecapture

import (
	"bytes"
	"encoding/binary"
	"testing"
	"time"
)

func TestReadFrameUsesTheBoundedVersionedEnvelope(t *testing.T) {
	payload := []byte{0, 0, 0, 1, 0x65}
	header := make([]byte, envelopeHeaderBytes)
	copy(header, "SMED")
	header[4] = 1
	header[5] = byte(FrameH264)
	header[6] = 1
	binary.BigEndian.PutUint64(header[8:16], 123)
	binary.BigEndian.PutUint64(header[16:24], 333_333)
	binary.BigEndian.PutUint32(header[24:], uint32(len(payload)))
	frame, err := readFrame(bytes.NewReader(append(header, payload...)))
	if err != nil {
		t.Fatal(err)
	}
	if frame.Kind != FrameH264 || !frame.KeyFrame ||
		frame.Timestamp != 12_300*time.Nanosecond ||
		frame.Duration != 33_333_300*time.Nanosecond ||
		!bytes.Equal(frame.Data, payload) {
		t.Fatalf("frame = %+v", frame)
	}
}

func TestReadFrameRejectsInvalidKindsFlagsAndBounds(t *testing.T) {
	base := make([]byte, envelopeHeaderBytes+1)
	copy(base, "SMED")
	base[4] = 1
	base[5] = byte(FrameH264)
	binary.BigEndian.PutUint64(base[16:24], 1)
	binary.BigEndian.PutUint32(base[24:], 1)
	for _, mutate := range []func([]byte){
		func(value []byte) { value[4] = 2 },
		func(value []byte) { value[5] = 9 },
		func(value []byte) { value[6] = 2 },
		func(value []byte) { value[7] = 1 },
		func(value []byte) { binary.BigEndian.PutUint32(value[24:], maxMediaBytes+1) },
	} {
		candidate := append([]byte(nil), base...)
		mutate(candidate)
		if _, err := readFrame(bytes.NewReader(candidate)); err == nil {
			t.Fatal("invalid native frame was accepted")
		}
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
	if !validCaptureTarget(window) || !validCaptureTarget(display) {
		t.Fatal("valid capture targets were rejected")
	}
	for _, invalid := range []CaptureTarget{
		{Kind: "window", SourceID: "123", PID: 42, Title: "Game"},
		{Kind: "display", SourceID: "789", PID: 42, Title: "Display 1"},
		{Kind: "display", SourceID: "789", CreationTime: "456", Title: "Display 1"},
		{Kind: "other", SourceID: "789", Title: "Display 1"},
	} {
		if validCaptureTarget(invalid) {
			t.Fatalf("invalid capture target was accepted: %+v", invalid)
		}
	}
	audio := Summary{ProcessAudio: true, SystemAudio: true}
	windowWithoutProcess := Summary{SystemAudio: true}
	if !audio.AudioFor("window") || !audio.AudioFor("display") ||
		windowWithoutProcess.AudioFor("window") {
		t.Fatal("capture audio scope was not separated by target kind")
	}
}
