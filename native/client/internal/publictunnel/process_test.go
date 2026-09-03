package publictunnel

import (
	"os"
	"testing"
)

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
