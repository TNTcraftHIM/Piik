package androidbridge

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
	"time"

	appconfig "github.com/TNTcraftHIM/Piik/internal/app/config"
	"github.com/TNTcraftHIM/Piik/internal/app/launcher"
	"github.com/TNTcraftHIM/Piik/internal/app/loopback"
)

// Run the real supervised process path without contacting Cloudflare.
func TestMain(tests *testing.M) {
	if mode := os.Getenv("PIIK_ANDROID_TUNNEL_FIXTURE"); mode != "" {
		index := slices.Index(os.Args, "--config")
		if index < 0 || index+1 >= len(os.Args) {
			os.Exit(9)
		}
		if record := os.Getenv("PIIK_ANDROID_TUNNEL_STARTED"); record != "" {
			if err := os.WriteFile(record, []byte(os.Args[index+1]), 0600); err != nil {
				os.Exit(9)
			}
		}
		if mode != "pending" {
			fmt.Println(`{"message":"https://android-fixture.trycloudflare.com"}`)
			fmt.Println(`{"message":"Registered tunnel connection"}`)
		}
		for {
			if trigger := os.Getenv("PIIK_ANDROID_TUNNEL_EXIT"); trigger != "" {
				if _, err := os.Stat(trigger); err == nil {
					os.Exit(7)
				}
			}
			time.Sleep(time.Millisecond)
		}
	}
	os.Exit(tests.Run())
}

type runtimePlatform struct {
	testPlatform
	terminated chan string
}

func (platform *runtimePlatform) RuntimeStopped(reason string) { platform.terminated <- reason }

func tunnelRuntime(t *testing.T) (*Runtime, *runtimePlatform) {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	control, err := loopback.Start(ctx, loopback.Options{})
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	configPath := filepath.Join(directory, "client.json")
	configuration, err := appconfig.LoadOrCreate(configPath)
	if err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	platform := &runtimePlatform{terminated: make(chan string, 1)}
	r := &Runtime{ctx: ctx, cancel: cancel, control: control, config: configuration, configPath: configPath,
		capture:          &capture{platform: platform, streams: make(map[int64]*captureStream)},
		tunnelExecutable: executable, temporaryDirectory: directory}
	t.Cleanup(func() { _ = r.Close() })
	return r, platform
}

func TestPublicLinkSharesServerAndRetiresOnDependencyExit(t *testing.T) {
	t.Setenv("PIIK_ANDROID_TUNNEL_FIXTURE", "ready")
	trigger := filepath.Join(t.TempDir(), "exit")
	t.Setenv("PIIK_ANDROID_TUNNEL_EXIT", trigger)
	r, platform := tunnelRuntime(t)
	target, err := r.startLocal(launcher.Selection{Mode: launcher.ModeLink}, "")
	if err != nil {
		t.Fatal(err)
	}
	if r.tunnel == nil || r.tunnel.Origin() != "https://android-fixture.trycloudflare.com" || !r.TrustedURL(target) {
		t.Fatal("public invitation did not retain the shared local Host")
	}
	endpoint, _ := url.Parse(target)
	endpoint.Fragment, endpoint.Path = "", "/healthz"
	client := &http.Client{Timeout: time.Second}
	response, err := client.Get(endpoint.String())
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("shared server not ready: %d", response.StatusCode)
	}
	if err := os.WriteFile(trigger, nil, 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case reason := <-platform.terminated:
		if reason != "public-link-stopped" {
			t.Fatalf("wrong terminal cause: %q", reason)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("dependency exit did not finish runtime retirement")
	}
	var dependency *exec.ExitError
	if !errors.As(r.Close(), &dependency) || dependency.ExitCode() != 7 {
		t.Fatal("dependency failure was swallowed by Close")
	}
	if response, err := client.Get(endpoint.String()); err == nil {
		response.Body.Close()
		t.Fatal("terminal runtime retained its room server")
	}
	configs, err := filepath.Glob(filepath.Join(r.temporaryDirectory, "piik-cloudflared-*.yml"))
	if err != nil || len(configs) != 0 {
		t.Fatalf("dependency retained temporary config: %v, %v", configs, err)
	}
}

func TestCloseJoinsUnreadyPublicLinkStartup(t *testing.T) {
	t.Setenv("PIIK_ANDROID_TUNNEL_FIXTURE", "pending")
	started := filepath.Join(t.TempDir(), "started")
	t.Setenv("PIIK_ANDROID_TUNNEL_STARTED", started)
	r, platform := tunnelRuntime(t)
	r.launchDone = make(chan struct{})
	result := make(chan error, 1)
	go func() {
		_, err := r.startLocal(launcher.Selection{Mode: launcher.ModeLink}, "")
		result <- err
		close(r.launchDone)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(started); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("fixture child did not start")
		}
		time.Sleep(time.Millisecond)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("startup cancellation lost: %v", err)
	}
	configPath, err := os.ReadFile(started)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(string(configPath)); !os.IsNotExist(err) {
		t.Fatalf("Close returned before child/config retirement: %v", err)
	}
	select {
	case <-platform.terminated:
		t.Fatal("explicit close reported an unexpected dependency exit")
	default:
	}
}
