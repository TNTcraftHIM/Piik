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
		{ModeSite, config.Site, ModeSite},
		{ModeLocal, config.Site, ModeLocal},
		{ModeLink, config.Site, ModeLink},
		{ModeSite, "", ModeLink},
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
