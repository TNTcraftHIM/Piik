package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/TNTcraftHIM/Piik/internal/server/config"
	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
	"github.com/TNTcraftHIM/Piik/internal/server/room"
	"github.com/TNTcraftHIM/Piik/internal/server/signal"
)

// The first matching route wins. The /api/ catch-all follows every concrete
// route so unknown API requests cannot fall through to the frontend.

var (
	roomReplacementPath = regexp.MustCompile(`^/api/rooms/([1-9][0-9]{3})/replacement$`)
	roomAccessPath      = regexp.MustCompile(`^/api/rooms/([1-9][0-9]{3})/access$`)
)

// ServeHTTP dispatches requests and contains handler panics at the HTTP boundary.
func (s *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	recorder := &responseRecorder{ResponseWriter: writer}
	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		if recovered == http.ErrAbortHandler {
			panic(recovered)
		}
		// Persist only fixed request categories, never the panic or raw URL.
		s.requestFailed(recorder, request)
	}()

	if !s.acceptingTraffic.Load() {
		// Hazard 13: no traffic at all until the SignalingServer exists, so
		// /healthz answers 503 while LiveKit reconciliation runs.
		recorder.Header().Set("Cache-Control", "no-store")
		recorder.Header().Set("Retry-After", "1")
		sendJSON(recorder, http.StatusServiceUnavailable, errorBody{"Service starting"})
		return
	}
	signaling := s.signaling.Load()
	if isUpgradeRequest(request) {
		// Node routed every upgrade to the SignalingServer's "upgrade"
		// listener, which was attached only while traffic was accepted.
		signaling.ServeHTTP(recorder, request)
		return
	}
	s.route(recorder, request, signaling)
}

func (s *Server) route(
	writer http.ResponseWriter,
	request *http.Request,
	signaling *signal.Server,
) {
	path := requestPath(request)

	if path == "/healthz" {
		writer.Header().Set("Cache-Control", "no-store")
		if !allowMethod(writer, request, http.MethodGet) {
			return
		}
		sendJSON(writer, http.StatusOK, healthBody{"ok"})
		return
	}

	if path == "/api/capabilities" {
		noStoreJSON(writer)
		if !allowMethod(writer, request, http.MethodGet) {
			return
		}
		sendJSON(writer, http.StatusOK, protocol.RuntimeCapabilities{
			Sfu:           s.config.SFU != nil,
			NatPrediction: s.config.NATPredictionEnabled,
		})
		return
	}

	if path == "/api/site-access" {
		s.handleSiteAccess(writer, request)
		return
	}

	if match := roomReplacementPath.FindStringSubmatch(path); match != nil {
		s.handleRoomReplacement(writer, request, signaling, match[1])
		return
	}

	if match := roomAccessPath.FindStringSubmatch(path); match != nil {
		s.handleRoomAccess(writer, request, signaling, match[1])
		return
	}

	if path == "/api/rooms" {
		s.handleRoomCreation(writer, request, signaling)
		return
	}

	if strings.HasPrefix(path, "/api/") {
		// The catch-all sets no nosniff header; only the concrete routes do.
		writer.Header().Set("Cache-Control", "no-store")
		sendJSON(writer, http.StatusNotFound, errorBody{"Not found"})
		return
	}

	if s.frontend != nil {
		s.frontend.ServeHTTP(writer, request)
		return
	}
	notFoundJSON(writer, request)
}

// notFoundJSON is the fallthrough app.ts handed to sirv as its next()
// callback and used when no frontend is composed at all.
func notFoundJSON(writer http.ResponseWriter, _ *http.Request) {
	sendJSON(writer, http.StatusNotFound, errorBody{"Not found"})
}

// noStoreJSON sets the two headers every /api route sets before its method
// check, so a 405 carries them too.
func noStoreJSON(writer http.ResponseWriter) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
}

// allowMethod answers the 405 row of the HTTP table, Allow header included.
func allowMethod(writer http.ResponseWriter, request *http.Request, allowed string) bool {
	if request.Method == allowed {
		return true
	}
	writer.Header().Set("Allow", allowed)
	sendJSON(writer, http.StatusMethodNotAllowed, errorBody{"Method not allowed"})
	return false
}

// handleSiteAccess is handleSiteAccessRequest of app.ts.
func (s *Server) handleSiteAccess(writer http.ResponseWriter, request *http.Request) {
	noStoreJSON(writer)
	access := s.siteAccessForRequest(request)

	if request.Method == http.MethodGet {
		status := siteAccessBody{
			Required:      access.required(),
			Authenticated: access.isAuthenticated(cookieHeader(request)),
		}
		if status.Required && status.Authenticated {
			// The Set-Cookie value is written verbatim, in the TS attribute
			// order (D11).
			writer.Header().Set("Set-Cookie", access.createCookie())
		}
		sendJSON(writer, http.StatusOK, status)
		return
	}

	if request.Method != http.MethodPost {
		writer.Header().Set("Allow", "GET, POST")
		sendJSON(writer, http.StatusMethodNotAllowed, errorBody{"Method not allowed"})
		return
	}

	if !s.allowedRequestOrigin(request) {
		sendJSON(writer, http.StatusForbidden, errorBody{"Forbidden"})
		return
	}
	// Released clients send a bodyless Bearer request. JSON preserves passwords
	// that cannot be represented in an HTTP header and takes precedence when sent.
	provided := bearerToken(request)
	if hasRequestBody(request) {
		body, err := readJSONBody(request)
		var fields map[string]json.RawMessage
		var password *string
		if err != nil || json.Unmarshal(body, &fields) != nil || len(fields) != 1 ||
			json.Unmarshal(fields["password"], &password) != nil || password == nil {
			sendJSON(writer, http.StatusBadRequest, errorBody{"Invalid site access request"})
			return
		}
		provided = *password
	}
	if !access.required() {
		sendJSON(writer, http.StatusOK, siteAccessBody{Required: false, Authenticated: true})
		return
	}
	if !access.passwordMatches(provided) {
		writer.Header().Set("WWW-Authenticate", "Bearer")
		sendJSON(writer, http.StatusUnauthorized, errorBody{"Unauthorized"})
		return
	}
	writer.Header().Set("Set-Cookie", access.createCookie())
	sendJSON(writer, http.StatusOK, siteAccessBody{Required: true, Authenticated: true})
}

func (s *Server) handleRoomReplacement(
	writer http.ResponseWriter,
	request *http.Request,
	signaling *signal.Server,
	roomID string,
) {
	noStoreJSON(writer)
	if !allowMethod(writer, request, http.MethodPost) {
		return
	}
	hostToken, authorized := s.authorizedRoomHostToken(writer, request)
	if !authorized {
		return
	}
	body, err := readJSONBody(request)
	var parsed protocol.ReplaceRoomRequest
	if err == nil {
		parsed, err = protocol.DecodeReplaceRoomRequest(body)
	}
	if err != nil {
		sendJSON(writer, http.StatusBadRequest, errorBody{"Invalid room replacement request"})
		return
	}
	if signaling == nil {
		sendJSON(writer, http.StatusServiceUnavailable, errorBody{"Service unavailable"})
		return
	}
	created, err := signaling.ReplaceRoom(
		roomID,
		hostToken,
		parsed.CodeEntryPolicy,
		parsed.RoomPassword.Value,
	)
	if err != nil {
		if status, message, mapped := replacementFailure(err); mapped {
			sendJSON(writer, status, errorBody{message})
			return
		}
		s.requestFailed(writer, request)
		return
	}
	sendJSON(writer, http.StatusCreated, s.createRoomResponse(created))
}

func (s *Server) handleRoomAccess(
	writer http.ResponseWriter,
	request *http.Request,
	signaling *signal.Server,
	roomID string,
) {
	noStoreJSON(writer)
	if !allowMethod(writer, request, http.MethodPost) {
		return
	}
	hostToken, authorized := s.authorizedRoomHostToken(writer, request)
	if !authorized {
		return
	}
	body, err := readJSONBody(request)
	var parsed protocol.RoomAccessUpdateRequest
	if err == nil {
		parsed, err = protocol.DecodeRoomAccessUpdateRequest(body)
	}
	if err != nil {
		sendJSON(writer, http.StatusBadRequest, errorBody{"Invalid room access request"})
		return
	}
	if signaling == nil {
		sendJSON(writer, http.StatusServiceUnavailable, errorBody{"Service unavailable"})
		return
	}
	updated, err := signaling.UpdateRoomAccess(roomID, hostToken, parsed)
	if err != nil {
		if status, message, mapped := accessFailure(err); mapped {
			sendJSON(writer, status, errorBody{message})
			return
		}
		s.requestFailed(writer, request)
		return
	}
	sendJSON(writer, http.StatusOK, updated)
}

func (s *Server) handleRoomCreation(
	writer http.ResponseWriter,
	request *http.Request,
	signaling *signal.Server,
) {
	noStoreJSON(writer)
	if !allowMethod(writer, request, http.MethodPost) {
		return
	}
	if !s.allowedRequestOrigin(request) {
		sendJSON(writer, http.StatusForbidden, errorBody{"Forbidden"})
		return
	}
	// Hazard 12: the cookie is the only room-creation credential. A
	// `Bearer <site password>` header must still be 401.
	if !s.roomCreationAuthorized(request) {
		sendJSON(writer, http.StatusUnauthorized, errorBody{"Unauthorized"})
		return
	}
	body, err := readJSONBody(request)
	var parsed protocol.CreateRoomRequest
	if err == nil {
		parsed, err = protocol.DecodeCreateRoomRequest(body)
	}
	if err != nil {
		sendJSON(writer, http.StatusBadRequest, errorBody{"Invalid room request"})
		return
	}
	// TS called roomStore.createRoom directly; the store is now guarded by the
	// signaling server's global mutex, so creation goes through it. There is
	// no `signaling == nil` answer here, because app.ts had no getSignaling()
	// check on this route: reconcile stores the signaling server before it
	// sets acceptingTraffic and never clears it again, so reaching a handler
	// at all means the pointer is set (the two sibling room routes keep their
	// 503 only because the TypeScript had one).
	created, err := signaling.CreateRoom(
		parsed.CodeEntryPolicy,
		parsed.RoomPassword.Value,
		parsed.PreferredRoomID,
	)
	if err != nil {
		if status, message, mapped := creationFailure(err); mapped {
			sendJSON(writer, status, errorBody{message})
			return
		}
		s.requestFailed(writer, request)
		return
	}
	sendJSON(writer, http.StatusCreated, s.createRoomResponse(created))
}

// authorizedRoomHostToken of app.ts: origin, then site access, then the bearer
// Host token, each with its own terminal response.
func (s *Server) authorizedRoomHostToken(
	writer http.ResponseWriter,
	request *http.Request,
) (string, bool) {
	if !s.allowedRequestOrigin(request) {
		sendJSON(writer, http.StatusForbidden, errorBody{"Forbidden"})
		return "", false
	}
	if !s.roomCreationAuthorized(request) {
		sendJSON(writer, http.StatusUnauthorized, errorBody{"Unauthorized"})
		return "", false
	}
	hostToken := bearerToken(request)
	if hostToken == "" {
		// An absent Host token is indistinguishable from a wrong one.
		sendJSON(writer, http.StatusNotFound, errorBody{"Room not found"})
		return "", false
	}
	return hostToken, true
}

// allowedRequestOrigin ports isStrictlyAllowedRequestOrigin: the header must be
// present, must parse, must be exactly its own serialised origin (so
// "http://allowed.test/path" is refused) and must be configured.
func (s *Server) allowedRequestOrigin(request *http.Request) bool {
	origin := request.Header.Get("Origin")
	if origin == "" {
		return false
	}
	parsed, err := url.Parse(origin)
	if err != nil || config.Origin(parsed) != origin {
		return false
	}
	_, allowed := s.config.AllowedOrigins[origin]
	return allowed
}

// roomCreationAuthorized ports isRoomCreationAuthorized.
func (s *Server) roomCreationAuthorized(request *http.Request) bool {
	return s.siteAccessForRequest(request).isAuthenticated(cookieHeader(request))
}

// createRoomResponse of app.ts. signal.InviteURL is the one owner of the invite
// URL shape; the rotated-grant notification on the signaling side uses it too.
func (s *Server) createRoomResponse(created room.CreatedRoom) protocol.CreateRoomResponse {
	return protocol.CreateRoomResponse{
		RoomID:          created.RoomID,
		HostToken:       created.HostToken,
		InviteURL:       signal.InviteURL(s.config.PublicBaseURL, created.RoomID, created.ViewerGrant),
		CodeEntryPolicy: created.CodeEntryPolicy,
	}
}

// requestFailed logs fixed request categories, then answers 500 or aborts a
// response that already started. Request paths and arbitrary methods are private.
func (s *Server) requestFailed(writer http.ResponseWriter, request *http.Request) {
	method := request.Method
	switch method {
	case http.MethodGet, http.MethodPost, http.MethodHead, http.MethodOptions,
		http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodConnect, http.MethodTrace:
	default:
		method = "other"
	}
	path := requestPath(request)
	category := "frontend"
	switch {
	case isUpgradeRequest(request):
		category = "signaling"
	case path == "/healthz":
		category = "health"
	case strings.HasPrefix(path, "/api/"):
		category = "api"
	}
	s.logger.Error("HTTP request failed", "method", method, "route", category)
	if recorder, ok := writer.(*responseRecorder); ok && recorder.wrote {
		panic(http.ErrAbortHandler)
	}
	sendJSON(writer, http.StatusInternalServerError, errorBody{"Internal server error"})
}

// roomErrorCode returns the RoomStoreError code, or "" when err is not one.
func roomErrorCode(err error) room.ErrorCode {
	var roomError *room.Error
	if errors.As(err, &roomError) {
		return roomError.Code
	}
	return ""
}

// replacementFailure maps replaceRoom errors; an unmapped error rethrows into
// the 500 handler, as the TS `throw error` did.
func replacementFailure(err error) (int, string, bool) {
	switch roomErrorCode(err) {
	case room.CodeRoomLimit:
		return http.StatusServiceUnavailable, "Room capacity reached", true
	case room.CodeRoomAccessDenied, room.CodeRoomBusy:
		return http.StatusServiceUnavailable, "Room replacement unavailable", true
	case room.CodeInvalidToken, room.CodeRoomNotFound:
		return http.StatusNotFound, "Room not found", true
	}
	return 0, "", false
}

// accessFailure maps updateRoomAccess errors. Unlike the other two tables,
// every remaining RoomStoreError is a 404; only a non-store error rethrows.
func accessFailure(err error) (int, string, bool) {
	switch code := roomErrorCode(err); code {
	case "":
		return 0, "", false
	case room.CodeRoomBusy:
		return http.StatusServiceUnavailable, "Room access update unavailable", true
	case room.CodeRoomAccessDenied:
		return http.StatusConflict, "Room access update rejected", true
	default:
		return http.StatusNotFound, "Room not found", true
	}
}

// creationFailure maps createRoom errors.
func creationFailure(err error) (int, string, bool) {
	switch roomErrorCode(err) {
	case room.CodeRoomLimit:
		return http.StatusServiceUnavailable, "Room capacity reached", true
	case room.CodeRoomBusy:
		return http.StatusServiceUnavailable, "Room creation unavailable", true
	case room.CodeInvalidToken:
		return http.StatusBadRequest, "Invalid room request", true
	}
	return 0, "", false
}
