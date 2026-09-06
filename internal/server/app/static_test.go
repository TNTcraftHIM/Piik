package app

import (
	"bytes"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

const staticNotFoundBody = `{"error":"Not found"}`

// staticNotFound is app.ts's `sendJson(response, 404, { error: "Not found" })`,
// the next() callback sirv fell through to.
var staticNotFound = http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(http.StatusNotFound)
	io.WriteString(writer, staticNotFoundBody)
})

// staticFixture mirrors the tree evidence/runtime.md served through real
// sirv@3.0.2, byte lengths included, so the parity table below is comparable.
func staticFixture() fs.FS {
	filled := func(size int) *fstest.MapFile {
		return &fstest.MapFile{Data: bytes.Repeat([]byte("x"), size)}
	}
	return fstest.MapFS{
		"index.html":               filled(100),
		"assets/app.js":            filled(20),
		"assets/app.css":           filled(15),
		"third-party-licenses.txt": filled(21),
		"favicon.svg":              filled(41),
		"fonts/inter.woff2":        filled(300),
		"manifest.webmanifest":     filled(19),
		"data.json":                filled(7),
		"nomime.bin":               filled(64),
		"noext":                    filled(23),
		".gitkeep":                 filled(0),
		".vite/manifest.json":      filled(7),
		".well-known/x.txt":        filled(10),
	}
}

// TestStaticHandlerMatchesSirv replays the 26-row parity table measured against
// sirv@3.0.2 in evidence/runtime.md section 4.4.
func TestStaticHandlerMatchesSirv(t *testing.T) {
	handler := staticHandler(staticFixture(), staticNotFound)

	const html = "text/html;charset=utf-8"
	for _, testCase := range []struct {
		method        string
		path          string
		headerName    string
		headerValue   string
		status        int
		contentType   string
		contentLength string
		contentRange  string
		bodyLength    int
	}{
		{method: "GET", path: "/", status: 200, contentType: html, contentLength: "100", bodyLength: 100},
		{method: "GET", path: "/index.html", status: 200, contentType: html, contentLength: "100", bodyLength: 100},
		{method: "GET", path: "/host", status: 200, contentType: html, contentLength: "100", bodyLength: 100},
		{method: "GET", path: "/room/1234", status: 200, contentType: html, contentLength: "100", bodyLength: 100},
		{method: "GET", path: "/assets/app.js", status: 200, contentType: "text/javascript", contentLength: "20", bodyLength: 20},
		{method: "GET", path: "/assets/app.css", status: 200, contentType: "text/css", contentLength: "15", bodyLength: 15},
		{method: "GET", path: "/third-party-licenses.txt", status: 200, contentType: "text/plain", contentLength: "21", bodyLength: 21},
		{method: "GET", path: "/favicon.svg", status: 200, contentType: "image/svg+xml", contentLength: "41", bodyLength: 41},
		{method: "GET", path: "/fonts/inter.woff2", status: 200, contentType: "font/woff2", contentLength: "300", bodyLength: 300},
		{method: "GET", path: "/manifest.webmanifest", status: 200, contentType: "application/manifest+json", contentLength: "19", bodyLength: 19},
		{method: "GET", path: "/data.json", status: 200, contentType: "application/json", contentLength: "7", bodyLength: 7},
		{method: "GET", path: "/nomime.bin", status: 200, contentType: "application/octet-stream", contentLength: "64", bodyLength: 64},
		// mrmime knows no extension here, so sirv sends an empty Content-Type.
		{method: "GET", path: "/noext", status: 200, contentType: "", contentLength: "23", bodyLength: 23},
		{method: "GET", path: "/assets/missing.js", status: 404, contentType: "application/json; charset=utf-8", bodyLength: len(staticNotFoundBody)},
		{method: "GET", path: "/missing.css", status: 404, contentType: "application/json; charset=utf-8", bodyLength: len(staticNotFoundBody)},
		{method: "GET", path: "/.well-known/x.txt", status: 200, contentType: "text/plain", contentLength: "10", bodyLength: 10},
		// The dotfile is not in sirv's FILES and does not match the "any extn"
		// ignore, so it falls back to index.html.
		{method: "GET", path: "/.gitkeep", status: 200, contentType: html, contentLength: "100", bodyLength: 100},
		{method: "GET", path: "/.vite/manifest.json", status: 404, contentType: "application/json; charset=utf-8", bodyLength: len(staticNotFoundBody)},
		{method: "GET", path: "/assets", status: 200, contentType: html, contentLength: "100", bodyLength: 100},
		{method: "GET", path: "/assets/", status: 200, contentType: html, contentLength: "100", bodyLength: 100},
		{method: "HEAD", path: "/index.html", status: 200, contentType: html, contentLength: "100", bodyLength: 0},
		{
			method: "GET", path: "/index.html", headerName: "Range", headerValue: "bytes=0-9",
			status: 206, contentType: html, contentLength: "10", contentRange: "bytes 0-9/100", bodyLength: 10,
		},
		{
			method: "GET", path: "/index.html", headerName: "Accept", headerValue: "application/json",
			status: 200, contentType: html, contentLength: "100", bodyLength: 100,
		},
		{method: "GET", path: "/../go.mod", status: 404, contentType: "application/json; charset=utf-8", bodyLength: len(staticNotFoundBody)},
		// sirv ignores req.method entirely; app.ts routes /api/** first.
		{method: "POST", path: "/", status: 200, contentType: html, contentLength: "100", bodyLength: 100},
		// The "any extn" class is ASCII-only, so this is not ignored.
		{method: "GET", path: "/文件.js", status: 200, contentType: html, contentLength: "100", bodyLength: 100},
	} {
		request := httptest.NewRequest(testCase.method, testCase.path, nil)
		if testCase.headerName != "" {
			request.Header.Set(testCase.headerName, testCase.headerValue)
		}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)

		label := testCase.method + " " + testCase.path
		if recorder.Code != testCase.status {
			t.Errorf("%s: status = %d, want %d", label, recorder.Code, testCase.status)
		}
		contentType, present := recorder.Header()["Content-Type"]
		if !present {
			t.Errorf("%s: Content-Type header is absent", label)
		} else if len(contentType) != 1 || contentType[0] != testCase.contentType {
			t.Errorf("%s: Content-Type = %q, want [%q]", label, contentType, testCase.contentType)
		}
		if got := recorder.Header().Get("Content-Length"); testCase.contentLength != "" && got != testCase.contentLength {
			t.Errorf("%s: Content-Length = %q, want %q", label, got, testCase.contentLength)
		}
		if got := recorder.Header().Get("Content-Range"); got != testCase.contentRange {
			t.Errorf("%s: Content-Range = %q, want %q", label, got, testCase.contentRange)
		}
		if got := recorder.Body.Len(); got != testCase.bodyLength {
			t.Errorf("%s: body length = %d, want %d", label, got, testCase.bodyLength)
		}
		// sirv never emits either, and a fabricated Last-Modified would add
		// 304 responses Node never sent.
		if got := recorder.Header().Get("Last-Modified"); got != "" {
			t.Errorf("%s: unexpected Last-Modified %q", label, got)
		}
		if got := recorder.Header().Get("Cache-Control"); got != "" {
			t.Errorf("%s: unexpected Cache-Control %q", label, got)
		}
		if got := recorder.Header().Get("Etag"); got != "" {
			t.Errorf("%s: unexpected ETag %q", label, got)
		}
		// app.ts setHeaders runs for served files only, not for the JSON 404.
		wantSecurityHeaders := testCase.status != http.StatusNotFound
		for header, want := range map[string]string{
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy":        "no-referrer",
		} {
			got := recorder.Header().Get(header)
			if wantSecurityHeaders && got != want {
				t.Errorf("%s: %s = %q, want %q", label, header, got, want)
			}
			if !wantSecurityHeaders && got != "" {
				t.Errorf("%s: unexpected %s %q on the 404", label, header, got)
			}
		}
	}
}

func TestStaticHandlerRefusesTraversal(t *testing.T) {
	handler := staticHandler(staticFixture(), staticNotFound)

	for _, target := range []string{
		"/../go.mod", "/../../go.mod", "/assets/../../go.mod",
		"/..%2fgo.mod", "/./../package.json", "//../go.mod",
	} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest("GET", target, nil))
		if recorder.Code != http.StatusNotFound {
			t.Errorf("GET %s: status = %d, want 404", target, recorder.Code)
		}
	}
}

func TestStaticHandlerWithoutIndexHTML(t *testing.T) {
	// The former frontend mode "none": nothing can be served, everything 404s.
	handler := staticHandler(fstest.MapFS{".gitkeep": &fstest.MapFile{}}, staticNotFound)

	for _, target := range []string{"/", "/host", "/assets/app.js", "/.gitkeep"} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest("GET", target, nil))
		if recorder.Code != http.StatusNotFound {
			t.Errorf("GET %s: status = %d, want 404", target, recorder.Code)
		}
	}
}

// TestLooksLikeFileMatchesSirvIgnore replays the Node oracle for sirv's
// "any extn" ignore recorded in evidence/runtime.md section 4.1.
func TestLooksLikeFileMatchesSirvIgnore(t *testing.T) {
	for pathname, want := range map[string]bool{
		"/":                       false,
		"/host":                   false,
		"/room/1234":              false,
		"/assets":                 false,
		"/assets/":                false,
		"/index.html":             true,
		"/assets/index-abc123.js": true,
		"/a.b.c.js":               true,
		"/favicon.ico":            true,
		"/my file.txt":            true,
		"/.gitkeep":               false,
		"/x.":                     false,
		"/.env":                   false,
		"/a.b-c":                  false,
		"/文件.js":                  false,
		"/café.css":               false,
		"/v1.2/thing":             false,
	} {
		if got := looksLikeFile(pathname); got != want {
			t.Errorf("looksLikeFile(%q) = %v, want %v", pathname, got, want)
		}
	}
}

func TestHasDotSegment(t *testing.T) {
	for name, want := range map[string]bool{
		"index.html":              false,
		"assets/app.js":           false,
		".gitkeep":                true,
		".vite/manifest.json":     true,
		"assets/.hidden":          true,
		".well-known/x.txt":       false,
		"deep/.well-known/x.txt":  false,
		"well-known/x.txt":        false,
		".well-knownish/file.txt": true,
	} {
		if got := hasDotSegment(name); got != want {
			t.Errorf("hasDotSegment(%q) = %v, want %v", name, got, want)
		}
	}
}
