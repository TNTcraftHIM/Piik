package remote

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestStartUsesHostAdmissionCookieAndPrivateV2Room(t *testing.T) {
	const password = "host-admission-password"
	harness := newRemoteHarnessWithPassword(t, []string{}, password)
	defer harness.Close()
	baseURL, err := url.Parse(harness.URL())
	if err != nil {
		t.Fatal(err)
	}
	session, room, err := Start(context.Background(), StartOptions{
		BaseURL:               baseURL,
		HostAdmissionPassword: password,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()

	admission := <-harness.admission
	if admission.Method != http.MethodPost || admission.Authorization != "Bearer "+password ||
		admission.Origin != harness.URL() || admission.Body != "" {
		t.Fatalf("host admission request = %+v", admission)
	}
	creation := <-harness.roomCreation
	if creation.Method != http.MethodPost || creation.Authorization != "" || creation.Origin != harness.URL() ||
		creation.ContentType != "application/json" ||
		creation.Body != `{"viewerPolicy":"private-link","hostClaimTtlSeconds":300}` ||
		!strings.HasPrefix(creation.Cookie, "screener-host-admission=v1.") {
		t.Fatalf("room creation request = %+v", creation)
	}
	if signalCookie := <-harness.signalCookie; signalCookie != creation.Cookie {
		t.Fatalf("signaling cookie did not match room cookie")
	}
	if !strings.Contains(room.InviteURL, "/r/1#v=g1.1.") {
		t.Fatalf("private invite was not returned to the local Host UI")
	}
	assertAuthenticateShape(t, harness.Authentication())
}

func TestStartRetriesTheSameProvisionalRoomOnce(t *testing.T) {
	var roomCreations atomic.Int32
	var signalAttempts atomic.Int32
	var authMu sync.Mutex
	var authentications [][]byte
	mux := http.NewServeMux()
	var server *httptest.Server
	mux.HandleFunc("/api/host-admission", func(response http.ResponseWriter, request *http.Request) {
		writeHarnessJSON(response, map[string]any{"required": false, "authenticated": true})
	})
	mux.HandleFunc("/api/rooms", func(response http.ResponseWriter, request *http.Request) {
		roomCreations.Add(1)
		response.WriteHeader(http.StatusCreated)
		_, _ = response.Write([]byte(validRoomResponseJSON(server.URL, "1", "1", nil)))
	})
	mux.HandleFunc("/signal", func(response http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(response, request, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer connection.CloseNow()
		messageType, payload, err := connection.Read(request.Context())
		if err != nil || messageType != websocket.MessageText {
			return
		}
		authMu.Lock()
		authentications = append(authentications, append([]byte(nil), payload...))
		authMu.Unlock()
		if signalAttempts.Add(1) == 1 {
			return
		}
		expiresAt := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
		authenticated, _ := json.Marshal(map[string]any{
			"type": "authenticated", "protocol": signalingProtocol, "role": "host", "peerId": "host-peer",
			"roomExpiresAt": expiresAt.Format(time.RFC3339), "maxViewers": 3, "hostOnline": true,
			"connectionId": nil, "viewerPeerIds": []string{},
			"iceConfig": map[string]any{"iceServers": []any{}}, "viewerPolicy": privateViewerPolicy,
			"viewerAuthorizationGeneration": "viewer_generation_12345678",
		})
		writeErr := connection.Write(request.Context(), websocket.MessageText, authenticated)
		if writeErr != nil {
			return
		}
		_, payload, err = connection.Read(request.Context())
		if err != nil || string(payload) != `{"type":"abandon-room"}` {
			return
		}
		_ = connection.Write(context.Background(), websocket.MessageText, []byte(`{"type":"room-closed","reason":"host-ended"}`))
	})
	server = httptest.NewServer(mux)
	defer server.Close()
	baseURL, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	session, _, err := Start(context.Background(), StartOptions{BaseURL: baseURL})
	if err != nil {
		t.Fatal(err)
	}
	session.Close()
	if roomCreations.Load() != 1 || signalAttempts.Load() != 2 {
		t.Fatalf("room creations = %d, signaling attempts = %d", roomCreations.Load(), signalAttempts.Load())
	}
	authMu.Lock()
	defer authMu.Unlock()
	if len(authentications) != 2 || !bytes.Equal(authentications[0], authentications[1]) {
		t.Fatal("signaling retry did not reuse the exact room and Host generation")
	}
}

func TestHostAdmissionFailuresAreBoundedAndDoNotLeakSecrets(t *testing.T) {
	const password = "never-report-this-password"
	const grant = "g1.1.1893456000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	tests := []struct {
		name      string
		status    int
		body      string
		setCookie string
	}{
		{name: "unauthorized", status: http.StatusUnauthorized, body: `{"error":"` + password + ` ` + grant + `"}`},
		{name: "rate-limited", status: http.StatusTooManyRequests, body: `{"error":"` + password + ` ` + grant + `"}`},
		{name: "wrong-success-status", status: http.StatusCreated, body: `{"required":false,"authenticated":true}`},
		{name: "missing-cookie", status: http.StatusOK, body: `{"required":true,"authenticated":true}`},
		{name: "missing-required", status: http.StatusOK, body: `{"authenticated":true}`},
		{name: "missing-authenticated", status: http.StatusOK, body: `{"required":false}`},
		{name: "unknown-field", status: http.StatusOK, body: `{"required":false,"authenticated":true,"url":"https://private.test/path"}`},
		{
			name: "quoted-cookie", status: http.StatusOK, body: `{"required":true,"authenticated":true}`,
			setCookie: `screener-host-admission="v1.1893456000.` + strings.Repeat("a", 43) + `"; Path=/; Max-Age=43200; HttpOnly; SameSite=Strict`,
		},
		{
			name: "partitioned-cookie", status: http.StatusOK, body: `{"required":true,"authenticated":true}`,
			setCookie: `screener-host-admission=v1.1893456000.` + strings.Repeat("a", 43) + `; Path=/; Max-Age=43200; HttpOnly; SameSite=Strict; Partitioned`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				if request.URL.Path != "/api/host-admission" {
					http.NotFound(response, request)
					return
				}
				if test.setCookie != "" {
					response.Header().Set("Set-Cookie", test.setCookie)
				}
				response.WriteHeader(test.status)
				_, _ = response.Write([]byte(test.body))
			}))
			defer server.Close()
			baseURL, parseErr := url.Parse(server.URL)
			if parseErr != nil {
				t.Fatal(parseErr)
			}
			_, _, startErr := Start(context.Background(), StartOptions{
				BaseURL:               baseURL,
				HostAdmissionPassword: password,
			})
			if startErr == nil {
				t.Fatal("invalid host admission response was accepted")
			}
			reported := startErr.Error()
			if strings.Contains(reported, password) || strings.Contains(reported, grant) || strings.Contains(reported, server.URL) {
				t.Fatalf("host admission error leaked untrusted data: %q", reported)
			}
		})
	}
}

func TestCreateRoomFailuresAreStrictAndDoNotLeakGrant(t *testing.T) {
	const grant = "g1.1.1893456000.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
	tests := []struct {
		name   string
		status int
		body   func(string) string
	}{
		{name: "unauthorized", status: http.StatusUnauthorized, body: func(string) string { return `{"error":"` + grant + `"}` }},
		{name: "wrong-success-status", status: http.StatusOK, body: func(origin string) string {
			return validRoomResponseJSON(origin, "1", "1", nil)
		}},
		{name: "unknown-field", status: http.StatusCreated, body: func(origin string) string {
			return validRoomResponseJSON(origin, "1", "1", map[string]any{"rawGrant": grant})
		}},
		{name: "mismatched-grant-room", status: http.StatusCreated, body: func(origin string) string {
			return validRoomResponseJSON(origin, "2", "1", nil)
		}},
		{name: "missing-room-expiry", status: http.StatusCreated, body: func(origin string) string {
			return validRoomResponseJSON(origin, "1", "1", map[string]any{"expiresAt": omittedJSONField{}})
		}},
		{name: "persistent-room", status: http.StatusCreated, body: func(origin string) string {
			return validRoomResponseJSON(origin, "1", "1", map[string]any{"expiresAt": nil})
		}},
		{name: "grant-expiry-mismatch", status: http.StatusCreated, body: func(origin string) string {
			return validRoomResponseJSON(origin, "1", "1", map[string]any{
				"viewerGrantExpiresAt": time.Now().UTC().Add(25 * time.Hour).Truncate(time.Second).Format(time.RFC3339),
			})
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			mux := http.NewServeMux()
			var server *httptest.Server
			mux.HandleFunc("/api/host-admission", func(response http.ResponseWriter, request *http.Request) {
				writeHarnessJSON(response, map[string]any{"required": false, "authenticated": true})
			})
			mux.HandleFunc("/api/rooms", func(response http.ResponseWriter, request *http.Request) {
				response.WriteHeader(test.status)
				_, _ = response.Write([]byte(test.body(server.URL)))
			})
			server = httptest.NewServer(mux)
			defer server.Close()
			baseURL, parseErr := url.Parse(server.URL)
			if parseErr != nil {
				t.Fatal(parseErr)
			}
			_, _, startErr := Start(context.Background(), StartOptions{BaseURL: baseURL})
			if startErr == nil {
				t.Fatal("invalid room response was accepted")
			}
			if strings.Contains(startErr.Error(), grant) || strings.Contains(startErr.Error(), server.URL) {
				t.Fatalf("room creation error leaked untrusted data: %q", startErr)
			}
		})
	}
}

func TestSessionTerminalPathsAbandonFreshRoomExactlyOnce(t *testing.T) {
	tests := []struct {
		name      string
		terminate func(*Session)
		wantFatal bool
	}{
		{name: "stop", terminate: func(session *Session) { session.Stop() }},
		{name: "process-close", terminate: func(session *Session) { session.Close() }},
		{name: "local-fatal", terminate: func(session *Session) { session.Fail(errors.New("local bridge failed")) }, wantFatal: true},
		{name: "concurrent", terminate: func(session *Session) {
			var wait sync.WaitGroup
			for index := 0; index < 8; index++ {
				wait.Add(1)
				go func(closeSession bool) {
					defer wait.Done()
					if closeSession {
						session.Close()
					} else {
						session.Stop()
					}
				}(index%2 == 0)
			}
			wait.Wait()
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			harness := newRemoteHarness(t, []string{"viewer-old"})
			defer harness.Close()
			baseURL, err := url.Parse(harness.URL())
			if err != nil {
				t.Fatal(err)
			}
			var eventsMu sync.Mutex
			var events []Event
			session, _, err := Start(context.Background(), StartOptions{
				BaseURL: baseURL,
				OnEvent: func(event Event) {
					eventsMu.Lock()
					events = append(events, event)
					eventsMu.Unlock()
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			assertAuthenticateShape(t, harness.Authentication())

			session.mu.Lock()
			active, waiting := session.admission.Counts()
			peerCount := len(session.peers)
			session.mu.Unlock()
			if active != 0 || waiting != 0 || peerCount != 0 {
				t.Fatalf("authentication roster allocated media: %d active, %d waiting, %d peers", active, waiting, peerCount)
			}

			test.terminate(session)
			select {
			case <-harness.Done():
			case <-time.After(2 * time.Second):
				t.Fatal("fake signaling server did not observe terminal shutdown")
			}
			if got := harness.AbandonCount(); got != 1 {
				t.Fatalf("abandon-room count = %d, want 1", got)
			}
			if got := string(harness.TerminalMessage()); got != `{"type":"abandon-room"}` {
				t.Fatalf("terminal wire = %q (length %d)", got, len(got))
			}

			eventsMu.Lock()
			defer eventsMu.Unlock()
			fatalCount := 0
			for _, event := range events {
				if event.Kind == "fatal" {
					fatalCount++
				}
			}
			if test.wantFatal && fatalCount != 1 {
				t.Fatalf("fatal event count = %d, want 1", fatalCount)
			}
			if !test.wantFatal && fatalCount != 0 {
				t.Fatalf("normal room closure emitted %d fatal events", fatalCount)
			}
		})
	}
}

func TestSessionSendPropagatesAClosedSignalingConnection(t *testing.T) {
	accepted := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(response, request, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer connection.CloseNow()
		close(accepted)
		_, _, _ = connection.Read(request.Context())
	}))
	defer server.Close()

	websocketURL := "ws" + server.URL[len("http"):]
	connection, _, err := websocket.Dial(context.Background(), websocketURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	<-accepted
	connection.CloseNow()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	session := &Session{ctx: ctx, signalCtx: ctx, conn: connection}
	if err = session.send(simpleMessage{Type: "abandon-room"}); err == nil {
		t.Fatal("signaling write to a closed connection returned success")
	}
}

func TestCanceledSessionContextStillAbandonsTheFreshRoomExactlyOnce(t *testing.T) {
	harness := newRemoteHarness(t, []string{})
	defer harness.Close()
	baseURL, err := url.Parse(harness.URL())
	if err != nil {
		t.Fatal(err)
	}
	parent, cancelParent := context.WithCancel(context.Background())
	session, _, err := Start(parent, StartOptions{BaseURL: baseURL})
	if err != nil {
		cancelParent()
		t.Fatal(err)
	}
	assertAuthenticateShape(t, harness.Authentication())
	cancelParent()
	session.Close()
	select {
	case <-harness.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("canceled session context prevented fresh-room abandonment")
	}
	if got := harness.AbandonCount(); got != 1 {
		t.Fatalf("abandon-room count = %d, want 1", got)
	}
	if got := string(harness.TerminalMessage()); got != `{"type":"abandon-room"}` {
		t.Fatalf("terminal wire = %q", got)
	}
}

func TestSessionCloseWaitsForRoomClosedAcknowledgement(t *testing.T) {
	ackGate := make(chan struct{})
	var releaseOnce sync.Once
	releaseACK := func() { releaseOnce.Do(func() { close(ackGate) }) }

	harness := newRemoteHarness(t, []string{})
	harness.ackGate = ackGate
	defer harness.Close()
	defer releaseACK()
	baseURL, err := url.Parse(harness.URL())
	if err != nil {
		t.Fatal(err)
	}
	var warningCount atomic.Uint64
	session, _, err := Start(context.Background(), StartOptions{
		BaseURL: baseURL,
		OnEvent: func(event Event) {
			if event.Kind == "warning" {
				warningCount.Add(1)
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	assertAuthenticateShape(t, harness.Authentication())

	closed := make(chan struct{})
	go func() {
		session.Close()
		close(closed)
	}()
	select {
	case <-harness.AbandonObserved():
	case <-time.After(2 * time.Second):
		releaseACK()
		t.Fatal("fake signaling server did not observe room abandonment")
	}
	select {
	case <-closed:
		releaseACK()
		t.Fatal("session closed the signaling transport before terminal acknowledgement")
	default:
	}

	releaseACK()
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("session did not close after terminal acknowledgement")
	}
	if got := warningCount.Load(); got != 0 {
		t.Fatalf("acknowledged room abandonment emitted %d warnings", got)
	}
}

func TestSessionCloseBoundsMissingRoomClosedAcknowledgement(t *testing.T) {
	ackGate := make(chan struct{})
	var releaseOnce sync.Once
	releaseACK := func() { releaseOnce.Do(func() { close(ackGate) }) }

	harness := newRemoteHarness(t, []string{})
	harness.ackGate = ackGate
	defer harness.Close()
	defer releaseACK()
	baseURL, err := url.Parse(harness.URL())
	if err != nil {
		t.Fatal(err)
	}
	var warningCount atomic.Uint64
	session, _, err := Start(context.Background(), StartOptions{
		BaseURL: baseURL,
		OnEvent: func(event Event) {
			if event.Kind == "warning" {
				warningCount.Add(1)
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	assertAuthenticateShape(t, harness.Authentication())

	started := time.Now()
	session.Close()
	elapsed := time.Since(started)
	if elapsed < signalWriteTimeout-250*time.Millisecond {
		t.Fatalf("session closed before its terminal deadline: %s", elapsed)
	}
	if elapsed > signalWriteTimeout+2*time.Second {
		t.Fatalf("session exceeded its terminal deadline: %s", elapsed)
	}
	if got := harness.AbandonCount(); got != 1 {
		t.Fatalf("abandon-room count = %d, want 1", got)
	}
	if got := warningCount.Load(); got != 1 {
		t.Fatalf("missing acknowledgement emitted %d warnings, want 1", got)
	}
	releaseACK()
}

func TestReaderOriginatedFatalAbandonsOnceWithoutDeadlock(t *testing.T) {
	harness := newRemoteHarness(t, []string{})
	harness.afterAuth = [][]byte{[]byte(`{"type":"error","code":"SERVER_ERROR","message":"bounded failure"}`)}
	defer harness.Close()
	baseURL, err := url.Parse(harness.URL())
	if err != nil {
		t.Fatal(err)
	}
	fatal := make(chan string, 1)
	session, _, err := Start(context.Background(), StartOptions{
		BaseURL: baseURL,
		OnEvent: func(event Event) {
			if event.Kind == "fatal" {
				select {
				case fatal <- event.Message:
				default:
				}
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	assertAuthenticateShape(t, harness.Authentication())

	select {
	case <-harness.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("reader-originated fatal did not complete terminal cleanup")
	}
	if got := harness.AbandonCount(); got != 1 {
		t.Fatalf("abandon-room count = %d, want 1", got)
	}
	select {
	case message := <-fatal:
		if message == "" {
			t.Fatal("reader-originated fatal message is empty")
		}
	default:
		t.Fatal("reader-originated error did not emit a fatal event")
	}
}

type remoteHarness struct {
	testing         *testing.T
	server          *httptest.Server
	authentication  chan []byte
	done            chan struct{}
	doneOnce        sync.Once
	abandonObserved chan struct{}
	abandonOnce     sync.Once
	ackGate         <-chan struct{}
	afterAuth       [][]byte
	terminalMu      sync.Mutex
	terminal        []byte
	abandonCount    atomic.Uint64
	password        string
	admission       chan capturedRequest
	roomCreation    chan capturedRequest
	signalCookie    chan string
}

type capturedRequest struct {
	Method        string
	Authorization string
	Cookie        string
	Origin        string
	ContentType   string
	Body          string
}

func newRemoteHarness(t *testing.T, roster []string) *remoteHarness {
	return newRemoteHarnessWithPassword(t, roster, "")
}

func newRemoteHarnessWithPassword(t *testing.T, roster []string, password string) *remoteHarness {
	t.Helper()
	harness := &remoteHarness{
		testing:         t,
		authentication:  make(chan []byte, 1),
		done:            make(chan struct{}),
		abandonObserved: make(chan struct{}),
		password:        password,
		admission:       make(chan capturedRequest, 1),
		roomCreation:    make(chan capturedRequest, 1),
		signalCookie:    make(chan string, 1),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/host-admission", func(response http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		harness.admission <- capturedRequest{
			Method:        request.Method,
			Authorization: request.Header.Get("Authorization"),
			Origin:        request.Header.Get("Origin"),
			Body:          string(body),
		}
		if password == "" {
			writeHarnessJSON(response, map[string]any{"required": false, "authenticated": true})
			return
		}
		if request.Header.Get("Authorization") != "Bearer "+password {
			response.WriteHeader(http.StatusUnauthorized)
			writeHarnessJSON(response, map[string]string{"error": "secret must never be reflected"})
			return
		}
		response.Header().Set("Set-Cookie", "screener-host-admission=v1.1893456000."+strings.Repeat("a", 43)+"; Path=/; Max-Age=43200; HttpOnly; SameSite=Strict")
		writeHarnessJSON(response, map[string]any{"required": true, "authenticated": true})
	})
	mux.HandleFunc("/api/rooms", func(response http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		harness.roomCreation <- capturedRequest{
			Method:        request.Method,
			Authorization: request.Header.Get("Authorization"),
			Cookie:        request.Header.Get("Cookie"),
			Origin:        request.Header.Get("Origin"),
			ContentType:   request.Header.Get("Content-Type"),
			Body:          string(body),
		}
		if password != "" && request.Header.Get("Cookie") == "" {
			response.WriteHeader(http.StatusUnauthorized)
			return
		}
		response.WriteHeader(http.StatusCreated)
		_, _ = response.Write([]byte(validRoomResponseJSON(harness.server.URL, "1", "1", nil)))
	})
	mux.HandleFunc("/signal", func(response http.ResponseWriter, request *http.Request) {
		harness.signalCookie <- request.Header.Get("Cookie")
		if password != "" && request.Header.Get("Cookie") == "" {
			http.Error(response, "unauthorized", http.StatusUnauthorized)
			return
		}
		connection, err := websocket.Accept(response, request, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			harness.finish()
			return
		}
		defer connection.CloseNow()
		messageType, payload, err := connection.Read(request.Context())
		if err != nil || messageType != websocket.MessageText {
			harness.finish()
			return
		}
		harness.authentication <- append([]byte(nil), payload...)
		authenticated, _ := json.Marshal(map[string]any{
			"type": "authenticated", "protocol": signalingProtocol, "role": "host", "peerId": "host-peer",
			"roomExpiresAt": nil, "maxViewers": 3, "hostOnline": true,
			"connectionId": nil, "viewerPeerIds": roster,
			"iceConfig":    map[string]any{"iceServers": []any{}},
			"viewerPolicy": privateViewerPolicy, "viewerAuthorizationGeneration": "viewer_generation_12345678",
		})
		if err = connection.Write(request.Context(), websocket.MessageText, authenticated); err != nil {
			harness.finish()
			return
		}
		for _, message := range harness.afterAuth {
			if err = connection.Write(request.Context(), websocket.MessageText, message); err != nil {
				harness.finish()
				return
			}
		}
		for {
			messageType, payload, err = connection.Read(request.Context())
			if err != nil {
				harness.finish()
				return
			}
			if messageType != websocket.MessageText {
				continue
			}
			var discriminator struct {
				Type string `json:"type"`
			}
			_ = json.Unmarshal(payload, &discriminator)
			if discriminator.Type != "abandon-room" {
				continue
			}
			harness.abandonCount.Add(1)
			harness.terminalMu.Lock()
			harness.terminal = append([]byte(nil), payload...)
			harness.terminalMu.Unlock()
			harness.abandonOnce.Do(func() { close(harness.abandonObserved) })
			if harness.ackGate != nil {
				select {
				case <-harness.ackGate:
				case <-request.Context().Done():
					harness.finish()
					return
				}
			}
			closed := []byte(`{"type":"room-closed","reason":"host-ended"}`)
			_ = connection.Write(context.Background(), websocket.MessageText, closed)
			harness.finish()
			return
		}
	})
	harness.server = httptest.NewServer(mux)
	return harness
}

func (harness *remoteHarness) URL() string {
	return harness.server.URL
}

func (harness *remoteHarness) Authentication() []byte {
	select {
	case payload := <-harness.authentication:
		return payload
	case <-time.After(2 * time.Second):
		harness.testing.Fatal("fake signaling server did not receive authentication")
		return nil
	}
}

func (harness *remoteHarness) TerminalMessage() []byte {
	harness.terminalMu.Lock()
	defer harness.terminalMu.Unlock()
	return append([]byte(nil), harness.terminal...)
}

func (harness *remoteHarness) AbandonCount() uint64 {
	return harness.abandonCount.Load()
}

func (harness *remoteHarness) Done() <-chan struct{} {
	return harness.done
}

func (harness *remoteHarness) AbandonObserved() <-chan struct{} {
	return harness.abandonObserved
}

func (harness *remoteHarness) Close() {
	harness.server.Close()
}

func (harness *remoteHarness) finish() {
	harness.doneOnce.Do(func() { close(harness.done) })
}

func writeHarnessJSON(response http.ResponseWriter, value any) {
	response.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(response).Encode(value)
}

type omittedJSONField struct{}

func validRoomResponseJSON(origin, roomID, grantRoomID string, overrides map[string]any) string {
	expiresAt := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	grant := "g1." + grantRoomID + "." + strconv.FormatInt(expiresAt.Unix(), 10) + "." + strings.Repeat("b", 43)
	response := map[string]any{
		"roomId": roomID, "hostToken": "0123456789abcdef0123456789abcdef",
		"inviteUrl":    origin + "/r/" + roomID + "#v=" + grant,
		"viewerPolicy": privateViewerPolicy, "viewerGrantExpiresAt": expiresAt.Format(time.RFC3339), "expiresAt": expiresAt.Format(time.RFC3339),
	}
	for key, value := range overrides {
		if _, omitted := value.(omittedJSONField); omitted {
			delete(response, key)
			continue
		}
		response[key] = value
	}
	payload, err := json.Marshal(response)
	if err != nil {
		panic(err)
	}
	return string(payload)
}

func assertAuthenticateShape(t *testing.T, payload []byte) {
	t.Helper()
	var message map[string]any
	if err := json.Unmarshal(payload, &message); err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(message))
	for key := range message {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	want := []string{"clientId", "protocol", "role", "roomId", "shareGeneration", "token", "type"}
	if len(keys) != len(want) {
		t.Fatalf("authentication keys = %v", keys)
	}
	for index := range want {
		if keys[index] != want[index] {
			t.Fatalf("authentication keys = %v, want %v", keys, want)
		}
	}
	if message["type"] != "authenticate" || message["protocol"] != signalingProtocol ||
		message["role"] != "host" || message["roomId"] != "1" {
		t.Fatalf("authentication = %v", message)
	}
}
