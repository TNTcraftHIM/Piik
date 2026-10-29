package launcher

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	appfailure "github.com/P4-aaaul/Silip/internal/app/failure"
	"github.com/P4-aaaul/Silip/internal/app/lan"
)

// appAssets stands in for the embedded Vite build the App ships.
func appAssets() fs.FS {
	return fstest.MapFS{
		"index.html": {Data: []byte("<!doctype html><html><body>client</body></html>")},
	}
}

func TestLauncherCompressesEntryAndAssetsWithoutChangingAPI(t *testing.T) {
	body := []byte(strings.Repeat("Silip launcher asset ", 400))
	assets := fstest.MapFS{
		"index.html":    {Data: body},
		"assets/app.js": {Data: body},
	}
	server, err := Start(t.Context(), assets, Options{Version: "development"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	origin := strings.TrimSuffix(server.URL(), "/client")
	for _, path := range []string{"/client", "/client/", "/assets/app.js"} {
		t.Run(path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, origin+path, nil)
			request.Header.Set("Accept-Encoding", "gzip")
			response := httptest.NewRecorder()
			server.ServeHTTP(response, request)
			if response.Code != http.StatusOK || response.Header().Get("Content-Encoding") != "gzip" {
				t.Fatalf("static response: %d, %v", response.Code, response.Header())
			}
			reader, err := gzip.NewReader(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			defer reader.Close()
			decoded, err := io.ReadAll(reader)
			if err != nil || !bytes.Equal(decoded, body) {
				t.Fatalf("compressed asset changed: %v", err)
			}
			if path != "/assets/app.js" && response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("launcher entry lost its cache policy")
			}
		})
	}
	request := httptest.NewRequest(http.MethodGet, origin+"/api/client-launcher", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get("Content-Encoding") != "" || !json.Valid(response.Body.Bytes()) {
		t.Fatalf("launcher API changed: %d, %v", response.Code, response.Header())
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
		Sites               []string `json:"sites"`
		LocalAccessPassword string   `json:"localAccessPassword"`
		DefaultMode         Mode     `json:"defaultMode"`
		Version             string   `json:"version"`
		Revision            string   `json:"revision"`
		Debug               *bool    `json:"debug"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(response.Body).Decode(&state) != nil ||
		strings.Join(state.Sites, ",") != "https://share.example" || state.DefaultMode != ModeLink ||
		state.Version != "development" || state.Revision != "" || state.LocalAccessPassword != "" || state.Debug == nil || *state.Debug {
		t.Fatalf("launcher state = %d, %+v", response.StatusCode, state)
	}

	result := make(chan *http.Response, 1)
	requestErr := make(chan error, 1)
	go func() {
		response, err := localPost(
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
		server.SetResult("http://localhost:8787/#silip-client=1", nil)
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
			launch.Target != "http://localhost:8787/#silip-client=1" {
			t.Fatalf("launcher result = %d, %+v", response.StatusCode, launch)
		}
	case <-time.After(time.Second):
		t.Fatal("launcher did not return its result")
	}
}

func TestLauncherReentryReturnsTheExistingRoom(t *testing.T) {
	server := startFixture(t, "https://share.example")
	origin := strings.TrimSuffix(server.URL(), "/client")
	post := func(ctx context.Context) (*http.Response, error) {
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, origin+"/api/client-launcher/launch",
			strings.NewReader(`{"mode":"local","language":"en"}`))
		if err != nil {
			return nil, err
		}
		request.Header.Set("Origin", origin)
		request.Header.Set("Content-Type", "application/json")
		return (&http.Client{Timeout: 3 * time.Second}).Do(request)
	}
	results := make(chan *http.Response, 2)
	errors := make(chan error, 2)
	enter := func(ctx context.Context) {
		response, err := post(ctx)
		if err != nil {
			errors <- err
			return
		}
		results <- response
	}
	first, cancel := context.WithCancel(t.Context())
	defer cancel()
	go enter(first)
	select {
	case <-server.Selection():
	case <-time.After(time.Second):
		t.Fatal("first entry did not start the room")
	}
	// Leaving the page cancels HTTP, but the accepted startup remains alive.
	cancel()
	select {
	case <-errors:
	case <-time.After(time.Second):
		t.Fatal("departed page did not release its request")
	}
	// A second page or rapid repeat entry must join the accepted startup.
	go enter(t.Context())
	go enter(t.Context())
	target := "http://localhost:8787/#silip-client=1"
	server.SetResult(target, nil)
	check := func(response *http.Response) {
		t.Helper()
		defer response.Body.Close()
		var result struct{ Target string }
		if json.NewDecoder(response.Body).Decode(&result) != nil || response.StatusCode != http.StatusOK || result.Target != target {
			t.Fatalf("entry did not open the existing room: status=%d result=%+v", response.StatusCode, result)
		}
	}
	for range 2 {
		select {
		case response := <-results:
			check(response)
		case err := <-errors:
			t.Fatal(err)
		case <-time.After(time.Second):
			t.Fatal("repeat entry did not finish")
		}
	}
	// Returning to the launcher after sharing uses the same healthy room.
	response, err := post(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	check(response)
	select {
	case <-server.Selection():
		t.Fatal("reentry started a second room")
	default:
	}
}

func TestRoomFailureInvalidatesReadyTargetButKeepsSiteApprovalAvailable(t *testing.T) {
	server := startFixture(t, "https://share.example")
	server.changeSite = func(site string, allowed bool) ([]string, error) { return []string{}, nil }
	origin := strings.TrimSuffix(server.URL(), "/client")
	server.Begin()
	server.SetResult("http://localhost:8787/#silip-client=1", nil)
	server.SetResult("", errors.New("public invitation link stopped"))
	response, err := http.Get(origin + "/api/client-launcher")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var state struct {
		Target, Detail string
		Sites          []string
		Starting       bool
	}
	if json.NewDecoder(response.Body).Decode(&state) != nil || state.Target != "" || state.Starting ||
		state.Detail != "public invitation link stopped" || strings.Join(state.Sites, ",") != "https://share.example" {
		t.Fatalf("failed room state = %+v", state)
	}
	response, err = localPost(origin+"/api/client-launcher/site", "application/json",
		strings.NewReader(`{"site":"https://share.example","allowed":false}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("failed room blocked approval revocation: %d", response.StatusCode)
	}
}

func TestLauncherRetainsAcceptedSelectionAfterRequestCancellation(t *testing.T) {
	// Cancellation may race the handoff, but cannot discard an accepted launch.
	for range 32 {
		server := &Server{
			ctx:       t.Context(),
			selection: make(chan Selection, 1),
		}
		ctx, cancel := context.WithCancel(t.Context())
		request := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/client-launcher/launch",
			strings.NewReader(`{"mode":"link","language":"en"}`))
		cancel()
		server.handleLaunch(httptest.NewRecorder(), request)
		select {
		case selection := <-server.Selection():
			if selection != (Selection{Mode: ModeLink, Language: "en"}) {
				t.Fatalf("selection = %+v", selection)
			}
		default:
			t.Fatal("cancelled Browser request left the App starting without a selection")
		}
		if server.Begin() {
			t.Fatal("cancelled Browser request allowed a second launch")
		}
	}
}

type pausedLaunchContext struct {
	context.Context
	waiting chan struct{}
	resume  chan struct{}
}

func (ctx pausedLaunchContext) Done() <-chan struct{} {
	close(ctx.waiting)
	<-ctx.resume
	return ctx.Context.Done()
}

func TestFailedAttemptCanRetryWithoutReplacingAnOlderRequestResult(t *testing.T) {
	server := &Server{ctx: t.Context(), selection: make(chan Selection, 1)}
	// Resume the old HTTP waiter only after the retry has already succeeded.
	firstContext := pausedLaunchContext{t.Context(), make(chan struct{}), make(chan struct{})}
	firstResponse := httptest.NewRecorder()
	firstDone := make(chan struct{})
	go func() {
		defer close(firstDone)
		server.handleLaunch(firstResponse, httptest.NewRequestWithContext(firstContext, "POST", "/api/client-launcher/launch",
			strings.NewReader(`{"mode":"link","language":"en"}`)))
	}()
	select {
	case <-firstContext.waiting:
	case <-time.After(time.Second):
		t.Fatal("first request did not start waiting")
	}
	if selection := <-server.Selection(); selection.Mode != ModeLink {
		t.Fatalf("first selection = %+v", selection)
	}
	if server.Begin() {
		t.Fatal("pending room allowed another start")
	}
	server.SetResult("", errors.New("first attempt failed"))

	secondResponse := httptest.NewRecorder()
	secondDone := make(chan struct{})
	go func() {
		defer close(secondDone)
		server.handleLaunch(secondResponse, httptest.NewRequest("POST", "/api/client-launcher/launch",
			strings.NewReader(`{"mode":"local","language":"en"}`)))
	}()
	select {
	case selection := <-server.Selection():
		if selection.Mode != ModeLocal {
			t.Fatalf("retry selection = %+v", selection)
		}
	case <-time.After(time.Second):
		t.Fatal("failure did not permit retry")
	}
	server.SetResult("http://localhost:8787/#silip-client=1", nil)
	if server.Begin() {
		t.Fatal("successful room allowed replacement")
	}
	close(firstContext.resume)
	for _, done := range []chan struct{}{firstDone, secondDone} {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("launch request did not complete")
		}
	}
	if firstResponse.Code != http.StatusServiceUnavailable || !strings.Contains(firstResponse.Body.String(), "first attempt failed") {
		t.Fatalf("old request observed retry result: %d %s", firstResponse.Code, firstResponse.Body.String())
	}
	if secondResponse.Code != http.StatusOK || !strings.Contains(secondResponse.Body.String(), "http://localhost:8787/") {
		t.Fatalf("retry did not return its own success: %d %s", secondResponse.Code, secondResponse.Body.String())
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
		Version     string `json:"version"`
		Revision    string `json:"revision"`
		DefaultMode Mode   `json:"defaultMode"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(response.Body).Decode(&state) != nil ||
		state.Version != version || state.Revision != revision ||
		state.DefaultMode != ModeLink {
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
			server, err := Start(t.Context(), appAssets(), Options{Sites: siteList("https://share.example"), LANAddress: test.preferred})
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
				state.DefaultMode != ModeLink || state.LAN == nil || state.LAN.Addresses == nil ||
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
	selected := make(chan Selection, 1)
	go func() {
		selected <- <-server.Selection()
		server.SetResult("http://localhost:8787/#silip-client=1", nil)
	}()
	response, err := localPost(strings.TrimSuffix(server.URL(), "/client")+"/api/client-launcher/launch",
		"application/json", strings.NewReader(`{"mode":"local","language":"en","lanAddress":"192.168.1.4"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("selection status = %d", response.StatusCode)
	}
	selection := <-selected
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
				response, err := localPost(
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
				server.SetResult("http://localhost:8787/#silip-client=1", nil)
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
	if _, err := Start(t.Context(), appAssets(), Options{Sites: siteList("https://example.test/path"), Version: "development"}); err == nil {
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
		"bare-site-path":   `{"mode":"site","language":"en","site":"share.example/path"}`,
		"site-credentials": `{"mode":"site","language":"en","site":"user:pass@share.example"}`,
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
			response, err := localPost(
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
	cause := errors.New("public tunnel failed: token=private-secret " + strings.Repeat("network unavailable ", 200))
	go func() {
		<-server.Selection()
		server.SetResult("", errors.Join(appfailure.TunnelExited, cause))
	}()
	response, err = localPost(origin+"/api/client-launcher/launch", "application/json",
		strings.NewReader(`{"mode":"link","language":"en"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var failure struct{ Error, Detail, Reason string }
	if err := json.NewDecoder(response.Body).Decode(&failure); err != nil || response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("failure response = %d, %v", response.StatusCode, err)
	}
	if failure.Reason != string(appfailure.TunnelExited) || failure.Error != "Silip App could not start" || !strings.Contains(failure.Detail, "public tunnel failed") ||
		strings.Contains(failure.Detail, "private-secret") || len([]rune(failure.Detail)) > 2051 {
		t.Fatalf("unsafe or missing failure detail: %+v", failure)
	}
	response, err = http.Get(origin + "/api/client-launcher")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var restored struct{ Reason, Detail string }
	if err := json.NewDecoder(response.Body).Decode(&restored); err != nil || restored.Reason != failure.Reason || restored.Detail != failure.Detail {
		t.Fatalf("restored failure = %+v, %v", restored, err)
	}
	if !errors.Is(server.attempt.err, cause) {
		t.Fatal("launcher lost original cause")
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
	server, err := Start(t.Context(), appAssets(), Options{Sites: siteList(site), Version: version, Revision: revision, LocalAccessPassword: password,
		EnableDebug: func() error { return nil }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	return server
}

func localPost(target, contentType string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodPost, target, body)
	if err != nil {
		return nil, err
	}
	address, _ := url.Parse(target)
	req.Header.Set("Origin", address.Scheme+"://"+address.Host)
	req.Header.Set("Content-Type", contentType)
	return (&http.Client{Timeout: 3 * time.Second}).Do(req)
}

func siteList(site string) []string {
	if site == "" {
		return []string{}
	}
	return []string{site}
}
