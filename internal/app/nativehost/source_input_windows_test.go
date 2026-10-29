//go:build windows

package nativehost

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/P4-aaaul/Silip/internal/app/nativecapture"
	"github.com/P4-aaaul/Silip/internal/app/remoteinput"
)

type sourceInputCapture struct {
	processCapture
	reject      error
	rejectAudio bool
}

func (c *sourceInputCapture) Audio(ctx context.Context, target nativecapture.CaptureTarget, excluded *nativecapture.CaptureTarget) (CaptureStream, error) {
	if c.rejectAudio {
		return nil, errors.New("candidate audio failed")
	}
	return c.processCapture.Audio(ctx, target, excluded)
}

func (c *sourceInputCapture) Video(ctx context.Context, options nativecapture.VideoOptions) (CaptureStream, error) {
	if c.reject != nil {
		return rejectedSourceStream{failure: c.reject}, nil
	}
	return c.processCapture.Video(ctx, options)
}

type rejectedSourceStream struct {
	CaptureStream
	failure error
}

func (s rejectedSourceStream) Read() (nativecapture.Frame, error) {
	return nativecapture.Frame{}, s.failure
}
func (s rejectedSourceStream) Close() error                           { return nil }
func (s rejectedSourceStream) Outputs() []nativecapture.OutputProfile { return nil }

func TestSourcePreparationPreservesInputAuthorizationUntilCommit(t *testing.T) {
	t.Setenv("SILIP_NATIVEHOST_PIPE_FIXTURE", "audio-recovery")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	input, err := remoteinput.New(ctx, false)
	if err != nil || input == nil {
		t.Fatalf("Windows input backend unavailable: %v", err)
	}
	defer input.Close()
	capture := &sourceInputCapture{processCapture: processCapture{executable}}
	video := nativecapture.VideoOptions{Codec: "vp8", Profile: audioRecoveryProfile(), Target: nativecapture.CaptureTarget{Kind: "display", SourceID: "1", Title: "Fixture"}}
	session, err := Start(ctx, Options{ShareID: "source-input-transaction", Capture: capture, Video: video, Profile: QualityProfile{Video: video.Profile, AudioBitrate: 64_000}, EdgeCapacity: 1, BindAddress: "127.0.0.1:0", RemoteInput: input, MicrophoneMixing: true})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	// Enabling ask records policy only. No Viewer is granted and no input is injected.
	apply, err := session.PrepareRemoteInputPolicy("ask", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := apply(); err != nil {
		t.Fatal(err)
	}
	previous := session.currentStream()
	next := video
	next.Target.SourceID = "2"
	for _, failure := range []error{errors.New("candidate failed"), nativecapture.ErrSourceCanceled} {
		capture.reject = failure
		if err := session.ReplaceSource(next, false, nil); err == nil {
			t.Fatal("rejected preparation succeeded")
		}
		if session.currentStream() != previous || session.RemoteInputState().Mode != "ask" {
			t.Fatal("failed preparation retired the previous source authorization")
		}
		select {
		case <-session.Done():
			t.Fatal("failed preparation stopped the share")
		default:
		}
	}
	capture.reject = nil
	select {
	case <-session.videoActive:
	case <-ctx.Done():
		t.Fatal("initial capture did not become active")
	}
	capture.rejectAudio = true
	if err := session.ReplaceSource(next, true, nil); err == nil {
		t.Fatal("rejected audio preparation succeeded")
	}
	if session.currentStream() != previous || session.RemoteInputState().Mode != "ask" {
		t.Fatal("audio preparation failure retired previous source authorization")
	}
	capture.rejectAudio = false
	profile := QualityProfile{Video: video.Profile, AudioBitrate: 64_000}
	profile.Video.Width, profile.Video.Height = 640, 360
	if err := session.UpdateProfile(profile); err != nil {
		t.Fatal(err)
	}
	if session.RemoteInputState().Mode != "ask" {
		t.Fatal("same-source profile update retired desktop input authorization")
	}
	if err := session.ReplaceSource(next, false, nil); err != nil {
		t.Fatal(err)
	}
	if session.RemoteInputState().Mode != "off" || session.videoOptions.Target.SourceID != "2" {
		t.Fatal("committed replacement inherited previous source authorization")
	}
}
