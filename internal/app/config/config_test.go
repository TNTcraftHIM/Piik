package config

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
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
		first.LocalAccessPassword != "" {
		t.Fatalf("persisted configuration = %+v, %+v", first, second)
	}
}

func TestUserChosenLocalAccessPasswordIsPreserved(t *testing.T) {
	path := filepath.Join(t.TempDir(), "client.json")
	for _, value := range []string{"", "x", "中文", " ", "  中文 +&  ", strings.Repeat("x", 256)} {
		if err := Save(path, Config{Version: currentVersion, LocalAccessPassword: value}); err != nil {
			t.Fatal(err)
		}
		loaded, err := LoadOrCreate(path)
		if err != nil || loaded.LocalAccessPassword != value {
			t.Fatalf("saved password changed: %v", err)
		}
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

func TestSaveReplacementFailurePreservesDestinationAndCleansTemporaryFile(t *testing.T) {
	directory := t.TempDir()
	// A directory cannot be replaced by a configuration file. Its contents must
	// survive the failed commit and no private temporary payload may be left.
	path := filepath.Join(directory, "client.json")
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(path, "keep")
	if err := os.WriteFile(marker, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Save(path, Config{Version: currentVersion}); err == nil {
		t.Fatal("replacement of a directory must fail")
	}
	payload, err := os.ReadFile(marker)
	if err != nil || string(payload) != "original" {
		t.Fatalf("failed replacement damaged the destination: %q, %v", payload, err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 1 || entries[0].Name() != "client.json" {
		t.Fatalf("replacement left temporary files: %v, %v", entries, err)
	}
}

func TestSavePublishesPrivateCompleteReplacement(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "client.json")
	initial := Config{Version: currentVersion, Site: "https://old.example"}
	if err := Save(path, initial); err != nil {
		t.Fatal(err)
	}
	updated := Config{Version: currentVersion, Site: "https://new.example", LocalAccessPassword: "new"}
	if err := Save(path, updated); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadOrCreate(path)
	if err != nil || loaded != updated {
		t.Fatalf("replacement = %+v, %v", loaded, err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 1 {
		t.Fatalf("successful replacement left temporary files: %v, %v", entries, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("private configuration mode = %o", info.Mode().Perm())
	}
}

func TestSaveDoesNotModifyPreviousFileInPlace(t *testing.T) {
	path := filepath.Join(t.TempDir(), "client.json")
	initial := Config{Version: currentVersion, Site: "https://old.example"}
	if err := Save(path, initial); err != nil {
		t.Fatal(err)
	}
	previous, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer previous.Close()
	updated := Config{Version: currentVersion, Site: "https://new.example"}
	saveErr := Save(path, updated)
	// Windows readers may deny replacement. Whether publication succeeds or
	// fails, an already-open previous file must never expose a truncated rewrite.
	if saveErr != nil && runtime.GOOS != "windows" {
		t.Fatal(saveErr)
	}
	want, _ := encode(initial)
	actual, err := io.ReadAll(previous)
	if err != nil || !bytes.Equal(actual, want) {
		t.Fatalf("the previous file was modified in place: %v", err)
	}
	loaded, err := LoadOrCreate(path)
	if err != nil || (saveErr == nil && loaded != updated) || (saveErr != nil && loaded != initial) {
		t.Fatalf("published configuration = %+v, load=%v, save=%v", loaded, err, saveErr)
	}
}

func TestNormalizeSiteAcceptsOnlyAPlainWebOrigin(t *testing.T) {
	for value, want := range map[string]string{
		"":                              "",
		" \t ":                          "",
		"share.example":                 "https://share.example",
		" Share.Example:443/ ":          "https://share.example",
		"share.example:8443":            "https://share.example:8443",
		"[::1]:8443":                    "https://[::1]:8443",
		"bücher.example":                "https://xn--bcher-kva.example",
		" HTTPS://Share.Example/ ":      "https://share.example",
		"https://share.example":         "https://share.example",
		"https://Share.Example:443/":    "https://share.example",
		"http://Share.Example:80":       "http://share.example",
		"https://share.example:0443":    "https://share.example",
		"http://192.168.1.4:8787/":      "http://192.168.1.4:8787",
		"http://share.example:443":      "http://share.example:443",
		"https://[::1]:443":             "https://[::1]",
		"https://bücher.example:443":    "https://xn--bcher-kva.example",
		"http://[0:0:0:0:0:0:0:1]:8787": "http://[::1]:8787",
	} {
		if got, err := NormalizeSite(value); err != nil || got != want {
			t.Fatalf("NormalizeSite(%q) = %q, %v; want %q", value, got, err, want)
		}
	}
	for _, value := range []string{
		"https://https://share.example",
		"share.example/r/9527",
		"share.example?mode=host",
		"share.example#credential",
		"user:pass@share.example",
		"share.example:65536",
		"ftp://share.example",
		"javascript:alert(1)",
		"file:///tmp/app",
		"https://user:pass@share.example",
		"https://share.example/room",
		"https://share.example?mode=host",
		"https://example.com:65536",
		"https://[fe80::1%25eth0]",
		"https://example：443",
		"https://example／evil",
		"https://\u00ad",
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
		"password": `{"version":1,"localAccessPassword":123}`,
		"trailing": `{"version":1,"localAccessPassword":"abcdefghijklmnopqrstuvwxyzABCDEF"} trailing`,
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "client.json")
			if err := os.WriteFile(path, []byte(payload), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := LoadOrCreate(path); err == nil {
				t.Fatal("invalid App configuration was accepted")
			}
		})
	}
}
