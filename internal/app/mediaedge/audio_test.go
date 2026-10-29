package mediaedge

import (
	"bytes"
	"encoding/binary"
	"io"
	"math"
	"testing"
	"time"

	"github.com/P4-aaaul/Silip/internal/app/nativeaudio"
	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	gopus "github.com/thesyncim/gopus"
)

// Exercise Pion's actual shared-track fanout without sockets or retirement races.
type audioBinding struct {
	id      string
	err     error
	packets int
	payload []byte
}

func (binding *audioBinding) CodecParameters() []webrtc.RTPCodecParameters {
	return []webrtc.RTPCodecParameters{{RTPCodecCapability: opusCapability, PayloadType: 111}}
}
func (*audioBinding) HeaderExtensions() []webrtc.RTPHeaderExtensionParameter { return nil }
func (*audioBinding) SSRC() webrtc.SSRC                                      { return 1 }
func (*audioBinding) SSRCRetransmission() webrtc.SSRC                        { return 0 }
func (*audioBinding) SSRCForwardErrorCorrection() webrtc.SSRC                { return 0 }
func (binding *audioBinding) WriteStream() webrtc.TrackLocalWriter           { return binding }
func (binding *audioBinding) ID() string                                     { return binding.id }
func (*audioBinding) RTCPReader() interceptor.RTCPReader                     { return nil }
func (binding *audioBinding) WriteRTP(_ *rtp.Header, payload []byte) (int, error) {
	binding.packets++
	binding.payload = append(binding.payload[:0], payload...)
	return len(payload), binding.err
}

func TestSourceVolumeReachesEveryBindingBeforeOpusEncoding(t *testing.T) {
	engine, err := NewEngine(EngineOptions{BindAddress: "127.0.0.1:0", IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	source, err := engine.NewAudioSource(2, 128_000)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	first, second := &audioBinding{id: "first"}, &audioBinding{id: "second"}
	for _, binding := range []*audioBinding{first, second} {
		if _, err := source.samples.Bind(binding); err != nil {
			t.Fatal(err)
		}
	}
	decoder, err := gopus.NewDecoder(gopus.DefaultDecoderConfig(nativeaudio.SampleRate, nativeaudio.Channels))
	if err != nil {
		t.Fatal(err)
	}
	pcm := make([]byte, nativeaudio.FrameBytes)
	decoded := make([]int16, nativeaudio.FrameSamples*nativeaudio.Channels)
	for sample := range nativeaudio.FrameSamples {
		for channel, frequency := range []float64{500, 1500} {
			value := int16(float64(2000*(channel+1)) * math.Sin(2*math.Pi*frequency*float64(sample)/nativeaudio.SampleRate))
			binary.LittleEndian.PutUint16(pcm[(sample*2+channel)*2:], uint16(value))
		}
	}
	original := bytes.Clone(pcm)
	var baseline [2]float64
	for _, gain := range []float64{1, 2, 0, 1} {
		if err := source.SetVolume(gain); err != nil {
			t.Fatal(err)
		}
		var energy [2]float64
		for block := range 20 {
			if err := source.WritePCM(pcm, 20*time.Millisecond); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(first.payload, second.payload) {
				t.Fatal("gain split shared output")
			}
			count, err := decoder.DecodeInt16(first.payload, decoded)
			if err != nil || count != nativeaudio.FrameSamples {
				t.Fatalf("decode: %d, %v", count, err)
			}
			if block < 5 {
				continue
			} // Exclude the gain ramp and codec settling.
			for sample, value := range decoded {
				energy[sample%2] += float64(value) * float64(value)
			}
		}
		if !bytes.Equal(pcm, original) {
			t.Fatal("gain modified capture-owned PCM")
		}
		for channel := range 2 {
			level := math.Sqrt(energy[channel])
			if baseline[channel] == 0 {
				baseline[channel] = level
			}
			ratio := level / baseline[channel]
			if math.Abs(ratio-gain) > .1 {
				t.Fatalf("channel %d gain %g decoded as %.3f", channel, gain, ratio)
			}
		}
	}
}
func (binding *audioBinding) Write(payload []byte) (int, error) {
	return binding.WriteRTP(nil, payload)
}

func TestAudioSourceIsolatesBindingWriteFailure(t *testing.T) {
	engine, err := NewEngine(EngineOptions{BindAddress: "127.0.0.1:0", IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	source, err := engine.NewAudioSource(2, 128_000)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	failed := &audioBinding{id: "retiring", err: io.ErrClosedPipe}
	healthy := &audioBinding{id: "healthy"}
	for _, binding := range []*audioBinding{failed, healthy} {
		if _, err = source.samples.Bind(binding); err != nil {
			t.Fatal(err)
		}
	}
	pcm := make([]byte, nativeaudio.FrameBytes)
	for expected := 1; expected <= 2; expected++ {
		if err = source.WritePCM(pcm, 20*time.Millisecond); err != nil {
			t.Fatalf("one failed binding stopped the shared source: %v", err)
		}
		if healthy.packets != expected || failed.packets != expected {
			t.Fatalf("fanout stopped: healthy=%d failed=%d", healthy.packets, failed.packets)
		}
	}
	if err = source.WritePCM(pcm[:1], 20*time.Millisecond); err == nil {
		t.Fatal("invalid PCM was accepted")
	}
	if err = source.Close(); err != nil {
		t.Fatal(err)
	}
	if err = source.WritePCM(pcm, 20*time.Millisecond); err == nil {
		t.Fatal("closed audio source was accepted")
	}
}
