package loopback

import (
	"encoding/json"
	"net/http"
	"sync/atomic"
	"testing"
)

func TestQuitRequiresLocalOriginAndInstanceToken(t *testing.T) {
	var count atomic.Int32
	server := startTestServerWithOptions(t, Options{
		AllowedOrigins: []string{"http://127.0.0.1:8787", testOrigin},
		Quit:           func() { count.Add(1) },
	})
	for _, tc := range []struct {
		origin  string
		allowed bool
	}{
		{"http://127.0.0.1:8787", true}, {testOrigin, false}, {"", false},
	} {
		response := doHealthRequest(t, server.Endpoint(), server.Endpoint().Host, tc.origin)
		var health Health
		if err := json.NewDecoder(response.Body).Decode(&health); err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if health.AppQuit != tc.allowed {
			t.Fatalf("quit capability for %q = %v", tc.origin, health.AppQuit)
		}
	}
	cases := []struct {
		method, origin, token string
		status                int
	}{
		{"POST", testOrigin, server.endpoint.InstanceToken, 403},
		{"POST", "", server.endpoint.InstanceToken, 403},
		{"POST", "http://127.0.0.1:9999", server.endpoint.InstanceToken, 403},
		{"POST", server.endpoint.URL + "/malformed", server.endpoint.InstanceToken, 403},
		{"POST", "http://127.0.0.1:8787", "wrong", 403},
		{"GET", "http://127.0.0.1:8787", server.endpoint.InstanceToken, 405},
		{"OPTIONS", "http://127.0.0.1:8787", "", 204},
		{"POST", "http://127.0.0.1:8787", server.endpoint.InstanceToken, 204},
	}
	for _, tc := range cases {
		request, _ := http.NewRequest(tc.method, server.Endpoint().URL+"/quit", nil)
		request.Header.Set("Origin", tc.origin)
		request.Header.Set("Authorization", "Bearer "+tc.token)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != tc.status {
			t.Fatalf("%s %s: %d, want %d", tc.method, tc.origin, response.StatusCode, tc.status)
		}
	}
	// Handler completion is fenced by a subsequent request on the server.
	response, err := http.Get(server.Endpoint().URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if count.Load() != 1 {
		t.Fatalf("quit invoked %d times", count.Load())
	}
}
