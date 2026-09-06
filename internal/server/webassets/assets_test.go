package webassets

import (
	"io/fs"
	"testing"
)

// TestFSTracksIndexHTML holds whether or not a Vite build is present: FS() must
// be non-nil exactly when dist/index.html is embedded.
func TestFSTracksIndexHTML(t *testing.T) {
	_, err := fs.Stat(embedded, "dist/index.html")
	assets := FS()

	switch {
	case err == nil && assets == nil:
		t.Fatal("dist/index.html is embedded but FS() returned nil")
	case err != nil && assets != nil:
		t.Fatalf("dist/index.html is absent (%v) but FS() returned a file system", err)
	case assets == nil:
		t.Log("no build embedded: the app serves the API only")
		return
	}

	if _, err := fs.Stat(assets, "index.html"); err != nil {
		t.Fatalf("index.html is not reachable through FS(): %v", err)
	}
}

// TestGitkeepIsEmbedded pins the `all:` prefix: without it the package does not
// build on a checkout whose dist holds only the dot-prefixed marker.
func TestGitkeepIsEmbedded(t *testing.T) {
	if _, err := fs.Stat(embedded, "dist/.gitkeep"); err != nil {
		t.Fatalf("dist/.gitkeep must stay tracked and embedded: %v", err)
	}
}
