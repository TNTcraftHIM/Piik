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

// maxJSONRequestBytes bounds the body every JSON route accepts.
const maxJSONRequestBytes = 1024

// errorBody is the { error } shape every failing route answers with.
type errorBody struct {
	Error string `json:"error"`
}

// healthBody is the /healthz payload.
type healthBody struct {
	Status string `json:"status"`
}

// siteAccessBody reports whether site access is required and already granted.
type siteAccessBody struct {
	Required      bool `json:"required"`
	Authenticated bool `json:"authenticated"`
}

// sendJSON sets the exact Content-Length and the JSON charset.
// Encoding one of this package's own values cannot fail, so a marshal error is
// a programming error and reaches the recover wrapper.
func sendJSON(writer http.ResponseWriter, status int, body any) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	// Responses have a JSON content type and are never embedded into HTML.
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

// readJSONBody requires application/json after removing parameters and a
// nonempty body of at most 1024 bytes. Every failure maps to the route's 400.
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

// net/http parses Content-Length and moves
// Transfer-Encoding out of Header, so a chunked body is ContentLength -1 and an
// unparseable length never reaches a handler at all.
func hasRequestBody(request *http.Request) bool {
	return len(request.TransferEncoding) > 0 || request.ContentLength != 0
}

// requestPath matches API routes without decoding separators or normalizing
// dot segments: "/api%2frooms" and "/x/../api/rooms" cannot alias /api/rooms.
func requestPath(request *http.Request) string {
	return request.URL.EscapedPath()
}

// cookieHeader joins repeated Cookie headers before the shared cookie reader.
func cookieHeader(request *http.Request) string {
	return strings.Join(request.Header.Values("Cookie"), "; ")
}

// bearerToken requires a case-sensitive prefix; an empty
// token counts as absent.
func bearerToken(request *http.Request) string {
	authorization := request.Header.Get("Authorization")
	if !strings.HasPrefix(authorization, "Bearer ") {
		return ""
	}
	return strings.TrimPrefix(authorization, "Bearer ")
}

// Upgrades require both a Connection: upgrade token and an Upgrade header.
// Signaling owns validation of the exact /signal path, query and admission.
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

// responseRecorder lets panic recovery send JSON only before a response starts;
// a partial response must instead abort the connection.
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
