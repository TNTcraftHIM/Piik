package loopback

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

const testOrigin = "https://share.bonfire.icu"

func TestStartServesHealthAndStrictControlHandshake(t *testing.T) {
	expectedMedia := NativeMediaCapabilities{
		Video: true, ProcessAudio: false, SystemAudio: true, HardwareH264: true,
	}
	server := startTestServerWithOptions(t, Options{
		AllowedOrigin: testOrigin,
		NativeMedia:   expectedMedia,
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

func TestOnlyOneControlSessionIsClaimed(t *testing.T) {
	server := startTestServer(t, testOrigin)
	endpoint := server.Endpoint()
	first := dialControl(t, endpoint, endpoint.InstanceToken, testOrigin)
	defer first.CloseNow()
	second, response, err := websocket.Dial(context.Background(), websocketURL(endpoint)+"/control", &websocket.DialOptions{
		HTTPHeader:   http.Header{"Origin": []string{testOrigin}},
		Subprotocols: []string{ControlSubprotocol + "." + endpoint.InstanceToken},
	})
	if second != nil {
		second.CloseNow()
	}
	if err == nil || response == nil || response.StatusCode != http.StatusConflict {
		t.Fatalf("second control dial: conn=%v response=%v err=%v", second, response, err)
	}
}

func TestControlSessionSharesOneBoundedSocketForResponsesAndEvents(t *testing.T) {
	extension := &testControlSession{
		events: make(chan any, 1),
		closed: make(chan struct{}),
	}
	server := startTestServerWithOptions(t, Options{
		AllowedOrigin: testOrigin,
		NewControl: func() ControlSession {
			return extension
		},
	})
	connection := dialControl(t, server.Endpoint(), server.Endpoint().InstanceToken, testOrigin)
	writeControl(t, connection, requestJSON("request_hello", "hello"))
	var ready controlMessage
	readControl(t, connection, &ready)
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
	return startTestServerWithOptions(t, Options{AllowedOrigin: origin})
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

func (session *testControlSession) Handle(_ context.Context, payload []byte) (any, error) {
	message, err := decodeEnvelope(payload)
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
