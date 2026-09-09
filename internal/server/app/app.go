// Package app ports src/server/app.ts: the HTTP composition, the startup and
// shutdown lifecycle, and the request router. access.go ports
// src/server/access-session.ts and static.go the sirv frontend handler.
//
// # Locking
//
// signal.Server owns the one mutex that guards the room store, the media router
// and every session. This package never takes it: everything a request can
// mutate goes through the signaling server. Server.mu below guards only this
// struct's own lifecycle bookkeeping.
//
// The lock order is one-directional: Server.mu may be held while the signaling
// mutex is taken (reconcile calls signal.New under it, and signal.New locks the
// server it is still building), never the reverse. Nothing reachable under the
// signaling mutex may take Server.mu, which is why the one callback this
// package hands to signal, SiteAccessAtUpgrade, only reads the lock-free
// site-access gate. Keep it that way or the two locks can deadlock.
package app

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/TNTcraftHIM/Screener/internal/diagnostics"
	"github.com/TNTcraftHIM/Screener/internal/server/config"
	"github.com/TNTcraftHIM/Screener/internal/server/room"
	"github.com/TNTcraftHIM/Screener/internal/server/sfu"
	"github.com/TNTcraftHIM/Screener/internal/server/signal"
	"github.com/TNTcraftHIM/Screener/internal/server/stun"
	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
)

// Node HTTP server settings of app.ts, mapped in map section 3.3 / D11.
const (
	requestTimeout   = 10 * time.Second // httpServer.requestTimeout
	headersTimeout   = 15 * time.Second // httpServer.headersTimeout
	keepAliveTimeout = 5 * time.Second  // httpServer.keepAliveTimeout
)

// Options is CreateServerOptions. Every zero value means the TS `undefined`.
type Options struct {
	// Config is the loaded server configuration; cmd owns config.Load / Local.
	Config config.Config
	// Listener is optional prebound TCP ownership transferred on successful New.
	// It lets the Local Client reserve its HTTP port before opening a tunnel.
	Listener *net.TCPListener
	// Assets is the built Browser UI. A nil FS serves the API only, which is
	// the TS frontend mode "none"; webassets.FS() returns nil the same way
	// when no build was embedded (D3).
	Assets fs.FS
	// Now returns Unix milliseconds; nil uses the wall clock.
	Now func() int64
	// Logger receives the request-failure record; nil uses slog.Default().
	Logger *slog.Logger

	AuthenticationTimeoutMs             int
	ViewerDisconnectGraceMs             int
	HeartbeatIntervalMs                 int
	CleanupIntervalMs                   int
	MaxSignalConnections                int
	MaxUnauthenticatedSignalConnections int
	SiteAccessTTLSeconds                int

	// AfterFunc is the signaling timer factory (D5); nil uses time.AfterFunc.
	AfterFunc func(time.Duration, func()) func() bool
	// RoomStore replaces the store this package would build from Config.
	RoomStore *room.Store
}

// Server is ScreenerServer.
type Server struct {
	config        config.Config
	store         *room.Store
	siteAccess    *siteAccessGate
	frontend      http.Handler
	logger        *slog.Logger
	media         *sfu.Media
	mediaMux      ice.UDPMux
	signalOptions signal.Options
	httpServer    *http.Server
	// Listen binds unless New received an already owned listener. Shutdown waits
	// for startupDone before reading it; closing before Listen also releases it.
	listener net.Listener
	// STUN shares the same startup/shutdown owner, never the advertised ICE URLs.
	stunServer *stun.Server

	// acceptingTraffic and signaling are the two closure variables app.ts
	// flipped together; both are read by request goroutines without a lock and
	// written under mu (hazard 13).
	acceptingTraffic atomic.Bool
	signaling        atomic.Pointer[signal.Server]

	mu               sync.Mutex
	closing          bool
	startupRequested bool
	// startupDone is closed when listen settles, which is what shutdown awaits
	// so the listener stays owned until an in-flight startup finishes (A6).
	startupDone chan struct{}

	shutdownOnce sync.Once
	shutdownErr  error
}

// New is createScreenerServer minus the listening: it builds the SFU fallback,
// the room store, the site-access issuer, the frontend handler and the HTTP
// server, none of which performs I/O.
func New(options Options) (*Server, error) {
	configuration := options.Config
	now := options.Now
	if now == nil {
		now = func() int64 { return time.Now().UnixMilli() }
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}

	store, err := newRoomStore(options, now)
	if err != nil {
		return nil, err
	}

	siteAccess, err := newSiteAccess(siteAccessOptions{
		Password: configuration.SiteAccessPassword,
		Secure: configuration.Env == config.EnvironmentProduction &&
			configuration.PublicBaseURL.Scheme == "https",
		Now:        now,
		TTLSeconds: options.SiteAccessTTLSeconds,
	})
	if err != nil {
		return nil, err
	}

	server := &Server{
		config:      configuration,
		store:       store,
		siteAccess:  siteAccess,
		logger:      logger,
		startupDone: make(chan struct{}),
	}
	if options.Listener != nil {
		server.listener = options.Listener
	}
	if options.Assets != nil {
		server.frontend = staticHandler(options.Assets, http.HandlerFunc(notFoundJSON))
	}
	server.signalOptions = signal.Options{
		Store:                     store,
		EndpointMediaCopyCapacity: configuration.EndpointMediaCopyCapacity,
		Ice:                       config.IceConfig(configuration),
		// The TS signaling server read natPredictionEnabled off the same
		// `ice` options object it forwarded; the Go IceConfig is already the
		// wire shape, so the capability travels beside it.
		NATPredictionEnabled: configuration.NATPredictionEnabled,
		AllowedOrigins:       configuration.AllowedOrigins,
		SiteAccessAtUpgrade: func(request *http.Request) bool {
			return server.siteAccessForRequest(request).isAuthenticated(cookieHeader(request))
		},
		PublicBaseURL:                 configuration.PublicBaseURL,
		Now:                           now,
		AuthenticationTimeoutMs:       options.AuthenticationTimeoutMs,
		ViewerDisconnectGraceMs:       options.ViewerDisconnectGraceMs,
		HeartbeatIntervalMs:           options.HeartbeatIntervalMs,
		CleanupIntervalMs:             options.CleanupIntervalMs,
		MaxConnections:                options.MaxSignalConnections,
		MaxUnauthenticatedConnections: options.MaxUnauthenticatedSignalConnections,
		AfterFunc:                     options.AfterFunc,
		Logger:                        logger,
	}
	server.httpServer = &http.Server{
		Handler:           server,
		ReadHeaderTimeout: headersTimeout,
		ReadTimeout:       requestTimeout,
		IdleTimeout:       keepAliveTimeout,
		// No WriteTimeout: Node had none, and it would cut long downloads.
	}
	return server, nil
}

// newRoomStore builds the room store createScreenerServer would otherwise take
// from Options.RoomStore. An empty RoomDatabasePath is the memory-only mode.
func newRoomStore(options Options, now func() int64) (*room.Store, error) {
	if options.RoomStore != nil {
		return options.RoomStore, nil
	}
	var database *room.Database
	if options.Config.RoomDatabasePath != "" {
		// The file is opened by store.Initialize, not here: a failed bind must
		// leave no database behind.
		opened, err := room.NewDatabase(options.Config.RoomDatabasePath)
		if err != nil {
			return nil, err
		}
		database = opened
	}
	return room.New(room.Options{
		LeaseMs:           options.Config.RoomLeaseMs,
		MaxRooms:          room.Capacity,
		MaxViewersPerRoom: options.Config.MaxViewersPerRoom,
		Database:          database,
		Now:               now,
	})
}

// Handler is the composed router, exposed so a host process can mount it.
func (s *Server) Handler() http.Handler { return s }

// Store is ScreenerServer.roomStore. The signaling server's mutex guards it, so
// callers outside that lock may only read it while no request is in flight.
func (s *Server) Store() *room.Store { return s.store }

// Listen binds application sockets before recovering room authority and accepting traffic.
func (s *Server) Listen(ctx context.Context) (int, error) {
	s.mu.Lock()
	if s.startupRequested {
		s.mu.Unlock()
		return 0, errors.New("Screener server startup was already requested")
	}
	if s.closing {
		s.mu.Unlock()
		return 0, errors.New("Screener server is closing")
	}
	s.startupRequested = true
	s.mu.Unlock()

	// Deferred: a rejected startupOperation still settled, so shutdown's wait
	// on it ended (app.ts:219). A panic escaping start() must likewise release
	// the latch, or every later Close blocks on it for good.
	defer close(s.startupDone)
	return s.start(ctx)
}

func (s *Server) start(ctx context.Context) (int, error) {
	// Bind first. A listener owned by another process must fail before
	// the room database is opened.
	listener := s.listener
	var err error
	if listener == nil {
		address := net.JoinHostPort(s.config.ListenHost, strconv.Itoa(s.config.Port))
		listener, err = net.Listen("tcp", address)
		if err != nil {
			return 0, err
		}
	}
	s.listener = listener
	if len(s.config.STUNListenAddresses) > 0 {
		s.stunServer, err = stun.Listen(ctx, s.config.STUNListenAddresses)
		if err != nil {
			_ = listener.Close()
			return 0, fmt.Errorf("Screener STUN listener failed: %w", err)
		}
	}
	if configuration := s.config.SFU; configuration != nil {
		connection, listenErr := net.ListenPacket("udp4", net.JoinHostPort(configuration.ListenHost, strconv.Itoa(configuration.Port)))
		if listenErr != nil {
			_ = s.stopServing(ctx)
			return 0, fmt.Errorf("Screener SFU listener failed: %w", listenErr)
		}
		factory := diagnostics.PionLoggerFactory()
		s.mediaMux = ice.NewUDPMuxDefault(ice.UDPMuxParams{UDPConn: connection, Logger: factory.NewLogger("sfu-udp")})
		settings := webrtc.SettingEngine{LoggerFactory: factory}
		settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
		settings.SetICEUDPMux(s.mediaMux)
		settings.SetIncludeLoopbackCandidate(net.ParseIP(configuration.ListenHost).IsLoopback())
		if configuration.PublicIP != "" {
			settings.SetNAT1To1IPs([]string{configuration.PublicIP}, webrtc.ICECandidateTypeHost)
		}
		s.media = sfu.NewMedia(sfu.MediaOptions{Settings: settings, Events: func(event sfu.MediaEvent) {
			if signaling := s.signaling.Load(); signaling != nil {
				signaling.HandleSfuMediaEvent(event)
			}
		}})
		s.signalOptions.SfuFallback = &signal.SfuFallback{Media: s.media, Admission: sfu.NewAdmission(sfu.AdmissionOptions{
			IngressCapacity: room.Capacity, EgressCapacity: room.Capacity * s.config.MaxViewersPerRoom,
		})}
	}
	go func() {
		// bindHttpServer removed its "error" listener once the server was
		// listening (app.ts:315-333), so a later listener failure ended the
		// Node process. Serve only returns something other than
		// ErrServerClosed on a permanent accept failure, which nothing here
		// causes; report it rather than serving nothing in silence.
		if err := s.httpServer.Serve(listener); !errors.Is(err, http.ErrServerClosed) {
			s.logger.Error("Screener HTTP server stopped unexpectedly", "errorType", fmt.Sprintf("%T", err))
			s.logger.Debug("http-listener-failed", diagnostics.Error(err))
		}
	}()
	port := listener.Addr().(*net.TCPAddr).Port

	if err := s.reconcile(ctx); err != nil {
		// A13: give the database and the listener back before reporting.
		var cleanup []error
		if closeErr := s.store.Close(); closeErr != nil {
			cleanup = append(cleanup, closeErr)
		}
		if closeErr := s.stopServing(ctx); closeErr != nil {
			cleanup = append(cleanup, closeErr)
		}
		if len(cleanup) > 0 {
			return 0, fmt.Errorf("Screener startup reconciliation failed: %w",
				errors.Join(append([]error{err}, cleanup...)...))
		}
		return 0, err
	}
	return port, nil
}

// stopServing releases the application-owned HTTP and STUN sockets. Shutdown
// stops accepting HTTP and drains, but it can lose the race against the Serve
// goroutine registering the listener, in
// which case it returns without having closed the bound socket; closing the
// listener afterwards makes the port release synchronous. A second close of an
// already closed HTTP listener is harmless.
func (s *Server) stopServing(ctx context.Context) error {
	err := s.httpServer.Shutdown(ctx)
	if s.listener != nil {
		_ = s.listener.Close()
	}
	if s.stunServer != nil {
		err = errors.Join(err, s.stunServer.Close())
		s.stunServer = nil
	}
	if s.media != nil {
		err = errors.Join(err, s.media.Close())
		s.media = nil
	}
	if s.mediaMux != nil {
		err = errors.Join(err, s.mediaMux.Close())
		s.mediaMux = nil
	}
	return err
}

// reconcile restores room authority and enables traffic unless shutdown has begun.
func (s *Server) reconcile(ctx context.Context) error {
	if err := s.store.Initialize(); err != nil {
		return err
	}
	// Holding mu across the check and the two stores is what made the TS
	// single thread safe here: a shutdown that already set closing must never
	// see traffic re-enabled behind it.
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return nil
	}
	signaling, err := signal.New(s.signalOptions)
	if err != nil {
		return err
	}
	s.signaling.Store(signaling)
	s.acceptingTraffic.Store(true)
	return nil
}

// Close stops accepting traffic, closes signaling, the HTTP/STUN listeners and
// the room store, and leaves the rooms in place. Hosted restarts use it.
func (s *Server) Close(ctx context.Context) error {
	return s.shutdown(ctx, false)
}

// End is Close preceded by ending every room. The Client uses it, because its
// authority dies with the process.
func (s *Server) End(ctx context.Context) error {
	return s.shutdown(ctx, true)
}

// shutdown is memoised exactly as the TS shutdownOperation was: the second
// caller joins the first and gets its result, whichever entry point it used.
func (s *Server) shutdown(ctx context.Context, endRooms bool) error {
	s.shutdownOnce.Do(func() { s.shutdownErr = s.runShutdown(ctx, endRooms) })
	return s.shutdownErr
}

func (s *Server) runShutdown(ctx context.Context, endRooms bool) error {
	// O35: stop traffic, mark closing, then wait for an in-flight startup.
	s.mu.Lock()
	s.acceptingTraffic.Store(false)
	s.closing = true
	awaitStartup := s.startupRequested
	s.mu.Unlock()
	if awaitStartup {
		// A6: the listen caller owns the startup error; shutdown only waits.
		<-s.startupDone
	}

	var failures []error
	signaling := s.signaling.Load()
	if endRooms {
		failures = append(failures, s.endAllRooms(signaling))
	}
	if signaling != nil {
		failures = append(failures, signaling.Close(ctx))
	}
	// The signaling server must be closed before the listener: its connections
	// live on it.
	failures = append(failures, s.stopServing(ctx))
	failures = append(failures, s.store.Close())
	if joined := errors.Join(failures...); joined != nil {
		return fmt.Errorf("Screener server shutdown failed: %w", joined)
	}
	return nil
}

// endAllRooms is the TS `signaling ? signaling.endAllRooms() :
// roomStore.abandonAllRooms()`: without a signaling server nobody is connected,
// so the store can be closed down directly.
func (s *Server) endAllRooms(signaling *signal.Server) error {
	if signaling != nil {
		return signaling.EndAllRooms()
	}
	_, err := s.store.AbandonAllRooms()
	return err
}
