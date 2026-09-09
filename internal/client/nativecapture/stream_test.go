package nativecapture

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
)

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
			if len(record) != 8 || record["event"] != "capture-process-failed" || record["msg"] != "screener-client" ||
				record["level"] != "DEBUG" || record["exitCode"] != float64(2) || record["stage"] != check.stage ||
				record["hresult"] != check.hresult || record["canceled"] != check.canceled || strings.Contains(output.String(), "private") {
				t.Fatalf("diagnostic leaked or changed fields: %s", output.String())
			}
		})
	}
}
