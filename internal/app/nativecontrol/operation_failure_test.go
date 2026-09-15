package nativecontrol

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/app/loopback"
	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

type observedProbeSession struct {
	*Session
	closed chan struct{}
}

func (session *observedProbeSession) Close() error {
	err := session.Session.Close()
	close(session.closed)
	return err
}

func TestSourceProbesRetireWithTheirControlConnection(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, request := range []struct{ kind, fields string }{
		{"list-sources", ""},
		{"source-preview", `,"source":{"kind":"display","sourceId":"1","title":"Fixture"}`},
	} {
		for _, shutdown := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/shutdown=%v", request.kind, shutdown), func(t *testing.T) {
				marker := filepath.Join(t.TempDir(), "probe-started")
				t.Setenv("PIIK_SOURCE_PROBE_FIXTURE", marker)
				ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
				defer cancel()
				closed := make(chan struct{})
				const origin = "https://site.example"
				server, err := loopback.Start(ctx, loopback.Options{AllowedOrigins: []string{origin},
					NewControl: func() loopback.ControlSession {
						return &observedProbeSession{Session: New(executable, nativecapture.Capabilities{}, false), closed: closed}
					}})
				if err != nil {
					t.Fatal(err)
				}
				defer server.Close()
				endpoint := server.Endpoint()
				connection, _, err := websocket.Dial(ctx, strings.Replace(endpoint.URL, "http:", "ws:", 1)+"/control",
					&websocket.DialOptions{HTTPHeader: http.Header{"Origin": {origin}},
						Subprotocols: []string{loopback.ControlSubprotocol + "." + endpoint.InstanceToken}})
				if err != nil {
					t.Fatal(err)
				}
				defer connection.CloseNow()
				if err = wsjson.Write(ctx, connection, json.RawMessage(`{"version":9,"id":"request_hello","type":"hello"}`)); err != nil {
					t.Fatal(err)
				}
				var ready struct{ Type string }
				if err = wsjson.Read(ctx, connection, &ready); err != nil || ready.Type != "ready" {
					t.Fatalf("hello: %+v, %v", ready, err)
				}
				defer func() {
					_ = connection.CloseNow()
					_ = server.Close()
					select {
					case <-closed:
					case <-time.After(5 * time.Second):
						t.Error("native probe fixture did not retire")
					}
				}()
				payload := fmt.Sprintf(`{"version":9,"id":"request_probe","type":%q%s}`, request.kind, request.fields)
				if err = wsjson.Write(ctx, connection, json.RawMessage(payload)); err != nil {
					t.Fatal(err)
				}
				deadline := time.Now().Add(2 * time.Second)
				for {
					if _, err = os.Stat(marker); err == nil {
						break
					}
					if time.Now().After(deadline) {
						t.Fatal("source probe did not start")
					}
					time.Sleep(10 * time.Millisecond)
				}
				if shutdown {
					if err = server.Close(); err != nil {
						t.Fatalf("source probe exceeded ordered shutdown: %v", err)
					}
				} else {
					_ = connection.CloseNow()
				}
				select {
				case <-closed:
				case <-time.After(2 * time.Second):
					t.Fatal("source probe retained its native session after control closed")
				}
			})
		}
	}
}

func assertOperationFailure(t *testing.T, session *Session, payload string) {
	t.Helper()
	value, err := session.Handle(t.Context(), []byte(payload))
	failed, ok := value.(requestFailedResponse)
	if err != nil || !ok || failed.Type != "request-failed" || failed.Code != "operation-failed" {
		t.Fatalf("operation failure escaped its request: %#v, %v", value, err)
	}
}

func TestOperationalFailureAndIdempotentStopKeepTheRealControlConnection(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	const origin = "https://site.example"
	server, err := loopback.Start(ctx, loopback.Options{AllowedOrigins: []string{origin},
		NewControl: func() loopback.ControlSession { return New("missing-capture", nativecapture.Capabilities{}, false) }})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	endpoint := server.Endpoint()
	connection, _, err := websocket.Dial(ctx, strings.Replace(endpoint.URL, "http:", "ws:", 1)+"/control",
		&websocket.DialOptions{HTTPHeader: http.Header{"Origin": {origin}},
			Subprotocols: []string{loopback.ControlSubprotocol + "." + endpoint.InstanceToken}})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.CloseNow()
	for index, command := range []struct{ kind, fields, expected string }{
		{"hello", "", "ready"},
		{"start-share", `,"shareId":"missing_share","source":{"kind":"display","sourceId":"1","title":"Fixture"},"edgeCapacity":1,"codec":"vp8","profile":{"resolution":"1080p","maxFramerate":30,"maxBitrate":5000000,"degradationPreference":"balanced"}`, "request-failed"},
		{"prepare-edge", `,"shareId":"missing_share","connectionId":"edge_123456","iceServers":[]`, "request-failed"},
		{"edge-answer", `,"shareId":"missing_share","connectionId":"edge_123456","sdp":"v=0"`, "request-failed"},
		{"receive-candidate", `,"shareId":"missing_share","connectionId":"edge_123456","candidate":null`, "request-failed"},
		{"pause-share", `,"shareId":"missing_share","paused":true`, "request-failed"},
		{"publication-media", `,"shareId":"missing_share","publicationGeneration":"publication_123","connectionId":"edge_123456"`, "request-failed"},
		{"stop-share", `,"shareId":"missing_share"`, "share-stopped"},
		{"stop-share", `,"shareId":"missing_share"`, "share-stopped"},
		{"close-publication", `,"shareId":"missing_share","publicationGeneration":"publication_123","connectionId":"edge_123456"`, "publication-closed"},
		{"ping", "", "pong"},
	} {
		id := fmt.Sprintf("request_%d", index)
		payload := fmt.Sprintf(`{"version":9,"id":%q,"type":%q%s}`, id, command.kind, command.fields)
		if err := wsjson.Write(ctx, connection, json.RawMessage(payload)); err != nil {
			t.Fatal(err)
		}
		var received struct{ ID, Type, Code string }
		if err := wsjson.Read(ctx, connection, &received); err != nil {
			t.Fatalf("%s closed control: %v", command.kind, err)
		}
		if received.ID != id || received.Type != command.expected ||
			(command.expected == "request-failed" && received.Code != "operation-failed") {
			t.Fatalf("%s response: %+v", command.kind, received)
		}
	}
	// A gone target must not bypass strict publication validation.
	if err := wsjson.Write(ctx, connection, json.RawMessage(`{"version":9,"id":"request_invalid","type":"close-publication","shareId":"missing_share","publicationGeneration":"publication_123","connectionId":"edge_123456","extra":true}`)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := connection.Read(ctx); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("malformed command did not close as a protocol violation: %v", err)
	}
}

func TestFailedEdgeAndLateStopDoNotRetireAnotherShare(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIIK_QUIET_CAPTURE_FIXTURE", t.TempDir())
	session := New(executable, nativecapture.Capabilities{SoftwareVP8: true}, false)
	defer session.Close()
	const start = `{"version":9,"id":"request_start","type":"start-share","shareId":"share_123456","source":{"kind":"display","sourceId":"1","title":"Fixture"},"audio":false,"edgeCapacity":1,"codec":"vp8","profile":{"resolution":"1080p","maxFramerate":30,"maxBitrate":5000000,"degradationPreference":"balanced"}}`
	if value, err := session.Handle(t.Context(), []byte(start)); err != nil {
		t.Fatal(err)
	} else if _, ok := value.(shareStartedResponse); !ok {
		t.Fatalf("start failed: %#v", value)
	}
	host := session.current("share_123456")
	if host == nil {
		t.Fatal("share was not installed")
	}
	const edge = `{"version":9,"id":"request_edge","type":"prepare-local-edge","shareId":"share_123456","connectionId":"edge_123456"}`
	if value, err := session.Handle(t.Context(), []byte(edge)); err != nil {
		t.Fatal(err)
	} else if _, ok := value.(edgeOfferResponse); !ok {
		t.Fatalf("edge preparation failed: %#v", value)
	}
	assertOperationFailure(t, session, edge)
	assertOperationFailure(t, session, `{"version":9,"id":"request_edge","type":"prepare-edge","shareId":"stale_share","connectionId":"edge_123456","iceServers":[]}`)
	if session.current("share_123456") != host {
		t.Fatal("failed edge retired the current share")
	}
	// The underlying owner can finish before the Browser's stop command arrives.
	_ = host.Close()
	deadline := time.Now().Add(time.Second)
	for session.current("share_123456") != nil {
		if time.Now().After(deadline) {
			t.Fatal("watchHost did not retire the source")
		}
		time.Sleep(time.Millisecond)
	}
	if _, err := session.Handle(t.Context(), []byte(strings.ReplaceAll(start, "share_123456", "share_654321"))); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		value, err := session.Handle(t.Context(), []byte(`{"version":9,"id":"request_stop","type":"stop-share","shareId":"share_123456"}`))
		if err != nil || value != response(requestEnvelope{Version: 9, ID: "request_stop"}, "share-stopped") {
			t.Fatalf("late stop: %#v, %v", value, err)
		}
	}
	if session.current("share_654321") == nil {
		t.Fatal("late stop retired the replacement share")
	}
}
