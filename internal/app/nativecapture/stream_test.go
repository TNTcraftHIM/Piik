package nativecapture

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCaptureStopHelper(t *testing.T) {
	mode := os.Getenv("PIIK_CAPTURE_STOP_FIXTURE")
	if mode == "" {
		return
	}
	if err := writeFrame(os.Stdout, Frame{Kind: FrameStatus, Data: []byte("ready")}); err != nil {
		os.Exit(2)
	}
	if mode == "unresponsive" {
		time.Sleep(10 * time.Second)
		os.Exit(3)
	}
	frame, err := readFrame(os.Stdin)
	if err != nil || frame.Kind != FrameControl || string(frame.Data) != "Q" {
		os.Exit(4)
	}
	// A platform capture must get time to release its session before process exit.
	time.Sleep(50 * time.Millisecond)
	if err := os.WriteFile(os.Getenv("PIIK_CAPTURE_STOP_MARKER"), []byte("released"), 0600); err != nil {
		os.Exit(5)
	}
	os.Exit(0)
}

func TestCaptureStopUsesOneBoundedRetirementPath(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"explicit", "parent", "both", "unresponsive"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			marker := filepath.Join(t.TempDir(), "released")
			stream, err := startStreamWithEnvironment(ctx, executable,
				[]string{"-test.run=^TestCaptureStopHelper$"},
				[]string{"PIIK_CAPTURE_STOP_FIXTURE=" + mode, "PIIK_CAPTURE_STOP_MARKER=" + marker})
			if err != nil {
				t.Fatal(err)
			}
			defer stream.Close()
			if _, err := stream.Read(); err != nil {
				t.Fatal(err)
			}
			if mode != "explicit" {
				cancel()
			}
			if mode == "explicit" || mode == "both" {
				go stream.Close()
			}
			select {
			case <-stream.Done():
			case <-time.After(captureStopTimeout + 3*time.Second):
				t.Fatal("capture retirement exceeded its stop budget")
			}
			_, err = os.Stat(marker)
			if mode == "unresponsive" {
				if !os.IsNotExist(err) {
					t.Fatalf("unresponsive capture unexpectedly released: %v", err)
				}
			} else if err != nil {
				t.Fatalf("capture was killed before receiving its stop command: %v", err)
			}
		})
	}
}

func TestDiagnosticStderrOverflowDoesNotStopTheChildReader(t *testing.T) {
	for _, discard := range []bool{false, true} {
		buffer := &boundedBuffer{limit: 4, discardOverflow: discard}
		var forwarded bytes.Buffer
		writer := io.MultiWriter(buffer, &forwarded)
		_, err := io.Copy(writer, strings.NewReader("stage=capture-closed\ndetail=more evidence\n"))
		if discard {
			if err != nil || string(buffer.Bytes()) != "nce\n" || !strings.Contains(forwarded.String(), "more evidence") {
				t.Fatalf("diagnostic stderr stopped or lost its bounded tail: %q, %q, %v", buffer.Bytes(), forwarded.String(), err)
			}
		} else if err == nil {
			t.Fatal("strict probe output no longer rejects overflow")
		}
	}
}

func TestVideoOutputGroupCountIsBoundedBeforeProcessStartup(t *testing.T) {
	options := VideoOptions{
		Target: CaptureTarget{Kind: "display", SourceID: "1", Title: "Display"},
		Codec:  "vp8",
		Profile: VideoProfile{Width: 1280, Height: 720, Framerate: 30,
			Bitrate: 3_000_000, Preference: "balanced"},
	}
	for _, groups := range []int{-1, maxOutputs - 1} {
		options.OutputGroups = groups
		if _, err := StartVideo(t.Context(), "", options); err == nil || err.Error() != "native video target is invalid" {
			t.Fatalf("group count %d reached process startup: %v", groups, err)
		}
	}
}

func TestCaptureFailureDebugUsesOnlyFixedFields(t *testing.T) {
	previous := slog.Default()
	t.Cleanup(func() { slog.SetDefault(previous) })
	for _, check := range []struct {
		name, stderr, stage, hresult     string
		debug, canceled, success, logged bool
	}{
		{name: "closed", stderr: "result=window-capture-failed\r\nstage=capture-closed\r\ndetail=private window title\r\n", stage: "capture-closed", debug: true, logged: true},
		{name: "device", stderr: "stage=windows-runtime\nhresult=0x887A0005\ndetail=C:\\private\\capture.exe", stage: "windows-runtime", hresult: "0x887a0005", debug: true, logged: true},
		{name: "malformed", stderr: "stage=C:\\private\\capture.exe\nhresult=0x887a0005 private\n", debug: true, logged: true},
		{name: "oversized-stage", stderr: "stage=" + strings.Repeat("a", 65), debug: true, logged: true},
		{name: "private-detail", stderr: "detail=private window title\n", debug: true, logged: true},
		{name: "disabled", stderr: "stage=capture-closed\n", debug: false},
		{name: "clean", stderr: "stage=capture-closed\n", debug: true, success: true},
		{name: "canceled", stderr: "detail=private cancellation\n", debug: true, canceled: true},
		{name: "failure-before-cancel", stderr: "stage=capture-closed\n", stage: "capture-closed", debug: true, canceled: true, logged: true},
	} {
		t.Run(check.name, func(t *testing.T) {
			var output bytes.Buffer
			level := slog.LevelInfo
			if check.debug {
				level = slog.LevelDebug
			}
			slog.SetDefault(slog.New(slog.NewJSONHandler(&output, &slog.HandlerOptions{Level: level})))
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if check.canceled {
				cancel()
			}
			var failure error
			if !check.success {
				failure = errors.New("private executable path")
			}
			logCaptureFailure(ctx, failure, 2, []byte(check.stderr))
			if !check.logged {
				if output.Len() != 0 {
					t.Fatalf("unexpected diagnostic: %s", output.String())
				}
				return
			}
			var record map[string]any
			if err := json.Unmarshal(output.Bytes(), &record); err != nil {
				t.Fatal(err)
			}
			if len(record) != 8 || record["event"] != "capture-process-failed" || record["msg"] != "piik-client" ||
				record["level"] != "DEBUG" || record["exitCode"] != float64(2) || record["stage"] != check.stage ||
				record["hresult"] != check.hresult || record["canceled"] != check.canceled || strings.Contains(output.String(), "private") {
				t.Fatalf("diagnostic leaked or changed fields: %s", output.String())
			}
		})
	}
}
