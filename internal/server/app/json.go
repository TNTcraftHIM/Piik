package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// Request and response helpers ported from src/server/app.ts.

// maxJSONRequestBytes is the readJsonBody(request, 1_024) budget every JSON
// route shares.
const maxJSONRequestBytes = 1024

// errorBody is the { error } shape every failing route answers with.
type errorBody struct {
	Error string `json:"error"`
}

// healthBody is the /healthz payload.
type healthBody struct {
	Status string `json:"status"`
}

// siteAccessBody is siteAccessStatus(); the key order is the TS literal's.
type siteAccessBody struct {
	Required      bool `json:"required"`
	Authenticated bool `json:"authenticated"`
}

// sendJSON always sets the exact Content-Length and the charset, as app.ts did.
// Encoding one of this package's own values cannot fail, so a marshal error is
// a programming error and reaches the recover wrapper.
func sendJSON(writer http.ResponseWriter, status int, body any) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	// D9: JSON.stringify does not escape HTML either.
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(body); err != nil {
		panic(err)
	}
	encoded := bytes.TrimSuffix(buffer.Bytes(), []byte("\n"))
	header := writer.Header()
	header.Set("Content-Type", "application/json; charset=utf-8")
	header.Set("Content-Length", strconv.Itoa(len(encoded)))
	writer.WriteHeader(status)
	_, _ = writer.Write(encoded)
}

// readJSONBody ports readJsonBody: the content type must be exactly
// application/json once its parameters are cut, the body must be at most 1024
// bytes and must not be empty. Every failure collapses to the route's 400, so
// the messages only exist to keep the TS reasons readable.
func readJSONBody(request *http.Request) ([]byte, error) {
	contentType, _, _ := strings.Cut(request.Header.Get("Content-Type"), ";")
	if strings.TrimSpace(contentType) != "application/json" {
		return nil, errors.New("Request content type must be application/json")
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, maxJSONRequestBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxJSONRequestBytes {
		return nil, errors.New("Request body is too large")
	}
	if len(body) == 0 {
		return nil, errors.New("Request body is required")
	}
	return body, nil
}

// hasRequestBody ports hasRequestBody. net/http parses Content-Length and moves
// Transfer-Encoding out of Header, so a chunked body is ContentLength -1 and an
// unparseable length never reaches a handler at all.
func hasRequestBody(request *http.Request) bool {
	return len(request.TransferEncoding) > 0 || request.ContentLength != 0
}

// requestPath is the WHATWG `url.pathname` app.ts routed and logged on. It is
// the escaped path on purpose: `new URL()` does not percent-decode, so
// "/api%2frooms" must not reach the /api/rooms route.
//
// Deviation: `new URL()` also resolves "." and ".." segments, which net/http
// leaves in the path. "/x/../api/rooms" therefore reaches the frontend handler
// here where TypeScript routed it to room creation. Only stricter: a raw path
// that already names a route still matches, so nothing can slip past an origin,
// cookie or token check that way.
func requestPath(request *http.Request) string {
	return request.URL.EscapedPath()
}

// cookieHeader rebuilds the single Cookie header value the Node parser handed
// to access-session.ts; Go keeps repeated Cookie headers apart.
func cookieHeader(request *http.Request) string {
	return strings.Join(request.Header.Values("Cookie"), "; ")
}

// bearerToken ports readBearerToken: the prefix is case sensitive and an empty
// token counts as absent.
func bearerToken(request *http.Request) string {
	authorization := request.Header.Get("Authorization")
	if !strings.HasPrefix(authorization, "Bearer ") {
		return ""
	}
	return strings.TrimPrefix(authorization, "Bearer ")
}

// isUpgradeRequest reproduces the condition under which Node emitted "upgrade"
// instead of "request": the parser needs both a Connection: upgrade token and
// an Upgrade header. The SignalingServer, not this router, owns the rejection
// ladder for a path or query that is not exactly /signal.
func isUpgradeRequest(request *http.Request) bool {
	if request.Header.Get("Upgrade") == "" {
		return false
	}
	for _, token := range strings.Split(request.Header.Get("Connection"), ",") {
		if strings.EqualFold(strings.TrimSpace(token), "upgrade") {
			return true
		}
	}
	return false
}

// responseRecorder tracks response.headersSent so the recover wrapper can pick
// between the JSON 500 and destroying the connection, as app.ts did.
type responseRecorder struct {
	http.ResponseWriter
	wrote bool
}

func (recorder *responseRecorder) WriteHeader(status int) {
	recorder.wrote = true
	recorder.ResponseWriter.WriteHeader(status)
}

func (recorder *responseRecorder) Write(data []byte) (int, error) {
	recorder.wrote = true
	return recorder.ResponseWriter.Write(data)
}

// Unwrap lets http.ResponseController reach the real writer's Flush and Hijack.
func (recorder *responseRecorder) Unwrap() http.ResponseWriter {
	return recorder.ResponseWriter
}
