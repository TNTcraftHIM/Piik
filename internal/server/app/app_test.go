package app

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"
	_ "modernc.org/sqlite"

	"github.com/TNTcraftHIM/Piik/internal/server/config"
	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
	"github.com/TNTcraftHIM/Piik/internal/server/room"
)

// The scenarios below are ported from tests/server-http.test.ts.

const allowedOrigin = "http://allowed.test"

// setCookiePattern is the exact attribute order access-session.ts emits and
// app.ts writes verbatim.
var setCookiePattern = regexp.MustCompile(
	`^piik-site-access=v1\.[0-9]+\.[A-Za-z0-9_-]{43}; Path=/; Max-Age=86400; HttpOnly; SameSite=Strict$`)

var secureSetCookiePattern = regexp.MustCompile(
	`^__Host-piik-site-access=v1\.[0-9]+\.[A-Za-z0-9_-]{43}; Path=/; Max-Age=86400; HttpOnly; SameSite=Strict; Secure$`)

func testConfig(t *testing.T) config.Config {
	t.Helper()
	publicBaseURL, err := url.Parse("https://share.example.test")
	if err != nil {
		t.Fatalf("url.Parse: %v", err)
	}
	return config.Config{
		Env:                       config.EnvironmentDevelopment,
		Port:                      0,
		ListenHost:                "127.0.0.1",
		PublicBaseURL:             publicBaseURL,
		AllowedOrigins:            map[string]struct{}{allowedOrigin: {}},
		SiteAccessPassword:        testAccessPassword,
		MaxViewersPerRoom:         8,
		EndpointMediaCopyCapacity: 2,
		NATPredictionEnabled:      false,
	}
}

// newServer builds a server without listening. It mirrors the TS harness: the
// heartbeat interval is pushed out of the way and a fake room
// control is injected whenever a LiveKit fallback is configured.
func newServer(t *testing.T, options Options) *Server {
	t.Helper()
	if options.Config.PublicBaseURL == nil {
		options.Config = testConfig(t)
	}
	if options.HeartbeatIntervalMs == 0 {
		options.HeartbeatIntervalMs = 60_000
	}
	server, err := New(options)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = server.Close(context.Background()) })
	return server
}

type harness struct {
	*Server
	t       *testing.T
	baseURL string
	client  *http.Client
}

func start(t *testing.T, options Options) *harness {
	t.Helper()
	server := newServer(t, options)
	port, err := server.Listen(context.Background())
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	return &harness{Server: server, t: t, baseURL: baseURL(port), client: testClient(t)}
}

func baseURL(port int) string { return fmt.Sprintf("http://127.0.0.1:%d", port) }

// testClient never reuses a connection, so a closed server never leaves a
// pooled socket behind for the next test.
func testClient(t *testing.T) *http.Client {
	t.Helper()
	transport := &http.Transport{DisableKeepAlives: true}
	t.Cleanup(transport.CloseIdleConnections)
	return &http.Client{Transport: transport, Timeout: 30 * time.Second}
}

// freePort reserves and releases a port so a test can know the listen address
// before Listen returns. The window is a few microseconds on a test machine.
func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatalf("close probe listener: %v", err)
	}
	return port
}

type reply struct {
	t      *testing.T
	status int
	header http.Header
	body   string
}

type requestOption func(*http.Request)

func withOrigin(origin string) requestOption {
	return func(request *http.Request) { request.Header.Set("Origin", origin) }
}

func withCookie(cookie string) requestOption {
	return func(request *http.Request) {
		if cookie != "" {
			request.Header.Set("Cookie", cookie)
		}
	}
}

func withBearer(token string) requestOption {
	return func(request *http.Request) {
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
	}
}

func withBody(contentType, payload string) requestOption {
	return func(request *http.Request) {
		if contentType != "" {
			request.Header.Set("Content-Type", contentType)
		}
		request.Body = io.NopCloser(strings.NewReader(payload))
		request.ContentLength = int64(len(payload))
	}
}

func withJSON(payload string) requestOption {
	return withBody("application/json", payload)
}

func (h *harness) do(method, path string, options ...requestOption) reply {
	h.t.Helper()
	return send(h.t, h.client, method, h.baseURL+path, options...)
}

func send(
	t *testing.T,
	client *http.Client,
	method, target string,
	options ...requestOption,
) reply {
	t.Helper()
	request, err := http.NewRequest(method, target, nil)
	if err != nil {
		t.Fatalf("http.NewRequest: %v", err)
	}
	for _, option := range options {
		option(request)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("%s %s: %v", method, target, err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return reply{t: t, status: response.StatusCode, header: response.Header, body: string(body)}
}

func (r reply) expect(status int, body string) reply {
	r.t.Helper()
	if r.status != status {
		r.t.Fatalf("status = %d, want %d (body %s)", r.status, status, r.body)
	}
	if r.body != body {
		r.t.Fatalf("body = %s, want %s", r.body, body)
	}
	return r
}

func (r reply) expectStatus(status int) reply {
	r.t.Helper()
	if r.status != status {
		r.t.Fatalf("status = %d, want %d (body %s)", r.status, status, r.body)
	}
	return r
}

func (r reply) expectHeader(name, want string) reply {
	r.t.Helper()
	if got := r.header.Get(name); got != want {
		r.t.Fatalf("header %s = %q, want %q", name, got, want)
	}
	return r
}

func (r reply) room() protocol.CreateRoomResponse {
	r.t.Helper()
	var created protocol.CreateRoomResponse
	if err := json.Unmarshal([]byte(r.body), &created); err != nil {
		r.t.Fatalf("decode CreateRoomResponse from %s: %v", r.body, err)
	}
	return created
}

// login is the TS login(): a POST with the site password as a bearer token.
func (h *harness) login() reply {
	h.t.Helper()
	return h.do(http.MethodPost, "/api/site-access",
		withBearer(testAccessPassword), withOrigin(allowedOrigin))
}

func (h *harness) cookie() string {
	h.t.Helper()
	response := h.login().expectStatus(http.StatusOK)
	return cookiePair(h.t, response.header.Get("Set-Cookie"))
}

type roomRequest struct {
	cookie          string
	codeEntryPolicy string
	password        *string
	preferredRoomID string
}

func (h *harness) createRoom(request roomRequest) reply {
	h.t.Helper()
	policy := request.codeEntryPolicy
	if policy == "" {
		policy = "open"
	}
	fields := []string{fmt.Sprintf("%q:%q", "codeEntryPolicy", policy)}
	if request.password != nil {
		fields = append(fields, fmt.Sprintf("%q:%q", "roomPassword", *request.password))
	}
	if request.preferredRoomID != "" {
		fields = append(fields, fmt.Sprintf("%q:%q", "preferredRoomId", request.preferredRoomID))
	}
	return h.do(http.MethodPost, "/api/rooms",
		withOrigin(allowedOrigin), withCookie(request.cookie),
		withJSON("{"+strings.Join(fields, ",")+"}"))
}

type accessRequest struct {
	roomID    string
	hostToken string
	body      string
	cookie    string
	origin    string
	method    string
}

func (h *harness) updateRoomAccess(request accessRequest) reply {
	h.t.Helper()
	method := request.method
	if method == "" {
		method = http.MethodPost
	}
	origin := request.origin
	if origin == "" {
		origin = allowedOrigin
	}
	options := []requestOption{
		withOrigin(origin), withCookie(request.cookie), withBearer(request.hostToken),
	}
	if method == http.MethodPost {
		options = append(options, withJSON(request.body))
	}
	return h.do(method, "/api/rooms/"+request.roomID+"/access", options...)
}

func (h *harness) replaceRoom(roomID, hostToken, body, cookie string) reply {
	h.t.Helper()
	return h.do(http.MethodPost, "/api/rooms/"+roomID+"/replacement",
		withOrigin(allowedOrigin), withCookie(cookie), withBearer(hostToken),
		withJSON(body))
}

func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func assertPortFree(t *testing.T, port int) {
	t.Helper()
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatalf("port %d is still owned: %v", port, err)
	}
	_ = listener.Close()
}

// expectGoroutinesSettled is the close tests' stand-in for the race detector
// (unavailable without cgo): the listener's Serve loop, the signaling
// goroutines and the timers must all have exited once Close (or a failed
// Listen) returns, so the count returns to what it was before New.
func expectGoroutinesSettled(t *testing.T, before int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for runtime.NumGoroutine() > before {
		if time.Now().After(deadline) {
			stacks := make([]byte, 1<<20)
			t.Fatalf("goroutines: %d before, %d after close\n%s",
				before, runtime.NumGoroutine(), stacks[:runtime.Stack(stacks, true)])
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// --- runtime capabilities -------------------------------------------------

func TestCapabilitiesReportServicesDisabledByDefault(t *testing.T) {
	server := start(t, Options{Config: testConfig(t)})

	server.do(http.MethodGet, "/api/capabilities").
		expect(http.StatusOK, `{"connectionAttemptProgress4":true,"sfu":false,"natPrediction":false}`)
}

func TestCapabilitiesReportOptionalNATPredictionWithoutExposingConfiguration(t *testing.T) {
	configuration := testConfig(t)
	configuration.STUNURLs = []string{"stun:share.example.test:3478"}
	configuration.NATPredictionEnabled = true
	configuration.STUNListenAddresses = []string{"127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0"}
	server := start(t, Options{Config: configuration})

	server.do(http.MethodGet, "/api/capabilities").
		expect(http.StatusOK, `{"connectionAttemptProgress4":true,"sfu":false,"natPrediction":true}`).
		expectHeader("Cache-Control", "no-store").
		expectHeader("X-Content-Type-Options", "nosniff")

	server.do(http.MethodPost, "/api/capabilities").
		expect(http.StatusMethodNotAllowed, `{"error":"Method not allowed"}`).
		expectHeader("Allow", "GET")
}

func TestSTUNListenersFollowApplicationCloseAndEnd(t *testing.T) {
	for _, ending := range []bool{false, true} {
		t.Run(fmt.Sprintf("end=%t", ending), func(t *testing.T) {
			configuration := testConfig(t)
			configuration.STUNURLs = []string{"stun:share.example.test:3478"}
			configuration.NATPredictionEnabled = true
			configuration.STUNListenAddresses = []string{"127.0.0.1:0", "127.0.0.1:0", "127.0.0.1:0"}
			server := start(t, Options{Config: configuration})
			addresses := server.stunServer.Addresses
			var err error
			if ending {
				err = server.End(context.Background())
			} else {
				err = server.Close(context.Background())
			}
			if err != nil {
				t.Fatal(err)
			}
			assertUDPPortsFree(t, addresses)
		})
	}
}

func TestSFUListenerFollowsApplicationCloseAndEnd(t *testing.T) {
	for _, ending := range []bool{false, true} {
		t.Run(fmt.Sprintf("end=%t", ending), func(t *testing.T) {
			configuration := testConfig(t)
			configuration.SFU = &config.SFUConfig{ListenHost: "127.0.0.1", Port: 0}
			server := start(t, Options{Config: configuration})
			addresses := server.mediaMux.GetListenAddresses()
			if server.signaling.Load() == nil || server.media == nil {
				t.Fatal("missing runtime owner")
			}
			server.do(http.MethodGet, "/api/capabilities").
				expect(http.StatusOK, `{"connectionAttemptProgress4":true,"sfu":true,"natPrediction":false}`)
			var err error
			if ending {
				err = server.End(context.Background())
			} else {
				err = server.Close(context.Background())
			}
			if err != nil {
				t.Fatal(err)
			}
			assertUDPPortsFree(t, addresses)
		})
	}
}

func TestOccupiedSFUPortRollsBackBeforeOpeningTheDatabase(t *testing.T) {
	occupied, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	configuration := testConfig(t)
	configuration.Port = freePort(t)
	configuration.RoomDatabasePath = filepath.Join(t.TempDir(), "rooms.sqlite")
	configuration.STUNListenAddresses = []string{"127.0.0.1:0"}
	configuration.SFU = &config.SFUConfig{ListenHost: "127.0.0.1", Port: occupied.LocalAddr().(*net.UDPAddr).Port}
	server := newServer(t, Options{Config: configuration})
	if _, err = server.Listen(context.Background()); err == nil {
		t.Fatal("occupied media listener was accepted")
	}
	if _, err = os.Stat(configuration.RoomDatabasePath); !os.IsNotExist(err) {
		t.Fatalf("SFU bind failure touched room persistence: %v", err)
	}
	assertPortFree(t, configuration.Port)
	if server.stunServer != nil || server.mediaMux != nil {
		t.Fatal("failed startup retained a UDP listener")
	}
	if err = occupied.SetDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatalf("startup rollback closed another listener: %v", err)
	}
}

func TestOccupiedSTUNAuxiliaryRollsBackBeforeOpeningTheDatabase(t *testing.T) {
	first, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	firstAddress := first.LocalAddr()
	_ = first.Close()
	occupied, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	configuration := testConfig(t)
	configuration.Port = freePort(t)
	configuration.RoomDatabasePath = filepath.Join(t.TempDir(), "rooms.sqlite")
	configuration.STUNListenAddresses = []string{
		firstAddress.String(), occupied.LocalAddr().String(), "127.0.0.1:0",
	}
	server := newServer(t, Options{Config: configuration})
	if _, err = server.Listen(context.Background()); err == nil {
		t.Fatal("occupied auxiliary STUN listener was accepted")
	}
	if _, err = os.Stat(configuration.RoomDatabasePath); !os.IsNotExist(err) {
		t.Fatalf("STUN bind failure touched room persistence: %v", err)
	}
	assertPortFree(t, configuration.Port)
	assertUDPPortsFree(t, []net.Addr{firstAddress})
	if err = occupied.SetDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatalf("startup rollback closed another listener: %v", err)
	}
}

func assertUDPPortsFree(t *testing.T, addresses []net.Addr) {
	t.Helper()
	for _, address := range addresses {
		listener, err := net.ListenPacket("udp4", address.String())
		if err != nil {
			t.Fatalf("STUN listener remained owned: %v", err)
		}
		_ = listener.Close()
	}
}

// --- site access ----------------------------------------------------------

func TestSiteAccessReportsStatusAndIssuesStatelessDayLongCookie(t *testing.T) {
	server := start(t, Options{Config: testConfig(t)})

	server.do(http.MethodGet, "/api/site-access").
		expect(http.StatusOK, `{"required":true,"authenticated":false}`).
		expectHeader("Cache-Control", "no-store").
		expectHeader("Set-Cookie", "")

	server.do(http.MethodPost, "/api/site-access",
		withBearer("wrong-password"), withOrigin(allowedOrigin)).
		expect(http.StatusUnauthorized, `{"error":"Unauthorized"}`).
		expectHeader("Set-Cookie", "").
		expectHeader("WWW-Authenticate", "Bearer")

	authenticated := server.login().
		expect(http.StatusOK, `{"required":true,"authenticated":true}`)
	setCookie := authenticated.header.Get("Set-Cookie")
	if !setCookiePattern.MatchString(setCookie) {
		t.Fatalf("Set-Cookie = %q, want %v", setCookie, setCookiePattern)
	}
	if strings.Contains(setCookie, testAccessPassword) {
		t.Fatal("Set-Cookie leaked the site access password")
	}
	cookie := cookiePair(t, setCookie)

	server.do(http.MethodPost, "/api/site-access",
		withBearer("wrong-password"), withCookie(cookie), withOrigin(allowedOrigin)).
		expect(http.StatusUnauthorized, `{"error":"Unauthorized"}`).
		expectHeader("Set-Cookie", "")

	status := server.do(http.MethodGet, "/api/site-access", withCookie(cookie)).
		expect(http.StatusOK, `{"required":true,"authenticated":true}`)
	if !setCookiePattern.MatchString(status.header.Get("Set-Cookie")) {
		t.Fatalf("renewal Set-Cookie = %q", status.header.Get("Set-Cookie"))
	}
}

func TestSiteAccessRenewsAnAuthenticatedCookieAcrossIdleDeadlines(t *testing.T) {
	var now atomic.Int64
	now.Store(1_000)
	server := start(t, Options{
		Config:               testConfig(t),
		Now:                  now.Load,
		SiteAccessTTLSeconds: 12,
	})
	original := cookiePair(t, server.login().header.Get("Set-Cookie"))

	now.Store(7_000)
	firstRenewed := cookiePair(t, server.do(
		http.MethodGet, "/api/site-access", withCookie(original)).
		header.Get("Set-Cookie"))
	if firstRenewed == original {
		t.Fatal("renewal reissued the same cookie")
	}

	now.Store(13_000)
	server.do(http.MethodGet, "/api/site-access", withCookie(original)).
		expect(http.StatusOK, `{"required":true,"authenticated":false}`).
		expectHeader("Set-Cookie", "")

	secondRenewed := cookiePair(t, server.do(
		http.MethodGet, "/api/site-access", withCookie(firstRenewed)).
		header.Get("Set-Cookie"))
	if secondRenewed == firstRenewed {
		t.Fatal("second renewal reissued the same cookie")
	}

	now.Store(20_000)
	server.do(http.MethodGet, "/api/site-access", withCookie(firstRenewed)).
		expect(http.StatusOK, `{"required":true,"authenticated":false}`).
		expectHeader("Set-Cookie", "")
	active := server.do(http.MethodGet, "/api/site-access", withCookie(secondRenewed)).
		expect(http.StatusOK, `{"required":true,"authenticated":true}`)
	if active.header.Get("Set-Cookie") == "" {
		t.Fatal("an active cookie was not renewed")
	}
}

func TestSiteAccessUsesASecureHostCookieForProductionHTTPS(t *testing.T) {
	configuration := testConfig(t)
	configuration.Env = config.EnvironmentProduction
	server := start(t, Options{Config: configuration})

	setCookie := server.login().expectStatus(http.StatusOK).header.Get("Set-Cookie")
	if !secureSetCookiePattern.MatchString(setCookie) {
		t.Fatalf("Set-Cookie = %q, want %v", setCookie, secureSetCookiePattern)
	}
	if strings.Contains(setCookie, "Domain=") {
		t.Fatalf("Set-Cookie = %q must not scope a domain", setCookie)
	}
}

func TestLocalPasswordUsesConfiguredDestinationCookieAcrossLANAndPublicLink(t *testing.T) {
	configuration, err := config.Local(config.LocalOptions{
		Port: freePort(t), PublicAddress: "192.0.2.10", PublicOrigin: "https://public.example.test",
		SiteAccessPassword: testAccessPassword,
	})
	if err != nil {
		t.Fatal(err)
	}
	server := start(t, Options{Config: configuration})
	lanOrigin := fmt.Sprintf("http://192.0.2.10:%d", configuration.Port)
	for _, origin := range []string{lanOrigin, "https://public.example.test"} {
		t.Run(origin, func(t *testing.T) {
			destination, _ := url.Parse(origin)
			host := func(request *http.Request) { request.Host = destination.Host }
			login := server.do(http.MethodPost, "/api/site-access", host,
				withOrigin(lanOrigin), withBearer(testAccessPassword)).expectStatus(http.StatusOK)
			cookies := (&http.Response{Header: login.header}).Cookies()
			if len(cookies) != 1 || cookies[0].Secure != (destination.Scheme == "https") {
				t.Fatal("cookie policy does not match its configured destination")
			}
			jar, _ := cookiejar.New(nil)
			jar.SetCookies(destination, cookies)
			usable := jar.Cookies(destination)
			if len(usable) != 1 {
				t.Fatal("browser cookie rules reject the issued login")
			}
			cookie := usable[0].String()
			server.do(http.MethodGet, "/api/site-access", host, withCookie(cookie)).
				expect(http.StatusOK, `{"required":true,"authenticated":true}`)
			server.do(http.MethodPost, "/api/rooms", host, withOrigin(origin),
				withCookie(cookie), withJSON(`{"codeEntryPolicy":"open"}`)).expectStatus(http.StatusCreated)
			upgrade := httptest.NewRequest(http.MethodGet, origin+"/signal", nil)
			upgrade.Header.Set("Cookie", cookie)
			upgrade.Header.Set("X-Forwarded-Proto", "http")
			if !server.signalOptions.SiteAccessAtUpgrade(upgrade) {
				t.Fatal("WebSocket admission does not use the same cookie policy")
			}
			if destination.Scheme == "https" {
				upgrade.Header.Set("Cookie", strings.TrimPrefix(cookie, "__Host-"))
				if server.signalOptions.SiteAccessAtUpgrade(upgrade) {
					t.Fatal("public authority accepted the plain LAN cookie name")
				}
			}
		})
	}
}

func TestSiteAccessRequiresAnAllowedOriginAndAValidLoginBody(t *testing.T) {
	server := start(t, Options{Config: testConfig(t)})
	forbidden := `{"error":"Forbidden"}`

	server.do(http.MethodPost, "/api/site-access", withBearer(testAccessPassword)).
		expect(http.StatusForbidden, forbidden)
	server.do(http.MethodPost, "/api/site-access",
		withBearer(testAccessPassword), withOrigin("https://foreign.test")).
		expect(http.StatusForbidden, forbidden)
	server.do(http.MethodPost, "/api/site-access",
		withBearer(testAccessPassword), withOrigin(allowedOrigin+"/path")).
		expect(http.StatusForbidden, forbidden)
	server.do(http.MethodPost, "/api/site-access",
		withBearer(testAccessPassword), withOrigin(allowedOrigin),
		withBody("text/plain;charset=UTF-8", "{}")).
		expect(http.StatusBadRequest, `{"error":"Invalid site access request"}`)
	for _, payload := range []string{
		`{`, `{}`, `null`, `[]`, `{"password":null}`, `{"password":123}`,
		`{"password":"wrong","extra":true}`, `{"password":"wrong"} {}`,
		`{"password":"` + strings.Repeat("x", maxJSONRequestBytes) + `"}`,
	} {
		server.do(http.MethodPost, "/api/site-access", withOrigin(allowedOrigin),
			withBearer(testAccessPassword), withJSON(payload)).
			expect(http.StatusBadRequest, `{"error":"Invalid site access request"}`)
	}
	server.do(http.MethodPost, "/api/site-access", withOrigin(allowedOrigin),
		withBearer(testAccessPassword), withJSON(`{"password":"wrong"}`)).
		expectStatus(http.StatusUnauthorized)

	server.do(http.MethodDelete, "/api/site-access", withOrigin(allowedOrigin)).
		expect(http.StatusMethodNotAllowed, `{"error":"Method not allowed"}`).
		expectHeader("Allow", "GET, POST")
}

func TestLocalSiteAcceptsTheExactPasswordThroughJSON(t *testing.T) {
	for index, password := range []string{"x", "中文", " ", "  中文 +&  ", strings.Repeat("x", 256)} {
		t.Run(fmt.Sprint(index), func(t *testing.T) {
			configuration, err := config.Local(config.LocalOptions{
				Port: freePort(t), PublicAddress: "192.0.2.10", SiteAccessPassword: password,
			})
			if err != nil {
				t.Fatal(err)
			}
			server := start(t, Options{Config: configuration})
			origin := config.Origin(configuration.PublicBaseURL)
			for _, wrong := range []string{"", password + "!"} {
				payload, _ := json.Marshal(map[string]string{"password": wrong})
				server.do(http.MethodPost, "/api/site-access", withOrigin(origin), withJSON(string(payload))).
					expectStatus(http.StatusUnauthorized).expectHeader("Set-Cookie", "")
			}
			payload, _ := json.Marshal(map[string]string{"password": password})
			login := server.do(http.MethodPost, "/api/site-access", withOrigin(origin), withJSON(string(payload))).
				expect(http.StatusOK, `{"required":true,"authenticated":true}`)
			cookie := cookiePair(t, login.header.Get("Set-Cookie"))
			server.do(http.MethodGet, "/api/site-access", withCookie(cookie)).
				expect(http.StatusOK, `{"required":true,"authenticated":true}`)
			server.do(http.MethodPost, "/api/rooms", withOrigin(origin), withCookie(cookie),
				withJSON(`{"codeEntryPolicy":"open"}`)).expectStatus(http.StatusCreated)
		})
	}
}

func TestSiteAccessRejectsAnExpiredOrModifiedCookie(t *testing.T) {
	var now atomic.Int64
	now.Store(1_000)
	server := start(t, Options{
		Config:               testConfig(t),
		Now:                  now.Load,
		SiteAccessTTLSeconds: 1,
	})
	cookie := cookiePair(t, server.login().header.Get("Set-Cookie"))

	server.do(http.MethodGet, "/api/site-access", withCookie(cookie+"x")).
		expect(http.StatusOK, `{"required":true,"authenticated":false}`)

	now.Store(2_000)
	server.do(http.MethodGet, "/api/site-access", withCookie(cookie)).
		expect(http.StatusOK, `{"required":true,"authenticated":false}`)
}

func TestSiteAccessIsImmediateWhenTheAccessPasswordIsEmpty(t *testing.T) {
	for _, environment := range []config.Environment{config.EnvironmentDevelopment, config.EnvironmentProduction} {
		t.Run(string(environment), func(t *testing.T) {
			configuration := testConfig(t)
			configuration.Env = environment
			configuration.SiteAccessPassword = ""
			server := start(t, Options{Config: configuration})

			server.do(http.MethodGet, "/api/site-access").
				expect(http.StatusOK, `{"required":false,"authenticated":true}`).
				expectHeader("Set-Cookie", "")
			server.do(http.MethodPost, "/api/site-access", withOrigin(allowedOrigin)).
				expect(http.StatusOK, `{"required":false,"authenticated":true}`).
				expectHeader("Set-Cookie", "")
			server.do(http.MethodPost, "/api/site-access", withOrigin(allowedOrigin), withJSON(`{"password":""}`)).
				expect(http.StatusOK, `{"required":false,"authenticated":true}`).
				expectHeader("Set-Cookie", "")
		})
	}
}

// --- room HTTP API --------------------------------------------------------

func TestRoomCreationRequiresALoggedInBrowser(t *testing.T) {
	server := start(t, Options{Config: testConfig(t)})

	server.createRoom(roomRequest{}).
		expect(http.StatusUnauthorized, `{"error":"Unauthorized"}`).
		expectHeader("WWW-Authenticate", "")

	// Hazard 12: the site password as a bearer token is not a browser session.
	server.do(http.MethodPost, "/api/rooms",
		withOrigin(allowedOrigin), withBearer(testAccessPassword),
		withJSON(`{"codeEntryPolicy":"open"}`)).
		expect(http.StatusUnauthorized, `{"error":"Unauthorized"}`)
}

func TestRoomCreationIssuesAnIndependentFragmentOnlyViewerGrant(t *testing.T) {
	server := start(t, Options{Config: testConfig(t)})

	response := server.createRoom(roomRequest{cookie: server.cookie()}).
		expectStatus(http.StatusCreated).
		expectHeader("Cache-Control", "no-store").
		expectHeader("X-Content-Type-Options", "nosniff")
	created := response.room()

	if !regexp.MustCompile(`^[1-9][0-9]{3}$`).MatchString(created.RoomID) {
		t.Fatalf("roomId = %q", created.RoomID)
	}
	invite, err := url.Parse(created.InviteURL)
	if err != nil {
		t.Fatalf("url.Parse(inviteUrl): %v", err)
	}
	if config.Origin(invite) != "https://share.example.test" {
		t.Fatalf("invite origin = %q", config.Origin(invite))
	}
	if invite.Path != "/r/"+created.RoomID {
		t.Fatalf("invite path = %q", invite.Path)
	}
	if !regexp.MustCompile(`^v=[A-Za-z0-9_-]{21}[AQgw]$`).MatchString(invite.Fragment) {
		t.Fatalf("invite fragment = %q", invite.Fragment)
	}
	if invite.RawQuery != "" {
		t.Fatalf("invite query = %q", invite.RawQuery)
	}
	if created.CodeEntryPolicy != "open" {
		t.Fatalf("codeEntryPolicy = %q", created.CodeEntryPolicy)
	}
	// The response carries only room authority and no ICE configuration.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(response.body), &raw); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	for _, absent := range []string{"iceConfig", "viewerGrant"} {
		if _, present := raw[absent]; present {
			t.Fatalf("response exposes %q", absent)
		}
	}
}

func TestRoomCreationPassesTheSharedViewerCeilingToRoomAdmission(t *testing.T) {
	configuration := testConfig(t)
	configuration.SiteAccessPassword = ""
	configuration.MaxViewersPerRoom = protocol.MaxViewersPerRoomLimit
	server := start(t, Options{Config: configuration})

	server.createRoom(roomRequest{}).expectStatus(http.StatusCreated)
	if got := server.store.MaxViewersPerRoom(); got != protocol.MaxViewersPerRoomLimit {
		t.Fatalf("maxViewersPerRoom = %d, want %d", got, protocol.MaxViewersPerRoomLimit)
	}
}

func TestRoomCreationCreatesPrivateRoomsWithOptionalPasswordsAtomically(t *testing.T) {
	server := start(t, Options{Config: testConfig(t)})
	cookie := server.cookie()
	password := "room-password"

	withPassword := server.createRoom(roomRequest{
		cookie: cookie, codeEntryPolicy: "private", password: &password,
	}).expectStatus(http.StatusCreated).room()
	if withPassword.CodeEntryPolicy != "private" {
		t.Fatalf("codeEntryPolicy = %q", withPassword.CodeEntryPolicy)
	}

	withoutPassword := server.createRoom(roomRequest{
		cookie: cookie, codeEntryPolicy: "private",
	}).expectStatus(http.StatusCreated).room()
	if withoutPassword.CodeEntryPolicy != "private" {
		t.Fatalf("codeEntryPolicy = %q", withoutPassword.CodeEntryPolicy)
	}
}

func TestProductionAllowsRoomCreationWithoutSiteAccessButRequiresRoomOwnership(t *testing.T) {
	configuration := testConfig(t)
	configuration.Env = config.EnvironmentProduction
	configuration.SiteAccessPassword = ""
	server := start(t, Options{Config: configuration})

	created := server.createRoom(roomRequest{codeEntryPolicy: "open"}).
		expectStatus(http.StatusCreated).room()
	if created.CodeEntryPolicy != "open" {
		t.Fatalf("codeEntryPolicy = %q", created.CodeEntryPolicy)
	}
	if !strings.Contains(created.InviteURL, "#v=") {
		t.Fatalf("inviteUrl = %q", created.InviteURL)
	}
	server.updateRoomAccess(accessRequest{
		roomID: created.RoomID, hostToken: "wrong-token",
		body: `{"action":"set-code-entry-policy","policy":"private"}`,
	}).expectStatus(http.StatusNotFound)
	server.updateRoomAccess(accessRequest{
		roomID: created.RoomID, hostToken: created.HostToken,
		body: `{"action":"set-code-entry-policy","policy":"private"}`,
	}).expectStatus(http.StatusOK)
}

func TestRoomCreationAllocatesUniqueFourDigitCodesConcurrently(t *testing.T) {
	server := start(t, Options{Config: testConfig(t)})
	cookie := server.cookie()

	var wait sync.WaitGroup
	created := make([]protocol.CreateRoomResponse, 2)
	for index := range created {
		wait.Add(1)
		go func() {
			defer wait.Done()
			created[index] = server.createRoom(roomRequest{cookie: cookie}).
				expectStatus(http.StatusCreated).room()
		}()
	}
	wait.Wait()

	if created[0].RoomID == created[1].RoomID {
		t.Fatalf("both rooms took the code %q", created[0].RoomID)
	}
}

func TestRoomCreationReusesAFreePreferredCodeAndNeverReplacesAnOccupiedRoom(t *testing.T) {
	configuration := testConfig(t)
	server := start(t, Options{Config: configuration})
	cookie := server.cookie()

	preferred := server.createRoom(roomRequest{cookie: cookie, preferredRoomID: "4321"}).
		expectStatus(http.StatusCreated).room()
	fallback := server.createRoom(roomRequest{cookie: cookie, preferredRoomID: "4321"}).
		expectStatus(http.StatusCreated).room()

	if preferred.RoomID != "4321" {
		t.Fatalf("preferred roomId = %q", preferred.RoomID)
	}
	if fallback.RoomID == "4321" {
		t.Fatal("the occupied preferred code was handed out twice")
	}
	if fallback.HostToken == preferred.HostToken {
		t.Fatal("the fallback room reused the Host token")
	}
}

func TestRoomReplacementReplacesAuthorityAndClosesOldMembership(t *testing.T) {
	server := start(t, Options{Config: testConfig(t)})
	cookie := server.cookie()
	password := "old-password"
	original := server.createRoom(roomRequest{
		cookie: cookie, codeEntryPolicy: "private",
		password: &password, preferredRoomID: "4321",
	}).expectStatus(http.StatusCreated).room()

	store := server.store
	host, err := store.ConnectParticipant(room.ConnectParticipantInput{
		RoomID: original.RoomID, Role: protocol.RoleHost, Token: original.HostToken,
		ClientID: "host-client", SessionID: "host-session",
	})
	if err != nil {
		t.Fatalf("connect host: %v", err)
	}
	invite, err := url.Parse(original.InviteURL)
	if err != nil {
		t.Fatalf("url.Parse(inviteUrl): %v", err)
	}
	if _, err := store.ConnectParticipant(room.ConnectParticipantInput{
		RoomID: original.RoomID, Role: protocol.RoleViewer,
		ViewerGrant: strings.TrimPrefix(invite.Fragment, "v="),
		ClientID:    "viewer-client", SessionID: "viewer-session",
	}); err != nil {
		t.Fatalf("connect viewer: %v", err)
	}

	server.replaceRoom(original.RoomID, original.HostToken,
		`{"codeEntryPolicy":"open"}`, "").
		expect(http.StatusUnauthorized, `{"error":"Unauthorized"}`)

	replacement := server.replaceRoom(original.RoomID, original.HostToken,
		`{"codeEntryPolicy":"private","roomPassword":"new-password"}`, cookie).
		expectStatus(http.StatusCreated).room()

	if replacement.RoomID == original.RoomID {
		t.Fatal("the replacement kept the old room code")
	}
	if replacement.CodeEntryPolicy != "private" {
		t.Fatalf("codeEntryPolicy = %q", replacement.CodeEntryPolicy)
	}
	if _, connected := store.GetConnectedHost(original.RoomID); connected {
		t.Fatal("the old Host is still connected")
	}
	if viewers := store.GetConnectedViewers(original.RoomID); len(viewers) != 0 {
		t.Fatalf("old viewers = %v", viewers)
	}
	if _, err := store.ConnectParticipant(room.ConnectParticipantInput{
		RoomID: original.RoomID, Role: protocol.RoleHost, Token: original.HostToken,
		ClientID: "old-host", SessionID: "old-session",
	}); roomErrorCode(err) != room.CodeInvalidToken {
		t.Fatalf("reconnect error = %v, want INVALID_TOKEN", err)
	}
	if host.PeerID == "" {
		t.Fatal("the replaced Host never had a peer id")
	}
}

// TestRoomMutationFailuresMapToTheHTTPTable covers the two TS cases that used
// vi.spyOn to make RoomStore reject: "keeps valid Host authority on a transient
// replacement rejection" (ROOM_ACCESS_DENIED) and "maps a busy password gate to
// 503 for every HTTP mutation" (ROOM_BUSY on all three). Go cannot monkey patch
// a concrete *room.Store, and neither code is reachable from HTTP without a
// racing second mutation, so the pure mapping functions the three routes share
// are driven directly instead; that the store leaves the authority intact when
// it rejects is the room package's own contract.
func TestRoomMutationFailuresMapToTheHTTPTable(t *testing.T) {
	otherError := errors.New("storage failed")
	cases := []struct {
		name    string
		mapper  func(error) (int, string, bool)
		err     error
		status  int
		message string
		mapped  bool
	}{
		{"replacement limit", replacementFailure, &room.Error{Code: room.CodeRoomLimit}, 503, "Room capacity reached", true},
		{"replacement denied", replacementFailure, &room.Error{Code: room.CodeRoomAccessDenied}, 503, "Room replacement unavailable", true},
		{"replacement busy", replacementFailure, &room.Error{Code: room.CodeRoomBusy}, 503, "Room replacement unavailable", true},
		{"replacement token", replacementFailure, &room.Error{Code: room.CodeInvalidToken}, 404, "Room not found", true},
		{"replacement missing", replacementFailure, &room.Error{Code: room.CodeRoomNotFound}, 404, "Room not found", true},
		{"replacement full", replacementFailure, &room.Error{Code: room.CodeRoomFull}, 0, "", false},
		{"replacement other", replacementFailure, otherError, 0, "", false},
		{"access busy", accessFailure, &room.Error{Code: room.CodeRoomBusy}, 503, "Room access update unavailable", true},
		{"access denied", accessFailure, &room.Error{Code: room.CodeRoomAccessDenied}, 409, "Room access update rejected", true},
		{"access token", accessFailure, &room.Error{Code: room.CodeInvalidToken}, 404, "Room not found", true},
		{"access limit", accessFailure, &room.Error{Code: room.CodeRoomLimit}, 404, "Room not found", true},
		{"access other", accessFailure, otherError, 0, "", false},
		{"creation limit", creationFailure, &room.Error{Code: room.CodeRoomLimit}, 503, "Room capacity reached", true},
		{"creation busy", creationFailure, &room.Error{Code: room.CodeRoomBusy}, 503, "Room creation unavailable", true},
		{"creation token", creationFailure, &room.Error{Code: room.CodeInvalidToken}, 400, "Invalid room request", true},
		{"creation denied", creationFailure, &room.Error{Code: room.CodeRoomAccessDenied}, 0, "", false},
		{"creation other", creationFailure, otherError, 0, "", false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			status, message, mapped := testCase.mapper(testCase.err)
			if status != testCase.status || message != testCase.message || mapped != testCase.mapped {
				t.Fatalf("got (%d, %q, %t), want (%d, %q, %t)",
					status, message, mapped,
					testCase.status, testCase.message, testCase.mapped)
			}
		})
	}
	// A wrapped store error still maps: the routes use errors.As.
	if status, _, mapped := creationFailure(
		fmt.Errorf("create: %w", &room.Error{Code: room.CodeRoomLimit}),
	); !mapped || status != 503 {
		t.Fatalf("wrapped ROOM_LIMIT mapped=%t status=%d", mapped, status)
	}
}

func TestRoomAccessManagesADormantRoomWithoutStartingSharing(t *testing.T) {
	var now atomic.Int64
	configuration := testConfig(t)
	server := start(t, Options{Config: configuration, Now: now.Load})
	cookie := server.cookie()
	created := server.createRoom(roomRequest{cookie: cookie}).
		expectStatus(http.StatusCreated).room()
	now.Store(900)

	server.updateRoomAccess(accessRequest{
		roomID: created.RoomID, hostToken: created.HostToken, cookie: cookie,
		body: `{"action":"set-code-entry-policy","policy":"private"}`,
	}).
		expect(http.StatusOK,
			`{"type":"code-entry-policy-updated","codeEntryPolicy":"private","viewerPasswordEnabled":false}`).
		expectHeader("Cache-Control", "no-store")

	server.updateRoomAccess(accessRequest{
		roomID: created.RoomID, hostToken: created.HostToken, cookie: cookie,
		body: `{"action":"set-viewer-password","password":"room-password"}`,
	}).expect(http.StatusOK, `{"type":"viewer-password-updated","enabled":true}`)

	server.updateRoomAccess(accessRequest{
		roomID: created.RoomID, hostToken: created.HostToken, cookie: cookie,
		body: `{"action":"set-viewer-password","password":null}`,
	}).expect(http.StatusOK, `{"type":"viewer-password-updated","enabled":false}`)

	rotated := server.updateRoomAccess(accessRequest{
		roomID: created.RoomID, hostToken: created.HostToken, cookie: cookie,
		body: `{"action":"rotate-viewer-grant"}`,
	}).expectStatus(http.StatusOK)
	var rotatedBody struct {
		Type                          string  `json:"type"`
		ViewerAuthorizationGeneration string  `json:"viewerAuthorizationGeneration"`
		InviteURL                     *string `json:"inviteUrl"`
	}
	if err := json.Unmarshal([]byte(rotated.body), &rotatedBody); err != nil {
		t.Fatalf("decode rotation: %v", err)
	}
	if rotatedBody.Type != "viewer-grant-updated" || rotatedBody.InviteURL == nil {
		t.Fatalf("rotation body = %s", rotated.body)
	}
	if !regexp.MustCompile(`#v=[A-Za-z0-9_-]{22}$`).MatchString(*rotatedBody.InviteURL) {
		t.Fatalf("rotated inviteUrl = %q", *rotatedBody.InviteURL)
	}

	revoked := server.updateRoomAccess(accessRequest{
		roomID: created.RoomID, hostToken: created.HostToken, cookie: cookie,
		body: `{"action":"revoke-viewer-grant"}`,
	}).expectStatus(http.StatusOK)
	if !strings.Contains(revoked.body, `"inviteUrl":null`) ||
		!strings.Contains(revoked.body, `"type":"viewer-grant-updated"`) {
		t.Fatalf("revocation body = %s", revoked.body)
	}
	if _, connected := server.store.GetConnectedHost(created.RoomID); connected {
		t.Fatal("managing access started a sharing session")
	}

	now.Store(30 * 24 * 60 * 60 * 1_000)
	server.updateRoomAccess(accessRequest{
		roomID: created.RoomID, hostToken: created.HostToken, cookie: server.cookie(),
		body: `{"action":"set-code-entry-policy","policy":"open"}`,
	}).expectStatus(http.StatusOK)
}

func TestRoomAccessRequiresSameOriginSiteAccessAndTheExactHostToken(t *testing.T) {
	server := start(t, Options{Config: testConfig(t)})
	cookie := server.cookie()
	first := server.createRoom(roomRequest{cookie: cookie}).
		expectStatus(http.StatusCreated).room()
	second := server.createRoom(roomRequest{cookie: cookie}).
		expectStatus(http.StatusCreated).room()
	rotate := `{"action":"rotate-viewer-grant"}`

	server.updateRoomAccess(accessRequest{
		roomID: first.RoomID, hostToken: first.HostToken, body: rotate,
	}).expect(http.StatusUnauthorized, `{"error":"Unauthorized"}`)

	server.updateRoomAccess(accessRequest{
		roomID: first.RoomID, hostToken: first.HostToken, body: rotate,
		cookie: cookie, origin: "https://foreign.test",
	}).expect(http.StatusForbidden, `{"error":"Forbidden"}`)

	server.updateRoomAccess(accessRequest{
		roomID: first.RoomID, body: rotate, cookie: cookie,
	}).expect(http.StatusNotFound, `{"error":"Room not found"}`)

	server.updateRoomAccess(accessRequest{
		roomID: first.RoomID, hostToken: "wrong-token", body: rotate, cookie: cookie,
	}).expect(http.StatusNotFound, `{"error":"Room not found"}`)

	server.updateRoomAccess(accessRequest{
		roomID: first.RoomID, hostToken: second.HostToken, body: rotate, cookie: cookie,
	}).expect(http.StatusNotFound, `{"error":"Room not found"}`)

	server.updateRoomAccess(accessRequest{
		roomID: first.RoomID, hostToken: first.HostToken, cookie: cookie,
		body: `{"action":"unknown"}`,
	}).expect(http.StatusBadRequest, `{"error":"Invalid room access request"}`)

	server.updateRoomAccess(accessRequest{
		roomID: first.RoomID, hostToken: first.HostToken, body: rotate,
		cookie: cookie, method: http.MethodGet,
	}).
		expect(http.StatusMethodNotAllowed, `{"error":"Method not allowed"}`).
		expectHeader("Allow", "POST")
}

func TestRoomCreationRejectsMalformedRequestsAndForeignBrowserOrigins(t *testing.T) {
	configuration := testConfig(t)
	configuration.SiteAccessPassword = ""
	server := start(t, Options{Config: configuration})

	server.do(http.MethodPost, "/api/rooms", withOrigin(allowedOrigin), withJSON("{}")).
		expect(http.StatusBadRequest, `{"error":"Invalid room request"}`)

	server.do(http.MethodPost, "/api/rooms",
		withOrigin("https://foreign.test"), withJSON(`{"codeEntryPolicy":"open"}`)).
		expect(http.StatusForbidden, `{"error":"Forbidden"}`)

	// An oversized or non-JSON body is the same 400.
	server.do(http.MethodPost, "/api/rooms", withOrigin(allowedOrigin),
		withJSON(`{"codeEntryPolicy":"open","preferredRoomId":"`+strings.Repeat("1", 1_024)+`"}`)).
		expect(http.StatusBadRequest, `{"error":"Invalid room request"}`)
	server.do(http.MethodPost, "/api/rooms", withOrigin(allowedOrigin),
		withBody("text/plain", `{"codeEntryPolicy":"open"}`)).
		expect(http.StatusBadRequest, `{"error":"Invalid room request"}`)

	server.do(http.MethodGet, "/api/rooms", withOrigin(allowedOrigin)).
		expect(http.StatusMethodNotAllowed, `{"error":"Method not allowed"}`).
		expectHeader("Allow", "POST")
}

func TestRoomCreationReturnsServiceUnavailableAtTheGlobalRoomBound(t *testing.T) {
	configuration := testConfig(t)
	configuration.SiteAccessPassword = ""
	store, err := room.New(room.Options{
		MaxRooms: 1, MaxViewersPerRoom: 8,
	})
	if err != nil {
		t.Fatalf("room.New: %v", err)
	}
	server := start(t, Options{Config: configuration, RoomStore: store})

	server.createRoom(roomRequest{}).expectStatus(http.StatusCreated)
	server.createRoom(roomRequest{}).
		expect(http.StatusServiceUnavailable, `{"error":"Room capacity reached"}`)
}

// --- server HTTP listener and health --------------------------------------

func TestServesAnExplicitStaticFrontendIndependentlyOfTheEnvironment(t *testing.T) {
	assets := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<main>local-static</main>")},
		"assets/app.js": &fstest.MapFile{
			Data: []byte("export const marker = 1;\n"),
		},
	}
	server := start(t, Options{Config: testConfig(t), Assets: assets})

	server.do(http.MethodGet, "/local-route").
		expect(http.StatusOK, "<main>local-static</main>").
		expectHeader("Content-Type", "text/html;charset=utf-8").
		expectHeader("X-Content-Type-Options", "nosniff").
		expectHeader("Referrer-Policy", "no-referrer")

	server.do(http.MethodGet, "/assets/app.js").
		expect(http.StatusOK, "export const marker = 1;\n").
		expectHeader("Content-Type", "text/javascript")

	// /api/** never falls through to the frontend.
	server.do(http.MethodGet, "/api/unknown").
		expect(http.StatusNotFound, `{"error":"Not found"}`).
		expectHeader("Cache-Control", "no-store")
	// A missing asset with an extension keeps the JSON 404.
	server.do(http.MethodGet, "/assets/missing.js").
		expect(http.StatusNotFound, `{"error":"Not found"}`)
}

func TestApiOnlyCompositionAnswersJSONNotFound(t *testing.T) {
	server := start(t, Options{Config: testConfig(t)})

	server.do(http.MethodGet, "/local-route").
		expect(http.StatusNotFound, `{"error":"Not found"}`).
		expectHeader("Cache-Control", "")
	server.do(http.MethodGet, "/api/unknown").
		expect(http.StatusNotFound, `{"error":"Not found"}`).
		expectHeader("Cache-Control", "no-store").
		expectHeader("X-Content-Type-Options", "")
}

func TestRestoresStableRoomAuthorityAcrossAnApplicationRestart(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "rooms.sqlite")
	var now atomic.Int64
	now.Store(100)
	configuration := testConfig(t)
	configuration.SiteAccessPassword = ""
	configuration.RoomDatabasePath = databasePath

	first := start(t, Options{Config: configuration, Now: now.Load})
	created := first.createRoom(roomRequest{codeEntryPolicy: "private"}).
		expectStatus(http.StatusCreated).room()
	if err := first.Close(context.Background()); err != nil {
		t.Fatalf("close first: %v", err)
	}

	now.Store(30 * 24 * 60 * 60 * 1_000)
	second := start(t, Options{Config: configuration, Now: now.Load})
	if size := second.store.Size(); size != 1 {
		t.Fatalf("restored room count = %d, want 1", size)
	}
	second.updateRoomAccess(accessRequest{
		roomID: created.RoomID, hostToken: created.HostToken,
		body: `{"action":"set-code-entry-policy","policy":"open"}`,
	}).expect(http.StatusOK,
		`{"type":"code-entry-policy-updated","codeEntryPolicy":"open","viewerPasswordEnabled":false}`)
}

func TestDoesNotOpenDatabaseWhenAnotherProcessOwnsTheListener(t *testing.T) {
	owner := start(t, Options{Config: testConfig(t)})
	ownerPort := ownerBoundPort(t, owner)

	databasePath := filepath.Join(t.TempDir(), "missing-parent", "rooms.sqlite")
	configuration := testConfig(t)
	configuration.Port = ownerPort
	configuration.RoomDatabasePath = databasePath
	contender := newServer(t, Options{Config: configuration})

	// The TS test asserted the EADDRINUSE code; Windows reports WSAEADDRINUSE,
	// which errors.Is does not fold into syscall.EADDRINUSE, so the contract
	// asserted here is the one that matters: the bind failed, nothing was
	// reconciled, and the owner still holds the port.
	_, err := contender.Listen(context.Background())
	if err == nil {
		t.Fatal("the contender bound a port another process owns")
	}
	var addressError *net.OpError
	if !errors.As(err, &addressError) || addressError.Op != "listen" {
		t.Fatalf("Listen error = %v, want a listen failure", err)
	}
	if _, statErr := os.Stat(databasePath); !os.IsNotExist(statErr) {
		t.Fatalf("the room database was created: %v", statErr)
	}
	owner.do(http.MethodGet, "/healthz").expect(http.StatusOK, `{"status":"ok"}`)
}

// ownerBoundPort re-reads the port a started harness listens on.
func ownerBoundPort(t *testing.T, server *harness) int {
	t.Helper()
	parsed, err := url.Parse(server.baseURL)
	if err != nil {
		t.Fatalf("url.Parse: %v", err)
	}
	port := 0
	if _, err := fmt.Sscanf(parsed.Port(), "%d", &port); err != nil {
		t.Fatalf("parse port: %v", err)
	}
	return port
}

func TestRejectsASecondDatabaseOwnerBeforeServingTraffic(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "rooms.sqlite")
	ownerConfig := testConfig(t)
	ownerConfig.RoomDatabasePath = databasePath
	start(t, Options{Config: ownerConfig})

	contenderConfig := testConfig(t)
	contenderConfig.Port = freePort(t)
	contenderConfig.RoomDatabasePath = databasePath
	contender := newServer(t, Options{Config: contenderConfig})

	_, err := contender.Listen(context.Background())
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "locked") {
		t.Fatalf("Listen error = %v, want a locked database", err)
	}
	assertPortFree(t, contenderConfig.Port)
}

func TestRejectsAMismatchedDatabaseBeforeServingTraffic(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "rooms.sqlite")
	raw, err := sql.Open("sqlite", "file:"+filepath.ToSlash(databasePath))
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	if _, err := raw.Exec("CREATE TABLE unrelated(value TEXT) STRICT"); err != nil {
		t.Fatalf("seed unrelated schema: %v", err)
	}
	if err := raw.Close(); err != nil {
		t.Fatalf("close raw database: %v", err)
	}

	configuration := testConfig(t)
	configuration.Port = freePort(t)
	configuration.RoomDatabasePath = databasePath
	server := newServer(t, Options{Config: configuration})

	_, err = server.Listen(context.Background())
	if err == nil ||
		!strings.Contains(err.Error(), "Room database application identity does not match") {
		t.Fatalf("Listen error = %v", err)
	}
	assertPortFree(t, configuration.Port)
}

func TestRejectsAnInaccessibleDatabasePathBeforeServingTraffic(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "missing-parent", "rooms.sqlite")
	configuration := testConfig(t)
	configuration.Port = freePort(t)
	configuration.RoomDatabasePath = databasePath
	server := newServer(t, Options{Config: configuration})

	if _, err := server.Listen(context.Background()); err == nil {
		t.Fatal("Listen accepted an unreachable database path")
	}
	if _, err := os.Stat(databasePath); !os.IsNotExist(err) {
		t.Fatalf("the room database was created: %v", err)
	}
	assertPortFree(t, configuration.Port)
}

func TestUsesTheConfiguredListenHostByDefault(t *testing.T) {
	server := start(t, Options{Config: testConfig(t)})

	if !strings.HasPrefix(server.baseURL, "http://127.0.0.1:") {
		t.Fatalf("listen address = %q", server.baseURL)
	}
	server.do(http.MethodGet, "/healthz").expect(http.StatusOK, `{"status":"ok"}`)
}

func TestPreboundListenerHasOneStartupAndShutdownOwner(t *testing.T) {
	for _, serve := range []bool{false, true} {
		t.Run(fmt.Sprintf("serve=%t", serve), func(t *testing.T) {
			listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
			if err != nil {
				t.Fatal(err)
			}
			address := listener.Addr().(*net.TCPAddr)
			server := newServer(t, Options{Listener: listener})
			if serve {
				port, err := server.Listen(t.Context())
				if err != nil || port != address.Port || server.listener != listener {
					t.Fatalf("startup replaced the prebound listener: port=%d err=%v", port, err)
				}
				client := &http.Client{Timeout: time.Second}
				response, err := client.Get("http://" + address.String() + "/healthz")
				if err != nil {
					t.Fatal(err)
				}
				_ = response.Body.Close()
				if response.StatusCode != http.StatusOK {
					t.Fatalf("prebound server health = %d", response.StatusCode)
				}
			}
			if err := server.Close(t.Context()); err != nil {
				t.Fatal(err)
			}
			rebound, err := net.ListenTCP("tcp4", address)
			if err != nil {
				t.Fatalf("prebound listener survived shutdown: %v", err)
			}
			_ = rebound.Close()
		})
	}
}

func TestReportsProcessLivenessWithoutAccessChecks(t *testing.T) {
	server := start(t, Options{Config: testConfig(t)})

	server.do(http.MethodGet, "/healthz", withOrigin("https://foreign.test")).
		expect(http.StatusOK, `{"status":"ok"}`).
		expectHeader("Cache-Control", "no-store").
		expectHeader("Content-Type", "application/json; charset=utf-8")
}

func TestOnlyAcceptsGETHealthChecks(t *testing.T) {
	server := start(t, Options{Config: testConfig(t)})

	server.do(http.MethodPost, "/healthz").
		expect(http.StatusMethodNotAllowed, `{"error":"Method not allowed"}`).
		expectHeader("Allow", "GET").
		expectHeader("Cache-Control", "no-store")
}

func TestListenIsSingleShotAndRefusedAfterClose(t *testing.T) {
	before := runtime.NumGoroutine()
	server := start(t, Options{Config: testConfig(t)})

	if _, err := server.Listen(context.Background()); err == nil ||
		err.Error() != "Piik server startup was already requested" {
		t.Fatalf("second Listen error = %v", err)
	}
	if err := server.Close(context.Background()); err != nil {
		t.Fatalf("Close: %v", err)
	}
	expectGoroutinesSettled(t, before)

	fresh := newServer(t, Options{Config: testConfig(t)})
	if err := fresh.Close(context.Background()); err != nil {
		t.Fatalf("Close before Listen: %v", err)
	}
	if _, err := fresh.Listen(context.Background()); err == nil ||
		err.Error() != "Piik server is closing" {
		t.Fatalf("Listen after Close error = %v", err)
	}
}

// --- request failures and server settings ---------------------------------

// The createServer .catch of app.ts: a handler that throws answers 500 and the
// record carries fixed method and route categories without request data.
func TestRequestFailureAnswers500AndLogsRequestCategoriesOnly(t *testing.T) {
	var logged bytes.Buffer
	server := newServer(t, Options{
		Config: testConfig(t),
		Logger: slog.New(slog.NewTextHandler(&logged, nil)),
	})
	server.frontend = http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("viewer-grant-that-must-not-be-logged")
	})
	server.acceptingTraffic.Store(true)

	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder,
		httptest.NewRequest(http.MethodGet, "/viewer-grant-that-must-not-be-logged?grant=viewer-grant-that-must-not-be-logged", nil))

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", recorder.Code)
	}
	if body := recorder.Body.String(); body != `{"error":"Internal server error"}` {
		t.Fatalf("body = %s", body)
	}
	record := logged.String()
	if !strings.Contains(record, "HTTP request failed") ||
		!strings.Contains(record, "method=GET") ||
		!strings.Contains(record, "route=frontend") || strings.Contains(record, "path=") {
		t.Fatalf("log record = %q", record)
	}
	if strings.Contains(record, "viewer-grant-that-must-not-be-logged") {
		t.Fatalf("the failure log leaked the request: %q", record)
	}
	logged.Reset()
	server.ServeHTTP(httptest.NewRecorder(),
		httptest.NewRequest("private-method-token", "/private-path-token", nil))
	if record := logged.String(); !strings.Contains(record, "method=other") || strings.Contains(record, "private-") {
		t.Fatalf("the failure log leaked a custom method: %q", record)
	}
}

// A failure after the response started destroyed the socket in Node; in Go the
// equivalent is http.ErrAbortHandler, which net/http turns into a silent close.
func TestRequestFailureAfterTheResponseStartedAbortsTheConnection(t *testing.T) {
	server := newServer(t, Options{
		Config: testConfig(t),
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	server.frontend = http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusOK)
		panic("late failure")
	})
	server.acceptingTraffic.Store(true)

	defer func() {
		if recovered := recover(); recovered != http.ErrAbortHandler {
			t.Fatalf("recovered = %v, want http.ErrAbortHandler", recovered)
		}
	}()
	server.ServeHTTP(httptest.NewRecorder(),
		httptest.NewRequest(http.MethodGet, "/late", nil))
	t.Fatal("ServeHTTP returned instead of aborting the connection")
}

// The three Node HTTP server settings of map section 3.3 / D11, and the write
// deadline Node never had.
func TestHTTPServerKeepsTheNodeTimeouts(t *testing.T) {
	server := newServer(t, Options{Config: testConfig(t)})

	if got := server.httpServer.ReadHeaderTimeout; got != 15*time.Second {
		t.Fatalf("ReadHeaderTimeout = %v, want headersTimeout 15s", got)
	}
	if got := server.httpServer.ReadTimeout; got != 10*time.Second {
		t.Fatalf("ReadTimeout = %v, want requestTimeout 10s", got)
	}
	if got := server.httpServer.IdleTimeout; got != 5*time.Second {
		t.Fatalf("IdleTimeout = %v, want keepAliveTimeout 5s", got)
	}
	if got := server.httpServer.WriteTimeout; got != 0 {
		t.Fatalf("WriteTimeout = %v, want none", got)
	}
}

// The upgrade dispatch of ServeHTTP: Node handed every Connection: Upgrade
// request to the signaling server's own listener, which owns the whole
// rejection ladder, and a plain GET of the same path stayed an ordinary
// request. It is also the only cover for the response wrapper being
// unwrappable to the http.Hijacker websocket.Accept needs.
func TestSignalUpgradeIsDispatchedToTheSignalingServer(t *testing.T) {
	server := start(t, Options{Config: testConfig(t)})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// websocket.Dial refuses a client with a Timeout, so the harness client
	// cannot be reused here.
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
	target := "ws" + strings.TrimPrefix(server.baseURL, "http") + "/signal"

	connection, _, err := websocket.Dial(ctx, target, &websocket.DialOptions{
		HTTPClient: client,
		HTTPHeader: http.Header{"Origin": []string{allowedOrigin}},
	})
	if err != nil {
		t.Fatalf("upgrade /signal: %v", err)
	}
	if err := connection.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatalf("close signal connection: %v", err)
	}

	if _, _, err := websocket.Dial(ctx, target, &websocket.DialOptions{
		HTTPClient: client,
		HTTPHeader: http.Header{"Origin": []string{"https://foreign.test"}},
	}); err == nil {
		t.Fatal("a foreign origin completed the upgrade")
	}

	server.do(http.MethodGet, "/signal").
		expect(http.StatusNotFound, `{"error":"Not found"}`)
}

// --- startup failures the TypeScript could not have ------------------------

// panickingRoomControl is a reconciliation step that fails with a panic rather
// than an error, which is what a nil dereference inside a future startup step
// would look like.

// app.ts:219 awaited startupOperation inside a try/catch, so a rejected
// startup still settled the promise shutdown waited on. A panic out of start()
// must release the same latch.

// syncBuffer collects log records written from the Serve goroutine.
type syncBuffer struct {
	mu      sync.Mutex
	records bytes.Buffer
}

func (buffer *syncBuffer) Write(record []byte) (int, error) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.records.Write(record)
}

func (buffer *syncBuffer) String() string {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.records.String()
}

// Node ended the process when the listening server raised, because
// bindHttpServer had already removed its "error" handler. Serve's error must
// at least reach the operator instead of leaving nothing serving in silence.
func TestReportsAListenerThatDiesWhileServing(t *testing.T) {
	var logged syncBuffer
	server := newServer(t, Options{
		Config: testConfig(t),
		Logger: slog.New(slog.NewTextHandler(&logged, nil)),
	})
	if _, err := server.Listen(context.Background()); err != nil {
		t.Fatalf("Listen: %v", err)
	}

	// Out of band: no Shutdown, so Serve returns a real accept failure.
	if err := server.listener.Close(); err != nil {
		t.Fatalf("close the listener: %v", err)
	}
	waitFor(t, "the serve failure to be reported", func() bool {
		return strings.Contains(logged.String(), "Piik HTTP server stopped unexpectedly")
	})
	if record := logged.String(); !strings.Contains(record, "errorType=*net.OpError") || strings.Contains(record, "error=") || strings.Contains(record, "127.0.0.1") {
		t.Fatalf("listener failure must log only the error type: %q", record)
	}
}
