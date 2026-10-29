package bridge

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/P4-aaaul/Silip/internal/app/buildinfo"
	appconfig "github.com/P4-aaaul/Silip/internal/app/config"
	"github.com/P4-aaaul/Silip/internal/app/launcher"
	"github.com/P4-aaaul/Silip/internal/app/loopback"
	"github.com/P4-aaaul/Silip/internal/server/webassets"
)

func TestStartRejectsUnownedActivationURLBeforeAllocating(t *testing.T) {
	_, err := Start(&testPlatform{}, "", "", "", "", "", "https://other.example/")
	if err == nil || !strings.Contains(err.Error(), "activation URL") {
		t.Fatalf("unexpected activation URL result: %v", err)
	}
}

func TestLauncherRestoresOnlyAvailableModes(t *testing.T) {
	if webassets.FS() == nil {
		t.Skip("mobile runtime requires built Web assets")
	}
	previousVersion, previousRevision := buildinfo.Release, buildinfo.Revision
	buildinfo.Release, buildinfo.Revision = "v2.4.1", strings.Repeat("a", 40)
	t.Cleanup(func() { buildinfo.Release, buildinfo.Revision = previousVersion, previousRevision })
	helper, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	path := filepath.Join(directory, "client.json")
	for _, test := range []struct {
		name        string
		saved       launcher.Mode
		helper      string
		want        launcher.Mode
		modes       []launcher.Mode
		selectLocal bool
	}{
		{"first launch with helper", "", helper, launcher.ModeLink, []launcher.Mode{launcher.ModeLocal, launcher.ModeLink}, true},
		{"saved local after restart", "", helper, launcher.ModeLocal, []launcher.Mode{launcher.ModeLocal, launcher.ModeLink}, false},
		{"saved link without helper", launcher.ModeLink, "", launcher.ModeLocal, []launcher.Mode{launcher.ModeLocal}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if test.saved != "" {
				if err := launcher.SaveMode(path, test.saved); err != nil {
					t.Fatal(err)
				}
			}
			r, err := Start(&testPlatform{}, "", `{"platform":"android","provider":"fixture","encoders":[]}`,
				directory, t.TempDir(), test.helper, "")
			if err != nil {
				t.Fatal(err)
			}
			defer r.Close()
			response, err := http.Get(strings.TrimSuffix(r.URL(), "/client") + "/api/client-launcher")
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			var state struct {
				DefaultMode launcher.Mode
				Modes       []launcher.Mode
				Version     string
				Revision    string
			}
			if err = json.NewDecoder(response.Body).Decode(&state); err != nil {
				t.Fatal(err)
			}
			if state.DefaultMode != test.want || !slices.Equal(state.Modes, test.modes) {
				t.Fatalf("launcher mode = %+v, want default=%s modes=%v", state, test.want, test.modes)
			}
			if state.Version != buildinfo.Version() || state.Revision != buildinfo.Revision {
				t.Fatalf("launcher did not receive App build identity: %+v", state)
			}
			if test.selectLocal {
				origin := strings.TrimSuffix(r.URL(), "/client")
				request, _ := http.NewRequest(http.MethodPost, origin+"/api/client-launcher/launch", strings.NewReader(`{"mode":"local","language":"en"}`))
				request.Header.Set("Origin", origin)
				request.Header.Set("Content-Type", "application/json")
				chosen, err := http.DefaultClient.Do(request)
				if err != nil {
					t.Fatal(err)
				}
				chosen.Body.Close()
				// Mode is remembered even when Local has no invitation interface.
				if chosen.StatusCode != http.StatusServiceUnavailable {
					t.Fatalf("Local without an address = %d", chosen.StatusCode)
				}
			}
		})
	}
}

func TestEntryTracksCurrentStartupPreferenceAndSiteRevocation(t *testing.T) {
	if webassets.FS() == nil {
		t.Skip("mobile runtime requires built Web assets")
	}
	directory := t.TempDir()
	configPath := filepath.Join(directory, "client.json")
	if err := appconfig.Save(configPath, appconfig.Config{Version: 1, Sites: []string{"https://first.example", "https://second.example"}}); err != nil {
		t.Fatal(err)
	}
	if err := launcher.SaveStartupSite(configPath, "https://first.example"); err != nil {
		t.Fatal(err)
	}
	r, err := Start(&testPlatform{}, "", `{"platform":"android","provider":"Android MediaCodec","systemAudio":true,"encoders":[]}`, directory, t.TempDir(), "", "silip://media")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	entrySuffix := "/?silip-client-port=" + strconv.Itoa(r.control.Endpoint().Port) + "#silip-client=1"
	if r.EntryURL() != "https://first.example"+entrySuffix {
		t.Fatal("saved entry was not restored")
	}
	startup := r.URL()
	origin := strings.TrimSuffix(startup, "/client")
	for _, test := range []struct{ setting, body, entry, startupSite string }{
		{"startup-site", `{"site":"https://second.example"}`, "https://second.example" + entrySuffix, "https://second.example"},
		{"startup-site", `{"site":""}`, startup, ""},
		{"startup-site", `{"site":"https://first.example"}`, "https://first.example" + entrySuffix, "https://first.example"},
		{"site", `{"site":"https://first.example","allowed":false}`, startup, ""},
		{"site", `{"site":"https://third.example","allowed":true}`, startup, ""},
		{"startup-site", `{"site":"https://third.example"}`, "https://third.example" + entrySuffix, "https://third.example"},
	} {
		request, _ := http.NewRequest(http.MethodPost, origin+"/api/client-launcher/"+test.setting, strings.NewReader(test.body))
		request.Header.Set("Origin", origin)
		request.Header.Set("Content-Type", "application/json")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		var state struct{ StartupSite string }
		decodeErr := json.NewDecoder(response.Body).Decode(&state)
		response.Body.Close()
		if response.StatusCode != http.StatusOK || decodeErr != nil {
			t.Fatalf("setting %s failed: %d %v", test.setting, response.StatusCode, decodeErr)
		}
		if r.EntryURL() != test.entry || r.URL() != startup || state.StartupSite != test.startupSite {
			t.Fatalf("entry did not follow %s: got %q want %q", test.body, r.EntryURL(), test.entry)
		}
	}
	for site, want := range map[string]int{"https://first.example": http.StatusForbidden, "https://third.example": http.StatusOK} {
		request, _ := http.NewRequest(http.MethodGet, r.control.Endpoint().URL+"/health", nil)
		request.Header.Set("Origin", site)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != want {
			t.Fatalf("site authorization = %d want %d", response.StatusCode, want)
		}
	}
	if r.server != nil {
		t.Fatal("startup preference created a local room")
	}
}

func TestSiteApprovalPersistsExactOriginAndRevocation(t *testing.T) {
	control, err := loopback.Start(context.Background(), loopback.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer control.Close()
	path := filepath.Join(t.TempDir(), "client.json")
	cfg, err := appconfig.LoadOrCreate(path)
	if err != nil {
		t.Fatal(err)
	}
	platform := &testPlatform{}
	r := &Runtime{capture: &capture{platform: platform}, control: control, url: "http://127.0.0.1:49152/#silip-client=1", configPath: path, config: cfg}
	var notified []bool
	platform.siteChanged = func() { notified = append(notified, r.TrustedURL("https://silip.example")) }
	site, err := r.approveSite("SILIP.example:443")
	if err != nil || site != "https://silip.example" {
		t.Fatalf("approval: %q %v", site, err)
	}
	if !r.TrustedURL(site+"/room#local") || r.TrustedURL("https://other.example") || r.TrustedURL("http://silip.example") || !r.TrustedURL(r.url) {
		t.Fatal("incorrect exact origin trust")
	}
	persisted, err := appconfig.LoadOrCreate(path)
	if err != nil || len(persisted.ApprovedSites()) != 1 {
		t.Fatalf("approval not persisted: %v", err)
	}
	if _, err = r.approveSite("https://silip.example/room"); err == nil {
		t.Fatal("navigation URL granted as an origin")
	}
	if _, err = r.approveSite("http://silip.example"); err == nil {
		t.Fatal("insecure hosted site approved")
	}
	if err = r.revokeSite(site); err != nil {
		t.Fatal(err)
	}
	if r.TrustedURL(site) || !r.TrustedURL(r.url) {
		t.Fatal("revocation changed wrong authority")
	}
	if !slices.Equal(notified, []bool{true, false}) {
		t.Fatalf("platform observed stale site authority: %v", notified)
	}
	persisted, err = appconfig.LoadOrCreate(path)
	if err != nil || len(persisted.ApprovedSites()) != 0 {
		t.Fatal("revocation not persisted")
	}
}
