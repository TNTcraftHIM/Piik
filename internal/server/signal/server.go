// Package signal owns authenticated signaling and room/media effects. It
// serializes session and presence changes, HTTP-facing room mutations, and
// execution of the synchronous route controller's decisions.
//
// # Locking
//
// Server.mu is the one lock of the effect layer: it guards every field of
// the server and the router, the room.Store and the route controllers. Every
// handler, timer callback and goroutine takes it; it is released only around
// I/O (the password KDF and media transport), after which current session,
// room and operation identities must be revalidated. Router methods and hooks are
// called with mu held and never lock.
package signal

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/TNTcraftHIM/Piik/internal/server/config"
	"github.com/TNTcraftHIM/Piik/internal/server/ordered"
	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
	"github.com/TNTcraftHIM/Piik/internal/server/room"
	"github.com/TNTcraftHIM/Piik/internal/server/route"
	"github.com/TNTcraftHIM/Piik/internal/server/sfu"
)

// Connection admission, queue and timeout bounds limit the signaling resources
// a stalled or unauthenticated peer can retain.
const (
	// maxBufferedSignalBytes is MAX_BUFFERED_SIGNAL_BYTES: once a connection's
	// unsent queue passes it the peer is not draining and the connection is
	// terminated, so one stalled reader cannot grow the server's heap.
	maxBufferedSignalBytes = 256 * 1024
	// defaultMaxSignalConnections and defaultMaxUnauthenticatedConnections are
	// the DEFAULT_MAX_* admission ceilings: 20 viewers plus a host across 9_000
	// room codes is far above either, so they bound abuse, not capacity.
	defaultMaxSignalConnections          = 2_048
	defaultMaxUnauthenticatedConnections = 256
	// minSignalingChallengeIntervalMs is MIN_SIGNALING_CHALLENGE_INTERVAL_MS:
	// the floor between two password challenges on one connection.
	minSignalingChallengeIntervalMs = int64(1_000)
	// serviceRestartCloseGrace is SERVICE_RESTART_CLOSE_GRACE_MS: how long a
	// peer has to acknowledge close{1012} before the socket is terminated.
	serviceRestartCloseGrace = 1_000 * time.Millisecond

	defaultAuthenticationTimeoutMs = 5_000
	defaultViewerDisconnectGraceMs = 5_000
	defaultHeartbeatIntervalMs     = 30_000
)

// SfuFallback configures embedded media; a zero prepare timeout selects the
// router's default.
type SfuFallback struct {
	Media            sfu.Runtime
	Admission        *sfu.Admission
	PrepareTimeoutMs int64
}

// Options supplies room authority, runtime capabilities and signaling limits.
type Options struct {
	Store                     *room.Store
	EndpointMediaCopyCapacity int
	// SfuFallback is nil when embedded SFU media is disabled.
	SfuFallback *SfuFallback
	// Ice is the derived wire ICE configuration (config.IceConfig).
	Ice protocol.IceConfig
	// NATPredictionEnabled is the server capability that clamps a Host's
	// requested natPrediction route policy (configuredRoutePolicy). It is
	// not derivable from Ice: an enabled capability with no STUN listener
	// still echoes the Host's policy.
	NATPredictionEnabled bool
	AllowedOrigins       map[string]struct{}
	SiteAccessAtUpgrade  func(*http.Request) bool
	PublicBaseURL        *url.URL
	// Now returns Unix milliseconds; nil uses the wall clock.
	Now                           func() int64
	AuthenticationTimeoutMs       int
	ViewerDisconnectGraceMs       int
	HeartbeatIntervalMs           int
	MaxConnections                int
	MaxUnauthenticatedConnections int
	// AfterFunc is the timer factory (D5); nil uses time.AfterFunc.
	AfterFunc func(time.Duration, func()) func() bool
	// Logger receives the three console.error records; nil uses slog.Default().
	Logger *slog.Logger
}

// viewerQualityEvidenceGate is ViewerQualityEvidenceGate; upstreamPeerID is
// "" where the TS had null.
type viewerQualityEvidenceGate struct {
	viewerSessionID   string
	upstreamKind      string
	upstreamPeerID    string
	connectionID      string
	presentationEpoch int64
	sequence          int64
}

// viewerQualityEvidenceAttempt is viewerQualityEvidenceAttemptAtMs plus the
// committed-edge connection the stamp was taken under. Tagging replaces the
// TS setViewerConnectionId reset: a viewer whose media identity changed is
// never held back by the previous route's stamp.
//
// Deviation: it does not replace the deleteViewerConnectionId reset, which
// broadcastActive also ran when a viewer's path stopped being physical. A
// viewer whose path breaks and heals on the same committed connection without
// sending evidence in between keeps its stamp here, where the TypeScript had
// cleared it, so one frame inside the 2 s window can be dropped that the
// TypeScript accepted. Unobservable: the reporter's own
// VIEWER_QUALITY_EVIDENCE_INTERVAL_MS gate means its next send is already at
// least that far from the last accepted one. The epoch/sequence gate below
// cannot be affected the same way, because a committed edge that loses
// physicalActive is never reactivated - its replacement carries a new
// connectionID, so sameEdge is false.
type viewerQualityEvidenceAttempt struct {
	connectionID string
	atMs         int64
}

// roomShare is one Host share of one room. Its zero value is the TS state
// where none of the four per-room share maps had an entry, so reads need no
// presence check: generation and pausedGeneration are never stored empty
// (authenticate falls back to the session id), which is what made the TS
// `undefined === undefined` comparisons meaningful.
type roomShare struct {
	// generation survives stopSharing; only closeRoom drops the whole
	// record (hazard 2).
	generation string
	// qualitySettings and routePolicy are nil where the TS map had no entry;
	// their presence is observable (hazard 3, and the host `authenticated`
	// quality default).
	qualitySettings *protocol.QualitySettings
	routePolicy     *protocol.RoutePolicy
	// pausedGeneration is the share generation the Host paused, "" if none.
	pausedGeneration string
}

// senderQualityRateWindow is SenderQualityRateWindow.
type senderQualityRateWindow struct {
	startedAtMs int64
	count       int
}

// graceTimer is one viewerGraceTimers entry; the callback compares the
// registered pointer with its own (a cleared TS timer never fired).
type graceTimer struct {
	stop func() bool
}

// Server is SignalingServer.
type Server struct {
	// ponytail: global lock, per-room locks if throughput matters
	mu sync.Mutex

	store                     *room.Store
	endpointMediaCopyCapacity int
	sfuFallback               *SfuFallback
	ice                       protocol.IceConfig
	natPredictionEnabled      bool
	allowedOrigins            map[string]struct{}
	siteAccessAtUpgrade       func(*http.Request) bool
	publicBaseURL             *url.URL
	now                       func() int64
	afterFunc                 func(time.Duration, func()) func() bool
	logger                    *slog.Logger

	authenticationTimeoutMs       int
	viewerDisconnectGraceMs       int
	heartbeatIntervalMs           int
	maxConnections                int
	maxUnauthenticatedConnections int

	router *router

	// sessions is socketStates (O11: heartbeat walks it in insertion order);
	// sessionsByID is socketsBySessionId.
	sessions     ordered.Map[*session, struct{}]
	sessionsByID map[string]*session
	// pendingConnections reserves the slots of upgrades between the capacity
	// check and accept() (D4).
	pendingConnections         int
	unauthenticatedConnections int

	viewerGraceTimers             map[string]*graceTimer
	viewerQualityEvidenceGates    map[string]viewerQualityEvidenceGate
	viewerQualityEvidenceAttempts map[string]viewerQualityEvidenceAttempt
	senderQualityRateBySession    map[string]*senderQualityRateWindow
	// shares owns the whole per-room share lifecycle (TS
	// shareGenerationsByRoom, qualitySettingsByRoom, routePolicyByRoom and
	// pausedShareGenerationsByRoom).
	shares                      map[string]roomShare
	deferredViewerPresenceRooms map[string]struct{}

	heartbeatStop func() bool
	closing       bool
}

// New is the SignalingServer constructor. It performs no I/O; the heartbeat
// ticker starts immediately.
func New(options Options) (*Server, error) {
	if err := protocol.AssertEndpointMediaCopyCapacity(options.EndpointMediaCopyCapacity); err != nil {
		return nil, err
	}
	if options.Store == nil {
		return nil, errors.New("signaling requires a room store")
	}
	if options.SfuFallback != nil && (options.SfuFallback.Media == nil || options.SfuFallback.Admission == nil) {
		return nil, errors.New("SFU fallback requires media and resource admission")
	}
	s := &Server{
		store:                         options.Store,
		endpointMediaCopyCapacity:     options.EndpointMediaCopyCapacity,
		sfuFallback:                   options.SfuFallback,
		ice:                           options.Ice,
		natPredictionEnabled:          options.NATPredictionEnabled,
		allowedOrigins:                options.AllowedOrigins,
		siteAccessAtUpgrade:           options.SiteAccessAtUpgrade,
		publicBaseURL:                 options.PublicBaseURL,
		now:                           options.Now,
		afterFunc:                     options.AfterFunc,
		logger:                        options.Logger,
		authenticationTimeoutMs:       orDefault(options.AuthenticationTimeoutMs, defaultAuthenticationTimeoutMs),
		viewerDisconnectGraceMs:       orDefault(options.ViewerDisconnectGraceMs, defaultViewerDisconnectGraceMs),
		heartbeatIntervalMs:           orDefault(options.HeartbeatIntervalMs, defaultHeartbeatIntervalMs),
		maxConnections:                orDefault(options.MaxConnections, defaultMaxSignalConnections),
		maxUnauthenticatedConnections: orDefault(options.MaxUnauthenticatedConnections, defaultMaxUnauthenticatedConnections),
		sessionsByID:                  map[string]*session{},
		viewerGraceTimers:             map[string]*graceTimer{},
		viewerQualityEvidenceGates:    map[string]viewerQualityEvidenceGate{},
		viewerQualityEvidenceAttempts: map[string]viewerQualityEvidenceAttempt{},
		senderQualityRateBySession:    map[string]*senderQualityRateWindow{},
		shares:                        map[string]roomShare{},
		deferredViewerPresenceRooms:   map[string]struct{}{},
	}
	if s.maxConnections <= 0 || s.maxUnauthenticatedConnections <= 0 ||
		s.maxUnauthenticatedConnections > s.maxConnections {
		return nil, errors.New("WebSocket connection limits are invalid")
	}
	if s.now == nil {
		s.now = func() int64 { return time.Now().UnixMilli() }
	}
	if s.afterFunc == nil {
		s.afterFunc = func(d time.Duration, fn func()) func() bool {
			return time.AfterFunc(d, fn).Stop
		}
	}
	if s.logger == nil {
		s.logger = slog.Default()
	}
	if s.siteAccessAtUpgrade == nil {
		s.siteAccessAtUpgrade = func(*http.Request) bool { return true }
	}
	var fallback *sfuFallback
	if options.SfuFallback != nil {
		fallback = &sfuFallback{
			media:            options.SfuFallback.Media,
			admission:        options.SfuFallback.Admission,
			prepareTimeoutMs: options.SfuFallback.PrepareTimeoutMs,
		}
	}
	mediaRouter, err := buildRouter(routerOptions{
		mu:                        &s.mu,
		store:                     s.store,
		endpointMediaCopyCapacity: s.endpointMediaCopyCapacity,
		sfu:                       fallback,
		hooks: routerHooks{
			sendToSession:   s.sendToSession,
			shareGeneration: func(roomID string) string { return s.shares[roomID].generation },
			routesChanged:   s.sendViewerPresence,
		},
		now:       s.now,
		afterFunc: s.afterFunc,
	})
	if err != nil {
		return nil, err
	}
	s.router = mediaRouter
	s.mu.Lock()
	s.armHeartbeat()
	s.mu.Unlock()
	return s, nil
}

// buildRouter returns constructor assertions through the startup error path.
func buildRouter(options routerOptions) (r *router, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("%v", recovered)
		}
	}()
	return newRouter(options), nil
}

func orDefault(value, fallback int) int {
	if value == 0 {
		return fallback
	}
	return value
}

// InviteURL is viewerInviteUrl / the inviteUrl of createRoomResponse:
// new URL(`/r/${roomId}`, publicBaseUrl) with the Viewer grant in the
// fragment only. viewerGrant "" is the TypeScript null.
func InviteURL(publicBaseURL *url.URL, roomID, viewerGrant string) string {
	invite := *publicBaseURL
	invite.Opaque = ""
	invite.Path = "/r/" + roomID
	invite.RawPath = ""
	invite.ForceQuery = false
	invite.RawQuery = ""
	invite.Fragment = ""
	invite.RawFragment = ""
	if viewerGrant != "" {
		invite.Fragment = "v=" + viewerGrant
	}
	return invite.String()
}

// ---------------------------------------------------------------------------
// upgrade
// ---------------------------------------------------------------------------

// ServeHTTP is the "upgrade" listener: the TS rejection ladder, then the
// accept (D4).
func (s *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	// accepts a scheme-relative target such as "//[" as a plain path, so
	// the WHATWG authority parse is re-run on the raw target.
	if _, err := url.Parse(request.RequestURI); err != nil {
		rejectUpgrade(writer, http.StatusBadRequest)
		return
	}
	// EscapedPath, not Path: the WHATWG pathname the TS compared is not
	// percent-decoded, so "/%73ignal" was a 404 there, while URL.Path decodes
	// it to "/signal" and would give the endpoint an alias the TS never had.
	// This is the path notion the sibling HTTP router already uses
	// (app/json.go requestPath), with the same dot-segment deviation.
	if request.URL.EscapedPath() != "/signal" || request.URL.RawQuery != "" {
		rejectUpgrade(writer, http.StatusNotFound)
		return
	}
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		rejectUpgrade(writer, http.StatusServiceUnavailable)
		return
	}
	if !s.isAllowedOrigin(request.Header.Get("Origin")) {
		s.mu.Unlock()
		rejectUpgrade(writer, http.StatusForbidden)
		return
	}
	if !s.hasConnectionCapacity() {
		s.mu.Unlock()
		rejectUpgrade(writer, http.StatusServiceUnavailable)
		return
	}
	// The TS counted the slot synchronously inside handleUpgrade; Accept
	// performs I/O, so the slot is reserved across it.
	s.pendingConnections++
	s.mu.Unlock()

	siteAccessAuthenticated := s.siteAccessAtUpgrade(request)
	var sess *session
	// Origin was verified above with the exact isAllowedOrigin rule, so the
	// library's own check is skipped; the TS ws server never compressed.
	conn, err := websocket.Accept(writer, request, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
		OnPongReceived: func(context.Context, []byte) {
			s.mu.Lock()
			if sess != nil {
				sess.alive = true
			}
			s.mu.Unlock()
		},
	})
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pendingConnections--
	if err != nil {
		return
	}
	conn.SetReadLimit(protocol.MaxSignalBytes)
	sess = s.accept(conn, siteAccessAuthenticated)
}

// rejectUpgrade is `HTTP/1.1 {status} {message}\r\nConnection: close\r\n
// Content-Length: 0\r\n\r\n`; net/http supplies the reason phrase.
func rejectUpgrade(writer http.ResponseWriter, status int) {
	writer.Header().Set("Connection", "close")
	writer.Header().Set("Content-Length", "0")
	writer.WriteHeader(status)
}

// isAllowedOrigin ports isAllowedOrigin: present, parses, equal to its own
// serialised origin (so "http://x/path" is refused) and configured.
func (s *Server) isAllowedOrigin(origin string) bool {
	if origin == "" {
		return false
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return false
	}
	_, allowed := s.allowedOrigins[origin]
	return config.Origin(parsed) == origin && allowed
}

// hasConnectionCapacity ports hasConnectionCapacity with the reserved slots
// counted in.
func (s *Server) hasConnectionCapacity() bool {
	return !s.closing &&
		s.sessions.Len()+s.pendingConnections < s.maxConnections &&
		s.unauthenticatedConnections+s.pendingConnections < s.maxUnauthenticatedConnections
}

// ---------------------------------------------------------------------------
// lifecycle and HTTP-facing mutations
// ---------------------------------------------------------------------------

// Close ports close() (D6). Every client is told 1012 "Service restart"
// before the router drains, as the TS did; readers get one second to finish
// the close handshake, survivors are terminated, and the router's drain
// error, if any, is returned after everything else settled.
func (s *Server) Close(ctx context.Context) error {
	s.mu.Lock()
	s.closing = true
	if s.heartbeatStop != nil {
		s.heartbeatStop()
	}
	for key, timer := range s.viewerGraceTimers {
		timer.stop()
		delete(s.viewerGraceTimers, key)
	}
	sessions := s.sessions.Keys()
	for _, sess := range sessions {
		sess.clearAuthenticationTimer()
		sess.close(websocket.StatusServiceRestart, "Service restart")
	}

	// T4: the grace starts where forceCloseTimer was armed, before
	// `await this.hybridMediaRouter.close()` (signaling.ts:251-259).
	//
	// Deviation (D6): the TS timer fired on its own and terminated the
	// remaining clients at one second even while the drains were still
	// running; here the grace is only consumed by the waits below, so a
	// survivor is terminated after max(1 s, the router close). D6 specifies
	// this shape ("wait for reader goroutines with min(ctx, 1 s), then
	// CloseNow survivors"), and Close returns at the same moment either way,
	// because the TS also awaited the drains before returning.
	grace := time.NewTimer(serviceRestartCloseGrace)
	defer grace.Stop()
	// TS close() ran `this.closing = true` and the router's synchronous close
	// prefix (its own closing flag, every deadline and operation
	// timer, the drains) in one tick; only the drain waits yielded. Keeping mu
	// held across that prefix reproduces it: a router timer callback that
	// fires now cannot slip in between and start a new media operation.
	routeCloseError := s.router.close(ctx)
	s.mu.Unlock()

	// A fired timer channel never delivers again, so once the grace has expired
	// every session still inside its close handshake is a survivor.
	var survivors []*session
	expired := false
	for _, sess := range sessions {
		if !expired {
			select {
			case <-sess.readerDone:
				continue
			case <-grace.C:
			case <-ctx.Done():
			}
			expired = true
		}
		select {
		case <-sess.readerDone:
		default:
			survivors = append(survivors, sess)
		}
	}
	if len(survivors) > 0 {
		s.mu.Lock()
		for _, sess := range survivors {
			sess.terminate()
		}
		s.mu.Unlock()
		for _, sess := range survivors {
			select {
			case <-sess.readerDone:
			case <-ctx.Done():
			}
		}
	}
	return routeCloseError
}

// EndAllRooms ports endAllRooms() (O3: store order).
func (s *Server) EndAllRooms() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	closedRooms, err := s.store.AbandonAllRooms()
	if err != nil {
		return err
	}
	for _, closed := range closedRooms {
		s.closeRoom(closed)
	}
	return nil
}

// UpdateRoomAccess ports updateRoomAccess(). The set-viewer-password action
// releases mu around the password KDF (S3) in the sequence the room package
// documents. Like the other room mutations it takes no context: Node ran a
// room mutation to completion even when the browser went away, and half of a
// mutation is worse than a wasted one.
func (s *Server) UpdateRoomAccess(
	roomID, hostToken string,
	request protocol.RoomAccessUpdateRequest,
) (protocol.RoomAccessUpdateResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch action := request.(type) {
	case protocol.SetCodeEntryPolicyRequest:
		update, err := s.store.SetCodeEntryPolicy(roomID, action.Policy, hostToken)
		if err != nil {
			return nil, err
		}
		return protocol.CodeEntryPolicyUpdatedResponse{
			Type:                  "code-entry-policy-updated",
			CodeEntryPolicy:       update.CodeEntryPolicy,
			ViewerPasswordEnabled: update.ViewerPasswordEnabled,
		}, nil
	case protocol.SetViewerPasswordRequest:
		current, err := s.store.HostManagedRoom(roomID, hostToken)
		if err != nil {
			return nil, err
		}
		material, derived := s.deriveViewerPasswordMaterial(roomID, hostToken, action.Password, current)
		enabled, err := s.store.SetViewerPassword(roomID, hostToken, material, derived, current)
		if err != nil {
			return nil, err
		}
		return protocol.ViewerPasswordUpdatedResponse{Type: "viewer-password-updated", Enabled: enabled}, nil
	case protocol.RotateViewerGrantRequest, protocol.RevokeViewerGrantRequest:
		verb := "revoke"
		if _, rotate := action.(protocol.RotateViewerGrantRequest); rotate {
			verb = "rotate"
		}
		update, err := s.store.SetViewerGrant(roomID, verb, hostToken)
		if err != nil {
			return nil, err
		}
		s.revokeGrantViewers(roomID, update)
		var inviteURL *string
		if verb == "rotate" {
			invite := InviteURL(s.publicBaseURL, roomID, update.ViewerGrant)
			inviteURL = &invite
		}
		return protocol.ViewerGrantUpdatedResponse{
			Type:                          "viewer-grant-updated",
			ViewerAuthorizationGeneration: update.ViewerAuthorizationGeneration,
			InviteURL:                     inviteURL,
		}, nil
	}
	return nil, fmt.Errorf("unknown room access request %T", request)
}

// deriveViewerPasswordMaterial is the unlocked KDF window of replaceRoom and
// setViewerPassword; mayStart is the TS `rooms.get(roomId) === current &&
// verifyDigest(hostToken)` closure. mu must be held; it is released only
// while the derivation runs. A nil password derives nothing.
func (s *Server) deriveViewerPasswordMaterial(
	roomID, hostToken string, password *string, current *room.Room,
) (material []byte, derived error) {
	if password == nil || *password == "" {
		return nil, nil
	}
	s.mu.Unlock()
	defer s.mu.Lock()
	return s.store.DeriveViewerPasswordMaterial(*password, func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.store.HostStillOwnsRoom(roomID, hostToken, current)
	})
}

// ReplaceRoom ports replaceRoom() (S4): the KDF runs unlocked, the commit
// and closeRoom run locked.
func (s *Server) ReplaceRoom(
	roomID, hostToken string,
	codeEntryPolicy protocol.CodeEntryPolicy,
	roomPassword *string,
) (room.CreatedRoom, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.store.HostManagedRoom(roomID, hostToken)
	if err != nil {
		return room.CreatedRoom{}, err
	}
	material, derived := s.deriveViewerPasswordMaterial(roomID, hostToken, roomPassword, current)
	replacement, err := s.store.ReplaceRoom(roomID, hostToken, codeEntryPolicy, material, derived, current)
	if err != nil {
		return room.CreatedRoom{}, err
	}
	s.closeRoom(replacement.Closed)
	return replacement.Created, nil
}

// CreateRoom is the roomStore.createRoom call of app.ts, run under mu with
// the KDF unlocked (the room package's documented sequence).
func (s *Server) CreateRoom(
	codeEntryPolicy protocol.CodeEntryPolicy,
	roomPassword *string,
	preferredRoomID string,
) (room.CreatedRoom, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.store.BeginCreateRoom(); err != nil {
		return room.CreatedRoom{}, err
	}
	var material []byte
	var derived error
	if roomPassword != nil && *roomPassword != "" {
		func() {
			s.mu.Unlock()
			defer s.mu.Lock()
			material, derived = s.store.DeriveViewerPasswordMaterial(*roomPassword, nil)
		}()
	}
	return s.store.CreateRoom(codeEntryPolicy, material, derived, preferredRoomID)
}

// armHeartbeat is the heartbeat setInterval (T1): each tick re-arms the
// next; a tick that lost the Stop race sees closing.
func (s *Server) armHeartbeat() {
	interval := time.Duration(s.heartbeatIntervalMs) * time.Millisecond
	s.heartbeatStop = s.afterFunc(interval, func() {
		s.mu.Lock()
		if s.closing {
			s.mu.Unlock()
			return
		}
		pings := s.heartbeat()
		s.armHeartbeat()
		s.mu.Unlock()
		for _, sess := range pings {
			go sess.ping(interval)
		}
	})
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

// handleMessage ports handleMessage(). mu must be held.
func (s *Server) handleMessage(sess *session, encoded []byte) {
	if !s.sessions.Has(sess) || s.closing {
		return
	}
	if sess.revoked {
		return
	}
	message, err := protocol.DecodeClientMessage(encoded)
	if err != nil {
		s.rejectInvalidMessage(sess)
		return
	}
	if _, evidence := message.(protocol.ViewerQualityEvidenceMessage); evidence &&
		len(encoded) > protocol.MaxViewerQualityEvidenceBytes {
		s.rejectInvalidMessage(sess)
		return
	}

	if sess.authenticated == nil {
		request, isAuthenticate := authRequestOf(message)
		if !isAuthenticate {
			s.sendError(sess, "AUTH_REQUIRED", "Authenticate before sending messages")
			sess.close(websocket.StatusCode(protocol.SignalCloseAuthenticationFailed), "Authentication required")
			return
		}
		if sess.authenticating {
			s.rejectInvalidMessage(sess)
			return
		}
		sess.authenticating = true
		s.authenticate(sess, request)
		return
	}
	if _, isAuthenticate := message.(protocol.AuthenticateHostMessage); isAuthenticate {
		s.sendError(sess, "FORBIDDEN", "Session is already authenticated")
		return
	}
	if _, isAuthenticate := message.(protocol.AuthenticateViewerMessage); isAuthenticate {
		s.sendError(sess, "FORBIDDEN", "Session is already authenticated")
		return
	}
	if !s.isCurrentSession(sess) {
		sess.close(websocket.StatusCode(protocol.SignalCloseSessionReplaced), "Session replaced")
		return
	}
	s.handleAuthenticatedMessage(sess, sess.authenticated, message)
}

// authRequest is the role-agnostic view of an authenticate message: the
// fields authenticate() and authenticationErrorCode() read. Empty strings
// and nil pointers are absent keys.
type authRequest struct {
	role            protocol.Role
	roomID          string
	clientID        string
	token           string
	viewerGrant     string
	viewerPassword  string
	shareGeneration string
	sharingPaused   bool
	qualitySettings *protocol.QualitySettings
	routePolicy     protocol.RoutePolicy
	viewerPresence  bool
	displayName     *string
}

func authRequestOf(message protocol.ClientMessage) (authRequest, bool) {
	switch m := message.(type) {
	case protocol.AuthenticateHostMessage:
		return authRequest{
			role:            protocol.RoleHost,
			roomID:          m.RoomID,
			clientID:        m.ClientID,
			token:           m.Token,
			shareGeneration: m.ShareGeneration,
			sharingPaused:   m.SharingPaused != nil && *m.SharingPaused,
			qualitySettings: m.QualitySettings,
			routePolicy:     m.RoutePolicy,
			viewerPresence:  m.ViewerPresence,
			displayName:     displayNameString(m.DisplayName),
		}, true
	case protocol.AuthenticateViewerMessage:
		return authRequest{
			role:           protocol.RoleViewer,
			roomID:         m.RoomID,
			clientID:       m.ClientID,
			viewerGrant:    m.ViewerGrant,
			viewerPassword: m.ViewerPassword,
			viewerPresence: m.ViewerPresence,
			displayName:    displayNameString(m.DisplayName),
		}, true
	}
	return authRequest{}, false
}

func displayNameString(name *protocol.DisplayName) *string {
	if name == nil {
		return nil
	}
	value := string(*name)
	return &value
}

// authenticate ports authenticate() up to its one await. The non-password
// branches had no await and run to completion here, inside the caller's
// critical section, exactly as the TS ran them; the password branch is a
// goroutine (D5) so the reader keeps reading while the KDF runs.
func (s *Server) authenticate(sess *session, request authRequest) {
	if request.role == protocol.RoleHost && !sess.siteAccessAuthenticated {
		s.sendError(sess, "AUTH_REQUIRED", "Site access is required")
		sess.close(websocket.StatusCode(protocol.SignalCloseAuthenticationFailed), "Authentication failed")
		s.finishAuthenticating(sess)
		return
	}
	if request.role == protocol.RoleViewer && !sess.siteAccessAuthenticated {
		mayEnter := false
		if request.viewerGrant != "" {
			allowed, err := s.store.ViewerGrantMayEnter(request.roomID, request.viewerGrant)
			if err != nil {
				s.authenticationFailed(sess, request, err)
				s.finishAuthenticating(sess)
				return
			}
			mayEnter = allowed
		}
		if !mayEnter {
			s.sendError(sess, "INVALID_TOKEN", authenticationErrorMessage("INVALID_TOKEN"))
			sess.close(websocket.StatusCode(protocol.SignalCloseAuthenticationFailed), "Authentication failed")
			s.finishAuthenticating(sess)
			return
		}
	}

	if request.role == protocol.RoleViewer && request.viewerGrant == "" && request.viewerPassword != "" {
		go s.authenticateWithPassword(sess, request)
		return
	}
	participant, err := s.store.ConnectParticipant(room.ConnectParticipantInput{
		RoomID:      request.roomID,
		Role:        request.role,
		Token:       request.token,
		ViewerGrant: request.viewerGrant,
		ClientID:    request.clientID,
		SessionID:   sess.sessionID,
	})
	if err != nil {
		s.authenticationFailed(sess, request, err)
	} else {
		s.completeAuthentication(sess, request, participant)
	}
	s.finishAuthenticating(sess)
}

// finishAuthenticating is the `.finally` of `void this.authenticate(...)`.
func (s *Server) finishAuthenticating(sess *session) {
	if s.sessions.Has(sess) {
		sess.authenticating = false
	}
}

// authenticateWithPassword is the connectViewerWithPassword branch (S5): the
// KDF runs with mu released; mayConnect is evaluated on the derive goroutine
// (gate admission) and again inside the commit, both against live state.
func (s *Server) authenticateWithPassword(sess *session, request authRequest) {
	mayConnect := func() bool {
		return !s.closing && s.sessions.Has(sess) && !sess.revoked &&
			sess.authenticated == nil && sess.open()
	}
	s.mu.Lock()
	salt, expected, ref, err := s.store.ViewerPasswordChallenge(request.roomID)
	s.mu.Unlock()
	var derivedKey []byte
	if err == nil {
		derivedKey, err = s.store.DeriveViewerPassword(request.viewerPassword, salt, func() bool {
			s.mu.Lock()
			defer s.mu.Unlock()
			return mayConnect()
		})
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	defer s.finishAuthenticating(sess)
	var participant room.ConnectedParticipant
	if err == nil {
		participant, err = s.store.ConnectViewerWithPassword(room.ConnectViewerWithPasswordInput{
			RoomID:    request.roomID,
			Password:  request.viewerPassword,
			ClientID:  request.clientID,
			SessionID: sess.sessionID,
		}, derivedKey, expected, ref, mayConnect)
	}
	if err != nil {
		s.authenticationFailed(sess, request, err)
		return
	}
	s.completeAuthentication(sess, request, participant)
}

// authenticationFailed is the catch of authenticate(): silent for a socket
// that is gone or revoked, otherwise the mapped error and 4003.
func (s *Server) authenticationFailed(sess *session, request authRequest, err error) {
	if !s.sessions.Has(sess) || sess.revoked {
		return
	}
	var roomError *room.Error
	if !errors.As(err, &roomError) {
		s.logger.Error("Signaling authentication failed unexpectedly")
	}
	code := authenticationErrorCode(request, err)
	s.sendError(sess, code, authenticationErrorMessage(code))
	sess.close(websocket.StatusCode(protocol.SignalCloseAuthenticationFailed), "Authentication failed")
}

// completeAuthentication is authenticate() after the store admitted the
// participant (lines 519-751), starting with the post-await guard.
func (s *Server) completeAuthentication(sess *session, request authRequest, participant room.ConnectedParticipant) {
	if s.closing || !s.sessions.Has(sess) || sess.revoked || !sess.open() {
		if _, err := s.store.DisconnectParticipant(participant.RoomID, participant.PeerID, sess.sessionID); err != nil {
			// The TS threw out of the async function; there is no catcher (D7).
			panic(fmt.Errorf("room store failed while releasing an aborted authentication: %w", err))
		}
		return
	}

	sess.clearAuthenticationTimer()
	s.unauthenticatedConnections--
	roomID := participant.RoomID
	shareGeneration := ""
	if participant.Role == protocol.RoleHost && request.role == protocol.RoleHost {
		shareGeneration = s.settleHostShare(roomID, sess.sessionID, request)
	}
	displayName := authenticatedDisplayName(request)
	authenticated := &authenticatedSession{
		roomID:          roomID,
		role:            participant.Role,
		peerID:          participant.PeerID,
		shareGeneration: shareGeneration,
		displayName:     displayName,
		viewerPresence:  request.viewerPresence,
	}
	sess.authenticated = authenticated
	if participant.Role == protocol.RoleViewer {
		s.clearViewerEvidence(roomID, participant.PeerID)
	}
	s.clearViewerGrace(roomID, participant.PeerID)
	routeParticipant := authenticatedRouteParticipant{
		roomID:    roomID,
		role:      participant.Role,
		peerID:    participant.PeerID,
		sessionID: sess.sessionID,
	}
	if participant.Role == protocol.RoleHost {
		policy := s.routePolicyOf(roomID)
		routeParticipant.routePolicy = &policy
	}
	hybridState, assigned := s.connectRouteParticipant(routeParticipant)
	if !assigned {
		s.logger.Error("Media router did not assign an authenticated participant")
		s.sendError(sess, "SERVER_ERROR", "Media assignment failed")
		sess.close(websocket.StatusInternalError, "Media assignment failed")
		return
	}
	// The viewer's media identity is derived from the committed edge, never
	// stored beside it; connectParticipant has just settled the graph.
	var connectionID *string
	if participant.Role == protocol.RoleViewer {
		if edge, ok := s.router.resolveActiveViewerMediaEdge(roomID, participant.PeerID); ok {
			current := edge.connectionID
			connectionID = &current
		}
	}
	// O7: the host-status fan-out below uses this pre-router snapshot.
	var connectedViewers []room.ConnectedPeer
	if participant.Role == protocol.RoleHost {
		connectedViewers = s.store.GetConnectedViewers(roomID)
	}
	share := s.shares[roomID]
	routePolicy := s.routePolicyOf(roomID)

	qualitySettings := protocol.DefaultQualitySettings
	if share.qualitySettings != nil {
		qualitySettings = *share.qualitySettings
	}
	var roomShareGeneration *string
	if share.generation != "" {
		generation := share.generation
		roomShareGeneration = &generation
	}
	if participant.Role == protocol.RoleHost {
		s.send(sess, protocol.AuthenticatedHostMessage{
			Type:                          "authenticated",
			Protocol:                      protocol.SignalingProtocol,
			PeerID:                        participant.PeerID,
			MaxViewers:                    protocol.Int(s.store.MaxViewersPerRoom()),
			EndpointMediaCopyCapacity:     protocol.Int(s.endpointMediaCopyCapacity),
			HostOnline:                    participant.HostOnline,
			ConnectionID:                  connectionID,
			IceConfig:                     s.ice,
			RoutePolicy:                   routePolicy,
			CodeEntryPolicy:               participant.CodeEntryPolicy,
			ViewerAuthorizationGeneration: participant.ViewerAuthorizationGeneration,
			MediaMode:                     "peer-assisted",
			ShareGeneration:               roomShareGeneration,
			RouteRevision:                 protocol.Int(hybridState.routeRevision),
			RouteAssignment:               hybridState.routeAssignment,
			QualitySettings:               qualitySettings,
			Role:                          protocol.RoleHost,
			ViewerPasswordEnabled:         participant.ViewerPasswordEnabled,
		})
	} else {
		hostPaused := participant.HostOnline &&
			share.pausedGeneration == share.generation
		s.send(sess, protocol.AuthenticatedViewerMessage{
			Type:                          "authenticated",
			Protocol:                      protocol.SignalingProtocol,
			PeerID:                        participant.PeerID,
			MaxViewers:                    protocol.Int(s.store.MaxViewersPerRoom()),
			EndpointMediaCopyCapacity:     protocol.Int(s.endpointMediaCopyCapacity),
			HostOnline:                    participant.HostOnline,
			HostPaused:                    &hostPaused,
			ConnectionID:                  connectionID,
			IceConfig:                     s.ice,
			RoutePolicy:                   routePolicy,
			CodeEntryPolicy:               participant.CodeEntryPolicy,
			ViewerAuthorizationGeneration: participant.ViewerAuthorizationGeneration,
			MediaMode:                     "peer-assisted",
			ShareGeneration:               roomShareGeneration,
			RouteRevision:                 protocol.Int(hybridState.routeRevision),
			RouteAssignment:               hybridState.routeAssignment,
			QualitySettings:               qualitySettings,
			Role:                          protocol.RoleViewer,
		})
	}
	if participant.ReplacedSessionID != "" {
		if replaced := s.sessionsByID[participant.ReplacedSessionID]; replaced != nil && replaced != sess {
			replaced.close(websocket.StatusCode(protocol.SignalCloseSessionReplaced), "Session replaced")
		}
	}

	if participant.Role == protocol.RoleHost {
		s.router.setPaused(roomID, s.shares[roomID].pausedGeneration == shareGeneration)
	}
	s.router.completeAuthentication(routeParticipant, hybridState)

	if participant.Role == protocol.RoleHost && shareGeneration != "" &&
		s.shares[roomID].pausedGeneration == shareGeneration {
		s.sendToSession(sess.sessionID, protocol.PauseSharingSourceMessage{
			Type:            "pause-sharing-source",
			ShareGeneration: shareGeneration,
		})
	}

	s.sendViewerPresence(roomID)

	if participant.Role == protocol.RoleHost {
		for _, viewer := range connectedViewers {
			s.sendToSession(viewer.SessionID, protocol.HostStatusMessage{
				Type:   "host-status",
				Online: true,
				Paused: s.shares[roomID].pausedGeneration == shareGeneration,
			})
		}
	}
}

// settleHostShare is the share half of authenticate() for a Host: it settles
// which share generation this connection owns, retires a superseded one, and
// broadcasts the quality settings and route policy the new generation starts
// with. It returns the settled generation and must run with mu held, before the
// `authenticated` message is built from the record it writes.
func (s *Server) settleHostShare(roomID, sessionID string, request authRequest) string {
	current := s.shares[roomID]
	currentGeneration := current.generation
	shareGeneration := request.shareGeneration
	if shareGeneration == "" {
		shareGeneration = currentGeneration
	}
	if shareGeneration == "" {
		shareGeneration = sessionID
	}
	sameShareWasAuthoritativelyPaused := currentGeneration == shareGeneration &&
		current.pausedGeneration == shareGeneration
	if currentGeneration != "" && currentGeneration != shareGeneration {
		s.stopSharing(roomID)
	}
	// stopSharing may have cleared the record, so the survivors are read
	// after it, exactly as the TS map reads were.
	share := s.shares[roomID]
	if request.shareGeneration != "" &&
		(currentGeneration != shareGeneration || share.qualitySettings == nil) {
		initialQualitySettings := protocol.DefaultQualitySettings
		if request.qualitySettings != nil {
			initialQualitySettings = *request.qualitySettings
		}
		share.qualitySettings = &initialQualitySettings
		// O6: store order.
		for _, viewer := range s.store.GetConnectedViewers(roomID) {
			s.sendToSession(viewer.SessionID, protocol.QualitySettingsMessage{
				Type:            "quality-settings",
				QualitySettings: initialQualitySettings,
			})
		}
	}
	if currentGeneration != shareGeneration || share.routePolicy == nil {
		routePolicy := s.configuredRoutePolicy(request.routePolicy)
		share.routePolicy = &routePolicy
		for _, viewer := range s.store.GetConnectedViewers(roomID) {
			message := protocol.RoutePolicyMessage{
				Type:            "route-policy",
				ShareGeneration: shareGeneration,
				RoutePolicy:     routePolicy,
			}
			// Hazard 3: no `has(roomId)` term here, unlike `authenticated`.
			s.sendToSession(viewer.SessionID, message)
		}
	}
	share.generation = shareGeneration
	share.pausedGeneration = ""
	if request.sharingPaused || sameShareWasAuthoritativelyPaused {
		share.pausedGeneration = shareGeneration
	}
	s.shares[roomID] = share
	return shareGeneration
}

// authenticatedDisplayName is the display name authenticate() records: nil for
// a Host that did not opt into viewer presence, and otherwise the requested
// name or the role's default.
func authenticatedDisplayName(request authRequest) *string {
	if request.role == protocol.RoleHost && !request.viewerPresence {
		return nil
	}
	if request.displayName != nil {
		return request.displayName
	}
	name := protocol.DefaultViewerDisplayName
	if request.role == protocol.RoleHost {
		name = protocol.DefaultHostDisplayNamePrefix
	}
	return &name
}

// connectRouteParticipant is the try/catch around
// hybridMediaRouter.connectParticipant: a controller assertion panics with
// the TS message (D11), which the TS catch swallowed.
func (s *Server) connectRouteParticipant(participant authenticatedRouteParticipant) (state hybridAuthenticationState, assigned bool) {
	defer func() {
		if recover() != nil {
			assigned = false
		}
	}()
	return s.router.connectParticipant(participant), true
}

func (s *Server) routePolicyOf(roomID string) protocol.RoutePolicy {
	if policy := s.shares[roomID].routePolicy; policy != nil {
		return *policy
	}
	return s.configuredRoutePolicy(protocol.DefaultRoutePolicy)
}

// configuredRoutePolicy restricts share preferences to the services this runtime owns.
func (s *Server) configuredRoutePolicy(policy protocol.RoutePolicy) protocol.RoutePolicy {
	policy.PeerOnly = s.router.sfu == nil || policy.PeerOnly
	policy.NatPrediction = s.natPredictionEnabled && policy.NatPrediction
	return policy
}

// routeParticipant is the `{...authenticated, sessionId}` spread handed to
// the router by the authenticated message handlers.
func routeParticipant(sess *session, authenticated *authenticatedSession) authenticatedRouteParticipant {
	return authenticatedRouteParticipant{
		roomID:    authenticated.roomID,
		role:      authenticated.role,
		peerID:    authenticated.peerID,
		sessionID: sess.sessionID,
	}
}

// handleAuthenticatedMessage ports handleAuthenticatedMessage().
func (s *Server) handleAuthenticatedMessage(sess *session, authenticated *authenticatedSession, message protocol.ClientMessage) {
	switch m := message.(type) {
	case protocol.SignalingChallengeMessage:
		if !s.sessions.Has(sess) || sess.authenticated != authenticated {
			return
		}
		now := s.now()
		if sess.challenged {
			elapsedMs := now - sess.lastSignalingChallengeAtMs
			if elapsedMs < 0 {
				sess.lastSignalingChallengeAtMs = now
				return
			}
			if elapsedMs < minSignalingChallengeIntervalMs {
				return
			}
		}
		sess.challenged = true
		sess.lastSignalingChallengeAtMs = now
		s.send(sess, protocol.SignalingChallengeResponseMessage{
			Type:     "signaling-challenge-response",
			Sequence: m.Sequence,
		})
	case protocol.ClientSignalMessage:
		s.routePeerAssistedSignal(sess, authenticated, m)
	case protocol.ClientRestartRequestMessage:
		if authenticated.role != protocol.RoleViewer {
			s.sendError(sess, "FORBIDDEN", "Only viewers may request an ICE restart")
			return
		}
		s.routePeerAssistedRestart(sess, authenticated, m)
	case protocol.SetQualitySettingsMessage:
		if authenticated.role != protocol.RoleHost {
			s.sendError(sess, "FORBIDDEN", "Only the host may set quality settings")
			return
		}
		share := s.shares[authenticated.roomID]
		share.qualitySettings = &m.QualitySettings
		s.shares[authenticated.roomID] = share
		// O8: store order.
		for _, viewer := range s.store.GetConnectedViewers(authenticated.roomID) {
			s.sendToSession(viewer.SessionID, protocol.QualitySettingsMessage{
				Type:            "quality-settings",
				QualitySettings: m.QualitySettings,
			})
		}
	case protocol.RelayCapacityMessage:
		if authenticated.role != protocol.RoleViewer {
			s.sendError(sess, "FORBIDDEN", "Only a viewer may advertise relay capacity")
			return
		}
		s.router.setViewerRelayCapacity(routeParticipant(sess, authenticated), int(m.DownstreamEdges))
	case protocol.RouteReadyMessage:
		s.router.handleRouteReady(routeParticipant(sess, authenticated), m)
	case protocol.RouteTransportConnectedMessage:
		s.router.handleRouteTransportConnected(routeParticipant(sess, authenticated), m)
	case protocol.RouteMediaUnavailableMessage:
		s.router.handleRouteMediaUnavailable(routeParticipant(sess, authenticated), m)
	case protocol.RouteFailedMessage:
		s.router.handleRouteFailed(routeParticipant(sess, authenticated), m)
	case protocol.SfuSignalMessage:
		s.router.handleSfuSignal(routeParticipant(sess, authenticated), m)
	case protocol.RefreshSfuMessage:
		if s.sfuFallback == nil {
			s.sendError(sess, "FORBIDDEN", "SFU fallback is not enabled")
			return
		}
		s.router.refreshSfu(routeParticipant(sess, authenticated), int64(m.Revision))
	case protocol.RequestRouteDiagnosticMessage:
		if authenticated.role != protocol.RoleHost {
			s.sendError(sess, "FORBIDDEN", "Only the host may request route diagnostics")
			return
		}
		s.send(sess, protocol.RouteDiagnosticSnapshotMessage{
			Type:     "route-diagnostic-snapshot",
			Snapshot: s.router.routeDiagnosticSnapshot(authenticated.roomID),
		})
	case protocol.ViewerQualityEvidenceMessage:
		s.handleViewerQualityEvidence(sess, authenticated, m)
	case protocol.SenderQualityEvidenceMessage:
		s.handleSenderQualityEvidence(sess, authenticated, m)
	case protocol.SfuPublisherQualityEvidenceMessage:
		s.handleSfuPublisherQualityEvidence(sess, authenticated, m)
	case protocol.ResetSenderQualityMessage:
		if s.sessions.Has(sess) && sess.authenticated == authenticated {
			s.router.resetSenderQuality(routeParticipant(sess, authenticated))
		}
	case protocol.SetDisplayNameMessage:
		if authenticated.role == protocol.RoleHost && !authenticated.viewerPresence {
			s.sendError(sess, "FORBIDDEN", "Display names require the Web presence capability")
			return
		}
		name := string(m.DisplayName)
		authenticated.displayName = &name
		s.sendViewerPresence(authenticated.roomID)
	case protocol.SetSharingPausedMessage:
		if authenticated.role != protocol.RoleHost {
			s.sendError(sess, "FORBIDDEN", "只有当前房主可以暂停分享")
			return
		}
		connectedHost, hasHost := s.store.GetConnectedHost(authenticated.roomID)
		if !s.sessions.Has(sess) ||
			!hasHost || connectedHost.SessionID != sess.sessionID ||
			authenticated.shareGeneration == "" ||
			s.shares[authenticated.roomID].generation != authenticated.shareGeneration ||
			m.ShareGeneration != authenticated.shareGeneration {
			sess.close(websocket.StatusCode(protocol.SignalCloseSessionReplaced), "Sharing generation replaced")
			return
		}
		share := s.shares[authenticated.roomID]
		share.pausedGeneration = ""
		if m.Paused {
			share.pausedGeneration = authenticated.shareGeneration
		}
		s.shares[authenticated.roomID] = share
		s.router.setPaused(authenticated.roomID, m.Paused)
		s.broadcastHostStatus(authenticated.roomID, true, m.Paused)
	case protocol.StopSharingMessage:
		if authenticated.role != protocol.RoleHost {
			s.sendError(sess, "FORBIDDEN", "只有当前房主可以停止分享")
			return
		}
		if authenticated.shareGeneration == "" ||
			s.shares[authenticated.roomID].generation != authenticated.shareGeneration ||
			(m.ShareGeneration != "" && m.ShareGeneration != authenticated.shareGeneration) {
			sess.close(websocket.StatusCode(protocol.SignalCloseSessionReplaced), "Sharing generation replaced")
			return
		}
		// Hazard 4: the participant leaves the store before stopSharing()
		// so the sharing-stopped / host-status pair is what viewers see.
		if s.sessions.Has(sess) && sess.authenticated == authenticated {
			if _, err := s.store.DisconnectParticipant(authenticated.roomID, authenticated.peerID, sess.sessionID); err != nil {
				// The TS threw out of the message handler; nothing caught it (D7).
				panic(fmt.Errorf("room store failed while stopping sharing: %w", err))
			}
		}
		s.stopSharing(authenticated.roomID)
		s.sendViewerPresence(authenticated.roomID)
		sess.close(websocket.StatusNormalClosure, "Sharing stopped")
	case protocol.AbandonRoomMessage:
		if authenticated.role != protocol.RoleHost {
			s.sendError(sess, "FORBIDDEN", "Only the host may abandon the room")
			return
		}
		if err := s.abandonRoom(authenticated.roomID); err != nil {
			s.logger.Error("Room abandonment failed", "errorType", fmt.Sprintf("%T", err))
			s.sendError(sess, "SERVER_ERROR", "Room could not be abandoned")
		}
	}
}

// ---------------------------------------------------------------------------
// quality evidence
// ---------------------------------------------------------------------------

// handleViewerQualityEvidence ports handleViewerQualityEvidence(). The
// forwarded envelope is encoded once; the same bytes reach the upstream
// recipient and, when different and opted in, the host (hazard 10).
func (s *Server) handleViewerQualityEvidence(sess *session, source *authenticatedSession, message protocol.ViewerQualityEvidenceMessage) {
	if source.role != protocol.RoleViewer {
		return
	}
	if !s.sessions.Has(sess) || sess.authenticated != source {
		return
	}
	connectedViewer, ok := s.store.GetConnectedViewer(source.roomID, source.peerID)
	if !ok || connectedViewer.SessionID != sess.sessionID {
		return
	}

	// The committed edge owns the viewer's media identity; connectionID is
	// "" while the viewer has no physical path (the TS mirror was absent).
	edge, hasEdge := s.router.resolveActiveViewerMediaEdge(source.roomID, source.peerID)
	connectionID := ""
	if hasEdge {
		connectionID = edge.connectionID
	}

	gateKey := viewerKey(source.roomID, source.peerID)
	now := s.now()
	if previous, attempted := s.viewerQualityEvidenceAttempts[gateKey]; attempted &&
		previous.connectionID == connectionID &&
		now-previous.atMs < protocol.ViewerQualityEvidenceIntervalMs {
		return
	}
	s.viewerQualityEvidenceAttempts[gateKey] = viewerQualityEvidenceAttempt{connectionID: connectionID, atMs: now}

	if !hasEdge || message.Guard.ConnectionID != connectionID {
		return
	}

	host, hasHost := s.store.GetConnectedHost(source.roomID)
	routeRevision := edge.revision
	upstream := edge.upstream
	var recipient room.ConnectedPeer
	hasRecipient := false
	if upstream.Kind == "peer" {
		recipient, hasRecipient = s.connectedPeer(source.roomID, upstream.PeerID)
	} else {
		recipient, hasRecipient = host, hasHost
	}
	if !hasRecipient || int64(message.Guard.RouteRevision) != routeRevision ||
		(upstream.Kind == "peer" && upstream.PeerID == source.peerID) {
		return
	}

	presentationEpoch := int64(message.Guard.PresentationEpoch)
	sequence := int64(message.Sequence)
	previous, hasPrevious := s.viewerQualityEvidenceGates[gateKey]
	sameEdge := hasPrevious &&
		previous.viewerSessionID == sess.sessionID &&
		previous.upstreamKind == upstream.Kind &&
		previous.upstreamPeerID == upstream.PeerID &&
		previous.connectionID == connectionID
	if sameEdge &&
		(presentationEpoch < previous.presentationEpoch ||
			(presentationEpoch == previous.presentationEpoch && sequence <= previous.sequence)) {
		return
	}

	forwarded := protocol.ServerViewerQualityEvidenceMessage{
		Type:         "viewer-quality-evidence",
		ViewerPeerID: source.peerID,
		Upstream:     upstream,
		Guard: protocol.ViewerQualityEvidenceGuard{
			ConnectionID:      connectionID,
			RouteRevision:     protocol.Int(routeRevision),
			PresentationEpoch: message.Guard.PresentationEpoch,
		},
		Sequence: message.Sequence,
		WindowMs: message.WindowMs,
		Metrics:  message.Metrics,
	}
	encoded, err := protocol.EncodeServerMessage(forwarded)
	if err != nil {
		panic(err)
	}
	if len(encoded) > protocol.MaxViewerQualityEvidenceBytes {
		return
	}
	qualityUpstream := route.QualityUpstream{Kind: route.UpstreamSfu}
	if upstream.Kind == "peer" {
		qualityUpstream = route.QualityUpstream{Kind: route.UpstreamPeer, PeerID: upstream.PeerID}
	}
	qualityResult := s.router.observeQualityEvidence(source.roomID, route.RouteQualityEvidenceInput{
		ChildPeerID:       source.peerID,
		ChildSessionID:    sess.sessionID,
		RouteRevision:     routeRevision,
		ConnectionID:      connectionID,
		Upstream:          qualityUpstream,
		PresentationEpoch: presentationEpoch,
		WindowMs:          int64(message.WindowMs),
		Metrics:           message.Metrics,
		AcceptedAtMs:      now,
	})
	if qualityResult == route.QualityEvidenceRejected {
		return
	}
	s.viewerQualityEvidenceGates[gateKey] = viewerQualityEvidenceGate{
		viewerSessionID:   sess.sessionID,
		upstreamKind:      upstream.Kind,
		upstreamPeerID:    upstream.PeerID,
		connectionID:      connectionID,
		presentationEpoch: presentationEpoch,
		sequence:          sequence,
	}
	s.sendEncodedToSession(recipient.SessionID, encoded)
	if !hasHost || host.SessionID == recipient.SessionID {
		return
	}
	if hostState := s.authenticatedOf(host.SessionID); hostState != nil &&
		hostState.role == protocol.RoleHost &&
		hostState.roomID == source.roomID &&
		hostState.peerID == host.PeerID &&
		hostState.viewerPresence {
		s.sendEncodedToSession(host.SessionID, encoded)
	}
}

// authenticatedOf is `socketStates.get(socketsBySessionId.get(id))?.authenticated`.
func (s *Server) authenticatedOf(sessionID string) *authenticatedSession {
	if sess := s.sessionsByID[sessionID]; sess != nil {
		return sess.authenticated
	}
	return nil
}

// handleSenderQualityEvidence ports handleSenderQualityEvidence().
func (s *Server) handleSenderQualityEvidence(sess *session, source *authenticatedSession, message protocol.SenderQualityEvidenceMessage) {
	if source.peerID == message.ChildPeerID {
		return
	}
	if !s.sessions.Has(sess) || sess.authenticated != source {
		return
	}
	if !s.consumeSenderQualityBudget(sess.sessionID, s.now()) {
		return
	}
	s.router.observeSenderQualityEvidence(routeParticipant(sess, source), message)
}

// handleSfuPublisherQualityEvidence ports handleSfuPublisherQualityEvidence().
func (s *Server) handleSfuPublisherQualityEvidence(sess *session, source *authenticatedSession, message protocol.SfuPublisherQualityEvidenceMessage) {
	if source.role != protocol.RoleHost {
		return
	}
	if !s.sessions.Has(sess) || sess.authenticated != source {
		return
	}
	if !s.consumeSenderQualityBudget(sess.sessionID, s.now()) {
		return
	}
	s.router.observeSfuPublisherQualityEvidence(routeParticipant(sess, source), message)
}

// consumeSenderQualityBudget ports consumeSenderQualityBudget().
func (s *Server) consumeSenderQualityBudget(sessionID string, nowMs int64) bool {
	maximumReports := min(s.endpointMediaCopyCapacity+1, 3) * 2
	current := s.senderQualityRateBySession[sessionID]
	if current == nil || nowMs-current.startedAtMs >= protocol.ViewerQualityEvidenceIntervalMs {
		s.senderQualityRateBySession[sessionID] = &senderQualityRateWindow{startedAtMs: nowMs, count: 1}
		return true
	}
	if current.count >= maximumReports {
		return false
	}
	current.count++
	return true
}

// ---------------------------------------------------------------------------
// peer-assisted signaling
// ---------------------------------------------------------------------------

// routePeerAssistedSignal ports routeSignal / routePeerAssistedSignal.
func (s *Server) routePeerAssistedSignal(sess *session, source *authenticatedSession, message protocol.ClientSignalMessage) {
	targetPeerID := message.TargetPeerID
	if targetPeerID == "" {
		s.sendError(sess, "FORBIDDEN", "Peer-assisted signals must target an assigned peer")
		return
	}
	parentToChild := s.router.isActivePeerParentOf(source.roomID, source.peerID, targetPeerID)
	childToParent := s.router.isActivePeerParentOf(source.roomID, targetPeerID, source.peerID)
	target, hasTarget := s.connectedPeer(source.roomID, targetPeerID)
	if !hasTarget {
		if parentToChild || childToParent {
			return
		}
		s.sendError(sess, "PEER_NOT_FOUND", "Target peer is not connected")
		return
	}

	payload := message.Payload
	descriptionType := ""
	if payload.Kind == "description" && payload.Description != nil {
		descriptionType = payload.Description.Type
	}
	candidateAuthorized := s.router.peerSignalAuthorization(peerSignalInput{
		roomID:          source.roomID,
		sourcePeerID:    source.peerID,
		sourceSessionID: sess.sessionID,
		targetPeerID:    target.PeerID,
		targetSessionID: target.SessionID,
		connectionID:    payload.ConnectionID,
		signalKind:      payload.Kind,
		descriptionType: descriptionType,
	})
	debugInput := peerSignalDebugInput{
		roomID:          source.roomID,
		sourcePeerID:    source.peerID,
		targetPeerID:    target.PeerID,
		signalKind:      payload.Kind,
		descriptionType: descriptionType,
		authorization:   candidateAuthorized,
	}
	if payload.Kind == "candidate" {
		candidate := ""
		if payload.Candidate != nil {
			candidate = payload.Candidate.Candidate
		}
		debugInput.candidateOrigin = protocol.CandidateSignalOriginOf(candidate)
	}
	s.router.debugPeerSignal(debugInput)
	var assignedEdgeAuthorized bool
	switch descriptionType {
	case "offer":
		assignedEdgeAuthorized = parentToChild
	case "":
		assignedEdgeAuthorized = parentToChild || childToParent
	default:
		assignedEdgeAuthorized = childToParent
	}
	var authorized bool
	switch candidateAuthorized {
	case signalAuthorizationUnassigned:
		authorized = assignedEdgeAuthorized
	case signalAuthorizationDenied:
		authorized = false
	default:
		authorized = true
	}
	if !authorized {
		return
	}

	// TS setViewerConnectionId here only ever restated the committed edge:
	// an authorized non-probe offer either matches edge.connectionId or was
	// adopted into it by peerSignalAuthorization.
	s.sendToSession(target.SessionID, protocol.ServerSignalMessage{
		Type:       "signal",
		FromPeerID: source.peerID,
		Payload:    payload,
	})
}

// routePeerAssistedRestart ports routePeerAssistedRestart.
func (s *Server) routePeerAssistedRestart(sess *session, source *authenticatedSession, message protocol.ClientRestartRequestMessage) {
	targetPeerID := message.TargetPeerID
	if targetPeerID == "" || !s.router.isActivePeerParentOf(source.roomID, targetPeerID, source.peerID) {
		s.sendError(sess, "FORBIDDEN", "Restart target is not the assigned media parent")
		return
	}
	parent, hasParent := s.connectedPeer(source.roomID, targetPeerID)
	if !hasParent {
		s.sendError(sess, "PEER_NOT_FOUND", "Media parent is not connected")
		return
	}
	s.sendToSession(parent.SessionID, protocol.ServerRestartRequestMessage{
		Type:         "restart-request",
		FromPeerID:   source.peerID,
		ConnectionID: message.ConnectionID,
		Rebuild:      message.Rebuild,
	})
}

// isCurrentSession ports isCurrentSession: checked on every authenticated
// message before dispatch.
func (s *Server) isCurrentSession(sess *session) bool {
	authenticated := sess.authenticated
	if authenticated == nil {
		return false
	}
	var current room.ConnectedPeer
	var ok bool
	if authenticated.role == protocol.RoleHost {
		current, ok = s.store.GetConnectedHost(authenticated.roomID)
	} else {
		current, ok = s.store.GetConnectedViewer(authenticated.roomID, authenticated.peerID)
	}
	return ok && current.SessionID == sess.sessionID
}

// connectedPeer ports connectedPeer.
func (s *Server) connectedPeer(roomID, peerID string) (room.ConnectedPeer, bool) {
	if host, ok := s.store.GetConnectedHost(roomID); ok && host.PeerID == peerID {
		return host, true
	}
	return s.store.GetConnectedViewer(roomID, peerID)
}

// ---------------------------------------------------------------------------
// error tables
// ---------------------------------------------------------------------------

// authenticationErrorMessage ports authenticationErrorMessage.
func authenticationErrorMessage(code string) string {
	switch code {
	case "ROOM_ACCESS_DENIED":
		return "Room access denied"
	case "ROOM_NOT_FOUND":
		return "Room not found"
	case "ROOM_FULL":
		return "Room is full"
	case "HOST_ALREADY_CONNECTED":
		return "A host is already connected"
	case "INVALID_TOKEN":
		return "Room credentials are invalid"
	}
	return "Authentication failed"
}

// authenticationErrorCode ports authenticationErrorCode verbatim.
func authenticationErrorCode(request authRequest, err error) string {
	var roomError *room.Error
	if !errors.As(err, &roomError) || roomError.Code == room.CodeRoomLimit {
		return "SERVER_ERROR"
	}
	if roomError.Code == room.CodeRoomBusy {
		if request.role == protocol.RoleViewer {
			return "ROOM_ACCESS_DENIED"
		}
		return "SERVER_ERROR"
	}
	if request.role != protocol.RoleViewer {
		return string(roomError.Code)
	}
	if request.viewerGrant == "" {
		if roomError.Code == room.CodeRoomNotFound {
			return "ROOM_NOT_FOUND"
		}
		return "ROOM_ACCESS_DENIED"
	}
	if roomError.Code == room.CodeRoomNotFound {
		return "INVALID_TOKEN"
	}
	return string(roomError.Code)
}
