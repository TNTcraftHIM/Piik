package androidbridge

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/app/nativeaudio"
	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
)

type testPlatform struct {
	mu           sync.Mutex
	stopped      []int64
	started      chan int64
	siteChanged  func()
	videoStarted func(int64, string)
}

func (p *testPlatform) StartVideo(id int64, configuration string) {
	if p.videoStarted != nil {
		p.videoStarted(id, configuration)
	}
}
func (*testPlatform) RuntimeStopped(string) {}
func (p *testPlatform) SiteAccessChanged() {
	if p.siteChanged != nil {
		p.siteChanged()
	}
}
func (p *testPlatform) StartAudio(id int64) {
	if p.started != nil {
		p.started <- id
	}
}
func (*testPlatform) Control(int64, string, int64, int64) {}
func (p *testPlatform) Stop(id int64)                     { p.mu.Lock(); p.stopped = append(p.stopped, id); p.mu.Unlock() }

func TestRetiredCaptureUnblocksProducerAndCannotReachReplacement(t *testing.T) {
	p := &testPlatform{}
	c := &capture{platform: p, streams: make(map[int64]*captureStream)}
	r := &Runtime{capture: c}
	old := c.stream(context.Background(), nil)
	for range cap(old.frames) {
		old.push(nativecapture.Frame{Kind: nativecapture.FramePCM})
	}
	blocked := make(chan struct{})
	go func() { r.Audio(old.id, make([]byte, nativeaudio.FrameBytes)); close(blocked) }()
	old.Close()
	old.Close()
	select {
	case <-blocked:
	case <-time.After(time.Second):
		t.Fatal("retired capture left JNI producer blocked")
	}
	next := c.stream(context.Background(), nil)
	defer next.Close()
	r.Audio(old.id, make([]byte, nativeaudio.FrameBytes))
	if r.CaptureCurrent(old.id) || !r.CaptureCurrent(next.id) {
		t.Fatal("wrong capture generation retained")
	}
	select {
	case <-next.frames:
		t.Fatal("old callback reached replacement")
	default:
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.stopped) != 1 || p.stopped[0] != old.id {
		t.Fatal("capture retirement was not once-only")
	}
}

func TestAudioProviderCommitsOnlyAfterPlatformStarted(t *testing.T) {
	p := &testPlatform{started: make(chan int64, 1)}
	c := &capture{platform: p, streams: make(map[int64]*captureStream)}
	r := &Runtime{capture: c}
	for _, success := range []bool{true, false} {
		done := make(chan error, 1)
		go func() {
			stream, err := c.Audio(context.Background(), nativecapture.CaptureTarget{}, nil)
			if stream != nil {
				stream.Close()
			}
			done <- err
		}()
		id := <-p.started
		select {
		case <-done:
			t.Fatal("audio returned before platform start")
		default:
		}
		if success {
			r.AudioReady(id)
		} else {
			r.CaptureEnded(id)
		}
		select {
		case err := <-done:
			if (err == nil) != success {
				t.Fatalf("audio success=%v err=%v", success, err)
			}
		case <-time.After(time.Second):
			t.Fatal("audio startup did not settle")
		}
		r.AudioReady(id)
		if r.CaptureCurrent(id) {
			t.Fatal("late ready revived retired audio")
		}
	}
}

func TestEncoderCatalogPreservesBothExplicitPaths(t *testing.T) {
	catalog, err := decodeEncoderCapabilities(`{"encoders":[{"name":"hardware-avc","codec":"h264","width":1920,"height":1080,"pixels":2073600,"macroblocks":100000,"fps":60,"bitrate":20000000},{"name":"platform-vp8","codec":"vp8","width":1280,"height":720,"pixels":921600,"macroblocks":100000,"fps":30,"bitrate":10000000}]}`)
	if err != nil {
		t.Fatal(err)
	}
	capabilities := catalog.nativeCapabilities()
	health := catalog.mediaCapabilities()
	if !health.HardwareH264 || !health.SoftwareVP8 || !capabilities.SoftwareVP8 || len(capabilities.Adapters[0].HardwareH264) != 1 {
		t.Fatal("catalog hid an available codec")
	}
	for _, requested := range []string{"h264", "vp8", "auto"} {
		var configured string
		p := &testPlatform{videoStarted: func(_ int64, configuration string) {
			var options struct{ Codec string }
			if err := json.Unmarshal([]byte(configuration), &options); err != nil {
				t.Fatal(err)
			}
			configured = options.Codec
		}}
		c := &capture{platform: p, encoders: catalog.Encoders, streams: make(map[int64]*captureStream)}
		stream, err := c.Video(context.Background(), nativecapture.VideoOptions{Codec: requested, Profile: nativecapture.VideoProfile{Width: 640, Height: 360, Framerate: 30, Bitrate: 1000000}})
		if err != nil {
			t.Fatal(err)
		}
		if configured != requested {
			t.Fatal("explicit intent or auto preparation was replaced before actual encoding")
		}
		stream.Close()
	}
}

func TestActualCodecCommitsStatusAndEncodedFrameTogether(t *testing.T) {
	for _, actual := range []string{"h264", "vp8"} {
		t.Run(actual, func(t *testing.T) {
			c := &capture{platform: &testPlatform{}, encoders: []encoderCapability{{Codec: "h264"}, {Codec: "vp8"}}, streams: make(map[int64]*captureStream)}
			raw, err := c.Video(context.Background(), nativecapture.VideoOptions{Codec: "auto", Profile: nativecapture.VideoProfile{Width: 640, Height: 360, Framerate: 30, Bitrate: 1000000}})
			if err != nil {
				t.Fatal(err)
			}
			defer raw.Close()
			s := raw.(*captureStream)
			r := &Runtime{capture: c}
			profile := ""
			kind := byte(nativecapture.FrameVP8)
			if actual == "h264" {
				profile = "42e01f"
				kind = byte(nativecapture.FrameH264)
			}
			r.VideoReady(s.id, actual, 640, 360, profile)
			frame, err := s.Read()
			if err != nil {
				t.Fatal(err)
			}
			var state struct{ Codec string }
			if err = json.Unmarshal(frame.Data, &state); err != nil {
				t.Fatal(err)
			}
			if frame.Kind != nativecapture.FrameStatus || state.Codec != actual {
				t.Fatal("actual codec absent from active status")
			}
			r.Video(s.id, []byte{1, 2, 3}, 0, 33333, true)
			_, _ = s.Read()
			frame, err = s.Read()
			if err != nil || byte(frame.Kind) != kind {
				t.Fatal("encoded bytes mislabeled after auto fallback")
			}
		})
	}
}

func TestExplicitCodecCannotCommitAnotherCodec(t *testing.T) {
	c := &capture{platform: &testPlatform{}, encoders: []encoderCapability{{Codec: "h264"}, {Codec: "vp8"}}, streams: make(map[int64]*captureStream)}
	raw, err := c.Video(context.Background(), nativecapture.VideoOptions{Codec: "h264", Profile: nativecapture.VideoProfile{Width: 640, Height: 360, Framerate: 30, Bitrate: 1000000}})
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	s := raw.(*captureStream)
	r := &Runtime{capture: c}
	r.VideoReady(s.id, "vp8", 640, 360, "")
	if r.CaptureCurrent(s.id) {
		t.Fatal("explicit AVC silently changed codec")
	}
}

func TestCommittedCodecStaysLockedWhileRotationCanUpdateDimensions(t *testing.T) {
	c := &capture{platform: &testPlatform{}, encoders: []encoderCapability{{Codec: "h264"}, {Codec: "vp8"}}, streams: make(map[int64]*captureStream)}
	raw, err := c.Video(context.Background(), nativecapture.VideoOptions{Codec: "auto", Profile: nativecapture.VideoProfile{Width: 640, Height: 640, Framerate: 30, Bitrate: 1000000}})
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	s := raw.(*captureStream)
	r := &Runtime{capture: c}
	r.VideoReady(s.id, "vp8", 640, 360, "")
	_, _ = s.Read()
	r.VideoReady(s.id, "vp8", 360, 640, "")
	frame, err := s.Read()
	if err != nil || frame.Kind != nativecapture.FrameStatus || s.format.Load() != uint64(360)<<32|640 {
		t.Fatal("same-codec rotation did not publish actual dimensions")
	}
	r.VideoReady(s.id, "h264", 360, 640, "42e01f")
	if r.CaptureCurrent(s.id) {
		t.Fatal("committed auto stream silently changed codec")
	}
}
