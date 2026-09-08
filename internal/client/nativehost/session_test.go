package nativehost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Screener/internal/client/mediaedge"
	"github.com/TNTcraftHIM/Screener/internal/client/nativecapture"
)

func TestMain(tests *testing.M) {
	if os.Getenv("SCREENER_NATIVEHOST_PIPE_FIXTURE") == "audio-recovery" {
		runAudioRecoveryCapture()
		os.Exit(0)
	}
	if os.Getenv("SCREENER_NATIVEHOST_PIPE_FIXTURE") == "echo" {
		_, _ = io.Copy(os.Stdout, os.Stdin)
		os.Exit(0)
	}
	if os.Getenv("SCREENER_NATIVEHOST_PIPE_FIXTURE") == "1" {
		_, _ = io.Copy(io.Discard, os.Stdin)
		os.Exit(0)
	}
	os.Exit(tests.Run())
}

func TestCaptureCommitWaitsForReaderMetadataOrTermination(t *testing.T) {
	t.Setenv("SCREENER_NATIVEHOST_PIPE_FIXTURE", "1")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"installed", "reader-failed", "closed"} {
		t.Run(mode, func(t *testing.T) {
			check := func(err error) {
				t.Helper()
				if err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			engine, err := mediaedge.NewEngine(mediaedge.EngineOptions{BindAddress: "127.0.0.1:0", IncludeLoopback: true})
			check(err)
			defer engine.Close()
			options := nativecapture.VideoOptions{Target: nativecapture.CaptureTarget{Kind: "display", SourceID: "1", Title: "Fixture"}, Codec: "vp8",
				Profile: nativecapture.VideoProfile{Width: 1280, Height: 720, Framerate: 15, Bitrate: 2_000_000, Preference: "balanced"}, OutputGroups: 1}
			previous, err := nativecapture.StartVideo(ctx, executable, options)
			check(err)
			defer previous.Close()
			if len(previous.Outputs()) != 3 {
				t.Fatal("capture did not retain its independent output group")
			}
			source, err := engine.NewSource("vp8", 1, 2, nil)
			check(err)
			defer source.Close()
			check(configureCaptureOutputs(source, previous.Outputs()))
			publication, err := engine.NewPublication(source, mediaedge.EdgeOptions{ConnectionID: "metadata-fixture"})
			check(err)
			session := &Session{ctx: ctx, cancel: cancel, engine: engine, source: source, stream: previous,
				edgeCapacity: 1, ready: make(chan error, 1), done: make(chan error, 1), events: make(chan Event, 16)}
			options.Profile.Width, options.Profile.Height = 854, 480
			replacement, err := nativecapture.StartVideo(ctx, executable, options)
			check(err)
			defer replacement.Close()
			committed := make(chan error, 1)
			go func() {
				session.updateMu.Lock()
				err := session.commitCapture(options, QualityProfile{Video: options.Profile, AudioBitrate: 64_000}, replacement, CaptureState{}, nil, false)
				session.updateMu.Unlock()
				committed <- err
			}()
			select {
			case <-previous.Done():
			case <-time.After(5 * time.Second):
				t.Fatal("old fixture did not exit")
			}
			select {
			case err := <-committed:
				t.Fatalf("process exit acknowledged metadata before reader installation: %v", err)
			default:
			}
			if len(publication.Media().Layers) != 2 || publication.Media().Layers[1].Width != 1280 {
				t.Fatal("held reader unexpectedly changed source metadata")
			}
			if mode == "installed" {
				// Hold the reader at its handoff, then run the same installation it uses.
				check(session.installCapture(replacement))
				select {
				case err = <-committed:
					check(err)
				case <-time.After(time.Second):
					t.Fatal("installed metadata did not acknowledge update")
				}
				media := publication.Media()
				if media.Layers[1].Width != 854 || media.Layers[1].Height != 480 || media.Layers[1].Bitrate != 2_000_000 {
					t.Fatalf("acknowledged stale metadata: %+v", media)
				}
				return
			}
			go session.run()
			closed := make(chan error, 1)
			if mode == "closed" {
				go func() { closed <- session.Close() }()
			} else {
				check(replacement.Close())
			}
			select {
			case err = <-committed:
				if err == nil {
					t.Fatal("terminated reader acknowledged an uninstalled stream")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("capture update remained latched after termination")
			}
			if mode == "closed" {
				select {
				case err = <-closed:
					check(err)
				case <-time.After(5 * time.Second):
					t.Fatal("Close deadlocked behind the capture update")
				}
			} else {
				select {
				case err = <-session.Done():
					if err == nil {
						t.Fatal("unexpected reader death did not fail the share")
					}
				case <-time.After(5 * time.Second):
					t.Fatal("reader death did not end the share")
				}
			}
		})
	}
}

func TestOutputPlanPreservesOriginalStartupAndIndependentActivation(t *testing.T) {
	t.Setenv("SCREENER_NATIVEHOST_PIPE_FIXTURE", "echo")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	stream, err := nativecapture.StartVideo(ctx, executable, nativecapture.VideoOptions{
		Target: nativecapture.CaptureTarget{Kind: "display", SourceID: "1", Title: "Fixture"}, Codec: "vp8",
		Profile: nativecapture.VideoProfile{Width: 1280, Height: 720, Framerate: 15,
			Bitrate: 2_000_000, Preference: "balanced"}, OutputGroups: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	plan := mediaedge.OutputPlan{Active: []bool{false, true, true, false}, Bitrates: []uint32{0, 0, 250_000, 0}}
	if err = applyOutputPlan(stream, plan, false); err != nil {
		t.Fatal(err)
	}
	plan.RecoveryLayers = []int{2}
	if err = applyOutputPlan(stream, plan, true); err != nil {
		t.Fatal(err)
	}
	clear(plan.Active)
	plan.RecoveryLayers = nil
	if err = applyOutputPlan(stream, plan, true); err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{"B 2 250000", "K 2", "A 0 0", "A 2 1", "A 1 0", "A 2 0"} {
		frame, readErr := stream.Read()
		if readErr != nil || frame.Kind != nativecapture.FrameControl || string(frame.Data) != command {
			t.Fatalf("expected control %q, received %+v, %v", command, frame, readErr)
		}
	}
}

func TestCaptureStateKeepsStartingAndActiveContractsDistinct(t *testing.T) {
	starting, err := decodeCaptureState(captureStatePayload(t,
		`{"state":"starting","hardwareOnly":true,"codec":"h264","adapterIndex":0,"adapterName":"GPU","adapterIdentity":"0:1","encoderIndex":0,"encoderName":"H264","encoderIdentity":"encoder"}`,
	))
	if err != nil || starting.State != "starting" || starting.AdapterIndex == nil {
		t.Fatalf("starting = %+v, %v", starting, err)
	}
	active, err := decodeCaptureState(captureStatePayload(t,
		`{"state":"active","hardwareOnly":true,"codec":"h264","profileLevelId":"42c01f","width":1280,"height":720,"fps":30}`,
	))
	if err != nil || active.State != "active" || active.ProfileLevelID != "42c01f" {
		t.Fatalf("active = %+v, %v", active, err)
	}
	for _, payload := range []string{
		`{"state":"starting","hardwareOnly":false,"codec":"vp8","adapterIndex":0,"adapterName":"GPU","adapterIdentity":"0:1","encoderName":"libvpx VP8","encoderIdentity":"libvpx/v1.17.0"}`,
		`{"state":"active","hardwareOnly":false,"codec":"vp8","width":1280,"height":720,"fps":30}`,
		`{"state":"active","hardwareOnly":true,"codec":"h264","profileLevelId":"42c01e","width":854,"height":480,"fps":15}`,
		`{"state":"active","hardwareOnly":true,"codec":"h264","profileLevelId":"42c033","width":2560,"height":1440,"fps":60,"restoreToken":"portal-token"}`,
	} {
		if _, err = decodeCaptureState(captureStatePayload(t, payload)); err != nil {
			t.Fatalf("valid profile state was rejected: %s: %v", payload, err)
		}
	}
}

func TestCaptureStateRejectsUnknownOrUnattributedState(t *testing.T) {
	for _, payload := range []string{
		`{"state":"active","hardwareOnly":true,"codec":"vp8","width":1280,"height":720,"fps":30}`,
		`{"state":"active","hardwareOnly":false,"codec":"vp8","profileLevelId":"42c01f","width":1280,"height":720,"fps":30}`,
		`{"state":"active","hardwareOnly":false}`,
		`{"state":"ready","hardwareOnly":true}`,
		`{"state":"active","hardwareOnly":true,"codec":"h264","extra":true}`,
	} {
		if _, err := decodeCaptureState(captureStatePayload(t, payload)); err == nil {
			t.Fatalf("invalid state was accepted: %s", payload)
		}
	}
}

func TestCaptureStateUsesOriginalSlotAndBoundsPhysicalGroups(t *testing.T) {
	state, err := decodeCaptureState(captureStatePayload(t,
		`{"state":"active","hardwareOnly":false,"codec":"vp8","width":1280,"height":720,"fps":30}`))
	if err != nil || len(state.Outputs) != 6 || state.Outputs[5] != state.Outputs[0] {
		t.Fatalf("independent output groups = %+v, %v", state, err)
	}
	wrongOriginal := state
	wrongOriginal.Width = state.Outputs[5].Width
	tooMany := state
	tooMany.Outputs = append(tooMany.Outputs, tooMany.Outputs[0])
	for _, invalid := range []CaptureState{wrongOriginal, tooMany} {
		payload, err := json.Marshal(invalid)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = decodeCaptureState(payload); err == nil {
			t.Fatal("invalid original slot or output count was accepted")
		}
	}
}

func captureStatePayload(t *testing.T, payload string) []byte {
	t.Helper()
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(payload), &fields); err != nil {
		t.Fatal(err)
	}
	profile := nativecapture.VideoProfile{Width: 1280, Height: 720, Framerate: 30, Bitrate: 3_000_000}
	for key, field := range map[string]*uint32{"width": &profile.Width, "height": &profile.Height, "fps": &profile.Framerate} {
		if value, ok := fields[key]; ok {
			if err := json.Unmarshal(value, field); err != nil {
				t.Fatal(err)
			}
		}
	}
	slots := nativecapture.ScreenShareOutputs(profile)
	for range 4 {
		slots = append(slots, slots[0])
	}
	outputs, err := json.Marshal(slots)
	if err != nil {
		t.Fatal(err)
	}
	fields["outputs"] = outputs
	result, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestCandidateForRetiredEdgeIsIgnored(t *testing.T) {
	session := &Session{}
	if err := session.AddCandidate("retired-edge", nil); err != nil {
		t.Fatalf("stale candidate stopped the session: %v", err)
	}
}

func TestCaptureProfileFailureLogsFixedStageWithoutPrivateError(t *testing.T) {
	previous := slog.Default()
	t.Cleanup(func() { slog.SetDefault(previous) })
	var output bytes.Buffer
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, &slog.HandlerOptions{Level: slog.LevelDebug})))
	failure := errors.New("private capture path and window title")
	profile := nativecapture.VideoProfile{Width: 1280, Height: 720, Framerate: 30, Bitrate: 3_000_000}
	if captureProfileFailure(t.Context(), profile, "wait-timeout", failure) != failure {
		t.Fatal("diagnostic changed the failure result")
	}
	var record map[string]any
	if err := json.Unmarshal(output.Bytes(), &record); err != nil {
		t.Fatal(err)
	}
	if record["event"] != "capture-profile-rejected" || record["stage"] != "wait-timeout" ||
		record["width"] != float64(1280) || record["height"] != float64(720) ||
		record["fps"] != float64(30) || record["bitrate"] != float64(3_000_000) || strings.Contains(output.String(), "private") {
		t.Fatalf("profile diagnostic changed or leaked: %s", output.String())
	}
}
