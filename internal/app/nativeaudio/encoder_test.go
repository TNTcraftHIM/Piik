package nativeaudio

import (
	"encoding/binary"
	"math"
	"math/rand/v2"
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

func TestEncodePreservesStereoSeparation(t *testing.T) {
	for _, bitrate := range []int{64_000, 128_000, 192_000, 256_000, 320_000} {
		encoder, err := NewEncoder(bitrate)
		if err != nil {
			t.Fatal(err)
		}
		decoder, err := gopus.NewDecoder(gopus.DefaultDecoderConfig(SampleRate, Channels))
		if err != nil {
			t.Fatal(err)
		}
		pcm := make([]byte, FrameBytes)
		decoded := make([]int16, FrameSamples*Channels)
		frequencies := [2]float64{500, 1500}
		var tones [2][2]complex128
		for block := 0; block < 30; block++ {
			for frame := 0; frame < FrameSamples; frame++ {
				for channel, frequency := range frequencies {
					phase := 2 * math.Pi * frequency * float64(block*FrameSamples+frame) / SampleRate
					binary.LittleEndian.PutUint16(pcm[(frame*Channels+channel)*2:], uint16(int16(8_000*math.Sin(phase))))
				}
			}
			packet, err := encoder.Encode(pcm)
			if err != nil {
				t.Fatal(err)
			}
			count, err := decoder.DecodeInt16(packet, decoded)
			if err != nil || count != FrameSamples {
				t.Fatalf("decode: %d samples, %v", count, err)
			}
			if block < 5 {
				continue // Exclude codec startup; compare frequency energy, not phase delay.
			}
			for frame := 0; frame < count; frame++ {
				for tone, frequency := range frequencies {
					phase := 2 * math.Pi * frequency * float64(block*FrameSamples+frame) / SampleRate
					for channel := range Channels {
						tones[channel][tone] += complex(float64(decoded[frame*Channels+channel]), 0) * complex(math.Cos(phase), math.Sin(phase))
					}
				}
			}
		}
		for channel := range Channels {
			wanted, other := tones[channel][channel], tones[channel][1-channel]
			level := math.Hypot(real(wanted), imag(wanted))
			leak := math.Hypot(real(other), imag(other))
			if level < 1 || level < 10*leak {
				t.Fatalf("%d bps channel %d lost separation: signal %f, leakage %f", bitrate, channel, level, leak)
			}
		}
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
	decoder, err := gopus.NewDecoder(gopus.DefaultDecoderConfig(SampleRate, Channels))
	if err != nil {
		t.Fatal(err)
	}
	pcm := make([]byte, FrameBytes)
	decoded := make([]int16, FrameSamples*Channels)
	for _, bitrate := range []int{64_000, 192_000, 256_000, 320_000, 96_000, DefaultBitrate} {
		if err = encoder.SetBitrate(bitrate); err != nil {
			t.Fatalf("SetBitrate(%d) = %v", bitrate, err)
		}
		if encoder.Bitrate() != bitrate {
			t.Fatalf("SetBitrate(%d) readback = %d", bitrate, encoder.Bitrate())
		}
		packet, err := encoder.Encode(pcm)
		if err != nil {
			t.Fatal(err)
		}
		count, err := decoder.DecodeInt16(packet, decoded)
		if err != nil || count != FrameSamples {
			t.Fatalf("decode after bitrate %d: %d samples, %v", bitrate, count, err)
		}
	}
	for _, bitrate := range []int{0, 5_999, 510_001} {
		if err = encoder.SetBitrate(bitrate); err == nil {
			t.Fatalf("invalid live bitrate %d was accepted", bitrate)
		}
		if encoder.Bitrate() != DefaultBitrate {
			t.Fatalf("rejected bitrate %d replaced the active setting", bitrate)
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

func TestEncodeBoundsTransientPacketsAcrossBitrateChanges(t *testing.T) {
	encoder, err := NewEncoder(DefaultBitrate)
	if err != nil {
		t.Fatal(err)
	}
	decoder, err := gopus.NewDecoder(gopus.DefaultDecoderConfig(SampleRate, Channels))
	if err != nil {
		t.Fatal(err)
	}
	pcm := make([]byte, FrameBytes)
	decoded := make([]int16, FrameSamples*Channels)
	random := rand.New(rand.NewPCG(472, 20261014))
	for _, bitrate := range []int{DefaultBitrate, MaxSendBitrate, MinBitrate, 12_345, MaxSendBitrate} {
		if err := encoder.SetBitrate(bitrate); err != nil {
			t.Fatal(err)
		}
		for block := range 100 {
			for frame := range FrameSamples {
				for channel := range Channels {
					sample := 0.0
					switch (block / 10) % 5 {
					case 1:
						sample = 26_000 * math.Sin(2*math.Pi*float64(500+channel*1000)*float64(block*FrameSamples+frame)/SampleRate)
					case 2:
						sample = 32_767 * (random.Float64()*2 - 1)
					case 3:
						if frame < 10 {
							sample = 32_767
						}
					case 4:
						sample = float64(32_767 - 65_535*(frame%2))
					}
					binary.LittleEndian.PutUint16(pcm[(frame*Channels+channel)*2:], uint16(int16(sample)))
				}
			}
			packet, err := encoder.Encode(pcm)
			if err != nil {
				t.Fatalf("encode %d bps block %d: %v", bitrate, block, err)
			}
			// Opus RTP cannot fragment a frame. Reserve RTP/extensions/SRTP space.
			if len(packet)+48 > 1200 {
				t.Fatalf("%d bps block %d exceeded packet budget: %d payload bytes", bitrate, block, len(packet))
			}
			count, err := decoder.DecodeInt16(packet, decoded)
			if err != nil || count != FrameSamples {
				t.Fatalf("decode %d bps block %d: %d samples, %v", bitrate, block, count, err)
			}
		}
	}
}
