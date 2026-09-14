package launcher

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"runtime"
	"strings"
	"sync"
	"time"

	appconfig "github.com/TNTcraftHIM/Piik/internal/app/config"
	"github.com/TNTcraftHIM/Piik/internal/app/lan"
	"github.com/TNTcraftHIM/Piik/internal/diagnostics"
)

const (
	maxRequestBytes = 2 << 10
	shutdownTimeout = 2 * time.Second
	// launcherIndex is the Browser entry document. /client serves it directly
	// because that route belongs to the client-side router, not to the assets.
	launcherIndex = "index.html"
)

type Mode string

const (
	ModeLocal Mode = "local"
	ModeLink  Mode = "link"
	ModeSite  Mode = "site"
)

type Selection struct {
	Mode                Mode    `json:"mode"`
	Language            string  `json:"language"`
	Site                string  `json:"site,omitempty"`
	LocalAccessPassword string  `json:"localAccessPassword"`
	Debug               bool    `json:"debug,omitempty"`
	LANAddress          *string `json:"lanAddress,omitempty"`
}

type Options struct {
	DefaultMode         Mode
	Site                string
	Version             string
	Revision            string
	LocalAccessPassword string
	Debug               bool
	LANAddress          string
}

var listLANAddresses = lan.List

type Server struct {
	ctx                 context.Context
	cancel              context.CancelFunc
	listener            net.Listener
	httpServer          *http.Server
	assets              fs.FS
	static              http.Handler
	site                string
	defaultMode         Mode
	localAccessPassword string
	version             string
	revision            string
	debug               bool
	lanAddress          string
	selection           chan Selection
	resultReady         chan struct{}
	handled             chan struct{}
	done                chan error
	ready               chan struct{}

	mu          sync.Mutex
	selected    bool
	resultSet   bool
	target      string
	resultErr   error
	closeOnce   sync.Once
	resultOnce  sync.Once
	handledOnce sync.Once
}

// Start serves the launcher page and its API on a loopback port. assets is the
// built Browser UI, which the App embeds; a nil file system means the binary
// carries no build and the launcher cannot run.
func Start(parent context.Context, assets fs.FS, options Options) (*Server, error) {
	if parent == nil {
		parent = context.Background()
	}
	normalizedSite, err := appconfig.NormalizeSite(options.Site)
	if err != nil {
		return nil, fmt.Errorf("App launcher Site is invalid: %w", err)
	}
	if assets == nil {
		return nil, errors.New("App launcher assets are unavailable")
	}
	if metadata, err := fs.Stat(assets, launcherIndex); err != nil || !metadata.Mode().IsRegular() {
		return nil, errors.New("App launcher assets are unavailable")
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("App launcher could not start: %w", err)
	}
	ctx, cancel := context.WithCancel(parent)
	server := &Server{
		ctx:                 ctx,
		cancel:              cancel,
		listener:            listener,
		assets:              assets,
		static:              http.FileServer(http.FS(assets)),
		site:                normalizedSite,
		defaultMode:         options.DefaultMode,
		localAccessPassword: options.LocalAccessPassword,
		version:             options.Version,
		revision:            strings.TrimSpace(options.Revision),
		debug:               options.Debug,
		lanAddress:          options.LANAddress,
		selection:           make(chan Selection, 1),
		resultReady:         make(chan struct{}),
		handled:             make(chan struct{}),
		done:                make(chan error, 1),
		ready:               make(chan struct{}),
	}
	server.httpServer = &http.Server{
		Handler:           server,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	go server.serve()
	<-server.ready
	go func() {
		<-ctx.Done()
		_ = server.Close()
	}()
	return server, nil
}

func (server *Server) URL() string {
	return "http://" + server.listener.Addr().String() + "/client"
}

func (server *Server) Selection() <-chan Selection {
	return server.selection
}

func (server *Server) Handled() <-chan struct{} {
	return server.handled
}

func (server *Server) Done() <-chan error {
	return server.done
}

func (server *Server) SetResult(target string, resultErr error) {
	server.resultOnce.Do(func() {
		if resultErr == nil && !validTarget(target) {
			resultErr = errors.New("App target is invalid")
		}
		server.mu.Lock()
		server.resultSet = true
		server.target = target
		server.resultErr = resultErr
		server.mu.Unlock()
		close(server.resultReady)
	})
}

func (server *Server) Close() error {
	server.closeOnce.Do(server.cancel)
	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	return server.httpServer.Shutdown(ctx)
}

func (server *Server) serve() {
	close(server.ready)
	err := server.httpServer.Serve(server.listener)
	if errors.Is(err, http.ErrServerClosed) {
		err = nil
	}
	server.done <- err
	close(server.done)
}

func (server *Server) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if !server.requestAllowed(request) {
		http.NotFound(response, request)
		return
	}
	response.Header().Set("X-Content-Type-Options", "nosniff")
	switch request.URL.Path {
	case "/api/client-launcher":
		server.handleState(response, request)
	case "/api/client-launcher/launch":
		server.handleLaunch(response, request)
	case "/client", "/client/":
		if request.Method != http.MethodGet && request.Method != http.MethodHead {
			response.Header().Set("Allow", "GET, HEAD")
			http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		response.Header().Set("Cache-Control", "no-store")
		http.ServeFileFS(response, request, server.assets, launcherIndex)
	default:
		server.static.ServeHTTP(response, request)
	}
}

func (server *Server) handleState(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	addresses, err := listLANAddresses()
	if err != nil {
		slog.DebugContext(request.Context(), "launcher-lan-unavailable", diagnostics.Error(err))
	}
	if addresses == nil {
		addresses = []lan.Address{}
	}
	values := make([]string, 0, len(addresses))
	for _, address := range addresses {
		values = append(values, address.Address)
	}
	selected, _ := lan.Select(values, server.lanAddress)
	writeJSON(response, http.StatusOK, map[string]any{
		"site":                server.site,
		"localAccessPassword": server.localAccessPassword,
		"version":             server.version,
		"revision":            server.revision,
		"packageTarget":       runtime.GOOS + "-" + runtime.GOARCH,
		"debug":               server.debug,
		"lan":                 map[string]any{"addresses": addresses, "selected": selected},
		"defaultMode": func() Mode {
			if validMode(server.defaultMode) && (server.defaultMode != ModeSite || server.site != "") {
				return server.defaultMode
			}
			if server.site != "" {
				return ModeSite
			}
			return ModeLink
		}(),
	})
}

func (server *Server) handleLaunch(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, maxRequestBytes)
	selection, err := decodeSelection(request.Body)
	if err != nil {
		writeJSON(response, http.StatusBadRequest, map[string]string{
			"error": "invalid launch request", "detail": errorDetail(err),
		})
		return
	}
	server.mu.Lock()
	if server.selected {
		server.mu.Unlock()
		writeJSON(response, http.StatusConflict, map[string]string{
			"error": "launch already requested", "detail": "Close and reopen Piik before starting again.",
		})
		return
	}
	server.selected = true
	server.mu.Unlock()

	select {
	case server.selection <- selection:
	case <-request.Context().Done():
		server.markHandled()
		return
	case <-server.ctx.Done():
		server.markHandled()
		return
	}
	select {
	case <-server.resultReady:
	case <-request.Context().Done():
		server.markHandled()
		return
	case <-server.ctx.Done():
		server.markHandled()
		return
	}
	server.mu.Lock()
	target, resultErr, resultSet := server.target, server.resultErr, server.resultSet
	server.mu.Unlock()
	if !resultSet || resultErr != nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{
			"error": "Piik App could not start", "detail": errorDetail(resultErr),
		})
		server.markHandled()
		return
	}
	writeJSON(response, http.StatusOK, map[string]string{"target": target})
	server.markHandled()
}

func errorDetail(err error) string {
	if err == nil {
		return ""
	}
	// Redact before truncation so a long credential cannot lose its delimiter.
	detail := []rune(diagnostics.SafeText(err.Error()))
	if len(detail) > 2048 {
		return string(detail[:2048]) + "..."
	}
	return string(detail)
}

func (server *Server) markHandled() {
	server.handledOnce.Do(func() { close(server.handled) })
}

func (server *Server) requestAllowed(request *http.Request) bool {
	_, port, err := net.SplitHostPort(request.Host)
	if err != nil {
		return false
	}
	_, listenerPort, listenerErr := net.SplitHostPort(server.listener.Addr().String())
	if listenerErr != nil || port != listenerPort {
		return false
	}
	host := strings.TrimSuffix(strings.ToLower(request.Host), ":"+port)
	if host != "127.0.0.1" && host != "localhost" {
		return false
	}
	origin := strings.TrimSpace(request.Header.Get("Origin"))
	return origin == "" || sameOrigin(origin, "http://"+request.Host)
}

func sameOrigin(actual, expected string) bool {
	actualURL, actualErr := url.Parse(actual)
	expectedURL, expectedErr := url.Parse(expected)
	return actualErr == nil && expectedErr == nil &&
		actualURL.Scheme == expectedURL.Scheme &&
		strings.EqualFold(actualURL.Host, expectedURL.Host) &&
		actualURL.Path == "" && actualURL.RawQuery == "" && actualURL.Fragment == ""
}

func decodeSelection(reader io.Reader) (Selection, error) {
	var selection Selection
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&selection) != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return Selection{}, errors.New("invalid launch request")
	}
	if selection.Language != "zh" && selection.Language != "en" && selection.Language != "vis" {
		return Selection{}, errors.New("invalid launch language")
	}
	if selection.LANAddress != nil {
		if selection.Mode != ModeLocal {
			return Selection{}, errors.New("only Local launch can select a LAN invitation address")
		}
		value := strings.TrimSpace(*selection.LANAddress)
		if ip := net.ParseIP(value); ip == nil || ip.To4() == nil {
			return Selection{}, errors.New("Local invitation address must be an active IPv4 address")
		}
		selection.LANAddress = &value
	}
	switch selection.Mode {
	case ModeLocal, ModeLink:
		if strings.TrimSpace(selection.Site) != "" {
			return Selection{}, errors.New("local launch cannot include a Site")
		}
		selection.Site = ""
	case ModeSite:
		if selection.LocalAccessPassword != "" {
			return Selection{}, errors.New("Site launch cannot include a local access password")
		}
		normalized, err := appconfig.NormalizeSite(selection.Site)
		if err != nil || normalized == "" {
			return Selection{}, errors.New("Site launch requires an HTTP or HTTPS origin")
		}
		selection.Site = normalized
	default:
		return Selection{}, errors.New("unknown launch mode")
	}
	return selection, nil
}

func validTarget(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != ""
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	payload, err := json.Marshal(value)
	if err != nil {
		http.Error(response, "response unavailable", http.StatusInternalServerError)
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_, _ = response.Write(payload)
}
