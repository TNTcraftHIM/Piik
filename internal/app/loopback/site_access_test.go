package loopback

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

func TestConnectDiscoveryDoesNotGrantNativeAccess(t *testing.T) {
	server := startTestServer(t, "")
	server.SetConnectURL("http://127.0.0.1:18990/client")
	endpoint := server.Endpoint()
	for _, test := range []struct {
		method, path, origin string
		status               int
	}{
		{"GET", "/connect-discovery", testOrigin, 200},
		{"OPTIONS", "/connect-discovery", testOrigin, 204},
		{"POST", "/connect-discovery", testOrigin, 405},
		{"GET", "/connect-discovery", "null", 403},
		{"GET", "/connect-discovery", "", 403},
		{"GET", "/connect-discovery", testOrigin + "/path", 403},
		{"GET", "/health", testOrigin, 403},
		{"GET", "/control", testOrigin, 403},
		{"GET", "/quality-preference", testOrigin, 403},
	} {
		request, _ := http.NewRequest(test.method, endpoint.URL+test.path, nil)
		request.Header.Set("Origin", test.origin)
		request.Header.Set("Access-Control-Request-Private-Network", "true")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != test.status {
			t.Fatalf("%+v: status %d", test, response.StatusCode)
		}
		if test.status == 200 {
			var body map[string]any
			if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if len(body) != 5 || body["connectURL"] != "http://127.0.0.1:18990/client" ||
				body["instanceToken"] != endpoint.InstanceToken || body["service"] != ServiceName {
				t.Fatalf("discovery exposed more than process identity and approval address: %v", body)
			}
		}
		response.Body.Close()
	}
}

type retiringControl struct {
	*testControlSession
	finish <-chan struct{}
}

func (session *retiringControl) Close() error {
	_ = session.testControlSession.Close()
	<-session.finish
	return nil
}

func TestSiteChangeWaitsForMediaRetirementWithoutStoppingLocalSession(t *testing.T) {
	finish := make(chan struct{})
	defer close(finish)
	created := make(chan *testControlSession, 2)
	server := startTestServerWithOptions(t, Options{AllowedOrigins: []string{testOrigin}, NewControl: func() ControlSession {
		session := &testControlSession{events: make(chan any), closed: make(chan struct{})}
		created <- session
		return &retiringControl{session, finish}
	}})
	endpoint := server.Endpoint()
	old := dialControl(t, endpoint, endpoint.InstanceToken, testOrigin)
	defer old.CloseNow()
	writeControl(t, old, requestJSON("old_hello", "hello"))
	var ready controlMessage
	readControl(t, old, &ready)
	oldSession := <-created
	local := dialControl(t, endpoint, endpoint.InstanceToken, endpoint.URL)
	defer local.CloseNow()
	writeControl(t, local, requestJSON("local_hello", "hello"))
	readControl(t, local, &ready)
	localSession := <-created

	done := make(chan error, 1)
	go func() { done <- server.SetAllowedOrigins([]string{"https://next.example"}) }()
	select {
	case <-oldSession.closed:
	case <-time.After(time.Second):
		t.Fatal("revoked session did not start retirement")
	}
	select {
	case err := <-done:
		t.Fatalf("permission reported ready before cleanup: %v", err)
	default:
	}
	select {
	case <-localSession.closed:
		t.Fatal("unrelated Local session was closed")
	default:
	}
	writeControl(t, local, requestJSON("local_ping", "ping"))
	readControl(t, local, &ready)
	if ready.Type != "pong" {
		t.Fatal("Local session was interrupted")
	}
	// A stuck media owner must not hang consent forever or restore old permission.
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("stuck cleanup was reported as successful")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("permission retirement was unbounded")
	}
	response := doHealthRequest(t, endpoint, endpoint.Host, testOrigin)
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("timeout restored the revoked origin")
	}
}

func TestPendingHandshakeCannotSurviveOriginReplacement(t *testing.T) {
	server := startTestServer(t, testOrigin)
	claim := server.claimConnection(testOrigin)
	if claim == nil {
		t.Fatal("initial claim failed")
	}
	defer server.releaseConnection(claim)
	done := make(chan error, 1)
	go func() { done <- server.SetAllowedOrigins(nil) }()
	select {
	case <-claim.ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("pending upgrade was not cancelled")
	}
	// Regrant the same origin before its old handshake returns.
	server.mu.Lock()
	server.allowedOrigins = []string{testOrigin}
	server.mu.Unlock()
	if server.setConnection(claim, nil) {
		t.Fatal("old generation regained permission")
	}
	// Cancellation of the App also bounds an already pending permission change.
	server.cancel()
	if err := <-done; err == nil || claim.ctx.Err() != context.Canceled {
		t.Fatal("cancelled change reported ready")
	}
}
