package launcher

import (
	"context"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

func TestQuitOnlyAcceptsSameOriginPost(t *testing.T) {
	var count atomic.Int32
	server, err := Start(context.Background(), appAssets(), Options{Quit: func() { count.Add(1) }})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	origin := strings.TrimSuffix(server.URL(), "/client")
	for _, tc := range []struct {
		method, origin string
		status         int
	}{
		{"GET", origin, 405}, {"POST", "", 403}, {"POST", "https://evil.example", 404}, {"POST", origin, 204},
	} {
		request, _ := http.NewRequest(tc.method, origin+"/api/client-launcher/quit", nil)
		request.Header.Set("Origin", tc.origin)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != tc.status {
			t.Fatalf("%s %s: %d", tc.method, tc.origin, response.StatusCode)
		}
	}
	if count.Load() != 1 {
		t.Fatalf("quit invoked %d times", count.Load())
	}
}
