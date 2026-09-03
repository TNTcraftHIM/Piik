package clientconfig

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadOrCreatePersistsOneValidConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "client.json")
	first, err := LoadOrCreate(path)
	if err != nil {
		t.Fatal(err)
	}
	second, err := LoadOrCreate(path)
	if err != nil {
		t.Fatal(err)
	}
	if first != second || first.Version != currentVersion ||
		!passwordPattern.MatchString(first.LocalAccessPassword) {
		t.Fatalf("persisted configuration = %+v, %+v", first, second)
	}
}

func TestSavePersistsOneNormalizedSiteChoice(t *testing.T) {
	path := filepath.Join(t.TempDir(), "client.json")
	config, err := LoadOrCreate(path)
	if err != nil {
		t.Fatal(err)
	}
	config.Site = "https://share.example"
	if err = Save(path, config); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadOrCreate(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Site != "https://share.example" ||
		loaded.LocalAccessPassword != config.LocalAccessPassword {
		t.Fatalf("saved configuration = %+v", loaded)
	}
}

func TestNormalizeSiteAcceptsOnlyAPlainWebOrigin(t *testing.T) {
	for _, value := range []string{
		"https://share.example",
		"http://192.168.1.4:8787/",
	} {
		if _, err := NormalizeSite(value); err != nil {
			t.Fatalf("NormalizeSite(%q) = %v", value, err)
		}
	}
	for _, value := range []string{
		"file:///tmp/app",
		"https://user:pass@share.example",
		"https://share.example/room",
		"https://share.example?mode=host",
	} {
		if _, err := NormalizeSite(value); err == nil {
			t.Fatalf("NormalizeSite accepted %q", value)
		}
	}
}

func TestLoadOrCreateRejectsUnknownOrMalformedState(t *testing.T) {
	for name, payload := range map[string]string{
		"unknown":  `{"version":1,"localAccessPassword":"abcdefghijklmnopqrstuvwxyzABCDEF","extra":true}`,
		"version":  `{"version":2,"localAccessPassword":"abcdefghijklmnopqrstuvwxyzABCDEF"}`,
		"password": `{"version":1,"localAccessPassword":"short"}`,
		"trailing": `{"version":1,"localAccessPassword":"abcdefghijklmnopqrstuvwxyzABCDEF"} trailing`,
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "client.json")
			if err := os.WriteFile(path, []byte(payload), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := LoadOrCreate(path); err == nil {
				t.Fatal("invalid Client configuration was accepted")
			}
		})
	}
}
