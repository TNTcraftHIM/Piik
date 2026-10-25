package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/app/loopback"
	"github.com/TNTcraftHIM/Piik/internal/app/nativeaudio"
	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/TNTcraftHIM/Piik/internal/app/nativecontrol"
	"github.com/TNTcraftHIM/Piik/internal/app/nativehost"
)

type testPlatform struct {
	mu              sync.Mutex
	stopped         []int64
	started         chan int64
	siteChanged     func()
	videoStarted    func(int64, string)
	preparationDone func(int64)
}

func TestVideoOnlyPlatformDoesNotAdvertisePlaybackAudio(t *testing.T) {
	catalog, err := decodeEncoderCapabilities(`{"platform":"ios","provider":"VideoToolbox","encoders":[{"name":"hardware-avc","codec":"h264","width":1280,"height":720,"pixels":921600,"macroblocks":100000,"fps":30,"bitrate":3000000}]}`)
	if err != nil {
		t.Fatal(err)
	}
	native, media := catalog.nativeCapabilities(), catalog.mediaCapabilities()
	if native.Platform != "ios" || native.Adapters[0].Name != "VideoToolbox" || !media.Video || !media.HardwareH264 {
		t.Fatalf("video producer was not preserved: native=%+v media=%+v", native, media)
	}
	if native.SystemAudio || media.SystemAudio || media.ShareVolume {
		t.Fatalf("video support invented playback audio: native=%+v media=%+v", native, media)
	}
}

func (p *testPlatform) StartVideo(id int64, configuration string) {
	if p.videoStarted != nil {
		p.videoStarted(id, configuration)
	}
}
func (*testPlatform) RuntimeStopped(string) {}
func (p *testPlatform) PreparationDone(id int64) {
	if p.preparationDone != nil {
		p.preparationDone(id)
	}
}
func (p *testPlatform) StartMicrophone(id int64, _ string) { p.StartAudio(id) }
func (*testPlatform) Microphones() (string, error)         { return "[]", nil }

func TestVideoPreparationSpansSourceAudioAndCaptureCommit(t *testing.T) {
	for _, outcome := range []string{"ready", "denied", "cancelled", "video-ended", "video-only", "replace"} {
		t.Run(outcome, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			completed := make(chan int64, 4)
			p := &testPlatform{started: make(chan int64, 4), preparationDone: func(id int64) { completed <- id }}
			c := &capture{platform: p, encoders: []encoderCapability{{Codec: "vp8"}}, streams: make(map[int64]*captureStream)}
			r := &Runtime{capture: c}
			p.videoStarted = func(id int64, configuration string) {
				var output nativecapture.OutputProfile
				if err := json.Unmarshal([]byte(configuration), &output); err != nil {
					t.Error(err)
					return
				}
				r.VideoReady(id, "vp8", int64(output.Width), int64(output.Height), "")
			}
			video := nativecapture.VideoOptions{Codec: "vp8", Target: nativecapture.CaptureTarget{Kind: "picker"},
				Profile: nativecapture.VideoProfile{Width: 640, Height: 360, Framerate: 30, Bitrate: 1_000_000, Preference: "balanced"}}
			var session *nativehost.Session
			result := make(chan error, 1)
			go func() {
				var err error
				session, err = nativehost.Start(ctx, nativehost.Options{ShareID: "preparation-fixture", Capture: c, Video: video,
					Profile: nativehost.QualityProfile{Video: video.Profile, AudioBitrate: 64_000}, AudioEnabled: outcome != "video-only" && outcome != "replace",
					MicrophoneMixing: outcome == "replace",
					EdgeCapacity:     1, BindAddress: "127.0.0.1:0"})
				result <- err
			}()
			awaitResult := func() error {
				t.Helper()
				select {
				case err := <-result:
					return err
				case <-time.After(3 * time.Second):
					t.Fatal("capture operation did not finish")
					return nil
				}
			}
			if outcome == "replace" {
				if err := awaitResult(); err != nil {
					t.Fatal(err)
				}
				if id := <-completed; id != 1 {
					t.Fatal("initial preparation identity", id)
				}
				go func() { result <- session.ReplaceSource(video, true, nil) }()
			}
			var audioID int64
			if outcome != "video-only" {
				select {
				case audioID = <-p.started:
				case <-time.After(3 * time.Second):
					t.Fatal("audio admission was not requested")
				}
				select {
				case <-completed:
					t.Fatal("video released preparation before source audio admission")
				default:
				}
				switch outcome {
				case "cancelled":
					cancel()
				case "denied":
					r.CaptureEnded(audioID)
				case "video-ended":
					r.CaptureEnded(1)
				default:
					r.AudioReady(audioID)
				}
			}
			err := awaitResult()
			if (err != nil) != (outcome == "cancelled" || outcome == "video-ended") {
				t.Fatalf("operation result: %v", err)
			}
			if outcome == "video-ended" && (session != nil || !strings.Contains(err.Error(), "capture stopped unexpectedly")) {
				t.Fatalf("ended video was not a failed startup: session=%v err=%v", session != nil, err)
			}
			if outcome == "ready" || outcome == "replace" {
				if audio := c.get(audioID); audio == nil || audio.ctx.Err() != nil || !session.HasAudio() {
					t.Fatal("successful startup retired live source audio")
				}
			}
			if outcome == "replace" && (r.CaptureCurrent(1) || !r.CaptureCurrent(2)) {
				t.Fatal("old source retirement affected the committed replacement")
			}
			select {
			case id := <-completed:
				want := int64(1)
				if outcome == "replace" {
					want = 2
				}
				if id != want {
					t.Fatalf("preparation identity %d, want %d", id, want)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("aggregate preparation was not released")
			}
			if session != nil {
				_ = session.Close()
			}
		})
	}
}

func TestCommentaryWaitsForPlatformAdmissionAndRetiresIndependently(t *testing.T) {
	for _, admitted := range []bool{false, true} {
		t.Run(fmt.Sprint(admitted), func(t *testing.T) {
			platform := &testPlatform{started: make(chan int64, 1)}
			capture := &capture{platform: platform, streams: make(map[int64]*captureStream)}
			runtime := &Runtime{capture: capture}
			source := capture.stream(t.Context(), nil)
			defer source.Close()
			type result struct {
				stream nativehost.CaptureStream
				err    error
			}
			done := make(chan result, 1)
			go func() { stream, err := capture.Microphone(t.Context(), ""); done <- result{stream, err} }()
			id := <-platform.started
			select {
			case <-done:
				t.Fatal("microphone reported success before platform admission")
			default:
			}
			if admitted {
				runtime.AudioReady(id)
			} else {
				runtime.CaptureEnded(id)
			}
			var observed result
			select {
			case observed = <-done:
			case <-time.After(time.Second):
				t.Fatal("microphone admission remained blocked")
			}
			if admitted {
				if observed.err != nil || observed.stream == nil {
					t.Fatalf("admitted microphone failed: %v", observed.err)
				}
				pcm := make([]byte, nativeaudio.FrameBytes)
				pcm[0], pcm[2] = 13, 13
				runtime.Audio(id, pcm)
				frame, err := observed.stream.Read()
				if err != nil || frame.Kind != nativecapture.FramePCM || frame.Duration != 20*time.Millisecond || !bytes.Equal(frame.Data, pcm) {
					t.Fatal("microphone did not use the existing stereo PCM contract")
				}
				observed.stream.Close()
			} else if observed.err == nil || observed.stream != nil {
				t.Fatal("rejected microphone was reported ready")
			}
			if !runtime.CaptureCurrent(source.id) || runtime.CaptureCurrent(id) {
				t.Fatal("microphone retirement affected source audio or retained failed input")
			}
		})
	}
}
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
	catalog, err := decodeEncoderCapabilities(`{"platform":"android","provider":"Android MediaCodec","systemAudio":true,"encoders":[{"name":"hardware-avc","codec":"h264","width":1920,"height":1080,"pixels":2073600,"macroblocks":100000,"fps":60,"bitrate":20000000},{"name":"platform-vp8","codec":"vp8","width":1280,"height":720,"pixels":921600,"macroblocks":100000,"fps":30,"bitrate":10000000}]}`)
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

func TestIncompatibleAVCPreparationCanFallBackBeforeCommit(t *testing.T) {
	c := &capture{platform: &testPlatform{}, encoders: []encoderCapability{{Codec: "h264"}, {Codec: "vp8"}}, streams: make(map[int64]*captureStream)}
	raw, err := c.Video(context.Background(), nativecapture.VideoOptions{Codec: "auto", Profile: nativecapture.VideoProfile{Width: 640, Height: 360, Framerate: 30, Bitrate: 1000000}})
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	s := raw.(*captureStream)
	r := &Runtime{capture: c}
	if r.VideoReady(s.id, "h264", 640, 360, "640028") {
		t.Fatal("unsupported actual AVC profile was accepted")
	}
	if !r.CaptureCurrent(s.id) || s.codec.Load() != 0 || s.format.Load() != 0 || len(s.frames) != 0 {
		t.Fatal("rejected preparation changed or retired the uncommitted stream")
	}
	if !r.VideoReady(s.id, "vp8", 640, 360, "") {
		t.Fatal("auto fallback could not prepare VP8")
	}
	frame, err := s.Read()
	if err != nil || frame.Kind != nativecapture.FrameStatus {
		t.Fatal("fallback status missing")
	}
	r.Video(s.id, []byte{1, 2, 3}, 0, 33333, true)
	_, _ = s.Read()
	frame, err = s.Read()
	if err != nil || frame.Kind != nativecapture.FrameVP8 {
		t.Fatal("fallback bytes used rejected AVC format")
	}
}

func TestRejectedRotationProfileLeavesCommittedSourceUntouched(t *testing.T) {
	c := &capture{platform: &testPlatform{}, encoders: []encoderCapability{{Codec: "h264"}}, streams: make(map[int64]*captureStream)}
	raw, err := c.Video(context.Background(), nativecapture.VideoOptions{Codec: "h264", Profile: nativecapture.VideoProfile{Width: 640, Height: 640, Framerate: 30, Bitrate: 1000000}})
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	s := raw.(*captureStream)
	r := &Runtime{capture: c}
	if !r.VideoReady(s.id, "h264", 640, 360, "42e01f") {
		t.Fatal("initial AVC not ready")
	}
	_, _ = s.Read()
	oldFormat := s.format.Load()
	if r.VideoReady(s.id, "h264", 360, 640, "640028") {
		t.Fatal("unsupported rotated profile accepted")
	}
	if !r.CaptureCurrent(s.id) || s.format.Load() != oldFormat || len(s.frames) != 0 {
		t.Fatal("failed rotation destroyed or modified healthy source")
	}
	r.Video(s.id, []byte{1, 2, 3}, 0, 33333, true)
	_, _ = s.Read()
	frame, err := s.Read()
	if err != nil || frame.Kind != nativecapture.FrameH264 || frame.Width != 640 || frame.Height != 360 {
		t.Fatal("restored old source cannot continue")
	}
	if !r.VideoReady(s.id, "h264", 360, 640, "42e01f") {
		t.Fatal("legal same-codec rotation rejected")
	}
}

func TestSourceCancellationRequiresTheActualRequestOptIn(t *testing.T) {
	for _, kind := range []string{"start-share", "replace-share-source"} {
		for _, optedIn := range []bool{false, true} {
			t.Run(fmt.Sprint(kind, "/", optedIn), func(t *testing.T) {
				p := &testPlatform{}
				c := &capture{platform: p, encoders: []encoderCapability{{Codec: "vp8"}}, streams: make(map[int64]*captureStream)}
				r := &Runtime{capture: c}
				p.videoStarted = func(id int64, configuration string) {
					if kind == "start-share" || id > 1 {
						r.CaptureCanceled(id)
						return
					}
					var output nativecapture.OutputProfile
					if err := json.Unmarshal([]byte(configuration), &output); err != nil {
						t.Error(err)
						return
					}
					r.VideoReady(id, "vp8", int64(output.Width), int64(output.Height), "")
				}
				control := nativecontrol.NewWithCapture(nativecapture.Capabilities{SoftwareVP8: true}, false, nil, c)
				defer control.Close()
				handle := func(payload string) map[string]any {
					t.Helper()
					value, err := control.Handle(t.Context(), []byte(payload))
					if err != nil {
						t.Fatal(err)
					}
					var request struct{ ID string }
					if err := json.Unmarshal([]byte(payload), &request); err != nil {
						t.Fatal(err)
					}
					deadline := time.NewTimer(3 * time.Second)
					defer deadline.Stop()
					for {
						if value == nil {
							select {
							case value = <-control.Events():
							case <-deadline.C:
								t.Fatal("control response did not complete")
							}
						}
						if event, ok := value.(loopback.ControlEvent); ok {
							if event.Current != nil && !event.Current() {
								value = nil
								continue
							}
							if event.BeforeWrite != nil {
								event.BeforeWrite()
							}
							value = event.Value
						}
						data, err := json.Marshal(value)
						if err != nil {
							t.Fatal(err)
						}
						var result map[string]any
						if err = json.Unmarshal(data, &result); err != nil {
							t.Fatal(err)
						}
						if result["id"] == request.ID {
							return result
						}
						value = nil
					}
				}
				start := `{"version":10,"id":"request_start","type":"start-share","shareId":"share_123456","source":{"kind":"picker","sourceId":"1","title":"Fixture"},"edgeCapacity":1,"codec":"vp8","profile":{"resolution":{"width":640,"height":360},"maxFramerate":30,"maxBitrate":1000000,"degradationPreference":"balanced"}}`
				payload := start
				if kind == "replace-share-source" {
					if result := handle(start); result["type"] != "share-started" {
						t.Fatalf("initial share: %v", result)
					}
					payload = `{"version":10,"id":"request_replace","type":"replace-share-source","shareId":"share_123456","source":{"kind":"picker","sourceId":"1","title":"Fixture"},"audio":false}`
				}
				if optedIn {
					payload = strings.TrimSuffix(payload, "}") + `,"reportSourceCancellation":true}`
				}
				result := handle(payload)
				want := "operation-failed"
				if optedIn {
					want = "source-canceled"
				}
				if result["type"] != "request-failed" || result["code"] != want {
					t.Fatalf("request opt-in lost: %v", result)
				}
			})
		}
	}
}

func TestProjectionDismissalPreservesCancellationAndCurrentCapture(t *testing.T) {
	for _, canceled := range []bool{true, false} {
		t.Run(fmt.Sprint(canceled), func(t *testing.T) {
			p := &testPlatform{}
			c := &capture{platform: p, encoders: []encoderCapability{{Codec: "vp8"}}, streams: make(map[int64]*captureStream)}
			r := &Runtime{capture: c}
			p.videoStarted = func(id int64, configuration string) {
				if id > 1 {
					if canceled {
						r.CaptureCanceled(id)
					} else {
						r.CaptureEnded(id)
					}
					return
				}
				var output nativecapture.OutputProfile
				if err := json.Unmarshal([]byte(configuration), &output); err != nil {
					t.Error(err)
					return
				}
				r.VideoReady(id, "vp8", int64(output.Width), int64(output.Height), "")
			}
			video := nativecapture.VideoOptions{Codec: "vp8", Target: nativecapture.CaptureTarget{Kind: "picker"}, Profile: nativecapture.VideoProfile{Width: 640, Height: 360, Framerate: 30, Bitrate: 1_000_000, Preference: "balanced"}}
			session, err := nativehost.Start(t.Context(), nativehost.Options{ShareID: "projection-cancel", Capture: c, Video: video, Profile: nativehost.QualityProfile{Video: video.Profile, AudioBitrate: 64_000}, EdgeCapacity: 1, BindAddress: "127.0.0.1:0"})
			if err != nil {
				t.Fatal(err)
			}
			defer session.Close()
			err = session.ReplaceSource(video, false, nil)
			if err == nil || errors.Is(err, nativecapture.ErrSourceCanceled) != canceled {
				t.Fatalf("replacement classification: %v", err)
			}
			if !r.CaptureCurrent(1) || r.CaptureCurrent(2) {
				t.Fatal("failed replacement retired the current capture or retained the candidate")
			}
			if canceled {
				p.videoStarted = func(id int64, _ string) { r.CaptureCanceled(id) }
				pending, err := nativehost.Start(t.Context(), nativehost.Options{ShareID: "projection-start-cancel", Capture: c, Video: video, Profile: nativehost.QualityProfile{Video: video.Profile, AudioBitrate: 64_000}, EdgeCapacity: 1, BindAddress: "127.0.0.1:0"})
				if pending != nil || !errors.Is(err, nativecapture.ErrSourceCanceled) {
					t.Fatalf("initial picker cancellation: %v", err)
				}
			}
		})
	}
}
