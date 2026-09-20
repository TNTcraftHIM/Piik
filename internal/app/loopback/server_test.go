package loopback

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

const testOrigin = "https://share.example.com"

func TestStartServesHealthAndStrictControlHandshake(t *testing.T) {
	expectedMedia := NativeMediaCapabilities{
		Video: true, ProcessAudio: false, SystemAudio: true, HardwareH264: true,
	}
	server := startTestServerWithOptions(t, Options{
		AllowedOrigins: []string{testOrigin},
		NativeMedia:    expectedMedia,
	})
	endpoint := server.Endpoint()

	var health Health
	response := doHealthRequest(t, endpoint, endpoint.Host, testOrigin)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("health status = %d", response.StatusCode)
	}
	if err := json.NewDecoder(response.Body).Decode(&health); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if health.Protocol != ProtocolVersion || health.Service != ServiceName ||
		health.Port != endpoint.Port || health.InstanceToken != endpoint.InstanceToken ||
		health.NativeMedia != expectedMedia {
		t.Fatalf("health = %+v", health)
	}

	connection := dialControl(t, endpoint, endpoint.InstanceToken, testOrigin)
	defer connection.CloseNow()
	writeControl(t, connection, requestJSON("request_hello", "hello"))
	var ready controlMessage
	readControl(t, connection, &ready)
	if ready.Type != "ready" || ready.ID != "request_hello" {
		t.Fatalf("ready = %+v", ready)
	}

	writeControl(t, connection, requestJSON("request_ping", "ping"))
	var pong controlMessage
	readControl(t, connection, &pong)
	if pong.Type != "pong" || pong.ID != "request_ping" {
		t.Fatalf("pong = %+v", pong)
	}
}

func TestHealthRejectsUnexpectedOriginAndHost(t *testing.T) {
	server := startTestServer(t, testOrigin)
	endpoint := server.Endpoint()
	response := doHealthRequest(t, endpoint, endpoint.Host, "https://other.example")
	response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("bad origin status = %d", response.StatusCode)
	}
	response = doHealthRequest(t, endpoint, "127.0.0.2:"+strconv.Itoa(endpoint.Port), testOrigin)
	response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("bad host status = %d", response.StatusCode)
	}
}

func TestHealthAcceptsTheLocalHostAlias(t *testing.T) {
	server := startTestServer(t, testOrigin)
	endpoint := server.Endpoint()
	response := doHealthRequest(t, endpoint,
		"localhost:"+strconv.Itoa(endpoint.Port),
		"http://localhost:"+strconv.Itoa(endpoint.Port),
	)
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("localhost health status = %d", response.StatusCode)
	}
}

func TestPresentationUpdatesOnlyLanguageWithoutClaimingMediaControl(t *testing.T) {
	languages := make(chan string, 3)
	var server *Server
	server = startTestServerWithOptions(t, Options{
		AllowedOrigins: []string{testOrigin},
		Presentation: func(language string) {
			server.SetAllowedOrigins([]string{testOrigin})
			languages <- language
		},
	})
	endpoint := server.Endpoint()
	connection := dialControl(t, endpoint, endpoint.InstanceToken, testOrigin)
	defer connection.CloseNow()
	writeControl(t, connection, requestJSON("request_hello", "hello"))
	var ready controlMessage
	readControl(t, connection, &ready)
	client := &http.Client{Timeout: time.Second}
	for _, input := range []struct {
		method, path, origin, body, language string
		status                               int
	}{
		{http.MethodPost, "/presentation", testOrigin, `{"language":"zh"}`, "zh", http.StatusNoContent},
		{http.MethodPost, "/presentation", testOrigin, `{"language":"en"}`, "en", http.StatusNoContent},
		{http.MethodPost, "/presentation", endpoint.URL, `{"language":"vis"}`, "vis", http.StatusNoContent},
		{http.MethodOptions, "/presentation", testOrigin, "", "", http.StatusNoContent},
		{http.MethodPost, "/presentation", "https://other.example", `{"language":"en"}`, "", http.StatusForbidden},
		{http.MethodOptions, "/presentation", "https://other.example", "", "", http.StatusForbidden},
		{http.MethodOptions, "/health", testOrigin, "", "", http.StatusNoContent},
		{http.MethodOptions, "/health", "https://other.example", "", "", http.StatusForbidden},
		{http.MethodGet, "/presentation", testOrigin, "", "", http.StatusMethodNotAllowed},
		{http.MethodPost, "/presentation", testOrigin, `{"language":"other"}`, "", http.StatusBadRequest},
		{http.MethodPost, "/presentation", testOrigin, `{"language":"en","capture":true}`, "", http.StatusBadRequest},
		{http.MethodPost, "/presentation", testOrigin, `{"language":"en"}{}`, "", http.StatusBadRequest},
		{http.MethodPost, "/presentation", testOrigin, strings.Repeat(" ", 257) + `{"language":"en"}`, "", http.StatusBadRequest},
	} {
		request, err := http.NewRequest(input.method, endpoint.URL+input.path, strings.NewReader(input.body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Origin", input.origin)
		request.Header.Set("Content-Type", "application/json")
		if input.method == http.MethodOptions {
			request.Header.Set("Access-Control-Request-Private-Network", "true")
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != input.status {
			t.Fatalf("%s %s status = %d, want %d", input.method, input.path, response.StatusCode, input.status)
		}
		if input.method == http.MethodOptions && input.status == http.StatusNoContent &&
			(response.Header.Get("Access-Control-Allow-Origin") != testOrigin ||
				response.Header.Get("Access-Control-Allow-Private-Network") != "true" ||
				(input.path == "/presentation" && (response.Header.Get("Access-Control-Allow-Methods") != "POST" ||
					response.Header.Get("Access-Control-Allow-Headers") != "Content-Type")) ||
				(input.path == "/health" && response.Header.Get("Access-Control-Allow-Methods") != "GET")) {
			t.Fatal("presentation preflight did not preserve its bounded origin/method scope")
		}
		select {
		case language := <-languages:
			if language != input.language {
				t.Fatalf("unexpected presentation callback: %q", language)
			}
		default:
			if input.language != "" {
				t.Fatal("presentation callback missing")
			}
		}
	}
	writeControl(t, connection, requestJSON("request_ping", "ping"))
	var pong controlMessage
	readControl(t, connection, &pong)
	if pong.Type != "pong" {
		t.Fatal("presentation changed the active media control")
	}
}

func TestControlSessionsAreBoundedAndRetireIndependently(t *testing.T) {
	created := make(chan *testControlSession, maxControlSessions)
	server := startTestServerWithOptions(t, Options{
		AllowedOrigins: []string{testOrigin},
		NewControl: func() ControlSession {
			session := &testControlSession{events: make(chan any), closed: make(chan struct{})}
			created <- session
			return session
		},
	})
	endpoint := server.Endpoint()
	var connections []*websocket.Conn
	var sessions []*testControlSession
	for index := 0; index < maxControlSessions; index++ {
		connection := dialControl(t, endpoint, endpoint.InstanceToken, testOrigin)
		defer connection.CloseNow()
		writeControl(t, connection, requestJSON("request_hello", "hello"))
		var ready controlMessage
		readControl(t, connection, &ready)
		connections = append(connections, connection)
		select {
		case session := <-created:
			sessions = append(sessions, session)
		case <-time.After(time.Second):
			t.Fatal("accepted control did not acquire its own session")
		}
	}
	extra, response, err := websocket.Dial(context.Background(), websocketURL(endpoint)+"/control", &websocket.DialOptions{
		HTTPHeader:   http.Header{"Origin": []string{testOrigin}},
		Subprotocols: []string{ControlSubprotocol + "." + endpoint.InstanceToken},
	})
	if extra != nil {
		extra.CloseNow()
	}
	if err == nil || response == nil || response.StatusCode != http.StatusConflict {
		t.Fatalf("excess control dial: conn=%v response=%v err=%v", extra, response, err)
	}
	_ = response.Body.Close()
	_ = connections[0].CloseNow()
	select {
	case <-sessions[0].closed:
	case <-time.After(time.Second):
		t.Fatal("closed room retained its native session")
	}
	writeControl(t, connections[1], requestJSON("request_ping", "ping"))
	var pong controlMessage
	readControl(t, connections[1], &pong)
	if pong.Type != "pong" {
		t.Fatal("closing one room affected its sibling control")
	}
	if err = server.Close(); err != nil {
		t.Fatal(err)
	}
	for _, session := range sessions {
		select {
		case <-session.closed:
		default:
			t.Fatal("App close returned before native session cleanup")
		}
	}
}

func TestControlSessionSharesOneBoundedSocketForResponsesAndEvents(t *testing.T) {
	extension := &testControlSession{
		events: make(chan any, 1),
		closed: make(chan struct{}),
	}
	server := startTestServerWithOptions(t, Options{
		AllowedOrigins: []string{testOrigin},
		NewControl: func() ControlSession {
			return extension
		},
	})
	connection := dialControl(t, server.Endpoint(), server.Endpoint().InstanceToken, testOrigin)
	writeControl(t, connection, requestJSON("request_hello", "hello"))
	var ready controlMessage
	readControl(t, connection, &ready)
	// The old owner's event was queued while valid, but retired before delivery.
	current := true
	retired := ControlEvent{Value: controlMessage{Version: ProtocolVersion, Type: "retired-event"},
		Current: func() bool { return current }}
	current = false
	extension.events <- retired
	extension.events <- ControlEvent{
		Value:   controlMessage{Version: ProtocolVersion, Type: "current-event"},
		Current: func() bool { return true },
	}
	var currentEvent controlMessage
	readControl(t, connection, &currentEvent)
	if currentEvent.Type != "current-event" {
		t.Fatalf("retired event escaped the delivery fence: %+v", currentEvent)
	}
	extension.events <- controlMessage{
		Version: ProtocolVersion, ID: "event_123456", Type: "extension-event",
	}
	writeControl(t, connection, requestJSON("request_extension", "extension"))
	received := map[string]bool{}
	for len(received) < 2 {
		var message controlMessage
		readControl(t, connection, &message)
		received[message.Type] = true
	}
	if !received["extension-event"] || !received["extension-response"] {
		t.Fatalf("control messages = %+v", received)
	}
	connection.CloseNow()
	select {
	case <-extension.closed:
	case <-time.After(time.Second):
		t.Fatal("control extension was not closed with its socket")
	}
}

func TestControlClosesTheSocketWhenItsReaderRejectsAFrame(t *testing.T) {
	server := startTestServer(t, testOrigin)
	connection := dialControl(t, server.Endpoint(), server.Endpoint().InstanceToken, testOrigin)
	defer connection.CloseNow()
	writeControl(t, connection, requestJSON("request_hello", "hello"))
	var ready controlMessage
	readControl(t, connection, &ready)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := connection.Write(ctx, websocket.MessageBinary, []byte("invalid")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := connection.Read(ctx); err == nil || ctx.Err() != nil {
		t.Fatalf("server did not close its rejected control socket: %v", err)
	}
}

func TestControlCloseCancelsAHandlerWaitingForPicker(t *testing.T) {
	extension := &blockingControlSession{
		startedSignal: make(chan struct{}),
		closedSignal:  make(chan struct{}),
	}
	server := startTestServerWithOptions(t, Options{
		AllowedOrigins: []string{testOrigin},
		NewControl: func() ControlSession {
			return extension
		},
	})
	connection := dialControl(t, server.Endpoint(), server.Endpoint().InstanceToken, testOrigin)
	writeControl(t, connection, requestJSON("request_hello", "hello"))
	var ready controlMessage
	readControl(t, connection, &ready)
	writeControl(t, connection, requestJSON("request_extension", "extension"))
	select {
	case <-extension.startedSignal:
	case <-time.After(time.Second):
		t.Fatal("control handler did not start")
	}
	connection.CloseNow()
	select {
	case <-extension.closedSignal:
	case <-time.After(time.Second):
		t.Fatal("closing the control socket did not release the picker handler")
	}

	deadline := time.Now().Add(time.Second)
	for {
		second, response, err := websocket.Dial(context.Background(),
			websocketURL(server.Endpoint())+"/control", &websocket.DialOptions{
				HTTPHeader:   http.Header{"Origin": []string{testOrigin}},
				Subprotocols: []string{ControlSubprotocol + "." + server.Endpoint().InstanceToken},
			})
		if err == nil {
			second.CloseNow()
			return
		}
		if response != nil && response.Body != nil {
			response.Body.Close()
		}
		if time.Now().After(deadline) {
			t.Fatalf("control session was not released: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestControlSessionProcessesARequestBurstInOrder(t *testing.T) {
	extension := &testControlSession{
		events: make(chan any, 1),
		closed: make(chan struct{}),
	}
	server := startTestServerWithOptions(t, Options{
		AllowedOrigins: []string{testOrigin},
		NewControl: func() ControlSession {
			return extension
		},
	})
	connection := dialControl(t, server.Endpoint(), server.Endpoint().InstanceToken, testOrigin)
	defer connection.CloseNow()
	writeControl(t, connection, requestJSON("request_hello", "hello"))
	var ready controlMessage
	readControl(t, connection, &ready)
	const burst = 32
	for index := 0; index < burst; index++ {
		writeControl(t, connection, requestJSON(
			fmt.Sprintf("request_extension_%d", index), "extension",
		))
	}
	seen := make(map[string]bool, burst)
	for len(seen) < burst {
		var response controlMessage
		readControl(t, connection, &response)
		seen[response.ID] = true
	}
	for index := 0; index < burst; index++ {
		if !seen[fmt.Sprintf("request_extension_%d", index)] {
			t.Fatalf("request %d was not processed", index)
		}
	}
}

func TestDeferredResponseKeepsControlResponsiveAndRequestIdentity(t *testing.T) {
	extension := &testControlSession{events: make(chan any, 1), closed: make(chan struct{})}
	server := startTestServerWithOptions(t, Options{AllowedOrigins: []string{testOrigin},
		NewControl: func() ControlSession { return extension }})
	connection := dialControl(t, server.Endpoint(), server.Endpoint().InstanceToken, testOrigin)
	defer connection.CloseNow()
	writeControl(t, connection, requestJSON("request_hello", "hello"))
	var value controlMessage
	readControl(t, connection, &value)
	writeControl(t, connection, requestJSON("request_pending", "deferred"))
	writeControl(t, connection, requestJSON("request_ping", "ping"))
	readControl(t, connection, &value)
	if value.Type != "pong" || value.ID != "request_ping" {
		t.Fatalf("pending operation blocked control: %+v", value)
	}
	extension.events <- controlMessage{Version: ProtocolVersion, ID: "request_pending", Type: "extension-response"}
	readControl(t, connection, &value)
	if value.Type != "extension-response" || value.ID != "request_pending" {
		t.Fatalf("deferred response lost its request identity: %+v", value)
	}
}

func TestStartAlwaysBindsToIPv4Loopback(t *testing.T) {
	server := startTestServer(t, testOrigin)
	host, _, err := net.SplitHostPort(server.Endpoint().Host)
	if err != nil || host != "127.0.0.1" {
		t.Fatalf("helper host = %q, %v", host, err)
	}
}

func TestCloseStopsTheControlSession(t *testing.T) {
	server := startTestServer(t, testOrigin)
	endpoint := server.Endpoint()
	connection := dialControl(t, endpoint, endpoint.InstanceToken, testOrigin)
	if err := server.Close(); err != nil {
		t.Fatal(err)
	}
	readContext, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, _, err := connection.Read(readContext); err == nil {
		t.Fatal("control connection remained open after server close")
	}
	connection.CloseNow()
}

func TestUnexpectedServeFailureIsReported(t *testing.T) {
	server := startTestServer(t, testOrigin)
	if err := server.listener.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-server.Done():
		if err == nil {
			t.Fatal("unexpected listener close was reported as a clean shutdown")
		}
	case <-time.After(time.Second):
		t.Fatal("serve failure was not reported")
	}
}

func startTestServer(t *testing.T, origin string) *Server {
	t.Helper()
	return startTestServerWithOptions(t, Options{AllowedOrigins: []string{origin}})
}

func startTestServerWithOptions(t *testing.T, options Options) *Server {
	t.Helper()
	port := freePort(t)
	options.PortStart = port
	options.PortEnd = port
	server, err := Start(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	return server
}

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

func doHealthRequest(t *testing.T, endpoint Endpoint, host, origin string) *http.Response {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, endpoint.URL+"/health", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Host = host
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func dialControl(t *testing.T, endpoint Endpoint, token, origin string) *websocket.Conn {
	t.Helper()
	connection, _, err := websocket.Dial(context.Background(), websocketURL(endpoint)+"/control", &websocket.DialOptions{
		HTTPHeader:   http.Header{"Origin": []string{origin}},
		Subprotocols: []string{ControlSubprotocol + "." + token},
	})
	if err != nil {
		t.Fatal(err)
	}
	return connection
}

func websocketURL(endpoint Endpoint) string {
	return strings.Replace(endpoint.URL, "http://", "ws://", 1)
}

func writeControl(t *testing.T, connection *websocket.Conn, value map[string]any) {
	t.Helper()
	if err := wsjson.Write(context.Background(), connection, value); err != nil {
		t.Fatal(err)
	}
}

func readControl(t *testing.T, connection *websocket.Conn, value any) {
	t.Helper()
	contextWithDeadline, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := wsjson.Read(contextWithDeadline, connection, value); err != nil {
		t.Fatal(err)
	}
}

func requestJSON(id, messageType string) map[string]any {
	return map[string]any{
		"version": ProtocolVersion,
		"id":      id,
		"type":    messageType,
	}
}

type testControlSession struct {
	events chan any
	closed chan struct{}
}

type blockingControlSession struct {
	started       sync.Once
	closed        sync.Once
	startedSignal chan struct{}
	closedSignal  chan struct{}
}

func (session *blockingControlSession) Handle(ctx context.Context, _ []byte) (any, error) {
	session.started.Do(func() { close(session.startedSignal) })
	<-ctx.Done()
	return nil, ctx.Err()
}

func (session *blockingControlSession) Events() <-chan any {
	return nil
}

func (session *blockingControlSession) Close() error {
	session.closed.Do(func() { close(session.closedSignal) })
	return nil
}

func (session *testControlSession) Handle(_ context.Context, payload []byte) (any, error) {
	message, err := decodeEnvelope(payload)
	if err == nil && message.Type == "deferred" {
		return nil, nil
	}
	if err != nil || message.Type != "extension" {
		return nil, errors.New("unexpected extension request")
	}
	return controlMessage{
		Version: ProtocolVersion, ID: message.ID, Type: "extension-response",
	}, nil
}

func (session *testControlSession) Events() <-chan any {
	return session.events
}

func (session *testControlSession) Close() error {
	select {
	case <-session.closed:
	default:
		close(session.closed)
	}
	return nil
}
