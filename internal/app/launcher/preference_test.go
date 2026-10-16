package launcher

import (
	"encoding/json"
	"fmt"
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
		server, err := Start(t.Context(), appAssets(), Options{Site: test.site, DefaultMode: mode})
		if err != nil {
			t.Fatal(err)
		}
		response, err := http.Get(strings.TrimSuffix(server.URL(), "/client") + "/api/client-launcher")
		if err != nil {
			t.Fatal(err)
		}
		var state struct {
			DefaultMode Mode   `json:"defaultMode"`
			Site        string `json:"site"`
		}
		err = json.NewDecoder(response.Body).Decode(&state)
		response.Body.Close()
		server.Close()
		if err != nil || state.DefaultMode != test.want || state.Site != test.site {
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

func TestStarredSitePersistsWithoutGrantingAccessAndClearsOnReplacement(t *testing.T) {
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
	if site, err := LoadStartupSite(path, config.Site); err != nil || site != "" {
		t.Fatalf("unselected startup Site = %q, %v", site, err)
	}
	server, err := Start(t.Context(), appAssets(), Options{Site: config.Site,
		SaveStartupSite: func(site string) error { return SaveStartupSite(path, site) },
		ChangeSite:      func(site string) (string, error) { return site, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	origin := strings.TrimSuffix(server.URL(), "/client")
	for _, test := range []struct {
		setting, site, approved, want string
		status                        int
	}{
		{"startup-site", config.Site, config.Site, config.Site, 200},
		{"startup-site", "https://unapproved.example", config.Site, config.Site, 409},
		{"startup-site", "", config.Site, "", 200},
		{"startup-site", config.Site, config.Site, config.Site, 200},
		{"site", "https://other.example", "https://other.example", "", 200},
		{"startup-site", "https://other.example", "https://other.example", "https://other.example", 200},
		{"site", "", "", "", 200},
	} {
		body := fmt.Sprintf(`{"site":%q,"expectedSite":%q}`, test.site, server.site)
		response, err := localPost(origin+"/api/client-launcher/"+test.setting, "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		var state struct{ Site, StartupSite string }
		err = json.NewDecoder(response.Body).Decode(&state)
		response.Body.Close()
		if err != nil || response.StatusCode != test.status || state.Site != test.approved || state.StartupSite != test.want {
			t.Fatalf("%+v: status=%d, state=%+v, error=%v", test, response.StatusCode, state, err)
		}
		if saved, err := LoadStartupSite(path, test.approved); err != nil || saved != test.want {
			t.Fatalf("startup Site did not survive reload: %q, %v", saved, err)
		}
	}
	if err := SaveStartupSite(path, config.Site); err != nil {
		t.Fatal(err)
	}
	for _, approved := range []string{"https://other.example", config.Site} {
		if saved, err := LoadStartupSite(path, approved); err != nil || saved != "" {
			t.Fatalf("startup preference survived a CLI/config Site change: %q, %v", saved, err)
		}
	}
	current, _ := os.ReadFile(path)
	if string(current) != string(original) || server.selected {
		t.Fatal("startup preference changed legacy configuration or started a room")
	}
}
