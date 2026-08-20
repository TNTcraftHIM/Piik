package app

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/TNTcraftHIM/Screener/native/sender/internal/media"
	"github.com/TNTcraftHIM/Screener/native/sender/internal/remote"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

const (
	processTokenHeader = "X-Screener-Process-Token"
	maxLocalJSONBytes  = 8 << 10
	localWriteTimeout  = 2 * time.Second
	mediaAttachTimeout = 10 * time.Second
	mediaConfigTimeout = 5 * time.Second
)

//go:embed ui/index.html ui/app.js ui/styles.css
var uiFiles embed.FS

type App struct {
	ctx           context.Context
	cancel        context.CancelFunc
	token         string
	attachTimeout time.Duration

	mu             sync.Mutex
	writeMu        sync.Mutex
	server         *http.Server
	listener       net.Listener
	expectedHost   string
	origin         string
	starting       bool
	generation     uint64
	startCancel    context.CancelFunc
	startFailure   string
	session        *remote.Session
	sessionCancel  context.CancelFunc
	room           remote.Room
	mediaConn      *websocket.Conn
	mediaClaimed   bool
	mediaClaimID   uint64
	nextClaimID    uint64
	attachTimer    *time.Timer
	configTimeout  time.Duration
	activeViewers  int
	waitingViewers int
}

type startRequest struct {
	ServerURL string `json:"serverUrl"`
	Password  string `json:"password"`
}

type encoderConfig struct {
	Kind             string `json:"kind"`
	Codec            string `json:"codec"`
	Width            int    `json:"width"`
	Height           int    `json:"height"`
	FPS              int    `json:"fps"`
	Bitrate          int    `json:"bitrate"`
	EncoderInstances int    `json:"encoderInstances"`
}

func New() (*App, error) {
	token, err := newOpaqueToken()
	if err != nil {
		return nil, fmt.Errorf("create process token: %w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &App{
		ctx: ctx, cancel: cancel, token: token,
		attachTimeout: mediaAttachTimeout,
		configTimeout: mediaConfigTimeout,
	}, nil
}

func (app *App) Start() (string, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return "", fmt.Errorf("listen on loopback: %w", err)
	}
	address, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		listener.Close()
		return "", errors.New("loopback listener returned an unexpected address")
	}
	app.listener = listener
	app.expectedHost = fmt.Sprintf("127.0.0.1:%d", address.Port)
	app.origin = "http://" + app.expectedHost
	app.server = &http.Server{
		Handler:           app,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	go func() {
		_ = app.server.Serve(listener)
	}()
	return app.origin + "/#token=" + app.token, nil
}

func (app *App) Close() {
	app.stopActive()
	app.cancel()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if app.server != nil {
		_ = app.server.Shutdown(ctx)
	}
}

func (app *App) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	setSecurityHeaders(response)
	if request.Host != app.expectedHost {
		http.NotFound(response, request)
		return
	}
	switch request.URL.Path {
	case "/":
		app.serveAsset(response, request, "ui/index.html", "text/html; charset=utf-8")
	case "/app.js":
		app.serveAsset(response, request, "ui/app.js", "text/javascript; charset=utf-8")
	case "/styles.css":
		app.serveAsset(response, request, "ui/styles.css", "text/css; charset=utf-8")
	case "/api/start":
		app.handleStart(response, request)
	case "/api/stop":
		app.handleStop(response, request)
	case "/media":
		app.handleMedia(response, request)
	default:
		http.NotFound(response, request)
	}
}

func (app *App) serveAsset(response http.ResponseWriter, request *http.Request, name, contentType string) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	contents, err := uiFiles.ReadFile(name)
	if err != nil {
		http.Error(response, "asset unavailable", http.StatusInternalServerError)
		return
	}
	response.Header().Set("Content-Type", contentType)
	response.Header().Set("Content-Length", fmt.Sprint(len(contents)))
	response.WriteHeader(http.StatusOK)
	_, _ = response.Write(contents)
}

func (app *App) handleStart(response http.ResponseWriter, request *http.Request) {
	if !app.authorizeAPI(response, request, http.MethodPost) {
		return
	}
	var input startRequest
	if err := decodeLocalJSON(request, &input); err != nil {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	baseURL, err := normalizeRemoteBase(input.ServerURL)
	if err != nil {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	app.mu.Lock()
	if app.starting || app.session != nil {
		app.mu.Unlock()
		writeJSON(response, http.StatusConflict, map[string]string{"error": "A sharing session is already active"})
		return
	}
	app.starting = true
	app.generation++
	generation := app.generation
	app.startFailure = ""
	startContext, startCancel := context.WithCancel(app.ctx)
	app.startCancel = startCancel
	app.mu.Unlock()

	session, room, err := remote.Start(startContext, remote.StartOptions{
		BaseURL:               baseURL,
		HostAdmissionPassword: strings.TrimSpace(input.Password),
		OnEvent:               func(event remote.Event) { app.emit(generation, event) },
	})
	app.mu.Lock()
	app.starting = false
	app.startCancel = nil
	startFailure := app.startFailure
	app.startFailure = ""
	startCanceled := startContext.Err() != nil
	currentGeneration := app.generation == generation
	if err == nil && currentGeneration && !startCanceled && startFailure == "" {
		app.session = session
		app.sessionCancel = startCancel
		app.room = room
		app.attachTimer = time.AfterFunc(app.attachTimeout, func() {
			app.mu.Lock()
			expired := app.generation == generation && app.session == session && app.mediaConn == nil
			app.mu.Unlock()
			if expired {
				session.Fail(errors.New("local media did not attach before the bounded deadline"))
			}
		})
	}
	app.mu.Unlock()
	if err == nil && (!currentGeneration || startCanceled) {
		err = errors.New("sharing start was canceled")
	}
	if err == nil && startFailure != "" {
		err = errors.New(startFailure)
	}
	if err != nil {
		startCancel()
		if session != nil {
			session.Close()
		}
		writeJSON(response, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(response, http.StatusCreated, room)
}

func (app *App) handleStop(response http.ResponseWriter, request *http.Request) {
	if !app.authorizeAPI(response, request, http.MethodPost) {
		return
	}
	app.stopActive()
	response.WriteHeader(http.StatusNoContent)
}

func (app *App) handleMedia(response http.ResponseWriter, request *http.Request) {
	if !exactRequest(request, app.expectedHost, app.origin) || request.Method != http.MethodGet {
		http.Error(response, "forbidden", http.StatusForbidden)
		return
	}
	protocol := "screener.token." + app.token
	app.mu.Lock()
	if app.session == nil || app.mediaClaimed {
		app.mu.Unlock()
		http.Error(response, "media session unavailable", http.StatusConflict)
		return
	}
	session := app.session
	generation := app.generation
	app.nextClaimID++
	claimID := app.nextClaimID
	app.mediaClaimed = true
	app.mediaClaimID = claimID
	app.mu.Unlock()
	connection, err := websocket.Accept(response, request, &websocket.AcceptOptions{
		Subprotocols: []string{protocol},
	})
	if err != nil {
		app.releaseMediaClaim(generation, claimID, nil)
		return
	}
	if connection.Subprotocol() != protocol {
		connection.CloseNow()
		app.releaseMediaClaim(generation, claimID, nil)
		return
	}
	connection.SetReadLimit(media.MaxFrameBytes + media.FrameHeaderBytes)
	app.mu.Lock()
	if app.generation != generation || app.session != session || app.mediaClaimID != claimID {
		app.mu.Unlock()
		connection.CloseNow()
		app.releaseMediaClaim(generation, claimID, nil)
		return
	}
	app.mediaConn = connection
	if app.attachTimer != nil {
		app.attachTimer.Stop()
		app.attachTimer = nil
	}
	room := app.room
	activeViewers := app.activeViewers
	waitingViewers := app.waitingViewers
	app.mu.Unlock()
	defer func() {
		app.releaseMediaClaim(generation, claimID, connection)
		app.stopActiveGeneration(generation)
	}()
	if session == nil {
		return
	}
	if err = app.writeLocal(connection, map[string]any{
		"kind":           "ready",
		"roomId":         room.ID,
		"inviteUrl":      room.InviteURL,
		"activeViewers":  activeViewers,
		"waitingViewers": waitingViewers,
	}); err != nil {
		session.Fail(fmt.Errorf("write local media readiness: %w", err))
		return
	}

	configContext, cancelConfig := context.WithTimeout(app.ctx, app.configTimeout)
	messageType, payload, err := connection.Read(configContext)
	cancelConfig()
	if err != nil {
		session.Fail(fmt.Errorf("read local encoder configuration: %w", err))
		return
	}
	if messageType != websocket.MessageText {
		session.Fail(errors.New("local encoder configuration was not text"))
		return
	}
	var config encoderConfig
	if err = decodeLocalPayload(payload, &config); err != nil || !validEncoderConfig(config) {
		session.Fail(errors.New("local encoder configuration is invalid"))
		_ = connection.Close(websocket.StatusPolicyViolation, "invalid encoder config")
		return
	}
	if err = app.writeLocal(connection, map[string]string{"kind": "config-accepted"}); err != nil {
		session.Fail(fmt.Errorf("acknowledge local encoder configuration: %w", err))
		return
	}
	for {
		messageType, payload, err = connection.Read(app.ctx)
		if err != nil {
			return
		}
		if messageType != websocket.MessageBinary {
			session.Fail(errors.New("local media bridge received a non-binary frame"))
			_ = connection.Close(websocket.StatusUnsupportedData, "binary frames required")
			return
		}
		frame, decodeErr := media.DecodeFrame(payload)
		if decodeErr != nil {
			session.Fail(fmt.Errorf("decode local encoded frame: %w", decodeErr))
			_ = connection.Close(websocket.StatusPolicyViolation, "invalid encoded frame")
			return
		}
		if err = session.WriteFrame(frame); err != nil {
			return
		}
	}
}

func (app *App) authorizeAPI(response http.ResponseWriter, request *http.Request, method string) bool {
	if !exactRequest(request, app.expectedHost, app.origin) ||
		!tokenMatches(request.Header.Get(processTokenHeader), app.token) {
		http.Error(response, "not found", http.StatusNotFound)
		return false
	}
	if request.Method != method {
		response.Header().Set("Allow", method)
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	return true
}

func (app *App) emit(generation uint64, event remote.Event) {
	app.mu.Lock()
	if app.generation != generation {
		app.mu.Unlock()
		return
	}
	if event.Kind == "viewer-count" {
		app.activeViewers = event.ActiveViewers
		app.waitingViewers = event.WaitingViewers
	}
	if event.Kind == "fatal" && app.starting && app.session == nil {
		app.startFailure = event.Message
	}
	connection := app.mediaConn
	session := app.session
	app.mu.Unlock()
	if connection != nil {
		if err := app.writeLocal(connection, event); err != nil && event.Kind != "fatal" && session != nil {
			go session.Fail(fmt.Errorf("write local sender event: %w", err))
		}
	}
	if event.Kind == "fatal" {
		go app.stopActiveGeneration(generation)
	}
}

func (app *App) writeLocal(connection *websocket.Conn, value any) error {
	app.writeMu.Lock()
	defer app.writeMu.Unlock()
	ctx, cancel := context.WithTimeout(app.ctx, localWriteTimeout)
	defer cancel()
	return wsjson.Write(ctx, connection, value)
}

func (app *App) releaseMediaClaim(generation, claimID uint64, connection *websocket.Conn) {
	app.mu.Lock()
	defer app.mu.Unlock()
	if app.generation == generation && app.mediaClaimed && app.mediaClaimID == claimID &&
		(connection == nil || app.mediaConn == connection) {
		app.mediaConn = nil
		app.mediaClaimed = false
		app.mediaClaimID = 0
	}
}

func (app *App) stopActive() {
	app.stopActiveGeneration(0)
}

func (app *App) stopActiveGeneration(expectedGeneration uint64) {
	app.mu.Lock()
	if expectedGeneration != 0 && app.generation != expectedGeneration {
		app.mu.Unlock()
		return
	}
	app.generation++
	startCancel := app.startCancel
	app.startCancel = nil
	app.startFailure = ""
	session := app.session
	app.session = nil
	sessionCancel := app.sessionCancel
	app.sessionCancel = nil
	connection := app.mediaConn
	app.mediaConn = nil
	app.mediaClaimed = false
	app.mediaClaimID = 0
	if app.attachTimer != nil {
		app.attachTimer.Stop()
		app.attachTimer = nil
	}
	app.room = remote.Room{}
	app.activeViewers = 0
	app.waitingViewers = 0
	app.mu.Unlock()
	if startCancel != nil {
		startCancel()
	}
	if session != nil {
		session.Close()
	}
	if sessionCancel != nil {
		sessionCancel()
	}
	if connection != nil {
		_ = connection.Close(websocket.StatusNormalClosure, "sharing stopped")
	}
}

func validEncoderConfig(config encoderConfig) bool {
	return config.Kind == "config" && config.Codec == "vp8" &&
		config.Width == 1280 && config.Height == 720 && config.FPS == 30 &&
		config.Bitrate == 3_000_000 && config.EncoderInstances == 1
}

func decodeLocalJSON(request *http.Request, target any) error {
	payload, err := io.ReadAll(io.LimitReader(request.Body, maxLocalJSONBytes+1))
	if err != nil || len(payload) > maxLocalJSONBytes {
		return errors.New("request is too large")
	}
	return decodeLocalPayload(payload, target)
}

func decodeLocalPayload(payload []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return errors.New("payload is not valid JSON")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("payload contains multiple JSON values")
	}
	return nil
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	payload, _ := json.Marshal(value)
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_, _ = response.Write(payload)
}

func setSecurityHeaders(response http.ResponseWriter) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
	response.Header().Set("Referrer-Policy", "no-referrer")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.Header().Set("X-Frame-Options", "DENY")
}
