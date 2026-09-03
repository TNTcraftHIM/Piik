package nativeaudio

import (
	"testing"
)

func TestEncodeProducesAReusableOpusPacket(t *testing.T) {
	encoder, err := NewEncoder(DefaultBitrate)
	if err != nil {
		t.Fatal(err)
	}
	pcm := make([]byte, FrameBytes)
	first, err := encoder.Encode(pcm)
	if err != nil || len(first) == 0 {
		t.Fatalf("first packet = %d bytes, %v", len(first), err)
	}
	firstCopy := append([]byte(nil), first...)
	second, err := encoder.Encode(pcm)
	if err != nil || len(second) == 0 {
		t.Fatalf("second packet = %d bytes, %v", len(second), err)
	}
	if string(firstCopy) != string(second) {
		t.Fatalf("silence packet changed between identical frames")
	}
	if &first[0] != &second[0] {
		t.Fatalf("encoder did not reuse its output buffer")
	}
}

func TestEncodeRejectsNonFrameSizedPCM(t *testing.T) {
	encoder, err := NewEncoder(DefaultBitrate)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = encoder.Encode(make([]byte, FrameBytes-2)); err == nil {
		t.Fatal("short PCM frame was accepted")
	}
	if _, err = encoder.Encode(make([]byte, FrameBytes+2)); err == nil {
		t.Fatal("long PCM frame was accepted")
	}
}

func TestNewEncoderRejectsOutOfRangeBitrate(t *testing.T) {
	for _, bitrate := range []int{0, 5_999, 510_001} {
		if _, err := NewEncoder(bitrate); err == nil {
			t.Fatalf("bitrate %d was accepted", bitrate)
		}
	}
}

func TestEncodeSteadyStateAllocationIsBounded(t *testing.T) {
	encoder, err := NewEncoder(DefaultBitrate)
	if err != nil {
		t.Fatal(err)
	}
	pcm := make([]byte, FrameBytes)
	if _, err = encoder.Encode(pcm); err != nil {
		t.Fatal(err)
	}
	allocations := testing.AllocsPerRun(20, func() {
		if _, err := encoder.Encode(pcm); err != nil {
			t.Fatal(err)
		}
	})
	if allocations > 4 {
		t.Fatalf("steady-state Opus encoding allocated %.1f objects", allocations)
	}
}
