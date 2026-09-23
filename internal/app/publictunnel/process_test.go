package publictunnel

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMain(tests *testing.M) {
	if mode := os.Getenv("PIIK_TUNNEL_FIXTURE"); mode != "" {
		if record := os.Getenv("PIIK_TUNNEL_FIXTURE_ATTEMPTS"); record != "" {
			previous, _ := os.ReadFile(record)
			var paths []string
			if len(previous) > 0 {
				paths = strings.Split(strings.TrimSpace(string(previous)), "\n")
			}
			for _, path := range paths {
				if _, err := os.Stat(strings.TrimSpace(path)); !os.IsNotExist(err) {
					fmt.Fprintln(os.Stderr, "previous attempt was not retired")
					os.Exit(9)
				}
			}
			configIndex := slices.Index(os.Args, "--config")
			if configIndex < 0 || configIndex+1 >= len(os.Args) {
				os.Exit(9)
			}
			file, err := os.OpenFile(record, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
			if err != nil {
				os.Exit(9)
			}
			_, writeErr := fmt.Fprintln(file, os.Args[configIndex+1])
			closeErr := file.Close()
			if writeErr != nil || closeErr != nil {
				os.Exit(9)
			}
			failures, _ := strconv.Atoi(os.Getenv("PIIK_TUNNEL_FIXTURE_FAILURES"))
			if len(paths) < failures {
				fmt.Fprintln(os.Stderr, "fixture allocation unavailable")
				code, _ := strconv.Atoi(os.Getenv("PIIK_TUNNEL_FIXTURE_EXIT_CODE"))
				os.Exit(code)
			}
		}
		if mode == "tcp-only" {
			// Model the pinned Quick Tunnel's opt-in protocol fallback. Without
			// both flags, an unavailable UDP edge consumes Piik's startup budget.
			for name, want := range map[string]string{"--protocol": "auto", "--max-edge-addr-retries": "0"} {
				index := slices.Index(os.Args, name)
				if index < 0 || index+1 >= len(os.Args) || os.Args[index+1] != want {
					fmt.Fprintln(os.Stderr, "UDP unavailable; TCP fallback not enabled within startup budget")
					os.Exit(7)
				}
			}
		}
		if mode == "ready" || mode == "fail-after-ready" || mode == "tcp-only" {
			fmt.Println(`{"message":"https://test-room.trycloudflare.com"}`)
			fmt.Println(`{"message":"Registered tunnel connection"}`)
		}
		if mode == "fail-after-ready" {
			fmt.Println(`{"level":"fatal","message":"fixture exit failure"}`)
			for {
				if _, err := os.Stat(os.Getenv("PIIK_TUNNEL_FIXTURE_EXIT")); err == nil {
					os.Exit(7)
				}
				time.Sleep(time.Millisecond)
			}
		}
		for {
			time.Sleep(time.Hour)
		}
	}
	os.Exit(tests.Run())
}

func TestStartupRetriesOnlyRetiredPreReadyChildren(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, sample := range []struct {
		name               string
		failures, exitCode int
		ready              bool
	}{
		{"fourth attempt succeeds", 3, 7, true},
		{"four failures stop", 9, 7, false},
		{"clean exit is not readiness", 9, 0, false},
	} {
		t.Run(sample.name, func(t *testing.T) {
			record := filepath.Join(t.TempDir(), "attempts")
			t.Setenv("PIIK_TUNNEL_FIXTURE", "ready")
			t.Setenv("PIIK_TUNNEL_FIXTURE_ATTEMPTS", record)
			t.Setenv("PIIK_TUNNEL_FIXTURE_FAILURES", strconv.Itoa(sample.failures))
			t.Setenv("PIIK_TUNNEL_FIXTURE_EXIT_CODE", strconv.Itoa(sample.exitCode))
			process, err := Start(t.Context(), executable, "http://127.0.0.1:8787")
			if sample.ready {
				if err != nil || process == nil {
					t.Fatalf("fourth attempt: %v, %v", process, err)
				}
				if err := process.Close(); err != nil {
					t.Fatal(err)
				}
			} else {
				if process != nil || !errors.Is(err, errStartupExited) {
					t.Fatalf("exhausted startup: %v, %v", process, err)
				}
				if sample.exitCode != 0 {
					var failure *exec.ExitError
					if !errors.As(err, &failure) || failure.ExitCode() != sample.exitCode {
						t.Fatalf("latest dependency exit was lost: %v", err)
					}
				}
			}
			assertRetiredAttempts(t, record, 4)
		})
	}
}

func TestStartupRetriesShareCancellationAndDeadline(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, sample := range []struct {
		name       string
		timeout    time.Duration
		attempts   int
		cancelOnly bool
	}{
		{"during retry delay", 500 * time.Millisecond, 1, false},
		{"during second child", 2 * time.Second, 2, false},
		{"clean cancellation during retry delay", 500 * time.Millisecond, 1, true},
	} {
		t.Run(sample.name, func(t *testing.T) {
			record := filepath.Join(t.TempDir(), "attempts")
			t.Setenv("PIIK_TUNNEL_FIXTURE", "starting")
			t.Setenv("PIIK_TUNNEL_FIXTURE_ATTEMPTS", record)
			t.Setenv("PIIK_TUNNEL_FIXTURE_FAILURES", "1")
			t.Setenv("PIIK_TUNNEL_FIXTURE_EXIT_CODE", "7")
			ctx, cancel := context.WithTimeout(t.Context(), sample.timeout)
			defer cancel()
			if sample.cancelOnly {
				ctx, cancel = context.WithCancel(t.Context())
				defer cancel()
				defer time.AfterFunc(sample.timeout, cancel).Stop()
			}
			started := time.Now()
			process, err := Start(ctx, executable, "http://127.0.0.1:8787")
			if process != nil || (!sample.cancelOnly && !errors.Is(err, context.DeadlineExceeded)) ||
				(sample.cancelOnly && err != context.Canceled) {
				t.Fatalf("startup deadline: %v, %v", process, err)
			}
			if time.Since(started) > sample.timeout+2*time.Second {
				t.Fatal("retry renewed the startup deadline")
			}
			assertRetiredAttempts(t, record, sample.attempts)
		})
	}
}

func assertRetiredAttempts(t *testing.T, record string, count int) {
	t.Helper()
	payload, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	paths := strings.Split(strings.TrimSpace(string(payload)), "\n")
	if len(paths) != count {
		t.Fatalf("started %d children, want %d", len(paths), count)
	}
	for _, path := range paths {
		if _, err := os.Stat(strings.TrimSpace(path)); !os.IsNotExist(err) {
			t.Fatalf("attempt config was not removed: %v", err)
		}
	}
}

func TestStartupEnablesCloudflaredProtocolFallback(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIIK_TUNNEL_FIXTURE", "tcp-only")
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	process, err := Start(ctx, executable, "http://127.0.0.1:8787")
	if err != nil {
		t.Fatalf("tunnel with TCP available: %v", err)
	}
	if err := process.Close(); err != nil {
		t.Fatal(err)
	}
}

type blockedTunnelLog struct {
	slog.Handler
	entered chan struct{}
	release <-chan struct{}
}

func (handler blockedTunnelLog) Handle(ctx context.Context, record slog.Record) error {
	blocked := false
	record.Attrs(func(attr slog.Attr) bool {
		blocked = blocked || attr.Key == "message" && attr.Value.String() == "fixture exit failure"
		return true
	})
	if blocked {
		close(handler.entered)
		<-handler.release
	}
	return handler.Handler.Handle(ctx, record)
}

func TestCloseKeepsAnObservedFailureWhileLogsDrain(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	exit := filepath.Join(t.TempDir(), "exit")
	t.Setenv("PIIK_TUNNEL_FIXTURE", "fail-after-ready")
	t.Setenv("PIIK_TUNNEL_FIXTURE_EXIT", exit)
	entered, release := make(chan struct{}), make(chan struct{})
	resume := sync.OnceFunc(func() { close(release) })
	previous := slog.Default()
	slog.SetDefault(slog.New(blockedTunnelLog{
		Handler: slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelDebug}),
		entered: entered, release: release,
	}))
	defer slog.SetDefault(previous)
	defer resume()
	process, err := Start(t.Context(), executable, "http://127.0.0.1:8787")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { resume(); _ = process.Close() }()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("fixture did not enter its log writer")
	}
	if err := os.WriteFile(exit, nil, 0600); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		process.mu.Lock()
		observed := process.err
		process.mu.Unlock()
		if observed != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("dependency exit was not recorded before draining its logs")
		}
		time.Sleep(time.Millisecond)
	}
	canceled := make(chan struct{})
	cancelProcess := process.cancel
	process.cancel = func() { cancelProcess(); close(canceled) }
	closed := make(chan error, 1)
	go func() { closed <- process.Close() }()
	<-canceled
	resume()
	select {
	case err := <-closed:
		var failure *exec.ExitError
		if !errors.As(err, &failure) || failure.ExitCode() != 7 {
			t.Fatalf("late owner cancellation lost the observed dependency failure: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("tunnel did not retire after its logs drained")
	}
}

func TestReadyTunnelWaitsForItsExplicitOrderedClose(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIIK_TUNNEL_FIXTURE", "ready")
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	process, err := Start(ctx, executable, "http://127.0.0.1:8787")
	if err != nil {
		t.Fatal(err)
	}
	defer process.Close()
	cancel()
	select {
	case <-process.Done():
		t.Fatal("parent cancellation killed the ready tunnel before its owner closed it")
	case <-time.After(150 * time.Millisecond):
	}
	if err := process.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-process.Done():
	default:
		t.Fatal("Close returned with the tunnel still running")
	}
	if err := process.Close(); err != nil {
		t.Fatalf("repeat Close: %v", err)
	}
}

func TestStartupCancellationStillRetiresTheTunnel(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIIK_TUNNEL_FIXTURE", "starting")
	ctx, cancel := context.WithTimeout(t.Context(), 150*time.Millisecond)
	defer cancel()
	started := time.Now()
	process, err := Start(ctx, executable, "http://127.0.0.1:8787")
	if process != nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("cancelled startup: %v, %v", process, err)
	}
	if time.Since(started) > 2*time.Second {
		t.Fatal("startup cancellation did not join its child promptly")
	}
}

func TestMissingTunnelExplainsHowToRestoreThePackage(t *testing.T) {
	_, err := Start(t.Context(), filepath.Join(t.TempDir(), "missing-tunnel"), "http://127.0.0.1:8787")
	var cause *os.PathError
	if !errors.As(err, &cause) || !strings.Contains(err.Error(), "extract the complete Piik archive") {
		t.Fatalf("missing tunnel lost its cause or recovery instruction: %v", err)
	}
}

func TestOriginFromCloudflaredLog(t *testing.T) {
	for _, line := range []string{
		`{"level":"info","message":"|  https://small-bright-room.trycloudflare.com  |"}`,
		"Visit HTTPS://SMALL-BRIGHT-ROOM.TRYCLOUDFLARE.COM now",
	} {
		origin, ok := originFromLogLine(line)
		if !ok || origin != "https://small-bright-room.trycloudflare.com" {
			t.Fatalf("originFromLogLine(%q) = %q, %v", line, origin, ok)
		}
	}
	for _, line := range []string{
		"https://example.com",
		"https://trycloudflare.com",
		"https://bad_.trycloudflare.com",
	} {
		if origin, ok := originFromLogLine(line); ok {
			t.Fatalf("unexpected public origin %q from %q", origin, line)
		}
	}
}

func TestRegisteredConnectionFromCloudflaredLog(t *testing.T) {
	if !connectionRegistered(
		`{"level":"info","message":"Registered tunnel connection","protocol":"quic"}`,
	) {
		t.Fatal("registered tunnel connection was not recognized")
	}
	if connectionRegistered(`{"message":"Requesting new quick Tunnel"}`) {
		t.Fatal("pre-connection log was accepted as ready")
	}
}

func TestLocalOriginMustBeLoopbackHTTP(t *testing.T) {
	for _, value := range []string{
		"http://127.0.0.1:8787",
		"http://[::1]:8787",
	} {
		if err := validateLocalOrigin(value); err != nil {
			t.Fatalf("valid Local origin %q: %v", value, err)
		}
	}
	for _, value := range []string{
		"https://127.0.0.1:8787",
		"http://192.168.1.2:8787",
		"http://127.0.0.1:8787/path",
		"http://127.0.0.1",
	} {
		if err := validateLocalOrigin(value); err == nil {
			t.Fatalf("invalid Local origin accepted: %q", value)
		}
	}
}

func TestTemporaryConfigIsMinimal(t *testing.T) {
	path, err := writeTemporaryConfig()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(path) })
	payload, err := os.ReadFile(path)
	if err != nil || string(payload) != "metrics: 127.0.0.1:0\n" {
		t.Fatalf("temporary config = %q, %v", payload, err)
	}
}
