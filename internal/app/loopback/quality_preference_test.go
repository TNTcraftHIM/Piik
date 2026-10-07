package loopback

import (
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	appconfig "github.com/TNTcraftHIM/Piik/internal/app/config"
	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
)

func TestQualityPreferenceRequiresCurrentOriginAndInstanceWithoutClaimingControl(t *testing.T) {
	p, err := appconfig.LoadQualityPreference(filepath.Join(t.TempDir(), "client.json"))
	if err != nil {
		t.Fatal(err)
	}
	server := startTestServerWithOptions(t, Options{AllowedOrigins: []string{testOrigin}, QualityPreference: p})
	endpoint := server.Endpoint()
	response := doHealthRequest(t, endpoint, endpoint.Host, testOrigin)
	var health Health
	if err := json.NewDecoder(response.Body).Decode(&health); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if !health.QualityPreference {
		t.Fatal("optional preference was not advertised")
	}
	payload, _ := json.Marshal(protocol.DefaultQualitySettings)
	for _, input := range []struct {
		method, origin, token, body string
		status                      int
	}{
		{"OPTIONS", testOrigin, "", "", http.StatusNoContent},
		{"OPTIONS", "https://other.example", "", "", http.StatusForbidden},
		{"GET", testOrigin, "", "", http.StatusForbidden},
		{"PUT", testOrigin, "old-instance", string(payload), http.StatusForbidden},
		{"PUT", "https://other.example", endpoint.InstanceToken, string(payload), http.StatusForbidden},
		{"PUT", testOrigin, endpoint.InstanceToken, `{}`, http.StatusBadRequest},
		{"PUT", testOrigin, endpoint.InstanceToken, `null`, http.StatusBadRequest},
		{"PUT", testOrigin, endpoint.InstanceToken, string(payload) + `{}`, http.StatusBadRequest},
		{"PUT", testOrigin, endpoint.InstanceToken, strings.Repeat(" ", 1025) + string(payload), http.StatusBadRequest},
		{"POST", testOrigin, endpoint.InstanceToken, string(payload), http.StatusMethodNotAllowed},
		{"PUT", testOrigin, endpoint.InstanceToken, string(payload), http.StatusNoContent},
		{"GET", testOrigin, endpoint.InstanceToken, "", http.StatusOK},
	} {
		request, _ := http.NewRequest(input.method, endpoint.URL+"/quality-preference", strings.NewReader(input.body))
		request.Header.Set("Origin", input.origin)
		request.Header.Set("X-Piik-Instance", input.token)
		request.Header.Set("Access-Control-Request-Private-Network", "true")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != input.status {
			t.Fatalf("%s: status %d, want %d", input.method, response.StatusCode, input.status)
		}
		if input.status == http.StatusOK {
			var quality protocol.QualitySettings
			if err := json.Unmarshal(body, &quality); err != nil || quality != protocol.DefaultQualitySettings {
				t.Fatalf("saved quality: %v, %v", quality, err)
			}
		}
		if input.method == "OPTIONS" && input.status == http.StatusNoContent &&
			(response.Header.Get("Access-Control-Allow-Methods") != "GET, PUT" || response.Header.Get("Access-Control-Allow-Private-Network") != "true") {
			t.Fatal("invalid preflight")
		}
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	if server.claimed != 0 {
		t.Fatal("preference claimed media control")
	}
}
