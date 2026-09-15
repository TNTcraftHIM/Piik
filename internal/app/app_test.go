package app

import (
	"bytes"
	"context"
	"encoding/json"
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
	"sync"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	appconfig "github.com/TNTcraftHIM/Piik/internal/app/config"
	"github.com/TNTcraftHIM/Piik/internal/app/lan"
	"github.com/TNTcraftHIM/Piik/internal/app/launcher"
	"github.com/TNTcraftHIM/Piik/internal/app/loopback"
	serverconfig "github.com/TNTcraftHIM/Piik/internal/server/config"
)

func TestMain(tests *testing.M) {
	if mode := os.Getenv("PIIK_APP_TUNNEL_FIXTURE"); mode != "" {
		if err := os.WriteFile(os.Getenv("PIIK_APP_TUNNEL_STARTED"), nil, 0600); err != nil {
			os.Exit(1)
		}
		if mode == "failed" {
			os.Exit(7)
		}
		if mode == "ready" || mode == "ready-failed" {
			fmt.Println(`{"message":"https://test-room.trycloudflare.com"}`)
			fmt.Println(`{"message":"Registered tunnel connection"}`)
		}
		if mode == "ready-failed" {
			for {
				if _, err := os.Stat(os.Getenv("PIIK_APP_TUNNEL_EXIT")); err == nil {
					os.Exit(7)
				}
				time.Sleep(time.Millisecond)
			}
		}
		time.Sleep(10 * time.Second)
		os.Exit(0)
	}
	os.Exit(tests.Run())
}

func TestPublicLinkStartupDistinguishesCancellationFromFailure(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIIK_DEBUG", "")
	for _, mode := range []string{"starting", "ready", "failed", "ready-failed"} {
		t.Run(mode, func(t *testing.T) {
			directory := t.TempDir()
			marker := filepath.Join(directory, "tunnel-started")
			exit := filepath.Join(directory, "tunnel-exit")
			t.Setenv("PIIK_APP_TUNNEL_FIXTURE", mode)
			t.Setenv("PIIK_APP_TUNNEL_STARTED", marker)
			t.Setenv("PIIK_APP_TUNNEL_EXIT", exit)
			listener, err := net.Listen("tcp4", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			port := listener.Addr().(*net.TCPAddr).Port
			if err = listener.Close(); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			ready := false
			done := make(chan error, 1)
			joined := false
			defer func() {
				cancel()
				if !joined {
					select {
					case <-done:
					case <-time.After(5 * time.Second):
						t.Error("App tunnel fixture did not retire")
					}
				}
			}()
			go func() {
				done <- Run(ctx, Options{
					Link: true, DisableBrowser: true, Debug: true, LogDir: filepath.Join(directory, "logs"),
					ConfigPath: filepath.Join(directory, "client.json"), Port: port,
					CaptureProcess: filepath.Join(directory, "missing-capture"), TunnelProcess: executable,
					Ready: func(string) {
						ready = true
						if mode == "ready-failed" {
							if err := os.WriteFile(exit, nil, 0600); err != nil {
								t.Error(err)
								cancel()
							}
						} else {
							cancel()
						}
					},
				})
			}()
			if mode == "starting" {
				deadline := time.Now().Add(3 * time.Second)
				for {
					if _, err = os.Stat(marker); err == nil {
						break
					}
					if time.Now().After(deadline) {
						t.Fatal("public link startup did not reach its tunnel")
					}
					time.Sleep(10 * time.Millisecond)
				}
				cancel()
			}
			select {
			case err = <-done:
				joined = true
				if mode == "failed" {
					if err == nil || !strings.Contains(err.Error(), "service exited before connecting") {
						t.Fatalf("startup failure was lost: %v", err)
					}
				} else if mode == "ready-failed" {
					if err == nil || !strings.Contains(err.Error(), "public invitation link stopped") ||
						strings.Count(err.Error(), "exit status 7") != 1 {
						t.Fatalf("ready tunnel failure must be retained once: %v", err)
					}
				} else if err != nil {
					t.Fatalf("intentional %s stop became an App failure: %v", mode, err)
				}
				if ready != (mode == "ready" || mode == "ready-failed") {
					t.Fatalf("startup readiness = %v for %s", ready, mode)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("App did not retire its local authority and tunnel")
			}
			content, err := os.ReadFile(filepath.Join(directory, "logs", "client.log"))
			if err != nil || !strings.Contains(string(content), fmt.Sprintf(`"event":"stopped","failed":%v`, mode == "failed" || mode == "ready-failed")) {
				t.Fatalf("diagnostics misclassified the App outcome: %s, %v", content, err)
			}
		})
	}
}

type launcherRuntimeLog struct {
	started chan struct{}
	release <-chan struct{}
}

func (writer launcherRuntimeLog) Write(data []byte) (int, error) {
	if bytes.Contains(data, []byte(`"event":"mode"`)) {
		close(writer.started)
		<-writer.release
	}
	return len(data), nil
}

func TestLauncherRetainsItsRuntimeFailureDuringCancellation(t *testing.T) {
	for _, cancelBeforeFailure := range []bool{true, false} {
		t.Run(fmt.Sprintf("cancel=%v", cancelBeforeFailure), func(t *testing.T) {
			listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4zero})
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			control, err := loopback.Start(ctx, loopback.Options{})
			if err != nil {
				t.Fatal(err)
			}
			defer control.Close()
			configPath := filepath.Join(t.TempDir(), "client.json")
			config, err := appconfig.LoadOrCreate(configPath)
			if err != nil {
				t.Fatal(err)
			}
			started, release := make(chan struct{}), make(chan struct{})
			resume := sync.OnceFunc(func() { close(release) })
			previous := slog.Default()
			slog.SetDefault(slog.New(slog.NewJSONHandler(launcherRuntimeLog{started, release},
				&slog.HandlerOptions{Level: slog.LevelDebug})))
			defer slog.SetDefault(previous)
			defer resume()
			opened := make(chan string, 1)
			console := newConsole(cancel, true)
			console.openURL = func(target string) error { opened <- target; return nil }
			done := make(chan error, 1)
			joined := false
			go func() {
				done <- runLauncher(ctx, Options{Port: listener.Addr().(*net.TCPAddr).Port, console: console},
					configPath, config, control, func(*Options, appconfig.Config) error { return nil })
			}()
			defer func() {
				cancel()
				resume()
				if !joined {
					select {
					case <-done:
					case <-time.After(3 * time.Second):
						t.Error("launcher runtime did not retire")
					}
				}
			}()
			var target string
			select {
			case target = <-opened:
			case <-time.After(2 * time.Second):
				t.Fatal("launcher did not open")
			}
			requestDone := make(chan struct{})
			go func() {
				defer close(requestDone)
				client := &http.Client{Timeout: 3 * time.Second}
				response, err := client.Post(strings.TrimSuffix(target, "/client")+"/api/client-launcher/launch",
					"application/json", strings.NewReader(`{"mode":"link","language":"en"}`))
				if err != nil {
					if !cancelBeforeFailure {
						t.Error(err)
					}
					return
				}
				defer response.Body.Close()
				if !cancelBeforeFailure && response.StatusCode != http.StatusServiceUnavailable {
					t.Errorf("launcher did not report the runtime failure: %d", response.StatusCode)
				}
			}()
			select {
			case <-started:
			case <-time.After(2 * time.Second):
				t.Fatal("launcher selection did not start its runtime")
			}
			if cancelBeforeFailure {
				cancel()
				select {
				case <-requestDone:
				case <-time.After(2 * time.Second):
					t.Fatal("launcher did not retire its pending selection")
				}
				// Hold the real port failure while the launcher handles cancellation.
				select {
				case err := <-done:
					joined = true
					t.Fatalf("launcher returned before its runtime: %v", err)
				case <-time.After(25 * time.Millisecond):
				}
			}
			resume()
			select {
			case err := <-done:
				joined = true
				var bindError *net.OpError
				if !errors.As(err, &bindError) || bindError.Op != "listen" ||
					strings.Count(err.Error(), "local server port is unavailable") != 1 {
					t.Fatalf("launcher must retain its runtime failure once: %v", err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("launcher did not join its failed runtime")
			}
			select {
			case <-requestDone:
			case <-time.After(2 * time.Second):
				t.Fatal("launcher selection did not finish")
			}
		})
	}
}

func TestHungBrowserHandoffDoesNotBlockLauncherOrSiteExit(t *testing.T) {
	t.Setenv("TERM", "dumb")
	for _, mode := range []string{"launcher", "site"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			control, err := loopback.Start(ctx, loopback.Options{})
			if err != nil {
				t.Fatal(err)
			}
			defer control.Close()
			console := newConsole(cancel, false)
			started, release := make(chan struct{}, 10), make(chan struct{})
			defer close(release)
			console.openURL = func(string) error { started <- struct{}{}; <-release; return errors.New("late browser result") }
			options := Options{Port: 8787, console: console}
			configPath := filepath.Join(t.TempDir(), "client.json")
			config, err := appconfig.LoadOrCreate(configPath)
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() {
				if mode == "site" {
					done <- runSite("https://share.example", options, control)
				} else {
					done <- runLauncher(ctx, options, configPath, config, control, func(*Options, appconfig.Config) error { return nil })
				}
			}()
			select {
			case <-started:
			case <-time.After(time.Second):
				t.Fatal("browser handoff was not started")
			}
			console.mu.Lock()
			model := console.plain
			console.mu.Unlock()
			if model.view.entry == "" {
				t.Fatal("manual entry was not available while browser opening hung")
			}
			for range 5 {
				_, command := model.Update(tea.KeyPressMsg{Code: 'o'})
				if command != nil {
					command()
				}
			}
			select {
			case <-started:
				t.Fatal("repeated open queued another hung handler")
			case <-time.After(50 * time.Millisecond):
			}
			model.Update(tea.KeyPressMsg{Code: 'q'})
			select {
			case err := <-done:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(time.Second):
				t.Fatal("App exit waited for the browser handler")
			}
			console.finish(nil, "")
		})
	}
}

func TestBrowserOpenFailureKeepsTheAppAvailable(t *testing.T) {
	// An empty launcher search path makes the real browser.Open fail on every
	// supported platform without changing the user's default browser or opening it.
	t.Setenv("PATH", t.TempDir())
	t.Setenv("TERM", "dumb")
	for _, mode := range []string{"launcher", "site"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			control, err := loopback.Start(ctx, loopback.Options{})
			if err != nil {
				t.Fatal(err)
			}
			defer control.Close()
			console := newConsole(cancel, false)
			options := Options{Port: 8787, console: console}
			configPath := filepath.Join(t.TempDir(), "client.json")
			config, err := appconfig.LoadOrCreate(configPath)
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() {
				if mode == "site" {
					done <- runSite("https://share.example", options, control)
				} else {
					done <- runLauncher(ctx, options, configPath, config, control,
						func(*Options, appconfig.Config) error { return nil })
				}
			}()
			t.Cleanup(func() {
				cancel()
				select {
				case err := <-done:
					if err != nil {
						t.Errorf("App exit: %v", err)
					}
				case <-time.After(5 * time.Second):
					t.Error("App did not stop after cancellation")
				}
			})
			var view consoleView
			deadline := time.After(3 * time.Second)
			for view.browserError == nil {
				console.mu.Lock()
				view = console.plain.view
				console.mu.Unlock()
				select {
				case <-deadline:
					t.Fatal("browser failure was not reported")
				case <-time.After(10 * time.Millisecond):
				}
			}
			if view.entry == "" || view.state != "setup" && view.state != "ready" {
				t.Fatalf("unusable App after browser failure: %+v", view)
			}
			if mode == "launcher" {
				client := &http.Client{Timeout: 3 * time.Second}
				origin := strings.TrimSuffix(view.entry, "/client")
				response, err := client.Post(origin+"/api/client-launcher/launch", "application/json",
					strings.NewReader(`{"mode":"site","language":"en","site":"https://share.example"}`))
				if err != nil {
					t.Fatal(err)
				}
				defer response.Body.Close()
				var result struct{ Target string }
				if json.NewDecoder(response.Body).Decode(&result) != nil || response.StatusCode != http.StatusOK ||
					result.Target != launchURL("https://share.example") {
					t.Fatalf("manual launch failed: status=%d, target=%q", response.StatusCode, result.Target)
				}
				if saved, err := launcher.LoadMode(configPath); err != nil || saved != launcher.ModeSite {
					t.Fatalf("manual selection was not saved: %q, %v", saved, err)
				}
			}
		})
	}
}

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

func TestLocalLaunchRevalidatesTheChosenLANAddress(t *testing.T) {
	addresses, err := lan.Addresses()
	if err != nil {
		t.Skipf("test requires an active LAN address: %v", err)
	}
	const inactive = "192.0.2.254"
	if slices.Contains(addresses, inactive) {
		t.Skip("documentation address is configured on this test machine")
	}
	err = runLocal(t.Context(), Options{
		Local: true, LANAddress: inactive, console: &console{machine: true},
	}, appconfig.Config{}, nil)
	if err == nil || !strings.Contains(err.Error(), "selected LAN address is not active") {
		t.Fatalf("Local launch accepted an unavailable invitation address: %v", err)
	}
}

func TestAppLaunchURLMarksThePageWithoutChangingOrigin(t *testing.T) {
	value := launchURL("https://share.example/")
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host != "share.example" ||
		parsed.RawQuery != "" {
		t.Fatalf("launch URL = %q, %v", value, err)
	}
	fragment, err := url.ParseQuery(parsed.EscapedFragment())
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
		reports, err := filepath.Glob(filepath.Join(directory, "*.zip"))
		if err != nil || len(reports) != 1 {
			t.Fatalf("failed App did not export its diagnostic report: %v, %v", reports, err)
		}
	}
}

func TestAppConfigurationFailurePreservesSystemCause(t *testing.T) {
	t.Setenv("PIIK_DEBUG", "")
	blocked := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blocked, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	err := Run(t.Context(), Options{DisableBrowser: true, ConfigPath: filepath.Join(blocked, "client.json")})
	var cause *os.PathError
	if !errors.As(err, &cause) || !strings.Contains(err.Error(), "Piik App configuration is unavailable") {
		t.Fatalf("configuration failure lost its path/system cause: %v", err)
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

func TestFailedCaptureProbeRetainsItsCause(t *testing.T) {
	path := t.TempDir() // A directory exists but cannot run as a capture sidecar.
	native := discoverNativeMedia(t.Context(), path)
	if native.discoveryErr == nil || native.captureProcess != path || native.capabilities.Video {
		t.Fatalf("failed probe lost its diagnostic context: %+v", native)
	}
}

func TestLaunchURLPreservesLocalAccessInsideThePrivateFragment(t *testing.T) {
	value := launchURL("http://localhost:8787/#client-access=secret")
	parsed, err := url.Parse(value)
	if err != nil || parsed.RawQuery != "" {
		t.Fatalf("local native launch URL = %q, %v", value, err)
	}
	fragment, err := url.ParseQuery(parsed.EscapedFragment())
	if err != nil || fragment.Get("client-access") != "secret" ||
		fragment.Get("piik-client") != "1" {
		t.Fatalf("local native launch fragment = %q, %v", parsed.Fragment, err)
	}
}

func TestLaunchURLEncodesAndClearsOptionalLocalAccess(t *testing.T) {
	for _, password := range []string{"x", "好", " ", "+", "%", "#&?=", " 中文 a+b&c?d=e% "} {
		t.Run(password, func(t *testing.T) {
			value := launchURLWithLocalAccess(
				"http://localhost:8787/?retained=query#retained=a%2Bb%25&client-access=old&piik-lang=zh&piik-mode=text&piik-theme=dark",
				password,
			)
			for _, target := range []string{value, launchURL(value)} {
				parsed, err := url.Parse(target)
				if err != nil || parsed.RawQuery != "retained=query" {
					t.Fatalf("local launch URL = %q, %v", target, err)
				}
				// location.hash stays escaped. Parsing Fragment instead would decode
				// twice and hide the browser's percent-encoded-password regression.
				fragment, err := url.ParseQuery(parsed.EscapedFragment())
				if err != nil || fragment.Get("client-access") != password ||
					fragment.Get("piik-client") != "1" || fragment.Get("retained") != "a+b%" ||
					fragment.Get("piik-lang") != "zh" || fragment.Get("piik-mode") != "text" ||
					fragment.Get("piik-theme") != "dark" {
					t.Fatalf("browser-visible launch fragment = %q, %v", parsed.EscapedFragment(), err)
				}
			}
		})
	}

	open := launchURLWithLocalAccess("http://localhost:8787/#client-access=old", "")
	parsed, err := url.Parse(open)
	if err != nil {
		t.Fatal(err)
	}
	fragment, err := url.ParseQuery(parsed.EscapedFragment())
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
	for _, options := range []Options{{Link: true}, {Local: true}} {
		selected, err := applyMode(config, options)
		if err != nil || selected != config {
			t.Fatalf("mode selection changed saved settings: %+v, %v", selected, err)
		}
	}
	if err := validateMode(Options{Link: true, SiteSet: true}); err == nil {
		t.Fatal("link mode accepted a separate Site")
	}
	if err := validateMode(Options{Link: true, Local: true}); err == nil {
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
