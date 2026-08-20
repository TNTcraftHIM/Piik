package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Screener/native/sender/internal/remote"
	"github.com/coder/websocket"
)

func TestEncoderConfigUsesTheFixedHighContract(t *testing.T) {
	config := encoderConfig{
		Kind: "config", Codec: "vp8", Width: 1280, Height: 720,
		FPS: 30, Bitrate: 3_000_000, EncoderInstances: 1,
	}
	if !validEncoderConfig(config) {
		t.Fatal("fixed 720p30/3 Mbps HIGH config was rejected")
	}
	config.Bitrate = 4_000_000
	if validEncoderConfig(config) {
		t.Fatal("unowned 4 Mbps config was accepted")
	}
}

func TestDecodeLocalPayloadIsStrictAndSingleValued(t *testing.T) {
	valid := []byte(`{"kind":"config","codec":"vp8","width":1280,"height":720,"fps":30,"bitrate":3000000,"encoderInstances":1}`)
	var config encoderConfig
	if err := decodeLocalPayload(valid, &config); err != nil {
		t.Fatal(err)
	}
	invalid := [][]byte{
		[]byte(`{"kind":"config","codec":"vp8","width":1280,"height":720,"fps":30,"bitrate":3000000,"encoderInstances":1,"extra":true}`),
		append(append([]byte(nil), valid...), valid...),
	}
	for _, payload := range invalid {
		if err := decodeLocalPayload(payload, &encoderConfig{}); err == nil {
			t.Fatalf("invalid local config was accepted: %s", payload)
		}
	}
}

func TestStaleSessionGenerationCannotMutateOrStopTheCurrentSession(t *testing.T) {
	application := &App{generation: 7, activeViewers: 1, waitingViewers: 2}
	application.emit(6, remote.Event{Kind: "viewer-count", ActiveViewers: 9, WaitingViewers: 9})
	application.emit(6, remote.Event{Kind: "fatal", Message: "stale failure"})
	application.stopActiveGeneration(6)
	application.mu.Lock()
	defer application.mu.Unlock()
	if application.generation != 7 || application.activeViewers != 1 || application.waitingViewers != 2 {
		t.Fatalf("stale generation mutated current state: generation=%d active=%d waiting=%d",
			application.generation, application.activeViewers, application.waitingViewers)
	}
}

func TestStaleMediaClaimCannotReleaseTheCurrentClaim(t *testing.T) {
	application := &App{generation: 7, mediaClaimed: true, mediaClaimID: 11}
	application.releaseMediaClaim(6, 11, nil)
	application.releaseMediaClaim(7, 10, nil)
	application.mu.Lock()
	if !application.mediaClaimed || application.mediaClaimID != 11 {
		application.mu.Unlock()
		t.Fatal("stale media claim released the current claim")
	}
	application.mu.Unlock()
	application.releaseMediaClaim(7, 11, nil)
	application.mu.Lock()
	defer application.mu.Unlock()
	if application.mediaClaimed || application.mediaClaimID != 0 {
		t.Fatal("current media claim was not released")
	}
}

func TestMediaAttachDeadlineAbandonsTheFreshRoom(t *testing.T) {
	remoteDone := make(chan []byte, 1)
	remoteServer := newAppRemoteServer(t, remoteDone)
	defer remoteServer.Close()

	application, err := New()
	if err != nil {
		t.Fatal(err)
	}
	application.attachTimeout = 25 * time.Millisecond
	_, err = application.Start()
	if err != nil {
		t.Fatal(err)
	}
	defer application.Close()

	body, _ := json.Marshal(startRequest{ServerURL: remoteServer.URL})
	request, err := http.NewRequest(http.MethodPost, application.origin+"/api/start", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", application.origin)
	request.Header.Set(processTokenHeader, application.token)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("start status = %d", response.StatusCode)
	}

	select {
	case payload := <-remoteDone:
		if string(payload) != `{"type":"abandon-room"}` {
			t.Fatalf("deadline terminal wire = %q", payload)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("media attach deadline did not abandon the room")
	}
}

func TestSuccessfulStartKeepsTheSessionAliveUntilStop(t *testing.T) {
	remoteDone := make(chan []byte, 1)
	remoteServer := newAppRemoteServer(t, remoteDone)
	defer remoteServer.Close()

	application := startTestApplication(t, remoteServer.URL, time.Second, time.Second)
	select {
	case payload := <-remoteDone:
		t.Fatalf("live session ended before stop: %q", payload)
	case <-time.After(50 * time.Millisecond):
	}
	stopTestApplication(t, application)
	assertAbandonRoom(t, remoteDone)
}

func TestInvalidMediaSubprotocolLeavesTheAttachDeadlineArmed(t *testing.T) {
	remoteDone := make(chan []byte, 1)
	remoteServer := newAppRemoteServer(t, remoteDone)
	defer remoteServer.Close()

	application := startTestApplication(t, remoteServer.URL, 25*time.Millisecond, time.Second)
	connection, _, err := websocket.Dial(context.Background(), application.origin+"/media", &websocket.DialOptions{
		HTTPHeader:   http.Header{"Origin": []string{application.origin}},
		Subprotocols: []string{"screener.token.wrong"},
	})
	if err == nil {
		connection.CloseNow()
	}
	assertAbandonRoom(t, remoteDone)
}

func TestAcceptedMediaWithoutConfigFailsWithinTheHandshakeDeadline(t *testing.T) {
	remoteDone := make(chan []byte, 1)
	remoteServer := newAppRemoteServer(t, remoteDone)
	defer remoteServer.Close()

	application := startTestApplication(t, remoteServer.URL, time.Second, 25*time.Millisecond)
	connection, _, err := websocket.Dial(context.Background(), application.origin+"/media", &websocket.DialOptions{
		HTTPHeader:   http.Header{"Origin": []string{application.origin}},
		Subprotocols: []string{"screener.token." + application.token},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.CloseNow()
	readContext, cancelRead := context.WithTimeout(context.Background(), time.Second)
	defer cancelRead()
	if _, _, err = connection.Read(readContext); err != nil {
		t.Fatalf("read local ready message: %v", err)
	}
	assertAbandonRoom(t, remoteDone)
}

func TestStopDuringDelayedStartCannotResurrectTheSession(t *testing.T) {
	authReceived := make(chan struct{})
	releaseAuthentication := make(chan struct{})
	remoteServer := newDelayedAppRemoteServer(t, authReceived, releaseAuthentication)
	defer remoteServer.Close()

	application, err := New()
	if err != nil {
		t.Fatal(err)
	}
	_, err = application.Start()
	if err != nil {
		t.Fatal(err)
	}
	defer application.Close()

	type requestResult struct {
		status int
		err    error
	}
	startResult := make(chan requestResult, 1)
	go func() {
		status, requestErr := doLocalPost(application, "/api/start", startRequest{ServerURL: remoteServer.URL})
		startResult <- requestResult{status: status, err: requestErr}
	}()
	select {
	case <-authReceived:
	case <-time.After(2 * time.Second):
		t.Fatal("remote signaling authentication was not received")
	}
	if status := postLocal(t, application, "/api/stop", nil); status != http.StatusNoContent {
		t.Fatalf("stop status = %d", status)
	}
	close(releaseAuthentication)
	select {
	case result := <-startResult:
		if result.err != nil {
			t.Fatal(result.err)
		}
		if result.status == http.StatusCreated {
			t.Fatal("a canceled delayed start returned success")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("canceled delayed start did not finish")
	}
	application.mu.Lock()
	defer application.mu.Unlock()
	if application.session != nil || application.sessionCancel != nil || application.starting {
		t.Fatal("canceled delayed start resurrected an active session")
	}
}

func startTestApplication(t *testing.T, remoteURL string, attachTimeout, configTimeout time.Duration) *App {
	t.Helper()
	application, err := New()
	if err != nil {
		t.Fatal(err)
	}
	application.attachTimeout = attachTimeout
	application.configTimeout = configTimeout
	_, err = application.Start()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	if status := postLocal(t, application, "/api/start", startRequest{ServerURL: remoteURL}); status != http.StatusCreated {
		t.Fatalf("start status = %d", status)
	}
	return application
}

func stopTestApplication(t *testing.T, application *App) {
	t.Helper()
	if status := postLocal(t, application, "/api/stop", nil); status != http.StatusNoContent {
		t.Fatalf("stop status = %d", status)
	}
}

func postLocal(t *testing.T, application *App, path string, body any) int {
	t.Helper()
	status, err := doLocalPost(application, path, body)
	if err != nil {
		t.Fatal(err)
	}
	return status
}

func doLocalPost(application *App, path string, body any) (int, error) {
	var payload []byte
	if body != nil {
		payload, _ = json.Marshal(body)
	}
	request, err := http.NewRequest(http.MethodPost, application.origin+path, bytes.NewReader(payload))
	if err != nil {
		return 0, err
	}
	request.Header.Set("Origin", application.origin)
	request.Header.Set(processTokenHeader, application.token)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	return response.StatusCode, nil
}

func assertAbandonRoom(t *testing.T, terminal <-chan []byte) {
	t.Helper()
	select {
	case payload := <-terminal:
		if string(payload) != `{"type":"abandon-room"}` {
			t.Fatalf("terminal wire = %q", payload)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("fresh room was not abandoned")
	}
}

func newAppRemoteServer(t *testing.T, terminal chan<- []byte) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	server := httptest.NewServer(mux)
	mux.HandleFunc("/api/host-admission", func(response http.ResponseWriter, request *http.Request) {
		_ = json.NewEncoder(response).Encode(map[string]any{"required": false, "authenticated": true})
	})
	mux.HandleFunc("/api/rooms", func(response http.ResponseWriter, request *http.Request) {
		response.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(response).Encode(appRoomResponse(server.URL))
	})
	mux.HandleFunc("/signal", func(response http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(response, request, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer connection.CloseNow()
		if _, _, err = connection.Read(request.Context()); err != nil {
			return
		}
		authenticated := []byte(`{"type":"authenticated","protocol":"screener-v2","role":"host","peerId":"host-peer","roomExpiresAt":null,"maxViewers":3,"hostOnline":true,"connectionId":null,"viewerPeerIds":[],"iceConfig":{"iceServers":[]},"viewerPolicy":"private-link","viewerAuthorizationGeneration":"viewer_generation_12345678"}`)
		if err = connection.Write(request.Context(), websocket.MessageText, authenticated); err != nil {
			return
		}
		for {
			messageType, payload, readErr := connection.Read(request.Context())
			if readErr != nil {
				return
			}
			if messageType != websocket.MessageText {
				continue
			}
			var message struct {
				Type string `json:"type"`
			}
			_ = json.Unmarshal(payload, &message)
			if message.Type == "abandon-room" {
				terminal <- append([]byte(nil), payload...)
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				_ = connection.Write(ctx, websocket.MessageText, []byte(`{"type":"room-closed","reason":"host-ended"}`))
				cancel()
				return
			}
		}
	})
	return server
}

func newDelayedAppRemoteServer(
	t *testing.T,
	authReceived chan<- struct{},
	releaseAuthentication <-chan struct{},
) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	server := httptest.NewServer(mux)
	mux.HandleFunc("/api/host-admission", func(response http.ResponseWriter, request *http.Request) {
		_ = json.NewEncoder(response).Encode(map[string]any{"required": false, "authenticated": true})
	})
	mux.HandleFunc("/api/rooms", func(response http.ResponseWriter, request *http.Request) {
		response.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(response).Encode(appRoomResponse(server.URL))
	})
	mux.HandleFunc("/signal", func(response http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(response, request, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer connection.CloseNow()
		if _, _, err = connection.Read(request.Context()); err != nil {
			return
		}
		close(authReceived)
		<-releaseAuthentication
		writeContext, cancelWrite := context.WithTimeout(context.Background(), time.Second)
		defer cancelWrite()
		_ = connection.Write(writeContext, websocket.MessageText, []byte(`{"type":"authenticated","protocol":"screener-v2","role":"host","peerId":"host-peer","roomExpiresAt":null,"maxViewers":3,"hostOnline":true,"connectionId":null,"viewerPeerIds":[],"iceConfig":{"iceServers":[]},"viewerPolicy":"private-link","viewerAuthorizationGeneration":"viewer_generation_12345678"}`))
	})
	return server
}

func appRoomResponse(origin string) map[string]any {
	expiresAt := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	grant := "g1.1." + strconv.FormatInt(expiresAt.Unix(), 10) + ".aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	return map[string]any{
		"roomId": "1", "hostToken": "0123456789abcdef0123456789abcdef",
		"inviteUrl":    origin + "/r/1#v=" + grant,
		"viewerPolicy": "private-link", "viewerGrantExpiresAt": expiresAt.Format(time.RFC3339), "expiresAt": expiresAt.Format(time.RFC3339),
	}
}
