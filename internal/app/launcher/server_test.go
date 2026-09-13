package launcher

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"runtime"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/app/lan"
)

// appAssets stands in for the embedded Vite build the App ships.
func appAssets() fs.FS {
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
		Version             string `json:"version"`
		Revision            string `json:"revision"`
		Debug               *bool  `json:"debug"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(response.Body).Decode(&state) != nil ||
		state.Site != "https://share.example" || state.DefaultMode != ModeSite ||
		state.Version != "development" || state.Revision != "" || state.LocalAccessPassword != "" || state.Debug == nil || *state.Debug {
		t.Fatalf("launcher state = %d, %+v", response.StatusCode, state)
	}

	result := make(chan *http.Response, 1)
	requestErr := make(chan error, 1)
	go func() {
		response, err := http.Post(
			origin+"/api/client-launcher/launch",
			"application/json",
			bytes.NewBufferString(`{"mode":"link","language":"vis","debug":true}`),
		)
		if err != nil {
			requestErr <- err
			return
		}
		result <- response
	}()

	select {
	case selection := <-server.Selection():
		if selection != (Selection{Mode: ModeLink, Language: "vis", Debug: true}) {
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

func TestLauncherIncludesTheInjectedBuildVersionAndRevision(t *testing.T) {
	const version = "v1.2.3"
	const revision = "0123456789abcdef0123456789abcdef01234567"
	server := startFixtureWithBuildAndPassword(t, "", version, revision, "")
	origin := strings.TrimSuffix(server.URL(), "/client")
	response, err := http.Get(origin + "/api/client-launcher")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var state struct {
		Version       string `json:"version"`
		Revision      string `json:"revision"`
		PackageTarget string `json:"packageTarget"`
		DefaultMode   Mode   `json:"defaultMode"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(response.Body).Decode(&state) != nil ||
		state.Version != version || state.Revision != revision ||
		state.PackageTarget != runtime.GOOS+"-"+runtime.GOARCH || state.DefaultMode != ModeLink {
		t.Fatalf("launcher build = %d, %+v", response.StatusCode, state)
	}
}

func TestLauncherLANChoicesUseCurrentAddressesAndTheExplicitPreference(t *testing.T) {
	for _, test := range []struct {
		name, preferred, selected string
		addresses                 []lan.Address
	}{
		{name: "one", selected: "192.168.1.4", addresses: []lan.Address{{Address: "192.168.1.4", Name: "Wi-Fi"}}},
		{name: "one-private", selected: "192.168.1.4", addresses: []lan.Address{{Address: "192.168.1.4", Name: "Wi-Fi"}, {Address: "198.18.0.1", Name: "Tunnel"}}},
		{name: "ambiguous", addresses: []lan.Address{{Address: "10.0.0.2", Name: "Ethernet"}, {Address: "192.168.1.4", Name: "Wi-Fi"}}},
		{name: "cli-preferred", preferred: "192.168.1.4", selected: "192.168.1.4", addresses: []lan.Address{{Address: "10.0.0.2", Name: "Ethernet"}, {Address: "192.168.1.4", Name: "Wi-Fi"}}},
		{name: "stale-preference", preferred: "192.168.1.4", addresses: []lan.Address{{Address: "10.0.0.2", Name: "Ethernet"}}},
		{name: "unavailable"},
	} {
		t.Run(test.name, func(t *testing.T) {
			original := listLANAddresses
			t.Cleanup(func() { listLANAddresses = original })
			listLANAddresses = func() ([]lan.Address, error) {
				if test.addresses == nil {
					return nil, errors.New("interfaces are unavailable")
				}
				return test.addresses, nil
			}
			server, err := Start(t.Context(), appAssets(), Options{Site: "https://share.example", LANAddress: test.preferred})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = server.Close() })
			response, err := http.Get(strings.TrimSuffix(server.URL(), "/client") + "/api/client-launcher")
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			var state struct {
				DefaultMode Mode
				LAN         *struct {
					Addresses []lan.Address
					Selected  string
				}
			}
			if err := json.NewDecoder(response.Body).Decode(&state); err != nil || response.StatusCode != http.StatusOK ||
				state.DefaultMode != ModeSite || state.LAN == nil || state.LAN.Addresses == nil ||
				state.LAN.Selected != test.selected || len(state.LAN.Addresses) != len(test.addresses) {
				t.Fatalf("LAN choices = %+v, status %d, %v", state, response.StatusCode, err)
			}
			for index, address := range state.LAN.Addresses {
				if address != test.addresses[index] {
					t.Fatalf("LAN interface label lost: %+v", address)
				}
			}
		})
	}
}

func TestLauncherPassesTheChosenLANAddressToTheApp(t *testing.T) {
	server := startFixture(t, "")
	server.SetResult("http://localhost:8787/#piik-client=1", nil)
	response, err := http.Post(strings.TrimSuffix(server.URL(), "/client")+"/api/client-launcher/launch",
		"application/json", strings.NewReader(`{"mode":"local","language":"en","lanAddress":"192.168.1.4"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("selection status = %d", response.StatusCode)
	}
	selection := <-server.Selection()
	if selection.LANAddress == nil || *selection.LANAddress != "192.168.1.4" {
		t.Fatalf("selected invitation address was lost: %+v", selection)
	}
}

func TestLauncherPreservesAnOptionalLocalPassword(t *testing.T) {
	for _, password := range []string{"", "x", "中文", " ", "  中文 +&  ", strings.Repeat("x", 256)} {
		t.Run(password, func(t *testing.T) {
			server := startFixtureWithPassword(t, "", password)
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
			if state.LocalAccessPassword != password {
				t.Fatal("launcher did not expose the saved Local access setting")
			}
			result := make(chan *http.Response, 1)
			payload, err := json.Marshal(Selection{Mode: ModeLocal, Language: "zh", LocalAccessPassword: password})
			if err != nil {
				t.Fatal(err)
			}
			go func() {
				response, err := http.Post(
					origin+"/api/client-launcher/launch",
					"application/json",
					bytes.NewReader(payload),
				)
				if err != nil {
					t.Error(err)
					return
				}
				result <- response
			}()
			select {
			case selection := <-server.Selection():
				if selection.Mode != ModeLocal || selection.Language != "zh" || selection.LocalAccessPassword != password {
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
		})
	}
}

func TestLauncherRejectsAnInvalidSavedSite(t *testing.T) {
	if _, err := Start(t.Context(), appAssets(), Options{Site: "https://example.test/path", Version: "development"}); err == nil {
		t.Fatal("launcher accepted a Site path")
	}
}

// A binary built without the Browser build has nothing to launch.
func TestLauncherRequiresTheEmbeddedBrowserBuild(t *testing.T) {
	if _, err := Start(t.Context(), nil, Options{Version: "development"}); err == nil {
		t.Fatal("launcher started without embedded assets")
	}
	if _, err := Start(t.Context(), fstest.MapFS{}, Options{Version: "development"}); err == nil {
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
		"password-type":    `{"mode":"local","language":"en","localAccessPassword":123}`,
		"debug-type":       `{"mode":"local","language":"en","debug":"true"}`,
		"lan-type":         `{"mode":"local","language":"en","lanAddress":123}`,
		"lan-invalid":      `{"mode":"local","language":"en","lanAddress":"bad-address"}`,
		"lan-ipv6":         `{"mode":"local","language":"en","lanAddress":"::1"}`,
		"link-lan":         `{"mode":"link","language":"en","lanAddress":"192.168.1.4"}`,
		"link-lan-empty":   `{"mode":"link","language":"en","lanAddress":""}`,
		"site-lan":         `{"mode":"site","language":"en","site":"https://share.example","lanAddress":"192.168.1.4"}`,
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
			var failure struct{ Error, Detail string }
			if err := json.NewDecoder(response.Body).Decode(&failure); err != nil || failure.Detail == "" {
				t.Fatalf("invalid selection lost its reason: %+v, %v", failure, err)
			}
		})
	}
}

func TestLauncherReportsSafeBoundedFailureDetails(t *testing.T) {
	server, err := Start(t.Context(), appAssets(), Options{Version: "development", Debug: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	origin := strings.TrimSuffix(server.URL(), "/client")
	response, err := http.Get(origin + "/api/client-launcher")
	if err != nil {
		t.Fatal(err)
	}
	var state struct{ Debug bool }
	if err := json.NewDecoder(response.Body).Decode(&state); err != nil || !state.Debug {
		t.Fatalf("CLI debug was not advertised: %+v, %v", state, err)
	}
	_ = response.Body.Close()
	server.SetResult("", errors.New("public tunnel failed: token=private-secret "+strings.Repeat("network unavailable ", 200)))
	response, err = http.Post(origin+"/api/client-launcher/launch", "application/json",
		strings.NewReader(`{"mode":"link","language":"en"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var failure struct{ Error, Detail string }
	if err := json.NewDecoder(response.Body).Decode(&failure); err != nil || response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("failure response = %d, %v", response.StatusCode, err)
	}
	if failure.Error != "Piik App could not start" || !strings.Contains(failure.Detail, "public tunnel failed") ||
		strings.Contains(failure.Detail, "private-secret") || len([]rune(failure.Detail)) > 2051 {
		t.Fatalf("unsafe or missing failure detail: %+v", failure)
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
	return startFixtureWithBuildAndPassword(t, site, "development", "", "")
}

func startFixtureWithPassword(t *testing.T, site, password string) *Server {
	return startFixtureWithBuildAndPassword(t, site, "development", "", password)
}

func startFixtureWithBuildAndPassword(
	t *testing.T,
	site, version, revision, password string,
) *Server {
	t.Helper()
	server, err := Start(t.Context(), appAssets(), Options{Site: site, Version: version, Revision: revision, LocalAccessPassword: password})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	return server
}
