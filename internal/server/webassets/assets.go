// Package webassets embeds the built Browser UI so a single binary can serve it.
package webassets

import (
	"embed"
	"io/fs"
)

// `all:` is the only pattern that still builds on a clean checkout, where dist
// holds nothing but the tracked .gitkeep marker. It also embeds dot-prefixed
// entries, which the static handler refuses to serve.
//
//go:embed all:dist
var embedded embed.FS

// FS returns the embedded Vite build, or nil when no build was embedded. The
// probe is dist/index.html, never an entry count: .gitkeep is always there.
func FS() fs.FS {
	assets, err := fs.Sub(embedded, "dist")
	if err != nil {
		return nil
	}
	if _, err := fs.Stat(assets, "index.html"); err != nil {
		return nil
	}
	return assets
}
