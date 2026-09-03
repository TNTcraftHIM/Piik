package loopback

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	defaultBindAddress = "127.0.0.1"
	instanceTokenBytes = 32
	helloTimeout       = 5 * time.Second
	shutdownTimeout    = 2 * time.Second
)

type Options struct {
	PortStart     int
	PortEnd       int
	AllowedOrigin string
	NativeMedia   NativeMediaCapabilities
	NewControl    func() ControlSession
}

type ControlSession interface {
	Handle(context.Context, []byte) (any, error)
	Events() <-chan any
	Close() error
}

type Endpoint struct {
	URL           string `json:"url"`
	Host          string `json:"host"`
	Port          int    `json:"port"`
	InstanceToken string `json:"instanceToken"`
}

type Health struct {
	Protocol      int                     `json:"protocol"`
	Service       string                  `json:"service"`
	Port          int                     `json:"port"`
	InstanceToken string                  `json:"instanceToken"`
	NativeMedia   NativeMediaCapabilities `json:"nativeMedia"`
}

type NativeMediaCapabilities struct {
	Video        bool `json:"video"`
	ProcessAudio bool `json:"processAudio"`
	SystemAudio  bool `json:"systemAudio"`
	HardwareH264 bool `json:"hardwareH264"`
}

type Server struct {
	ctx           context.Context
	cancel        context.CancelFunc
	listener      net.Listener
	httpServer    *http.Server
	endpoint      Endpoint
	allowedOrigin string
	nativeMedia   NativeMediaCapabilities
	newControl    func() ControlSession
	done          chan error

	mu         sync.Mutex
	activeConn *websocket.Conn
	claimed    bool
	closed     bool
}

func Start(parent context.Context, options Options) (*Server, error) {
	if parent == nil {
		parent = context.Background()
	}
	portStart, portEnd := normalizePortRange(options.PortStart, options.PortEnd)
	listener, err := listenInRange(defaultBindAddress, portStart, portEnd)
	if err != nil {
		return nil, err
	}
	address, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		_ = listener.Close()
		return nil, errors.New("loopback listener returned an unexpected address")
	}
	instanceToken, err := newInstanceToken()
	if err != nil {
		_ = listener.Close()
		return nil, fmt.Errorf("create helper instance token: %w", err)
	}
	ctx, cancel := context.WithCancel(parent)
	server := &Server{
		ctx: ctx, cancel: cancel, listener: listener,
		endpoint: Endpoint{
			URL:           "http://" + listener.Addr().String(),
			Host:          listener.Addr().String(),
			Port:          address.Port,
			InstanceToken: instanceToken,
		},
		allowedOrigin: strings.TrimSpace(options.AllowedOrigin),
		nativeMedia:   options.NativeMedia,
		newControl:    options.NewControl,
		done:          make(chan error, 1),
	}
	server.httpServer = &http.Server{
		Handler:           server,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	go server.serve()
	go func() {
		<-ctx.Done()
		_ = server.Close()
	}()
	return server, nil
}

func (server *Server) Endpoint() Endpoint {
	return server.endpoint
}

func (server *Server) Done() <-chan error {
	return server.done
}

func (server *Server) Close() error {
	server.mu.Lock()
	if server.closed {
		server.mu.Unlock()
		return nil
	}
	server.closed = true
	connection := server.activeConn
	server.activeConn = nil
	server.claimed = false
	server.mu.Unlock()
	server.cancel()
	if connection != nil {
		_ = connection.Close(websocket.StatusNormalClosure, "helper stopped")
	}
	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	return server.httpServer.Shutdown(ctx)
}

func (server *Server) serve() {
	err := server.httpServer.Serve(server.listener)
	if errors.Is(err, http.ErrServerClosed) {
		err = nil
	}
	if err != nil {
		server.cancel()
	}
	server.done <- err
	close(server.done)
}

func (server *Server) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if !server.requestAllowed(response, request) {
		return
	}
	switch request.URL.Path {
	case "/health":
		server.handleHealth(response, request)
	case "/control":
		server.handleControl(response, request)
	default:
		http.NotFound(response, request)
	}
}

func (server *Server) handleHealth(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	writeJSON(response, http.StatusOK, Health{
		Protocol:      ProtocolVersion,
		Service:       ServiceName,
		Port:          server.endpoint.Port,
		InstanceToken: server.endpoint.InstanceToken,
		NativeMedia:   server.nativeMedia,
	})
}

func (server *Server) handleControl(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !server.claimConnection() {
		http.Error(response, "control session already active", http.StatusConflict)
		return
	}
	expectedSubprotocol := ControlSubprotocol + "." + server.endpoint.InstanceToken
	connection, err := websocket.Accept(response, request, &websocket.AcceptOptions{
		Subprotocols:   []string{expectedSubprotocol},
		OriginPatterns: server.originPatterns(),
	})
	if err != nil {
		server.releaseConnection(nil)
		return
	}
	if connection.Subprotocol() != expectedSubprotocol {
		closeControl(connection, "unsupported control protocol")
		server.releaseConnection(connection)
		return
	}
	server.setConnection(connection)
	defer server.releaseConnection(connection)
	connection.SetReadLimit(MaxControlMessageBytes)

	helloContext, cancelHello := context.WithTimeout(server.ctx, helloTimeout)
	messageType, payload, err := connection.Read(helloContext)
	cancelHello()
	if err != nil || messageType != websocket.MessageText {
		closeControl(connection, "hello frame required")
		return
	}
	message, err := decodeRequest(payload)
	if err != nil {
		closeControl(connection, "invalid control message")
		return
	}
	if validateHello(message) != nil {
		closeControl(connection, "hello required")
		return
	}
	var writeMutex sync.Mutex
	write := func(ctx context.Context, value any) error {
		encoded, encodeErr := encodeMessage(value)
		if encodeErr != nil {
			return encodeErr
		}
		writeMutex.Lock()
		defer writeMutex.Unlock()
		return connection.Write(ctx, websocket.MessageText, encoded)
	}
	if err = write(server.ctx, controlMessage{
		Version: ProtocolVersion, ID: message.ID, Type: "ready",
	}); err != nil {
		return
	}
	controlContext, cancelControl := context.WithCancel(server.ctx)
	defer cancelControl()
	var extension ControlSession
	if server.newControl != nil {
		extension = server.newControl()
	}
	if extension != nil {
		defer extension.Close()
		go func() {
			for {
				select {
				case event, open := <-extension.Events():
					if !open {
						return
					}
					if write(controlContext, event) != nil {
						cancelControl()
						return
					}
				case <-controlContext.Done():
					return
				}
			}
		}()
	}
	for {
		messageType, payload, err = connection.Read(controlContext)
		if err != nil || messageType != websocket.MessageText {
			closeControl(connection, "control frame required")
			return
		}
		message, err = decodeEnvelope(payload)
		if err != nil {
			closeControl(connection, "invalid control message")
			return
		}
		if message.Type == "ping" {
			strict, strictErr := decodeRequest(payload)
			if strictErr != nil || validatePing(strict) != nil ||
				write(controlContext, controlMessage{
					Version: ProtocolVersion, ID: message.ID, Type: "pong",
				}) != nil {
				closeControl(connection, "invalid control message")
				return
			}
			continue
		}
		if extension == nil {
			closeControl(connection, "unsupported control message")
			return
		}
		value, handleErr := extension.Handle(controlContext, payload)
		if handleErr != nil || value == nil {
			closeControl(connection, "invalid control message")
			return
		}
		if err = write(controlContext, value); err != nil {
			return
		}
	}
}

func (server *Server) originPatterns() []string {
	patterns := make([]string, 0, 3)
	if parsed, err := url.Parse(server.allowedOrigin); err == nil && parsed.Host != "" {
		patterns = append(patterns, parsed.Scheme+"://"+parsed.Host)
	}
	port := strconv.Itoa(server.endpoint.Port)
	patterns = append(patterns, "http://localhost:"+port, "http://127.0.0.1:"+port)
	return patterns
}

func closeControl(connection *websocket.Conn, reason string) {
	_ = connection.Close(websocket.StatusPolicyViolation, reason)
}

func (server *Server) requestAllowed(response http.ResponseWriter, request *http.Request) bool {
	origin := strings.TrimSpace(request.Header.Get("Origin"))
	if origin != "" && !sameOrigin(origin, server.allowedOrigin) && !server.localOrigin(origin) {
		http.Error(response, "forbidden", http.StatusForbidden)
		return false
	}
	if !server.hostAllowed(request.Host) {
		http.NotFound(response, request)
		return false
	}
	if origin != "" {
		response.Header().Set("Access-Control-Allow-Origin", origin)
		response.Header().Add("Vary", "Origin")
	}
	return true
}

func (server *Server) hostAllowed(host string) bool {
	if host == server.endpoint.Host {
		return true
	}
	return host == net.JoinHostPort("localhost", strconv.Itoa(server.endpoint.Port))
}

func (server *Server) localOrigin(origin string) bool {
	parsed, err := url.Parse(origin)
	return err == nil && parsed.Scheme == "http" &&
		parsed.Port() == strconv.Itoa(server.endpoint.Port) &&
		(strings.EqualFold(parsed.Hostname(), "localhost") ||
			strings.EqualFold(parsed.Hostname(), "127.0.0.1"))
}

func (server *Server) claimConnection() bool {
	server.mu.Lock()
	defer server.mu.Unlock()
	if server.closed || server.claimed {
		return false
	}
	server.claimed = true
	return true
}

func (server *Server) setConnection(connection *websocket.Conn) {
	server.mu.Lock()
	server.activeConn = connection
	server.mu.Unlock()
}

func (server *Server) releaseConnection(connection *websocket.Conn) {
	server.mu.Lock()
	if server.activeConn == connection {
		server.activeConn = nil
	}
	server.claimed = false
	server.mu.Unlock()
}

func listenInRange(bindAddress string, start, end int) (net.Listener, error) {
	var lastErr error
	for port := start; port <= end; port++ {
		listener, err := net.Listen("tcp4", net.JoinHostPort(bindAddress, strconv.Itoa(port)))
		if err == nil {
			return listener, nil
		}
		lastErr = err
	}
	return nil, fmt.Errorf("helper could not bind port range %d-%d: %w", start, end, lastErr)
}

func normalizePortRange(start, end int) (int, int) {
	if start <= 0 && end <= 0 {
		return DefaultPortStart, DefaultPortEnd
	}
	if start <= 0 {
		start = end
	}
	if start < 1 {
		start = 1
	}
	if start > 65535 {
		start = 65535
	}
	if end < start {
		end = start
	}
	if end > 65535 {
		end = 65535
	}
	return start, end
}

func sameOrigin(actual, expected string) bool {
	return strings.EqualFold(strings.TrimRight(actual, "/"), strings.TrimRight(expected, "/"))
}

func newInstanceToken() (string, error) {
	buffer := make([]byte, instanceTokenBytes)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	payload, err := encodeMessage(value)
	if err != nil {
		http.Error(response, "response unavailable", http.StatusInternalServerError)
		return
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_, _ = response.Write(payload)
}
