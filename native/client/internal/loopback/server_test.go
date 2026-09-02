package loopback

import (
	"context"
	"encoding/json"
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
	server := startTestServer(t, testOrigin)
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
		health.Port != endpoint.Port || health.InstanceToken != endpoint.InstanceToken {
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
	port := freePort(t)
	server, err := Start(context.Background(), Options{
		PortStart:     port,
		PortEnd:       port,
		AllowedOrigin: origin,
	})
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
