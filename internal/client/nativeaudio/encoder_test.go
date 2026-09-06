package nativeaudio

import (
	"encoding/binary"
	"math"
	"testing"

	gopus "github.com/thesyncim/gopus"
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

func TestEncodePreservesAudiblePCM(t *testing.T) {
	encoder, err := NewEncoder(DefaultBitrate)
	if err != nil {
		t.Fatal(err)
	}
	pcm := make([]byte, FrameBytes)
	for frame := 0; frame < FrameSamples; frame++ {
		sample := int16(math.Sin(2*math.Pi*440*float64(frame)/SampleRate) * 8_000)
		for channel := 0; channel < Channels; channel++ {
			binary.LittleEndian.PutUint16(
				pcm[(frame*Channels+channel)*2:],
				uint16(sample),
			)
		}
	}
	packet, err := encoder.Encode(pcm)
	if err != nil {
		t.Fatal(err)
	}
	decoder, err := gopus.NewDecoder(gopus.DefaultDecoderConfig(SampleRate, Channels))
	if err != nil {
		t.Fatal(err)
	}
	decoded := make([]int16, FrameSamples*Channels)
	samples, err := decoder.DecodeInt16(packet, decoded)
	if err != nil {
		t.Fatal(err)
	}
	energy := int64(0)
	for _, sample := range decoded[:samples*Channels] {
		if sample < 0 {
			energy -= int64(sample)
		} else {
			energy += int64(sample)
		}
	}
	if energy == 0 {
		t.Fatal("Opus round trip produced silence")
	}
}

func TestNewEncoderRejectsOutOfRangeBitrate(t *testing.T) {
	for _, bitrate := range []int{0, 5_999, 510_001} {
		if _, err := NewEncoder(bitrate); err == nil {
			t.Fatalf("bitrate %d was accepted", bitrate)
		}
	}
}

func TestEncoderUpdatesBitrateWithinTheSameGeneration(t *testing.T) {
	encoder, err := NewEncoder(DefaultBitrate)
	if err != nil {
		t.Fatal(err)
	}
	for _, bitrate := range []int{64_000, 192_000, DefaultBitrate} {
		if err = encoder.SetBitrate(bitrate); err != nil {
			t.Fatalf("SetBitrate(%d) = %v", bitrate, err)
		}
	}
	if err = encoder.SetBitrate(0); err == nil {
		t.Fatal("invalid live bitrate was accepted")
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
