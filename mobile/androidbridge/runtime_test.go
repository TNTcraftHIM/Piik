package androidbridge

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	appconfig "github.com/TNTcraftHIM/Piik/internal/app/config"
	"github.com/TNTcraftHIM/Piik/internal/app/launcher"
	"github.com/TNTcraftHIM/Piik/internal/app/loopback"
	"github.com/TNTcraftHIM/Piik/internal/server/webassets"
)

func TestStartRejectsUnownedActivationURLBeforeAllocating(t *testing.T) {
	_, err := Start(&testPlatform{}, "", "", "", "", "", "https://other.example/")
	if err == nil || !strings.Contains(err.Error(), "activation URL") {
		t.Fatalf("unexpected activation URL result: %v", err)
	}
}

func TestEntryTracksCurrentStartupPreferenceAndSiteRevocation(t *testing.T) {
	if webassets.FS() == nil {
		t.Skip("Android runtime requires built Web assets")
	}
	directory := t.TempDir()
	configPath := filepath.Join(directory, "client.json")
	if err := appconfig.Save(configPath, appconfig.Config{Version: 1, Sites: []string{"https://first.example", "https://second.example"}}); err != nil {
		t.Fatal(err)
	}
	if err := launcher.SaveStartupSite(configPath, "https://first.example"); err != nil {
		t.Fatal(err)
	}
	r, err := Start(&testPlatform{}, "", `{"encoders":[]}`, directory, t.TempDir(), "", "piik://media")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if r.EntryURL() != "https://first.example/#piik-client=1" {
		t.Fatal("saved entry was not restored")
	}
	startup := r.URL()
	origin := strings.TrimSuffix(startup, "/client")
	for _, test := range []struct{ setting, body, entry, startupSite string }{
		{"startup-site", `{"site":"https://second.example"}`, "https://second.example/#piik-client=1", "https://second.example"},
		{"startup-site", `{"site":""}`, startup, ""},
		{"startup-site", `{"site":"https://first.example"}`, "https://first.example/#piik-client=1", "https://first.example"},
		{"site", `{"site":"https://first.example","allowed":false}`, startup, ""},
		{"site", `{"site":"https://third.example","allowed":true}`, startup, ""},
		{"startup-site", `{"site":"https://third.example"}`, "https://third.example/#piik-client=1", "https://third.example"},
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
	r := &Runtime{capture: &capture{platform: platform}, control: control, url: "http://127.0.0.1:49152/#piik-client=1", configPath: path, config: cfg}
	var notified []bool
	platform.siteChanged = func() { notified = append(notified, r.TrustedURL("https://piik.example")) }
	site, err := r.approveSite("PIIK.example:443")
	if err != nil || site != "https://piik.example" {
		t.Fatalf("approval: %q %v", site, err)
	}
	if !r.TrustedURL(site+"/room#local") || r.TrustedURL("https://other.example") || r.TrustedURL("http://piik.example") || !r.TrustedURL(r.url) {
		t.Fatal("incorrect exact origin trust")
	}
	persisted, err := appconfig.LoadOrCreate(path)
	if err != nil || len(persisted.ApprovedSites()) != 1 {
		t.Fatalf("approval not persisted: %v", err)
	}
	if _, err = r.approveSite("https://piik.example/room"); err == nil {
		t.Fatal("navigation URL granted as an origin")
	}
	if _, err = r.approveSite("http://piik.example"); err == nil {
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
