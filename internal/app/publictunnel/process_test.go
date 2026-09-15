package publictunnel

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMain(tests *testing.M) {
	if mode := os.Getenv("PIIK_TUNNEL_FIXTURE"); mode != "" {
		if mode == "ready" {
			fmt.Println(`{"message":"https://test-room.trycloudflare.com"}`)
			fmt.Println(`{"message":"Registered tunnel connection"}`)
		}
		for {
			time.Sleep(time.Hour)
		}
	}
	os.Exit(tests.Run())
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
