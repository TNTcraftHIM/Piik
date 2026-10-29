package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	appconfig "github.com/P4-aaaul/Silip/internal/app/config"
	"github.com/P4-aaaul/Silip/internal/app/failure"
	"github.com/P4-aaaul/Silip/internal/app/launcher"
	"github.com/P4-aaaul/Silip/internal/app/loopback"
	serverapp "github.com/P4-aaaul/Silip/internal/server/app"
	serverconfig "github.com/P4-aaaul/Silip/internal/server/config"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

type retiringRoomControl struct {
	started chan struct{}
	release chan struct{}
}

func (*retiringRoomControl) Handle(context.Context, []byte) (any, error) { return nil, nil }
func (*retiringRoomControl) Events() <-chan any                          { return nil }
func (control *retiringRoomControl) Close() error {
	close(control.started)
	<-control.release
	return nil
}

func TestCloseJoinsLocalControlRetirementWithoutFalseError(t *testing.T) {
	t.Setenv("SILIP_ANDROID_TUNNEL_FIXTURE", "ready")
	r, _ := tunnelRuntime(t)
	if err := r.control.Close(); err != nil {
		t.Fatal(err)
	}
	control := &retiringRoomControl{started: make(chan struct{}), release: make(chan struct{})}
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(control.release) }) })
	var err error
	r.control, err = loopback.Start(r.ctx, loopback.Options{NewControl: func() loopback.ControlSession { return control }})
	if err != nil {
		t.Fatal(err)
	}
	r.launcher, err = launcher.Start(r.ctx, fstest.MapFS{"index.html": {Data: []byte("launcher")}}, launcher.Options{})
	if err != nil {
		t.Fatal(err)
	}
	r.launchDone = make(chan struct{})
	go func() { defer close(r.launchDone); r.runLauncher("") }()
	launcherOrigin := strings.TrimSuffix(r.launcher.URL(), "/client")
	request, _ := http.NewRequest("POST", launcherOrigin+"/api/client-launcher/launch", strings.NewReader(`{"mode":"link","language":"en"}`))
	request.Header.Set("Origin", launcherOrigin)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("launch = %d", response.StatusCode)
	}
	r.configMu.Lock()
	origin := r.localOrigin()
	r.configMu.Unlock()
	endpoint := r.control.Endpoint()
	connection, _, err := websocket.Dial(t.Context(), strings.Replace(endpoint.URL, "http://", "ws://", 1)+"/control", &websocket.DialOptions{
		HTTPHeader:   http.Header{"Origin": []string{origin}},
		Subprotocols: []string{loopback.ControlSubprotocol + "." + endpoint.InstanceToken},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.CloseNow()
	if err = wsjson.Write(t.Context(), connection, map[string]any{"version": loopback.ProtocolVersion, "id": "close_hello", "type": "hello"}); err != nil {
		t.Fatal(err)
	}
	var ready map[string]any
	if err = wsjson.Read(t.Context(), connection, &ready); err != nil {
		t.Fatal(err)
	}
	if ready["type"] != "ready" {
		t.Fatalf("control handshake = %v", ready)
	}
	closed := make(chan error, 1)
	go func() { closed <- r.Close() }()
	select {
	case <-control.started:
	case <-time.After(5 * time.Second):
		t.Fatal("local control did not enter retirement")
	}
	select {
	case err := <-closed:
		t.Fatalf("Close returned before local control cleanup: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	release.Do(func() { close(control.release) })
	select {
	case err := <-closed:
		if err != nil {
			t.Fatalf("completed local control cleanup reported failure: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Close did not join completed control cleanup")
	}
}

// Run the real supervised process path without contacting Cloudflare.
func TestMain(tests *testing.M) {
	if mode := os.Getenv("SILIP_ANDROID_TUNNEL_FIXTURE"); mode != "" {
		index := slices.Index(os.Args, "--config")
		if index < 0 || index+1 >= len(os.Args) {
			os.Exit(9)
		}
		if record := os.Getenv("SILIP_ANDROID_TUNNEL_STARTED"); record != "" {
			if err := os.WriteFile(record, []byte(os.Args[index+1]), 0600); err != nil {
				os.Exit(9)
			}
		}
		if mode == "held" {
			for {
				if _, err := os.Stat(os.Getenv("SILIP_ANDROID_TUNNEL_RELEASE")); err == nil {
					break
				}
				time.Sleep(time.Millisecond)
			}
		}
		if mode != "pending" {
			fmt.Println(`{"message":"https://android-fixture.trycloudflare.com"}`)
			fmt.Println(`{"message":"Registered tunnel connection"}`)
		}
		for {
			if trigger := os.Getenv("SILIP_ANDROID_TUNNEL_EXIT"); trigger != "" {
				if _, err := os.Stat(trigger); err == nil {
					os.Exit(7)
				}
			}
			time.Sleep(time.Millisecond)
		}
	}
	os.Exit(tests.Run())
}

func TestStartupAndSiteRevocationCommitOneOriginAuthority(t *testing.T) {
	dir := t.TempDir()
	started, release := filepath.Join(dir, "started"), filepath.Join(dir, "release")
	t.Setenv("SILIP_ANDROID_TUNNEL_FIXTURE", "held")
	t.Setenv("SILIP_ANDROID_TUNNEL_STARTED", started)
	t.Setenv("SILIP_ANDROID_TUNNEL_RELEASE", release)
	if err := appconfig.Save(filepath.Join(dir, "client.json"), appconfig.Config{Version: 1, Sites: []string{"https://revoked.example"}}); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	platform := &testPlatform{}
	r, err := Start(platform, "", `{"platform":"android","provider":"fixture","encoders":[]}`, dir, t.TempDir(), executable, "")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	client := &http.Client{Timeout: 5 * time.Second}
	origin := strings.TrimSuffix(r.URL(), "/client")
	post := func(path, body string) int {
		t.Helper()
		request, _ := http.NewRequest(http.MethodPost, origin+"/api/client-launcher/"+path, strings.NewReader(body))
		request.Header.Set("Origin", origin)
		request.Header.Set("Content-Type", "application/json")
		response, err := client.Do(request)
		if err != nil {
			t.Error(err)
			return 0
		}
		response.Body.Close()
		return response.StatusCode
	}
	health := func(site string) int {
		t.Helper()
		request, _ := http.NewRequest(http.MethodGet, r.control.Endpoint().URL+"/health", nil)
		request.Header.Set("Origin", site)
		response, err := client.Do(request)
		if err != nil {
			t.Error(err)
			return 0
		}
		response.Body.Close()
		return response.StatusCode
	}
	launched := make(chan int, 1)
	go func() { launched <- post("launch", `{"mode":"link","language":"en"}`) }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(started); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("startup did not reach the pending helper")
		}
		time.Sleep(time.Millisecond)
	}
	notified, notificationReleased := make(chan struct{}), make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(notificationReleased) })
	platform.siteChanged = func() {
		if r.TrustedURL("https://revoked.example") || health("https://revoked.example") != http.StatusForbidden {
			t.Error("platform notification preceded the exact-origin revocation commit")
		}
		close(notified)
		<-notificationReleased
	}
	revoked := make(chan int, 1)
	go func() { revoked <- post("site", `{"site":"https://revoked.example","allowed":false}`) }()
	select {
	case <-notified:
	case <-time.After(5 * time.Second):
		t.Fatal("revocation notification blocked")
	}
	if err := os.WriteFile(release, nil, 0600); err != nil {
		t.Fatal(err)
	}
	var target string
	for {
		r.configMu.Lock()
		target = r.url
		r.configMu.Unlock()
		if target != "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("platform notification held the runtime authority lock")
		}
		time.Sleep(time.Millisecond)
	}
	local, _ := url.Parse(target)
	if !r.TrustedURL(target) || health(local.Scheme+"://"+local.Host) != http.StatusOK || health("https://revoked.example") != http.StatusForbidden {
		t.Fatal("startup lost its local origin or restored the revoked Site")
	}
	once.Do(func() { close(notificationReleased) })
	if status := <-revoked; status != http.StatusOK {
		t.Fatalf("revocation = %d", status)
	}
	if status := <-launched; status != http.StatusOK {
		t.Fatalf("startup = %d", status)
	}
}

type runtimePlatform struct {
	testPlatform
	terminated chan string
}

func (platform *runtimePlatform) RuntimeStopped(reason string) { platform.terminated <- reason }

func TestEssentialServicesRetireTheMobileRuntime(t *testing.T) {
	for _, component := range []string{"launcher", "control", "room-and-control", "owner-close"} {
		t.Run(component, func(t *testing.T) {
			platform := &runtimePlatform{terminated: make(chan string, 4)}
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			r, err := Start(platform, "", `{"platform":"android","provider":"Android MediaCodec","encoders":[]}`, t.TempDir(), t.TempDir(), executable, "silip://media")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = r.Close() })
			want := failure.Launcher
			switch component {
			case "launcher":
				err = r.launcher.Close()
			case "control":
				want = failure.NativeControl
				err = r.control.Close()
			case "room-and-control":
				t.Setenv("SILIP_ANDROID_TUNNEL_FIXTURE", "ready")
				trigger := filepath.Join(t.TempDir(), "exit")
				t.Setenv("SILIP_ANDROID_TUNNEL_EXIT", trigger)
				if _, err = r.startLocal(launcher.Selection{Mode: launcher.ModeLink}, ""); err != nil {
					t.Fatal(err)
				}
				if err = os.WriteFile(trigger, nil, 0600); err != nil {
					t.Fatal(err)
				}
				err = r.control.Close()
			case "owner-close":
				err = r.Close()
			}
			if err != nil {
				t.Fatal(err)
			}
			if component != "owner-close" {
				select {
				case reason := <-platform.terminated:
					if component == "room-and-control" {
						if reason != string(failure.NativeControl) {
							t.Fatalf("unexpected competing failure: %q", reason)
						}
					} else if reason != string(want) {
						t.Fatalf("wrong service failure: %q", reason)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("essential listener ended but mobile Runtime remained live")
				}
			}
			if r.ctx.Err() == nil {
				t.Fatal("service exit did not retire the Runtime")
			}
			if component == "room-and-control" {
				<-r.tunnel.Done()
			}
			r.watchServices()
			select {
			case reason := <-platform.terminated:
				t.Fatalf("normal close or repeated completion reported an extra failure: %q", reason)
			default:
			}
		})
	}
}

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

func TestLauncherRetriesFailedStartupAndKeepsSuccessfulRoom(t *testing.T) {
	t.Setenv("SILIP_ANDROID_TUNNEL_FIXTURE", "ready")
	r, _ := tunnelRuntime(t)
	if _, err := r.approveSite("https://site.example"); err != nil {
		t.Fatal(err)
	}
	var err error
	r.launcher, err = launcher.Start(r.ctx, fstest.MapFS{"index.html": {Data: []byte("launcher")}}, launcher.Options{})
	if err != nil {
		t.Fatal(err)
	}
	r.launchDone = make(chan struct{})
	go func() { defer close(r.launchDone); r.runLauncher("") }()
	endpoint := strings.TrimSuffix(r.launcher.URL(), "/client") + "/api/client-launcher/launch"
	client := &http.Client{Timeout: 5 * time.Second}
	post := func(body string) *http.Response {
		t.Helper()
		request, _ := http.NewRequest("POST", endpoint, strings.NewReader(body))
		request.Header.Set("Origin", strings.TrimSuffix(r.launcher.URL(), "/client"))
		request.Header.Set("Content-Type", "application/json")
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { response.Body.Close() })
		return response
	}
	// No invitation interface was selected, so Local fails after opening its
	// loopback listener. Public mode can then start without a LAN selection.
	if response := post(`{"mode":"local","language":"en"}`); response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("Local startup without an address = %d", response.StatusCode)
	}
	if r.server != nil || r.tunnel != nil || !r.TrustedURL("https://site.example") {
		t.Fatal("failed attempt retained a room or retired Site access")
	}
	if response := post(`{"mode":"link","language":"en"}`); response.StatusCode != http.StatusOK {
		t.Fatalf("public retry = %d", response.StatusCode)
	}
	if mode, err := launcher.LoadMode(r.configPath); err != nil || mode != launcher.ModeLink {
		t.Fatalf("Public selection was not saved: %q, %v", mode, err)
	}
	r.configMu.Lock()
	server, tunnel, target := r.server, r.tunnel, r.url
	r.configMu.Unlock()
	if server == nil || tunnel == nil || !r.TrustedURL("https://site.example") || !r.TrustedURL(target) {
		t.Fatal("retry did not retain room and Site authority")
	}
	response := post(`{"mode":"local","language":"en"}`)
	var reopened struct{ Target string }
	if response.StatusCode != http.StatusOK || json.NewDecoder(response.Body).Decode(&reopened) != nil || reopened.Target != target {
		t.Fatalf("active room reentry = %d, target unchanged = %v", response.StatusCode, reopened.Target == target)
	}
	r.configMu.Lock()
	if r.server != server || r.tunnel != tunnel {
		r.configMu.Unlock()
		t.Fatal("launcher reopening replaced a successful room")
	}
	r.configMu.Unlock()
	siteCapture := r.capture.stream(r.ctx, nil)
	if err := tunnel.Close(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		response, err := client.Get(strings.TrimSuffix(r.launcher.URL(), "/client") + "/api/client-launcher")
		if err != nil {
			t.Fatal(err)
		}
		var state struct {
			Target string
			Reason string
		}
		err = json.NewDecoder(response.Body).Decode(&state)
		response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if state.Target == "" && state.Reason != "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("room failure did not return launcher to retry")
		}
		time.Sleep(time.Millisecond)
	}
	if r.TrustedURL(target) || !r.TrustedURL("https://site.example") || r.capture.get(siteCapture.id) == nil {
		t.Fatal("room failure changed unrelated authority")
	}
	if response := post(`{"mode":"link","language":"en"}`); response.StatusCode != http.StatusOK {
		t.Fatalf("room retry = %d", response.StatusCode)
	}
	r.configMu.Lock()
	if r.server == nil || r.server == server || r.tunnel == tunnel || r.url == target {
		r.configMu.Unlock()
		t.Fatal("retry did not create a fresh room")
	}
	r.configMu.Unlock()
}

func TestPublicLinkSharesServerAndRetiresOnDependencyExit(t *testing.T) {
	t.Setenv("SILIP_ANDROID_TUNNEL_FIXTURE", "ready")
	trigger := filepath.Join(t.TempDir(), "exit")
	t.Setenv("SILIP_ANDROID_TUNNEL_EXIT", trigger)
	r, platform := tunnelRuntime(t)
	if _, err := r.approveSite("https://site.example"); err != nil {
		t.Fatal(err)
	}
	siteCapture := r.capture.stream(r.ctx, nil)
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
	result := make(chan error, 1)
	r.launchDone = make(chan struct{})
	go func() { defer close(r.launchDone); result <- r.watchRoom(r.server, r.tunnel) }()
	if err := os.WriteFile(trigger, nil, 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if !errors.Is(err, failure.TunnelStopped) {
			t.Fatalf("wrong room failure: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("dependency exit did not finish room retirement")
	}
	if r.ctx.Err() != nil || r.TrustedURL(target) || !r.TrustedURL("https://site.example") || r.capture.get(siteCapture.id) != siteCapture {
		t.Fatal("room failure changed unrelated Runtime/Site/capture authority")
	}
	request, _ := http.NewRequest("GET", r.control.Endpoint().URL+"/health", nil)
	request.Header.Set("Origin", "https://site.example")
	if response, err := client.Do(request); err != nil {
		t.Fatal(err)
	} else {
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatal("Site control is unavailable")
		}
	}
	select {
	case <-platform.terminated:
		t.Fatal("room failure ended Runtime")
	default:
	}
	if response, err := client.Get(endpoint.String()); err == nil {
		response.Body.Close()
		t.Fatal("terminal runtime retained its room server")
	}
	configs, err := filepath.Glob(filepath.Join(r.temporaryDirectory, "silip-cloudflared-*.yml"))
	if err != nil || len(configs) != 0 {
		t.Fatalf("dependency retained temporary config: %v, %v", configs, err)
	}
}

func TestRoomListenerFailureRetiresOnlyRoom(t *testing.T) {
	t.Setenv("SILIP_ANDROID_TUNNEL_FIXTURE", "ready")
	r, platform := tunnelRuntime(t)
	if _, err := r.approveSite("https://site.example"); err != nil {
		t.Fatal(err)
	}
	siteCapture := r.capture.stream(r.ctx, nil)
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	port := listener.Addr().(*net.TCPAddr).Port
	configuration, err := serverconfig.Local(serverconfig.LocalOptions{Port: port, PublicOrigin: "https://fixture.example"})
	if err != nil {
		t.Fatal(err)
	}
	server, err := serverapp.New(serverapp.Options{Config: configuration, Listeners: []net.Listener{listener}})
	if err != nil {
		t.Fatal(err)
	}
	r.server = server
	oldTarget := "http://127.0.0.1:" + strconv.Itoa(port) + "/"
	r.url = oldTarget
	if _, err := server.Listen(r.ctx); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	r.launchDone = make(chan struct{})
	go func() { defer close(r.launchDone); result <- r.watchRoom(server, nil) }()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if !errors.Is(err, failure.LocalServer) {
			t.Fatalf("wrong room failure: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("listener failure left the mobile runtime ready")
	}
	if r.ctx.Err() != nil || r.server != nil {
		t.Fatal("listener failure retained room or ended Runtime")
	}
	if r.TrustedURL(oldTarget) || !r.TrustedURL("https://site.example") || r.capture.get(siteCapture.id) == nil {
		t.Fatal("listener failure changed unrelated Site/capture authority")
	}
	request, _ := http.NewRequest("GET", r.control.Endpoint().URL+"/health", nil)
	request.Header.Set("Origin", "https://site.example")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatal("listener failure ended Site control")
	}
	if target, err := r.startLocal(launcher.Selection{Mode: launcher.ModeLink}, ""); err != nil || target == oldTarget {
		t.Fatalf("new selection did not recover after listener failure: %v", err)
	}
	select {
	case <-platform.terminated:
		t.Fatal("listener failure ended Runtime")
	default:
	}
}

func TestCloseJoinsUnreadyPublicLinkStartup(t *testing.T) {
	t.Setenv("SILIP_ANDROID_TUNNEL_FIXTURE", "pending")
	started := filepath.Join(t.TempDir(), "started")
	t.Setenv("SILIP_ANDROID_TUNNEL_STARTED", started)
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
