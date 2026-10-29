// Package httpassets supplies shared HTTP delivery for Silip's Web assets.
package httpassets

import (
	"net/http"

	"github.com/klauspost/compress/gzhttp"
)

// Compress negotiates gzip for text assets, leaving precompressed media alone.
func Compress(handler http.Handler) http.Handler {
	compress, err := gzhttp.NewWrapper(gzhttp.EnableZstd(false), gzhttp.ContentTypes([]string{
		"text/html", "text/javascript", "application/javascript", "text/css",
	}))
	if err != nil {
		panic(err)
	}
	return compress(handler)
}
