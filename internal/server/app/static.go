package app

import (
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"

	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
)

// staticContentTypes fixes the MIME types for this repository's Web assets.
// Go's mime.TypeByExtension overlays the Windows
// registry or /etc/mime.types, so the served Content-Type would otherwise
// depend on the machine; with X-Content-Type-Options: nosniff a wrong type on a
// font or a webmanifest is user visible.
var staticContentTypes = map[string]string{
	".html":        "text/html;charset=utf-8", // sirv appends ";charset=utf-8" with no space
	".htm":         "text/html;charset=utf-8",
	".js":          "text/javascript",
	".mjs":         "text/javascript",
	".css":         "text/css",
	".json":        "application/json",
	".map":         "application/json",
	".txt":         "text/plain",
	".svg":         "image/svg+xml",
	".png":         "image/png",
	".jpg":         "image/jpeg",
	".jpeg":        "image/jpeg",
	".webp":        "image/webp",
	".gif":         "image/gif",
	".avif":        "image/avif",
	".woff":        "font/woff",
	".woff2":       "font/woff2",
	".ttf":         "font/ttf",
	".otf":         "font/otf",
	".wasm":        "application/wasm",
	".webmanifest": "application/manifest+json",
	".bin":         "application/octet-stream",
	".xml":         "text/xml",
	".ico":         "", // mrmime has no .ico, so sirv sends an EMPTY Content-Type
}

// staticHandler serves embedded assets and falls back to index.html for SPA
// routes. Missing files use the application's JSON 404 handler.
func staticHandler(assets fs.FS, notFound http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		// API and health routes have already been handled by ServeHTTP.
		cleaned := path.Clean("/" + request.URL.Path)
		name := strings.TrimPrefix(cleaned, "/")

		serve := func(candidate string) bool {
			// Clean traversal segments and exclude hidden assets before opening.
			if candidate == "" || hasDotSegment(candidate) {
				return false
			}
			file, err := assets.Open(candidate)
			if err != nil {
				return false
			}
			defer file.Close()
			info, err := file.Stat()
			if err != nil || info.IsDir() {
				return false
			}
			seeker, ok := file.(io.ReadSeeker)
			if !ok {
				return false
			}
			writer.Header().Set("X-Content-Type-Options", "nosniff")
			writer.Header().Set("Referrer-Policy", "no-referrer")
			// Set Content-Type explicitly, possibly to "", so ServeContent
			// never sniffs; the empty name keeps it from guessing either.
			writer.Header()["Content-Type"] = []string{staticContentTypes[strings.ToLower(path.Ext(candidate))]}
			// embed.FS reports a zero ModTime; do not fabricate Last-Modified.
			http.ServeContent(writer, request, "", info.ModTime(), seeker)
			return true
		}

		// sirv strips a trailing "/" before the lookup, and its FILES map holds
		// files only, so "/assets/" can never hit a file.
		if !strings.HasSuffix(request.URL.Path, "/") && serve(name) {
			return
		}
		// opts.single: fall back to index.html unless the request matches one
		// of sirv's two default ignores.
		if !looksLikeFile(cleaned) && !strings.Contains(cleaned, "/.well-known") {
			if serve("index.html") {
				return
			}
		}
		notFound.ServeHTTP(writer, request)
	})
}

// hasDotSegment reports whether any path segment starts with '.', reproducing
// totalist's filter `!opts.dotfiles && /(^\.|[\\+|\/+]\.)/.test(name)` together
// with the `/\.well-known[\\+\/]/` exemption that runs before it.
func hasDotSegment(name string) bool {
	if strings.Contains(name, ".well-known/") {
		return false
	}
	for _, segment := range strings.Split(name, "/") {
		if strings.HasPrefix(segment, ".") {
			return true
		}
	}
	return false
}

// looksLikeFile ports sirv's default "any extn" ignore,
// /[/]([A-Za-z\s\d~$._-]+\.\w+){1,}$/. Because the character class excludes
// "/" and the match is anchored at the end, only the last path segment can
// match: it must contain a dot with a non-empty [A-Za-z0-9_] extension after
// it, and everything before that dot must be in the class. The class is
// ASCII-only, so "/文件.js" and "/café.css" are NOT ignored and do get the
// index.html fallback.
func looksLikeFile(pathname string) bool {
	slash := strings.LastIndexByte(pathname, '/')
	if slash < 0 {
		return false
	}
	segment := pathname[slash+1:]
	dot := strings.LastIndexByte(segment, '.')
	if dot <= 0 || dot == len(segment)-1 {
		return false
	}
	for _, character := range segment[:dot] { // [A-Za-z\s\d~$._-]
		switch {
		case character >= 'A' && character <= 'Z',
			character >= 'a' && character <= 'z',
			character >= '0' && character <= '9',
			character == '~', character == '$', character == '.',
			character == '_', character == '-',
			// URL paths are percent-decoded before this test, so a non-ASCII
			// space can genuinely reach it; protocol owns the JavaScript
			// whitespace class.
			protocol.IsJSWhitespace(character):
		default:
			return false
		}
	}
	for _, character := range segment[dot+1:] { // \w+
		switch {
		case character >= 'A' && character <= 'Z',
			character >= 'a' && character <= 'z',
			character >= '0' && character <= '9',
			character == '_':
		default:
			return false
		}
	}
	return true
}
