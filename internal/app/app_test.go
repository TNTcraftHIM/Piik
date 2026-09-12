package app

import (
	"bytes"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	appconfig "github.com/TNTcraftHIM/Piik/internal/app/config"
	"github.com/TNTcraftHIM/Piik/internal/app/loopback"
	serverconfig "github.com/TNTcraftHIM/Piik/internal/server/config"
)

func TestSavedSiteAllowsBrowserOriginAtNativeControl(t *testing.T) {
	for _, site := range []struct{ input, origin string }{
		{"https://Share.Example:443", "https://share.example"},
		{"http://share.example:80", "http://share.example"},
		{"http://share.example:8787", "http://share.example:8787"},
	} {
		t.Run(site.input, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "client.json")
			payload := fmt.Sprintf(`{"version":1,"localAccessPassword":"","site":%q}`, site.input)
			if err := os.WriteFile(path, []byte(payload), 0o600); err != nil {
				t.Fatal(err)
			}
			configuration, err := appconfig.LoadOrCreate(path)
			if err != nil {
				t.Fatal(err)
			}
			control, err := loopback.Start(t.Context(), loopback.Options{
				AllowedOrigins: allowedOrigins(configuration.Site, 8787),
			})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = control.Close() })
			client := &http.Client{Timeout: 3 * time.Second}
			for _, probe := range []struct {
				method, origin string
				status         int
			}{
				{http.MethodOptions, site.origin, http.StatusNoContent},
				{http.MethodGet, site.origin, http.StatusOK},
				{http.MethodOptions, "https://other.example", http.StatusForbidden},
			} {
				request, err := http.NewRequest(probe.method, control.Endpoint().URL+"/health", nil)
				if err != nil {
					t.Fatal(err)
				}
				request.Header.Set("Origin", probe.origin)
				response, err := client.Do(request)
				if err != nil {
					t.Fatal(err)
				}
				response.Body.Close()
				if response.StatusCode != probe.status {
					t.Fatalf("%s health from %q = %d, want %d", probe.method, probe.origin, response.StatusCode, probe.status)
				}
			}
		})
	}
}

func TestOccupiedPortRejectsLinkBeforeStartingATunnel(t *testing.T) {
	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4zero})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	err = runLocal(t.Context(), Options{
		Link: true, Port: listener.Addr().(*net.TCPAddr).Port,
		TunnelProcess: "missing-tunnel-process", console: &console{machine: true},
	}, appconfig.Config{}, nil)
	var bindError *net.OpError
	if !errors.As(err, &bindError) || bindError.Op != "listen" {
		t.Fatalf("occupied port must fail before tunnel work: %v", err)
	}
}

func TestAppLaunchURLMarksThePageWithoutChangingOrigin(t *testing.T) {
	value := launchURL("https://share.example/")
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host != "share.example" ||
		parsed.RawQuery != "" {
		t.Fatalf("launch URL = %q, %v", value, err)
	}
	fragment, err := url.ParseQuery(parsed.Fragment)
	if err != nil || fragment.Get("piik-client") != "1" {
		t.Fatalf("App launch fragment = %q, %v", parsed.Fragment, err)
	}
}

func TestAppDiagnosticsUseFilesOnlyWhenEnabled(t *testing.T) {
	for value, want := range map[string]bool{
		"client": true, "route, client": true, "client,": true,
		"": false, "route": false, "all": false, "client-secret": false,
	} {
		if got := debugEnabled(value); got != want {
			t.Fatalf("debugEnabled(%q) = %v, want %v", value, got, want)
		}
	}

	var output bytes.Buffer
	previousOutput := log.Writer()
	previousLevel := slog.SetLogLoggerLevel(slog.LevelInfo)
	log.SetOutput(&output)
	t.Cleanup(func() {
		log.SetOutput(previousOutput)
		slog.SetLogLoggerLevel(previousLevel)
	})
	t.Setenv("PIIK_DEBUG", "")
	for _, enabled := range []bool{false, true} {
		output.Reset()
		directory := t.TempDir()
		err := Run(t.Context(), Options{Debug: enabled, LogDir: directory, DisableBrowser: true, Local: true, Link: true})
		if err == nil {
			t.Fatal("invalid mode must stop before starting capture or services")
		}
		if strings.Contains(output.String(), "piik-client") {
			t.Fatalf("App diagnostics reached stderr: %s", output.String())
		}
		content, readErr := os.ReadFile(filepath.Join(directory, "client.log"))
		if !enabled {
			if !errors.Is(readErr, os.ErrNotExist) {
				t.Fatalf("disabled diagnostics created a log: %v", readErr)
			}
			continue
		}
		if readErr != nil || !strings.Contains(string(content), `"event":"start"`) ||
			!strings.Contains(string(content), `"version":"`+buildVersion()+`"`) ||
			!strings.Contains(string(content), `"revision":`) ||
			!strings.Contains(string(content), `"event":"stopped","failed":true`) {
			t.Fatalf("missing file lifecycle events: %s, %v", content, readErr)
		}
	}
}

func TestAppDiagnosticDirectoryHonorsExplicitSelection(t *testing.T) {
	environmentDirectory := t.TempDir()
	t.Setenv("PIIK_LOG_DIR", environmentDirectory)
	for _, directory := range []string{"", t.TempDir()} {
		recorder, err := openDiagnostics(directory)
		if err != nil {
			t.Fatal(err)
		}
		want := directory
		if want == "" {
			want = environmentDirectory
		}
		if recorder.LogPath() != filepath.Join(want, "client.log") {
			t.Fatalf("diagnostic path = %q", recorder.LogPath())
		}
		if err = recorder.Close(); err != nil {
			t.Fatal(err)
		}
	}
	blocked := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blocked, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if recorder, err := openDiagnostics(blocked); err == nil {
		_ = recorder.Close()
		t.Fatal("an explicit directory failure silently fell back")
	}
}

func TestMissingCaptureKeepsViewerControlAvailable(t *testing.T) {
	native := discoverNativeMedia(t.Context(), "missing-capture-process")
	if native.capabilities.Video || native.capabilities.HardwareH264 {
		t.Fatalf("missing native capture = %+v", native)
	}
	control := native.controlFactory()()
	if control == nil {
		t.Fatal("missing capture disabled the native Viewer control")
	}
	_ = control.Close()
}

func TestLaunchURLPreservesLocalAccessInsideThePrivateFragment(t *testing.T) {
	value := launchURL("http://localhost:8787/#client-access=secret")
	parsed, err := url.Parse(value)
	if err != nil || parsed.RawQuery != "" {
		t.Fatalf("local native launch URL = %q, %v", value, err)
	}
	fragment, err := url.ParseQuery(parsed.Fragment)
	if err != nil || fragment.Get("client-access") != "secret" ||
		fragment.Get("piik-client") != "1" {
		t.Fatalf("local native launch fragment = %q, %v", parsed.Fragment, err)
	}
}

func TestLaunchURLEncodesAndClearsOptionalLocalAccess(t *testing.T) {
	value := launchURLWithLocalAccess(
		"http://localhost:8787/#retained=yes&client-access=old",
		" 中文 a+b&c?d=e ",
	)
	parsed, err := url.Parse(value)
	if err != nil {
		t.Fatal(err)
	}
	fragment, err := url.ParseQuery(parsed.Fragment)
	if err != nil || fragment.Get("client-access") != " 中文 a+b&c?d=e " ||
		fragment.Get("piik-client") != "1" || fragment.Get("retained") != "yes" {
		t.Fatalf("encoded local launch fragment = %q, %v", parsed.Fragment, err)
	}

	open := launchURLWithLocalAccess("http://localhost:8787/#client-access=old", "")
	parsed, err = url.Parse(open)
	if err != nil {
		t.Fatal(err)
	}
	fragment, err = url.ParseQuery(parsed.Fragment)
	if err != nil || fragment.Get("client-access") != "" || fragment.Get("piik-client") != "1" {
		t.Fatalf("open local launch fragment = %q, %v", parsed.Fragment, err)
	}
}

func TestLinkModeKeepsOneLocalAuthority(t *testing.T) {
	config := appconfig.Config{
		Version:             1,
		LocalAccessPassword: "abcdefghijklmnopqrstuvwxyzABCDEF",
		Site:                "https://example.test",
	}
	selected, err := applyMode(config, Options{Link: true})
	if err != nil || selected.Site != config.Site {
		t.Fatalf("link mode = %+v, %v", selected, err)
	}
	if err = validateMode(Options{Link: true, SiteSet: true}); err == nil {
		t.Fatal("link mode accepted a separate Site")
	}
	if err = validateMode(Options{Link: true, Local: true}); err == nil {
		t.Fatal("link mode accepted a second Local selector")
	}
}

// The Local room authority owns its ICE configuration: a STUN_URLS meant for
// the App's own Pion edge must not reach it, and only --link is public.
func TestLocalServerOwnsItsSTUNConfiguration(t *testing.T) {
	t.Setenv("STUN_URLS", "stun:inherited.example:3478")
	for _, testCase := range []struct {
		name                  string
		link                  bool
		stunURLs              []string
		natPredictionSTUNURLs []string
	}{
		{name: "local"},
		{
			name: "link", link: true,
			stunURLs: []string{publicSTUNURL},
			natPredictionSTUNURLs: []string{
				publicNATPredictionSTUNURLA, publicNATPredictionSTUNURLB,
			},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			stunURLs, natPredictionSTUNURLs := localSTUNURLs(testCase.link)
			if !slices.Equal(stunURLs, testCase.stunURLs) ||
				!slices.Equal(natPredictionSTUNURLs, testCase.natPredictionSTUNURLs) {
				t.Fatalf("Local STUN selection = %v, %v", stunURLs, natPredictionSTUNURLs)
			}
			config, err := serverconfig.Local(serverconfig.LocalOptions{
				Port:                  8787,
				PublicAddress:         "192.168.1.2",
				AllowedAddresses:      []string{"192.168.1.2"},
				SiteAccessPassword:    "abcdefghijklmnopqrstuvwxyzABCDEF",
				STUNURLs:              stunURLs,
				NATPredictionSTUNURLs: natPredictionSTUNURLs,
			})
			if err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(config.STUNURLs, testCase.stunURLs) ||
				config.NATPredictionEnabled != testCase.link {
				t.Fatalf("Local server config = %v, NAT prediction %t",
					config.STUNURLs, config.NATPredictionEnabled)
			}
		})
	}
}
