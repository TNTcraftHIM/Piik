package launcher

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"net/http"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

// clientAssets stands in for the embedded Vite build the Client ships.
func clientAssets() fs.FS {
	return fstest.MapFS{
		"index.html": {Data: []byte("<!doctype html><html><body>client</body></html>")},
	}
}

func TestLauncherServesStateAndCompletesOneSelection(t *testing.T) {
	server := startFixture(t, "https://share.example")
	origin := strings.TrimSuffix(server.URL(), "/client")

	response, err := http.Get(origin + "/api/client-launcher")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var state struct {
		Site                string `json:"site"`
		LocalAccessPassword string `json:"localAccessPassword"`
		DefaultMode         Mode   `json:"defaultMode"`
		Revision            string `json:"revision"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(response.Body).Decode(&state) != nil ||
		state.Site != "https://share.example" || state.DefaultMode != ModeSite ||
		state.Revision != "" || state.LocalAccessPassword != "" {
		t.Fatalf("launcher state = %d, %+v", response.StatusCode, state)
	}

	result := make(chan *http.Response, 1)
	requestErr := make(chan error, 1)
	go func() {
		response, err := http.Post(
			origin+"/api/client-launcher/launch",
			"application/json",
			bytes.NewBufferString(`{"mode":"link","language":"vis"}`),
		)
		if err != nil {
			requestErr <- err
			return
		}
		result <- response
	}()

	select {
	case selection := <-server.Selection():
		if selection != (Selection{Mode: ModeLink, Language: "vis"}) {
			t.Fatalf("selection = %+v", selection)
		}
		server.SetResult("http://localhost:8787/#piik-client=1", nil)
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
			launch.Target != "http://localhost:8787/#piik-client=1" {
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

func TestLauncherCarriesAndNormalizesAnOptionalLocalPassword(t *testing.T) {
	server := startFixtureWithPassword(t, "", "existing-pass")
	origin := strings.TrimSuffix(server.URL(), "/client")
	stateResponse, err := http.Get(origin + "/api/client-launcher")
	if err != nil {
		t.Fatal(err)
	}
	var state struct {
		LocalAccessPassword string `json:"localAccessPassword"`
	}
	if stateResponse.StatusCode != http.StatusOK ||
		json.NewDecoder(stateResponse.Body).Decode(&state) != nil {
		_ = stateResponse.Body.Close()
		t.Fatal("launcher state was unavailable")
	}
	_ = stateResponse.Body.Close()
	if state.LocalAccessPassword != "existing-pass" {
		t.Fatal("launcher did not expose the saved Local access setting")
	}
	result := make(chan *http.Response, 1)
	go func() {
		response, err := http.Post(
			origin+"/api/client-launcher/launch",
			"application/json",
			bytes.NewBufferString(`{"mode":"local","language":"zh","localAccessPassword":"new-local-pass"}`),
		)
		if err != nil {
			t.Error(err)
			return
		}
		result <- response
	}()
	select {
	case selection := <-server.Selection():
		if selection.Mode != ModeLocal || selection.Language != "zh" || selection.LocalAccessPassword != "new-local-pass" {
			t.Fatalf("selection = %+v", selection)
		}
		server.SetResult("http://localhost:8787/#piik-client=1", nil)
	case <-time.After(time.Second):
		t.Fatal("launcher did not emit a selection")
	}
	response := <-result
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("launch status = %d", response.StatusCode)
	}
}

func TestLauncherRejectsAnInvalidSavedSite(t *testing.T) {
	if _, err := Start(t.Context(), clientAssets(), "https://example.test/path", "", ""); err == nil {
		t.Fatal("launcher accepted a Site path")
	}
}

// A binary built without the Browser build has nothing to launch.
func TestLauncherRequiresTheEmbeddedBrowserBuild(t *testing.T) {
	if _, err := Start(t.Context(), nil, "", "", ""); err == nil {
		t.Fatal("launcher started without embedded assets")
	}
	if _, err := Start(t.Context(), fstest.MapFS{}, "", "", ""); err == nil {
		t.Fatal("launcher started without an index document")
	}
}

func TestLauncherRejectsInvalidSelections(t *testing.T) {
	for name, payload := range map[string]string{
		"unknown":          `{"mode":"other","language":"en"}`,
		"local-site":       `{"mode":"local","language":"en","site":"https://share.example"}`,
		"missing-site":     `{"mode":"site","language":"en"}`,
		"site-path":        `{"mode":"site","language":"en","site":"https://share.example/path"}`,
		"site-password":    `{"mode":"site","language":"en","site":"https://share.example","localAccessPassword":"valid-pass"}`,
		"unknown-field":    `{"mode":"local","language":"en","extra":true}`,
		"short-password":   `{"mode":"local","language":"en","localAccessPassword":"short"}`,
		"missing-language": `{"mode":"local"}`,
		"unknown-language": `{"mode":"local","language":"other"}`,
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
	return startFixtureWithRevisionAndPassword(t, site, "", "")
}

func startFixtureWithRevision(t *testing.T, site, revision string) *Server {
	return startFixtureWithRevisionAndPassword(t, site, revision, "")
}

func startFixtureWithPassword(t *testing.T, site, password string) *Server {
	return startFixtureWithRevisionAndPassword(t, site, "", password)
}

func startFixtureWithRevisionAndPassword(
	t *testing.T,
	site, revision, password string,
) *Server {
	t.Helper()
	server, err := Start(t.Context(), clientAssets(), site, revision, password)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	return server
}
