package loopback

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	controlQueueSize   = 64 // MaxControlMessageBytes * 64 = 16 MiB worst-case.
	maxControlSessions = 2
)

type Options struct {
	PortStart      int
	PortEnd        int
	AllowedOrigins []string
	NativeMedia    NativeMediaCapabilities
	NewControl     func() ControlSession
	Presentation   func(language string)
}

type ControlSession interface {
	// Errors reject protocol violations and close this control connection.
	// Valid operation failures return a response instead of ending the session.
	// A nil response with no error is completed later through Events, using the request ID.
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
	SoftwareVP8  bool `json:"softwareVP8"`
}

type Server struct {
	ctx            context.Context
	cancel         context.CancelFunc
	listener       net.Listener
	httpServer     *http.Server
	endpoint       Endpoint
	allowedOrigins []string
	nativeMedia    NativeMediaCapabilities
	newControl     func() ControlSession
	presentation   func(string)
	done           chan error

	mu          sync.Mutex
	connections map[*websocket.Conn]struct{}
	claimed     int
	closed      bool
	controls    sync.WaitGroup
	closeOnce   sync.Once
	closeErr    error
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
		allowedOrigins: normalizedOrigins(options.AllowedOrigins),
		nativeMedia:    options.NativeMedia,
		newControl:     options.NewControl,
		presentation:   options.Presentation,
		done:           make(chan error, 1),
		connections:    make(map[*websocket.Conn]struct{}),
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

func (server *Server) SetAllowedOrigins(origins []string) {
	server.mu.Lock()
	server.allowedOrigins = normalizedOrigins(origins)
	server.mu.Unlock()
}

func (server *Server) Close() error {
	server.closeOnce.Do(func() {
		server.mu.Lock()
		server.closed = true
		connections := make([]*websocket.Conn, 0, len(server.connections))
		for connection := range server.connections {
			connections = append(connections, connection)
		}
		server.mu.Unlock()
		server.cancel()
		ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		for _, connection := range connections {
			_ = connection.CloseNow()
		}
		server.closeErr = server.httpServer.Shutdown(ctx)
		retired := make(chan struct{})
		go func() {
			server.controls.Wait()
			close(retired)
		}()
		select {
		case <-retired:
		case <-ctx.Done():
			server.closeErr = errors.Join(server.closeErr, ctx.Err())
		}
	})
	return server.closeErr
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
	case "/presentation":
		server.handlePresentation(response, request)
	default:
		http.NotFound(response, request)
	}
}

func (server *Server) handlePresentation(response http.ResponseWriter, request *http.Request) {
	if request.Method == http.MethodOptions {
		response.Header().Set("Access-Control-Allow-Methods", http.MethodPost)
		response.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		allowPrivateNetwork(response, request)
		response.WriteHeader(http.StatusNoContent)
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", "POST, OPTIONS")
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, 256)
	var presentation struct {
		Language string `json:"language"`
	}
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&presentation) != nil || decoder.Decode(&struct{}{}) != io.EOF ||
		(presentation.Language != "zh" && presentation.Language != "en" && presentation.Language != "vis") {
		http.Error(response, "invalid presentation", http.StatusBadRequest)
		return
	}
	if server.presentation != nil {
		server.presentation(presentation.Language)
	}
	response.WriteHeader(http.StatusNoContent)
}

func (server *Server) handleHealth(response http.ResponseWriter, request *http.Request) {
	if request.Method == http.MethodOptions {
		response.Header().Set("Access-Control-Allow-Methods", http.MethodGet)
		allowPrivateNetwork(response, request)
		response.WriteHeader(http.StatusNoContent)
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", "GET, OPTIONS")
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

func allowPrivateNetwork(response http.ResponseWriter, request *http.Request) {
	if strings.EqualFold(strings.TrimSpace(request.Header.Get("Access-Control-Request-Private-Network")), "true") {
		response.Header().Set("Access-Control-Allow-Private-Network", "true")
	}
}

func (server *Server) handleControl(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !server.claimConnection() {
		http.Error(response, "native control capacity is occupied", http.StatusConflict)
		return
	}
	var connection *websocket.Conn
	defer func() { server.releaseConnection(connection) }()
	expectedSubprotocol := ControlSubprotocol + "." + server.endpoint.InstanceToken
	var err error
	connection, err = websocket.Accept(response, request, &websocket.AcceptOptions{
		Subprotocols:   []string{expectedSubprotocol},
		OriginPatterns: server.originPatterns(),
	})
	if err != nil {
		return
	}
	defer connection.CloseNow()
	if connection.Subprotocol() != expectedSubprotocol {
		closeControl(connection, "unsupported control protocol")
		return
	}
	if !server.setConnection(connection) {
		return
	}
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
	reads := make(chan []byte, controlQueueSize)
	go func() {
		for {
			messageType, payload, readErr := connection.Read(controlContext)
			if readErr != nil || messageType != websocket.MessageText {
				cancelControl()
				return
			}
			select {
			case reads <- payload:
			case <-controlContext.Done():
				return
			default:
				cancelControl()
				return
			}
		}
	}()
	for {
		select {
		case <-controlContext.Done():
			return
		case payload = <-reads:
			messageType = websocket.MessageText
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
		if handleErr != nil {
			closeControl(connection, "invalid control message")
			return
		}
		if value == nil {
			continue
		}
		if err = write(controlContext, value); err != nil {
			return
		}
	}
}

func (server *Server) originPatterns() []string {
	server.mu.Lock()
	origins := append([]string(nil), server.allowedOrigins...)
	server.mu.Unlock()
	patterns := make([]string, 0, len(origins)+2)
	for _, origin := range origins {
		if parsed, err := url.Parse(origin); err == nil && parsed.Host != "" {
			patterns = append(patterns, parsed.Scheme+"://"+parsed.Host)
		}
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
	if origin != "" && !server.allowedOrigin(origin) && !server.localOrigin(origin) {
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

func (server *Server) allowedOrigin(origin string) bool {
	server.mu.Lock()
	defer server.mu.Unlock()
	for _, allowed := range server.allowedOrigins {
		if sameOrigin(origin, allowed) {
			return true
		}
	}
	return false
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
	if server.closed || server.claimed >= maxControlSessions {
		return false
	}
	server.claimed++
	server.controls.Add(1)
	return true
}

func (server *Server) setConnection(connection *websocket.Conn) bool {
	server.mu.Lock()
	defer server.mu.Unlock()
	if server.closed {
		return false
	}
	server.connections[connection] = struct{}{}
	return true
}

func (server *Server) releaseConnection(connection *websocket.Conn) {
	server.mu.Lock()
	delete(server.connections, connection)
	server.claimed--
	server.mu.Unlock()
	server.controls.Done()
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

func normalizedOrigins(origins []string) []string {
	result := make([]string, 0, len(origins))
	seen := make(map[string]struct{}, len(origins))
	for _, origin := range origins {
		origin = strings.TrimRight(strings.TrimSpace(origin), "/")
		if origin == "" {
			continue
		}
		if _, found := seen[strings.ToLower(origin)]; found {
			continue
		}
		seen[strings.ToLower(origin)] = struct{}{}
		result = append(result, origin)
	}
	return result
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
