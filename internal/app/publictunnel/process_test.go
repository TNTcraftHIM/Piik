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
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMain(tests *testing.M) {
	if mode := os.Getenv("PIIK_TUNNEL_FIXTURE"); mode != "" {
		if mode == "ready" || mode == "fail-after-ready" {
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
