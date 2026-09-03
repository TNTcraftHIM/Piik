package launcher

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLauncherServesStateAndCompletesOneSelection(t *testing.T) {
	server := startFixture(t, "https://share.example")
	origin := strings.TrimSuffix(server.URL(), "/client")

	response, err := http.Get(origin + "/api/client-launcher")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var state struct {
		Site        string `json:"site"`
		DefaultMode Mode   `json:"defaultMode"`
		Revision    string `json:"revision"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(response.Body).Decode(&state) != nil ||
		state.Site != "https://share.example" || state.DefaultMode != ModeSite ||
		state.Revision != "" {
		t.Fatalf("launcher state = %d, %+v", response.StatusCode, state)
	}

	result := make(chan *http.Response, 1)
	requestErr := make(chan error, 1)
	go func() {
		response, err := http.Post(
			origin+"/api/client-launcher/launch",
			"application/json",
			bytes.NewBufferString(`{"mode":"link"}`),
		)
		if err != nil {
			requestErr <- err
			return
		}
		result <- response
	}()

	select {
	case selection := <-server.Selection():
		if selection != (Selection{Mode: ModeLink}) {
			t.Fatalf("selection = %+v", selection)
		}
		server.SetResult("http://localhost:8787/#screener-client=1", nil)
	case <-time.After(time.Second):
		t.Fatal("launcher did not emit a selection")
	}
	select {
	case err = <-requestErr:
		t.Fatal(err)
	case response = <-result:
		defer response.Body.Close()
		var launch struct {
			Target string `json:"target"`
		}
		if response.StatusCode != http.StatusOK || json.NewDecoder(response.Body).Decode(&launch) != nil ||
			launch.Target != "http://localhost:8787/#screener-client=1" {
			t.Fatalf("launcher result = %d, %+v", response.StatusCode, launch)
		}
	case <-time.After(time.Second):
		t.Fatal("launcher did not return its result")
	}
}

func TestLauncherIncludesTheInjectedBuildRevision(t *testing.T) {
	const revision = "0123456789abcdef0123456789abcdef01234567"
	server := startFixtureWithRevision(t, "", revision)
	origin := strings.TrimSuffix(server.URL(), "/client")
	response, err := http.Get(origin + "/api/client-launcher")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var state struct {
		Revision string `json:"revision"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(response.Body).Decode(&state) != nil ||
		state.Revision != revision {
		t.Fatalf("launcher revision = %d, %+v", response.StatusCode, state)
	}
}

func TestLauncherRejectsAnInvalidSavedSite(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(directory, "index.html"),
		[]byte("client"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := Start(t.Context(), directory, "https://example.test/path", ""); err == nil {
		t.Fatal("launcher accepted a Site path")
	}
}

func TestLauncherRejectsInvalidSelections(t *testing.T) {
	for name, payload := range map[string]string{
		"unknown":       `{"mode":"other"}`,
		"local-site":    `{"mode":"local","site":"https://share.example"}`,
		"missing-site":  `{"mode":"site"}`,
		"site-path":     `{"mode":"site","site":"https://share.example/path"}`,
		"unknown-field": `{"mode":"local","extra":true}`,
	} {
		t.Run(name, func(t *testing.T) {
			server := startFixture(t, "")
			origin := strings.TrimSuffix(server.URL(), "/client")
			response, err := http.Post(
				origin+"/api/client-launcher/launch",
				"application/json",
				bytes.NewBufferString(payload),
			)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusBadRequest {
				t.Fatalf("status = %d", response.StatusCode)
			}
		})
	}
}

func TestLauncherAcceptsLocalhostAlias(t *testing.T) {
	server := startFixture(t, "")
	origin := strings.TrimSuffix(server.URL(), "/client")
	request, err := http.NewRequest(
		http.MethodGet,
		origin+"/api/client-launcher",
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	request.Host = "localhost:" + strings.TrimPrefix(origin, "http://127.0.0.1:")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("localhost status = %d", response.StatusCode)
	}
}

func TestLauncherRejectsCrossOriginControl(t *testing.T) {
	server := startFixture(t, "")
	origin := strings.TrimSuffix(server.URL(), "/client")
	request, err := http.NewRequest(
		http.MethodGet,
		origin+"/api/client-launcher",
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", "https://unrelated.example")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("cross-origin status = %d", response.StatusCode)
	}
}

func startFixture(t *testing.T, site string) *Server {
	return startFixtureWithRevision(t, site, "")
}

func startFixtureWithRevision(t *testing.T, site, revision string) *Server {
	t.Helper()
	directory := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(directory, "index.html"),
		[]byte("<!doctype html><html><body>client</body></html>"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	server, err := Start(t.Context(), directory, site, revision)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	return server
}
