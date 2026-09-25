package mediaedge

import (
	"io"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/app/nativeaudio"
	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// Exercise Pion's actual shared-track fanout without sockets or retirement races.
type audioBinding struct {
	id      string
	err     error
	packets int
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
	return len(payload), binding.err
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
