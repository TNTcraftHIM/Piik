package launcher

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	appconfig "github.com/TNTcraftHIM/Piik/internal/app/config"
)

func TestSavedModeSurvivesRelaunchWithoutChangingLegacyConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "client.json")
	config, err := appconfig.LoadOrCreate(path)
	if err != nil {
		t.Fatal(err)
	}
	config.Site = "https://share.example"
	if err := appconfig.Save(path, config); err != nil {
		t.Fatal(err)
	}
	original, _ := os.ReadFile(path)
	for _, test := range []struct {
		chosen Mode
		site   string
		want   Mode
	}{
		{ModeLocal, config.Site, ModeLocal},
		{ModeLink, config.Site, ModeLink},
	} {
		if err := SaveMode(path, test.chosen); err != nil {
			t.Fatal(err)
		}
		mode, err := LoadMode(path)
		if err != nil || mode != test.chosen {
			t.Fatalf("restored mode = %q, %v", mode, err)
		}
		server, err := Start(t.Context(), appAssets(), Options{Sites: siteList(test.site), DefaultMode: mode})
		if err != nil {
			t.Fatal(err)
		}
		response, err := http.Get(strings.TrimSuffix(server.URL(), "/client") + "/api/client-launcher")
		if err != nil {
			t.Fatal(err)
		}
		var state struct {
			DefaultMode Mode     `json:"defaultMode"`
			Sites       []string `json:"sites"`
		}
		err = json.NewDecoder(response.Body).Decode(&state)
		response.Body.Close()
		server.Close()
		if err != nil || state.DefaultMode != test.want || strings.Join(state.Sites, ",") != test.site {
			t.Fatalf("launcher lost mode or saved Site: %+v, %v", state, err)
		}
	}
	current, _ := os.ReadFile(path)
	if string(current) != string(original) {
		t.Fatal("launcher preference changed legacy configuration")
	}
}

func TestUnavailableModePreferenceDoesNotSupplyAnInvalidChoice(t *testing.T) {
	path := filepath.Join(t.TempDir(), "client.json")
	if mode, err := LoadMode(path); err != nil || mode != "" {
		t.Fatalf("missing preference = %q, %v", mode, err)
	}
	if err := os.WriteFile(path+".mode", []byte("invalid"), 0o600); err != nil {
		t.Fatal(err)
	}
	if mode, err := LoadMode(path); err == nil || mode != "" {
		t.Fatalf("corrupt preference = %q, %v", mode, err)
	}
	if err := SaveMode(path, "invalid"); err == nil {
		t.Fatal("saved an invalid mode")
	}
}

func TestStarredSiteSurvivesOtherApprovalsAndClearsOnRevocation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "client.json")
	config, err := appconfig.LoadOrCreate(path)
	if err != nil {
		t.Fatal(err)
	}
	sites := []string{"https://share.example"}
	server, err := Start(t.Context(), appAssets(), Options{Sites: sites, ControlPort: 39730,
		SaveStartupSite: func(site string) error { return SaveStartupSite(path, site) },
		ChangeSite: func(site string, allowed bool) ([]string, error) {
			sites = editSites(sites, site, allowed)
			return sites, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	origin := strings.TrimSuffix(server.URL(), "/client")
	for _, test := range []struct {
		setting, body, want string
		status              int
	}{
		{"startup-site", `{"site":"https://share.example"}`, "https://share.example", 200},
		{"startup-site", `{"site":"https://unapproved.example"}`, "https://share.example", 409},
		{"site", `{"site":"https://other.example","allowed":true}`, "https://share.example", 200},
		{"startup-site", `{"site":"https://other.example"}`, "https://other.example", 200},
		{"site", `{"site":"https://share.example","allowed":false}`, "https://other.example", 200},
		{"site", `{"site":"https://other.example","allowed":false}`, "", 200},
	} {
		response, err := localPost(origin+"/api/client-launcher/"+test.setting, "application/json", strings.NewReader(test.body))
		if err != nil {
			t.Fatal(err)
		}
		var state struct {
			Sites       []string
			StartupSite string
		}
		err = json.NewDecoder(response.Body).Decode(&state)
		response.Body.Close()
		if err != nil || response.StatusCode != test.status || state.StartupSite != test.want {
			t.Fatalf("%+v: %+v %v", test, state, err)
		}
		if saved, err := LoadStartupSite(path, state.Sites...); err != nil || saved != test.want {
			t.Fatalf("saved startup: %q %v", saved, err)
		}
		entry := server.URL()
		if test.want != "" {
			entry = test.want + "/?piik-client-port=39730#piik-client=1"
		}
		if server.EntryURL() != entry {
			t.Fatalf("startup entry lost its App endpoint: %q, want %q", server.EntryURL(), entry)
		}
	}
	if server.attempt != nil || config.Site != "" {
		t.Fatal("startup preference created room or access")
	}
}
