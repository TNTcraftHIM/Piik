package app

import (
	"io"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"

	"github.com/TNTcraftHIM/Piik/internal/httpassets"
	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
)

// staticContentTypes fixes the MIME types for this repository's Web assets.
// Go's mime.TypeByExtension overlays the Windows
// registry or /etc/mime.types, so the served Content-Type would otherwise
// depend on the machine; with X-Content-Type-Options: nosniff a wrong type on a
// font or a webmanifest is user visible.
var staticContentTypes = map[string]string{
	".html":        "text/html;charset=utf-8",
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
	".ico":         "", // Preserve the published empty type without sniffing.
}

// Vite emits assets/[name]-[hash] for its generated scripts and styles.
var viteBundle = regexp.MustCompile(`^assets/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(js|css)$`)

// staticHandler serves embedded assets and falls back to index.html for SPA
// routes. A missing document uses the SPA's unavailable page with HTTP 404.
func staticHandler(assets fs.FS, notFound http.Handler) http.Handler {
	return httpassets.Compress(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
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
			if viteBundle.MatchString(candidate) {
				writer.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
				// Identity and gzip encode the same fingerprinted resource.
				writer.Header().Set("ETag", `W/"`+path.Base(candidate)+`"`)
			}
			// Set Content-Type explicitly, possibly to "", so ServeContent
			// never sniffs; the empty name keeps it from guessing either.
			writer.Header()["Content-Type"] = []string{staticContentTypes[strings.ToLower(path.Ext(candidate))]}
			// embed.FS reports a zero ModTime; do not fabricate Last-Modified.
			http.ServeContent(writer, request, "", info.ModTime(), seeker)
			return true
		}

		// A trailing slash cannot name an asset file.
		if !strings.HasSuffix(request.URL.Path, "/") && serve(name) {
			return
		}
		// Route-like paths use the SPA; files and .well-known requests do not.
		if !strings.Contains(cleaned, "/.well-known") {
			if !looksLikeFile(cleaned) && serve("index.html") {
				return
			}
			writer.Header().Add("Vary", "Accept, Sec-Fetch-Mode")
			if isDocumentNavigation(request) && serveMissingDocument(writer, request, assets) {
				return
			}
		}
		notFound.ServeHTTP(writer, request)
	}))
}

func isDocumentNavigation(request *http.Request) bool {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		return false
	}
	if mode := request.Header.Get("Sec-Fetch-Mode"); mode != "" && mode != "navigate" {
		return false
	}
	for _, field := range request.Header.Values("Accept") {
		for mediaRange := range strings.SplitSeq(field, ",") {
			mediaType, parameters, err := mime.ParseMediaType(mediaRange)
			if err != nil || mediaType != "text/html" {
				continue
			}
			quality, explicit := parameters["q"]
			if !explicit {
				return true
			}
			if weight, err := strconv.ParseFloat(quality, 64); err == nil && weight > 0 && weight <= 1 {
				return true
			}
		}
	}
	return false
}

func serveMissingDocument(writer http.ResponseWriter, request *http.Request, assets fs.FS) bool {
	shell, err := fs.ReadFile(assets, "index.html")
	if err != nil {
		return false
	}
	// The SPA's existing route parser renders the unavailable or malformed-room view.
	header := writer.Header()
	header.Set("Content-Type", staticContentTypes[".html"])
	header.Set("Content-Length", strconv.Itoa(len(shell)))
	header.Set("Cache-Control", "no-store")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Referrer-Policy", "no-referrer")
	writer.WriteHeader(http.StatusNotFound)
	if request.Method == http.MethodGet {
		_, _ = writer.Write(shell)
	}
	return true
}

// hasDotSegment excludes hidden assets, with the published .well-known exemption.
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

// looksLikeFile preserves the published SPA fallback boundary: the last path
// segment needs an ASCII-style basename and a nonempty alphanumeric/underscore
// extension. Names such as "/文件.js" and "/café.css" still reach the SPA.
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
