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
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSourceListBoundsFollowSerializedOutput(t *testing.T) {
	for _, check := range []struct {
		name, title string
		count       int
		truncated   bool
	}{
		{"empty", "Window", 0, false},
		{"long-localized-titles", strings.Repeat("界", 512), 64, false},
		{"many-windows", "Window", maxSources, false},
		{"escaped-titles", strings.Repeat("<", 512), 100, true},
		{"full-list", strings.Repeat("a", maxSourceTitleBytes), maxSources, true},
	} {
		t.Run(check.name, func(t *testing.T) {
			targets := make([]CaptureTarget, check.count)
			for index := range targets {
				targets[index] = CaptureTarget{Kind: "window", SourceID: strconv.Itoa(index + 1),
					PID: 1, CreationTime: "1", Title: check.title}
			}
			var input bytes.Buffer
			encoder := json.NewEncoder(&input)
			// The platform helpers need not use Go's HTML escaping.
			encoder.SetEscapeHTML(false)
			if err := encoder.Encode(targets); err != nil {
				t.Fatal(err)
			}
			got, err := readSources(&input)
			if err != nil {
				t.Fatal(err)
			}
			if (!check.truncated && len(got) != len(targets)) ||
				(check.truncated && (len(got) == 0 || len(got) >= len(targets))) {
				t.Fatalf("source count = %d of %d", len(got), len(targets))
			}
			for index, target := range got {
				if target != targets[index] {
					t.Fatal("bounded list changed a source's identity or title")
				}
			}
			output, _ := json.Marshal(got)
			if len(output) > maxSourceListBytes || string(output) == "null" {
				t.Fatalf("source-list response exceeds its contract: %d bytes", len(output))
			}
		})
	}
}

func TestSourceListRejectsMalformedOutputEvenAfterTheReturnedPrefix(t *testing.T) {
	valid := `{"kind":"display","sourceId":"1","title":"Display"}`
	full := `{"kind":"display","sourceId":"1","title":"` + strings.Repeat("a", maxSourceTitleBytes) + `"}`
	for _, payload := range []string{
		`null`, `{}`, `[`, `[` + valid, `[` + valid + `] []`,
		`[{"kind":"display","sourceId":"1","title":"Display","extra":true}]`,
		`[` + strings.Repeat(valid+",", maxSources) + valid + `]`,
		`[` + strings.Repeat(full+",", 100) + `{"kind":"wrong","sourceId":"1","title":"Window"}]`,
		`[]` + strings.Repeat(" ", maxSourceOutputBytes),
	} {
		if _, err := readSources(strings.NewReader(payload)); err == nil {
			t.Fatal("invalid helper output was accepted")
		}
	}
}

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
	if strings.HasPrefix(mode, "blocked-output-") {
		// A producer can fill stdout before returning to its control reader.
		if err := writeFrame(os.Stdout, Frame{Kind: FrameVP8, Width: 1280, Height: 720,
			Duration: time.Second / 30, Data: make([]byte, 1024*1024)}); err != nil {
			os.Exit(6)
		}
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
	for _, mode := range []string{"explicit", "parent", "both", "unresponsive",
		"blocked-output-explicit", "blocked-output-parent", "blocked-output-both"} {
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
			stop := strings.TrimPrefix(mode, "blocked-output-")
			if stop != "explicit" {
				cancel()
			}
			if stop == "explicit" || stop == "both" {
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

func TestCaptureStopPreservesAnInFlightFrame(t *testing.T) {
	input, output := io.Pipe()
	control, commands := io.Pipe()
	done := make(chan error)
	var finishOnce sync.Once
	finish := func() {
		finishOnce.Do(func() {
			_ = output.Close()
			_ = input.Close()
			_ = control.Close()
			close(done)
		})
	}
	stream := &Stream{input: input, key: commands, done: done, cancel: finish}
	t.Cleanup(func() { finish(); _ = stream.Close() })
	expected := Frame{Kind: FrameVP8, Width: 1280, Height: 720,
		Duration: time.Second / 30, Data: bytes.Repeat([]byte{0x12}, 1024*1024)}
	var encoded bytes.Buffer
	if err := writeFrame(&encoded, expected); err != nil {
		t.Fatal(err)
	}
	read := make(chan error, 1)
	go func() {
		frame, err := stream.Read()
		if err == nil && (frame.Kind != expected.Kind || !bytes.Equal(frame.Data, expected.Data)) {
			err = errors.New("retirement discarded part of the in-flight frame")
		}
		read <- err
	}()
	// Pipe.Write returns after Read has entered the frame, before its header is complete.
	if _, err := output.Write(encoded.Bytes()[:1]); err != nil {
		t.Fatal(err)
	}
	closed := make(chan struct{})
	go func() { _ = stream.Close(); close(closed) }()
	frame, err := readFrame(control)
	if err != nil || frame.Kind != FrameControl || string(frame.Data) != "Q" {
		t.Fatalf("stop command = %+v, %v", frame, err)
	}
	if _, err := output.Write(encoded.Bytes()[1:]); err != nil {
		t.Fatal(err)
	}
	if err := <-read; err != nil {
		t.Fatal(err)
	}
	finish()
	<-closed
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
