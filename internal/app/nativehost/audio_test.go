package nativehost

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/app/nativeaudio"
	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/pion/webrtc/v4"
)

func writeCaptureFixtureFrame(frame nativecapture.Frame) {
	var header [32]byte
	copy(header[:], "SMED")
	header[4], header[5], header[7] = 2, byte(frame.Kind), byte(frame.Layer)
	if frame.KeyFrame {
		header[6] = 1
	}
	binary.BigEndian.PutUint64(header[8:16], uint64(frame.Timestamp/(100*time.Nanosecond)))
	binary.BigEndian.PutUint64(header[16:24], uint64(frame.Duration/(100*time.Nanosecond)))
	binary.BigEndian.PutUint16(header[24:26], uint16(frame.Width))
	binary.BigEndian.PutUint16(header[26:28], uint16(frame.Height))
	binary.BigEndian.PutUint32(header[28:32], uint32(len(frame.Data)))
	if _, err := os.Stdout.Write(append(header[:], frame.Data...)); err != nil {
		os.Exit(1)
	}
}

func audioRecoveryProfile() nativecapture.VideoProfile {
	return nativecapture.VideoProfile{Width: 1280, Height: 720, Framerate: 30,
		Bitrate: 2_000_000, Preference: "balanced"}
}

// The same stable test executable supplies framed video and PCM, without a
// capture device. Closing stdin ends either child independently.
func runAudioRecoveryCapture() {
	stopped := make(chan struct{})
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); close(stopped) }()
	write := writeCaptureFixtureFrame
	microphone := len(os.Args) > 1 && os.Args[1] == "--capture-microphone"
	if microphone {
		if len(os.Args) == 4 && os.Args[2] == "--device" && os.Args[3] == "missing" {
			os.Exit(2)
		}
		if marker := os.Getenv("PIIK_MICROPHONE_WAIT"); marker != "" {
			_ = os.WriteFile(marker, nil, 0600)
			<-stopped
			return
		}
	}
	audio := microphone || (len(os.Args) > 1 && os.Args[1] == "--capture-audio")
	var deviceFailure string
	if marker := os.Getenv("PIIK_VIDEO_DEVICE_FAILURE"); !audio && marker != "" {
		// Only the first video process fails; a replacement uses the same fixture.
		if owner, err := os.OpenFile(marker+".owner", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600); err == nil {
			_ = owner.Close()
			deviceFailure = marker
		}
	}
	startupGate := os.Getenv("PIIK_VIDEO_START_GATE")
	if audio && !microphone && startupGate != "" {
		if _, err := os.Stat(startupGate + ".active"); err != nil {
			_ = os.WriteFile(startupGate+".early-audio", nil, 0600)
			os.Exit(2)
		}
		_ = os.WriteFile(startupGate+".audio", []byte(os.Args[3]+":"+os.Args[4]), 0600)
	}
	if !audio && os.Getenv("PIIK_VIDEO_FAIL") == "1" {
		_, _ = io.WriteString(os.Stderr, "stage=mft-set-output-type\nhresult=0xc00d36b4\ndetail=private capture target\n")
		os.Exit(2)
	}
	if !microphone && audio && os.Args[2] == "exclude" {
		if os.Getenv("PIIK_EXCLUSION_FAIL") == "1" {
			os.Exit(2)
		}
		if marker := os.Getenv("PIIK_EXCLUSION_STARTED"); marker != "" {
			_ = os.WriteFile(marker, []byte(os.Args[3]+":"+os.Args[4]), 0600)
		}
	}
	if audio && os.Getenv("PIIK_AUDIO_STARTUP") == "no-ready" {
		<-stopped
		return
	}
	profile := audioRecoveryProfile()
	if !audio {
		for index := 1; index+1 < len(os.Args); index++ {
			value, _ := strconv.ParseUint(os.Args[index+1], 10, 32)
			switch os.Args[index] {
			case "--width":
				profile.Width = uint32(value)
			case "--height":
				profile.Height = uint32(value)
			case "--fps":
				profile.Framerate = uint32(value)
			case "--bitrate":
				profile.Bitrate = uint32(value)
			}
		}
	}
	period := time.Second / time.Duration(profile.Framerate)
	status := []byte(`{"state":"active","audio":true}`)
	if audio {
		period = 20 * time.Millisecond
	} else {
		outputs := nativecapture.ScreenShareOutputs(profile)
		outputs = append(outputs, outputs[0])
		status, _ = json.Marshal(CaptureState{State: "active", Codec: "vp8",
			Width: profile.Width, Height: profile.Height, FPS: profile.Framerate, Outputs: outputs})
	}
	marker := os.Getenv("PIIK_AUDIO_WAIT_FOR_VIDEO")
	if audio && marker != "" {
		ticker := time.NewTicker(5 * time.Millisecond)
		defer ticker.Stop()
		for {
			if _, err := os.Stat(marker); err == nil {
				break
			}
			select {
			case <-stopped:
				return
			case <-ticker.C:
			}
		}
	}
	if !audio && startupGate != "" && os.Args[3] == "1" && profile.Width == audioRecoveryProfile().Width {
		var starting CaptureState
		_ = json.Unmarshal(status, &starting)
		starting.State = "starting"
		index := uint32(0)
		starting.AdapterIndex = &index
		starting.AdapterName, starting.AdapterIdentity = "Fixture", "fixture"
		starting.EncoderName, starting.EncoderIdentity = "Fixture VP8", "fixture-vp8"
		initial, _ := json.Marshal(starting)
		write(nativecapture.Frame{Kind: nativecapture.FrameStatus, Data: initial})
		ticker := time.NewTicker(5 * time.Millisecond)
		defer ticker.Stop()
		for {
			if _, err := os.Stat(startupGate + ".fail"); err == nil {
				_, _ = io.WriteString(os.Stderr, "stage=fixture-video-initialization\n")
				os.Exit(2)
			}
			if _, err := os.Stat(startupGate + ".release"); err == nil {
				break
			}
			select {
			case <-stopped:
				return
			case <-ticker.C:
			}
		}
	}
	if !audio && startupGate != "" {
		_ = os.WriteFile(startupGate+".active", nil, 0600)
	}
	write(nativecapture.Frame{Kind: nativecapture.FrameStatus, Data: status})
	if !audio && marker != "" {
		// Exceed the OS pipe buffer before allowing audio initialization to finish.
		data := make([]byte, 256*1024)
		copy(data, sfu.VP8KeyFrame8x8)
		write(nativecapture.Frame{Kind: nativecapture.FrameBegin, Duration: period})
		write(nativecapture.Frame{Kind: nativecapture.FrameVP8, Layer: 1, Width: 8, Height: 8,
			Duration: period, KeyFrame: true, Data: data})
		_ = os.WriteFile(marker, nil, 0600)
	}
	if audio && os.Getenv("PIIK_AUDIO_STARTUP") == "silent" {
		<-stopped
		return
	}
	ticker := time.NewTicker(period)
	defer ticker.Stop()
	for pts := period; ; pts += period {
		select {
		case <-stopped:
			return
		case <-ticker.C:
		}
		if audio {
			write(nativecapture.Frame{Kind: nativecapture.FramePCM, Timestamp: pts,
				Duration: period, Data: make([]byte, nativeaudio.FrameBytes)})
			continue
		}
		if deviceFailure != "" {
			if _, err := os.Stat(deviceFailure); err == nil {
				if os.Getenv("PIIK_VIDEO_DEVICE_CONTROL") == "1" {
					_ = os.Stdin.Close()
					write(nativecapture.Frame{Kind: nativecapture.FrameBegin, Timestamp: pts, Duration: period})
					time.Sleep(50 * time.Millisecond)
				}
				_, _ = io.WriteString(os.Stderr, "stage=capture-device-lost\nhresult=0x887a0005\n")
				os.Exit(2)
			}
		}
		write(nativecapture.Frame{Kind: nativecapture.FrameBegin, Timestamp: pts, Duration: period})
		for layer := range 2 {
			write(nativecapture.Frame{Kind: nativecapture.FrameVP8, Layer: layer, Width: 8, Height: 8,
				Timestamp: pts, Duration: period, KeyFrame: true, Data: sfu.VP8KeyFrame8x8})
		}
	}
}

func TestMixedSourceAudioWaitsForActiveVideoWithoutBlockingStart(t *testing.T) {
	t.Setenv("PIIK_NATIVEHOST_PIPE_FIXTURE", "audio-recovery")
	gate := filepath.Join(t.TempDir(), "video")
	t.Setenv("PIIK_VIDEO_START_GATE", gate)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	events := make(chan Event, 32)
	video := nativecapture.VideoOptions{Codec: "vp8", Profile: audioRecoveryProfile(),
		Target: nativecapture.CaptureTarget{Kind: "window", SourceID: "1", PID: 42, CreationTime: "1", Title: "Fixture"}}
	session, err := Start(ctx, Options{ShareID: "staged-audio", CaptureProcess: executable,
		Video: video, Profile: QualityProfile{Video: video.Profile, AudioBitrate: 64_000},
		AudioEnabled: true, MicrophoneMixing: true, EdgeCapacity: 1, BindAddress: "127.0.0.1:0",
		Events: func(_ context.Context, event Event) { events <- event }})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	if _, err := os.Stat(gate + ".early-audio"); err == nil {
		t.Fatal("source audio initialized before video became active")
	}
	if !session.HasAudio() || session.SourceAudio() == nil || *session.SourceAudio() {
		t.Fatal("pending source audio changed the mixed output shape or claimed readiness")
	}
	if err := os.WriteFile(gate+".release", nil, 0600); err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case event := <-events:
			if event.Type == "audio-state" && event.SourceAudio {
				if _, err := os.Stat(gate + ".audio"); err != nil {
					t.Fatal("source audio did not initialize after active video")
				}
				return
			}
		case <-ctx.Done():
			t.Fatal("active video did not resume pending source audio")
		}
	}
}

func TestPendingSourceAudioRetiresWithVideoOrLaterSelection(t *testing.T) {
	t.Setenv("PIIK_NATIVEHOST_PIPE_FIXTURE", "audio-recovery")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, finish := range []string{"stop", "video-failure", "audio-off", "source-replacement", "audio-profile", "video-profile", "audio-on"} {
		t.Run(finish, func(t *testing.T) {
			gate := filepath.Join(t.TempDir(), "video")
			t.Setenv("PIIK_VIDEO_START_GATE", gate)
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			events := make(chan Event, 32)
			video := nativecapture.VideoOptions{Codec: "vp8", Profile: audioRecoveryProfile(),
				Target: nativecapture.CaptureTarget{Kind: "display", SourceID: "1", Title: "Fixture"}}
			session, err := Start(ctx, Options{ShareID: "pending-audio", CaptureProcess: executable,
				Video: video, Profile: QualityProfile{Video: video.Profile, AudioBitrate: 64_000},
				AudioEnabled: true, MicrophoneMixing: true, EdgeCapacity: 1, BindAddress: "127.0.0.1:0",
				Events: func(_ context.Context, event Event) { events <- event }})
			if err != nil {
				t.Fatal(err)
			}
			defer session.Close()
			completed := make(chan error, 1)
			switch finish {
			case "stop":
				go func() { completed <- session.Close() }()
			case "video-failure":
				if err := os.WriteFile(gate+".fail", nil, 0600); err != nil {
					t.Fatal(err)
				}
				go func() { err := <-session.Done(); completed <- err }()
			case "audio-off", "source-replacement":
				next := video
				if finish == "source-replacement" {
					next.Target = nativecapture.CaptureTarget{Kind: "window", SourceID: "2", PID: 99, CreationTime: "2", Title: "Next fixture"}
				}
				go func() { completed <- session.ReplaceSource(next, false, nil) }()
			case "audio-profile":
				profile := QualityProfile{Video: video.Profile, AudioBitrate: 32_000}
				go func() { completed <- session.UpdateProfile(profile) }()
			case "video-profile":
				profile := QualityProfile{Video: video.Profile, AudioBitrate: 64_000}
				profile.Video.Width, profile.Video.Height = 640, 360
				go func() { completed <- session.UpdateProfile(profile) }()
			case "audio-on":
				go func() { completed <- session.ReplaceSource(video, true, nil) }()
			}
			select {
			case err := <-completed:
				if (err != nil) != (finish == "video-failure" || finish == "audio-on") {
					t.Fatalf("unexpected %s result: %v", finish, err)
				}
			case <-ctx.Done():
				t.Fatal("pending audio blocked", finish)
			}
			if _, err := os.Stat(gate + ".early-audio"); err == nil {
				t.Fatal("source audio initialized before active video")
			}
			if finish == "audio-off" || finish == "source-replacement" {
				if session.SourceAudio() == nil || *session.SourceAudio() || session.currentAudioStream() != nil {
					t.Fatal("late initial audio overwrote the newer source-audio selection")
				}
			} else if finish != "video-profile" {
				if _, err := os.Stat(gate + ".audio"); err == nil {
					t.Fatal("retired video still started source audio")
				}
			}
			if finish == "video-profile" {
				for {
					select {
					case event := <-events:
						if event.Type == "audio-state" && event.SourceAudio {
							return
						}
					case <-ctx.Done():
						t.Fatal("quality replacement lost pending source audio")
					}
				}
			}
		})
	}
}

func TestFixedSourceAudioWaitsForActiveVideoAndCanCancel(t *testing.T) {
	t.Setenv("PIIK_NATIVEHOST_PIPE_FIXTURE", "audio-recovery")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, cancelStartup := range []bool{false, true} {
		t.Run(map[bool]string{false: "active", true: "cancelled"}[cancelStartup], func(t *testing.T) {
			gate := filepath.Join(t.TempDir(), "video")
			t.Setenv("PIIK_VIDEO_START_GATE", gate)
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			events := make(chan Event, 16)
			type result struct {
				session *Session
				err     error
			}
			started := make(chan result, 1)
			go func() {
				video := nativecapture.VideoOptions{Codec: "vp8", Profile: audioRecoveryProfile(),
					Target: nativecapture.CaptureTarget{Kind: "display", SourceID: "1", Title: "Fixture"}}
				session, err := Start(ctx, Options{ShareID: "fixed-audio", CaptureProcess: executable,
					Video: video, Profile: QualityProfile{Video: video.Profile, AudioBitrate: 64_000},
					AudioEnabled: true, EdgeCapacity: 1, BindAddress: "127.0.0.1:0",
					Events: func(_ context.Context, event Event) { events <- event }})
				started <- result{session, err}
			}()
			select {
			case event := <-events:
				if event.Type != "capture-state" || event.State != "starting" {
					t.Fatal("missing video startup progress", event)
				}
			case <-ctx.Done():
				t.Fatal("video startup progress did not arrive")
			}
			select {
			case result := <-started:
				if result.session != nil {
					_ = result.session.Close()
				}
				t.Fatal("fixed audio shape committed before video became active", result.err)
			default:
			}
			if cancelStartup {
				cancel()
			} else if err := os.WriteFile(gate+".release", nil, 0600); err != nil {
				t.Fatal(err)
			}
			select {
			case result := <-started:
				if result.session != nil {
					defer result.session.Close()
				}
				if cancelStartup {
					if result.err == nil || result.session != nil {
						t.Fatal("cancelled startup admitted a share")
					}
				} else if result.err != nil || result.session == nil || !result.session.HasAudio() {
					t.Fatal("fixed source audio was not admitted", result.err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("source audio did not finish startup or cancellation")
			}
			if _, err := os.Stat(gate + ".early-audio"); err == nil {
				t.Fatal("source audio initialized before active video")
			}
		})
	}
}

func TestCaptureStartupReturnsNativeFailureCodesWithoutPrivateDetail(t *testing.T) {
	t.Setenv("PIIK_NATIVEHOST_PIPE_FIXTURE", "audio-recovery")
	t.Setenv("PIIK_VIDEO_FAIL", "1")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	video := nativecapture.VideoOptions{Codec: "h264", Profile: audioRecoveryProfile(),
		Target: nativecapture.CaptureTarget{Kind: "display", SourceID: "1", Title: "Fixture"}}
	session, err := Start(t.Context(), Options{ShareID: "startup-failure", CaptureProcess: executable,
		Video: video, Profile: QualityProfile{Video: video.Profile, AudioBitrate: 64_000}, EdgeCapacity: 1,
		BindAddress: "127.0.0.1:0"})
	if session != nil {
		_ = session.Close()
		t.Fatal("failed capture started a share")
	}
	if err == nil || !strings.Contains(err.Error(), "mft-set-output-type") || !strings.Contains(err.Error(), "0xc00d36b4") {
		t.Fatalf("startup lost native machine codes: %v", err)
	}
	if strings.Contains(err.Error(), "private") {
		t.Fatalf("startup exposed private helper detail: %v", err)
	}
}

func TestAudioStartupDoesNotRequireSamplesOrStopVideo(t *testing.T) {
	t.Setenv("PIIK_NATIVEHOST_PIPE_FIXTURE", "audio-recovery")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"silent", "no-ready", "drain-video"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("PIIK_AUDIO_STARTUP", mode)
			if mode == "drain-video" {
				t.Setenv("PIIK_AUDIO_WAIT_FOR_VIDEO", filepath.Join(t.TempDir(), "video-drained"))
			}
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			video := nativecapture.VideoOptions{Codec: "vp8", Profile: audioRecoveryProfile(),
				Target: nativecapture.CaptureTarget{Kind: "display", SourceID: "1", Title: "Silent fixture"}}
			session, err := Start(ctx, Options{ShareID: "audio-startup", CaptureProcess: executable,
				Video: video, Profile: QualityProfile{Video: video.Profile, AudioBitrate: 64_000},
				AudioEnabled: true, EdgeCapacity: 1, BindAddress: "127.0.0.1:0"})
			if err != nil {
				t.Fatal(err)
			}
			defer session.Close()
			if session.Codec() != "vp8" || session.HasAudio() != (mode != "no-ready") {
				t.Fatalf("codec=%s audio=%v for %s", session.Codec(), session.HasAudio(), mode)
			}
			cancel()
			select {
			case err := <-session.Done():
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("Stop did not release the silent audio and video readers")
			}
		})
	}
}

func TestAudioEOFWaitsForExplicitSourceReplacement(t *testing.T) {
	t.Setenv("PIIK_NATIVEHOST_PIPE_FIXTURE", "audio-recovery")
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	executable, err := os.Executable()
	check(err)
	events := make(chan Event, 64)
	options := nativecapture.VideoOptions{Codec: "vp8", Profile: audioRecoveryProfile(),
		Target: nativecapture.CaptureTarget{Kind: "display", SourceID: "1", Title: "Audio fixture"}}
	session, err := Start(ctx, Options{ShareID: "audio-recovery", CaptureProcess: executable,
		Video: options, Profile: QualityProfile{Video: options.Profile, AudioBitrate: 64_000},
		AudioEnabled: true, EdgeCapacity: 1, BindAddress: "127.0.0.1:0", Events: func(_ context.Context, event Event) {
			select {
			case events <- event:
			case <-ctx.Done():
			}
		}})
	check(err)
	defer session.Close()
	if !session.HasAudio() {
		t.Fatal("fixture did not start audio")
	}
	settings := webrtc.SettingEngine{}
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	receiver, err := webrtc.NewAPI(webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
	check(err)
	defer receiver.Close()
	var audioPackets, videoPackets atomic.Uint64
	receiver.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			packet, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			if track.Codec().MimeType == webrtc.MimeTypeOpus && len(packet.Payload) > 0 {
				audioPackets.Add(1)
			} else if track.Kind() == webrtc.RTPCodecTypeVideo {
				videoPackets.Add(1)
			}
		}
	})
	offer, err := session.PrepareLocalEdge("audio-edge", "local_offer_1", false)
	check(err)
	check(receiver.SetRemoteDescription(offer))
	// A receive preference belongs to this answer, not the upstream offer.
	for _, transceiver := range receiver.GetTransceivers() {
		if transceiver.Kind() != webrtc.RTPCodecTypeAudio {
			continue
		}
		for _, codec := range transceiver.Receiver().GetParameters().Codecs {
			if codec.MimeType == webrtc.MimeTypeOpus {
				codec.SDPFmtpLine = "stereo=1;maxaveragebitrate=510000"
				check(transceiver.SetCodecPreferences([]webrtc.RTPCodecParameters{codec}))
				break
			}
		}
	}
	go func() {
		for {
			select {
			case event := <-events:
				if event.Type == "edge-candidate" && event.Candidate != nil {
					_ = receiver.AddICECandidate(*event.Candidate)
				}
			case <-ctx.Done():
				return
			}
		}
	}()
	gathered := webrtc.GatheringCompletePromise(receiver)
	answer, err := receiver.CreateAnswer(nil)
	check(err)
	check(receiver.SetLocalDescription(answer))
	select {
	case <-gathered:
	case <-ctx.Done():
		t.Fatal("receiver gathering timed out")
	}
	check(session.SetAnswer("audio-edge", *receiver.LocalDescription(), "local_offer_1"))
	waitPackets := func(counter *atomic.Uint64, minimum uint64, label string) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for counter.Load() < minimum {
			if time.Now().After(deadline) {
				t.Fatalf("%s: received %d, wanted %d", label, counter.Load(), minimum)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	waitPackets(&audioPackets, 3, "initial Opus")
	waitPackets(&videoPackets, 3, "initial video")
	previousAudio, previousVideo := session.currentAudioStream(), session.currentStream()
	edge, audioSource := session.edge("audio-edge"), session.audioSource
	check(previousAudio.Close())
	waitPackets(&videoPackets, videoPackets.Load()+10, "video after audio EOF")
	before := audioPackets.Load()
	options.Target.SourceID = "2"
	check(session.ReplaceSource(options, true, nil))
	if session.currentStream() == previousVideo || session.currentAudioStream() == previousAudio ||
		session.edge("audio-edge") != edge || session.audioSource != audioSource {
		t.Fatal("explicit replacement did not preserve the media owners")
	}
	waitPackets(&audioPackets, before+3, "Opus after explicit source replacement")
	check(session.currentAudioStream().Close())
	waitPackets(&videoPackets, videoPackets.Load()+5, "video after second audio EOF")
	closed := make(chan error, 1)
	go func() { closed <- session.Close() }()
	select {
	case err = <-closed:
		check(err)
	case <-time.After(3 * time.Second):
		t.Fatal("Stop did not unblock the audio replacement wait")
	}
}
