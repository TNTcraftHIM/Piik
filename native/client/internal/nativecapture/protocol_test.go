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

func TestWindowListRejectsPrivateProtocolDrift(t *testing.T) {
	var targets []WindowTarget
	if err := decodeStrictJSON([]byte(
		`[{"windowHandle":"1","pid":2,"creationTime":"3","title":"Game","extra":true}]`,
	), &targets); err == nil {
		t.Fatal("unknown window-list field was accepted")
	}
}
