package diagnostics

import (
	"archive/zip"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func TestRecorderRotationAndExport(t *testing.T) {
	directory := t.TempDir()
	const private = "private-environment-and-media-sentinel"
	t.Setenv("SCREENER_DIAGNOSTICS_TEST_SECRET", private)
	if err := os.WriteFile(filepath.Join(directory, "private-config.json"), []byte(private), 0600); err != nil {
		t.Fatal(err)
	}
	recorder, err := Open(directory, "client", "test-revision")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = recorder.Close() })
	chunk := bytes.Repeat([]byte("x"), maxFileBytes/2)
	for range 5 {
		if _, err := recorder.log.Write(chunk); err != nil {
			t.Fatal(err)
		}
	}
	recorder.Logger().Debug("capture state", "event", "started")
	for _, path := range []string{recorder.LogPath(), recorder.LogPath() + ".1"} {
		info, err := os.Stat(path)
		if err != nil || info.Size() > maxFileBytes {
			t.Fatalf("bounded log %s: %v, %v", path, info, err)
		}
	}
	if _, err := os.Stat(recorder.LogPath() + ".2"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unexpected second backup: %v", err)
	}
	archivePath, err := recorder.Export()
	if err != nil {
		t.Fatal(err)
	}
	archive, err := zip.OpenReader(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	expected := map[string]bool{"client.log": false, "client.log.1": false, "metadata.json": false, "memory.json": false, "heap.pprof": false, "goroutines.txt": false}
	for _, file := range archive.File {
		if _, ok := expected[file.Name]; !ok {
			t.Fatalf("unexpected archive entry: %s", file.Name)
		}
		expected[file.Name] = true
		entry, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, readErr := io.ReadAll(entry)
		if err := errors.Join(readErr, entry.Close()); err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(data, []byte(private)) {
			t.Fatalf("private data in %s", file.Name)
		}
		switch file.Name {
		case "client.log":
			if !bytes.Contains(data, []byte(`"level":"DEBUG"`)) {
				t.Fatal("debug event was not persisted")
			}
		case "metadata.json":
			var metadata map[string]any
			if err := json.Unmarshal(data, &metadata); err != nil {
				t.Fatal(err)
			}
			if metadata["revision"] != "test-revision" || metadata["component"] != "client" || metadata["goos"] != runtime.GOOS || len(metadata) != 7 {
				t.Fatalf("unexpected metadata: %v", metadata)
			}
		case "memory.json":
			var memory runtime.MemStats
			if err := json.Unmarshal(data, &memory); err != nil || memory.Sys == 0 {
				t.Fatalf("invalid memory counters: %v", err)
			}
		case "heap.pprof":
			profile, err := gzip.NewReader(bytes.NewReader(data))
			if err != nil {
				t.Fatal(err)
			}
			profileData, err := io.ReadAll(profile)
			if err != nil || len(profileData) == 0 || bytes.Contains(profileData, []byte(private)) {
				t.Fatalf("invalid or private heap allocation profile: %v", err)
			}
			if err := profile.Close(); err != nil {
				t.Fatal(err)
			}
		case "goroutines.txt":
			if !bytes.HasPrefix(data, []byte("goroutine profile: total ")) || bytes.Contains(data, []byte("[running]:")) {
				t.Fatal("expected aggregated goroutine profile")
			}
		}
	}
	for name, found := range expected {
		if !found {
			t.Fatalf("missing archive entry: %s", name)
		}
	}
	second, err := recorder.Export()
	if err != nil || second == archivePath {
		t.Fatalf("export must have a unique path: %q, %v", second, err)
	}
}

func TestRecorderCloseAndFailures(t *testing.T) {
	if _, err := Open(t.TempDir(), "../client", "test"); err == nil {
		t.Fatal("accepted a component path")
	}
	recorder, err := Open(t.TempDir(), "server", "test")
	if err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	var started sync.WaitGroup
	started.Add(4)
	stop := make(chan struct{})
	defer func() {
		close(stop)
		workers.Wait()
	}()
	for worker := range 4 {
		workers.Go(func() {
			recorder.Logger().Debug("concurrent log", "worker", worker)
			started.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				recorder.Logger().Debug("concurrent log", "worker", worker)
			}
		})
	}
	started.Wait()
	if _, err := recorder.Export(); err != nil {
		t.Fatal(err)
	}
	workers.Go(func() {
		if _, err := recorder.Export(); err != nil && !errors.Is(err, os.ErrClosed) {
			t.Errorf("concurrent export: %v", err)
		}
	})
	if err := recorder.Close(); err != nil {
		t.Fatal(err)
	}
	if err := recorder.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := recorder.Export(); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("export after close: %v", err)
	}
	failing, err := Open(t.TempDir(), "client", "test")
	if err != nil {
		t.Fatal(err)
	}
	if err := failing.log.file.Close(); err != nil {
		t.Fatal(err)
	}
	failing.Logger().Error("write fails")
	if _, err := failing.Export(); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("export hid a log write failure: %v", err)
	}
	if err := failing.Close(); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("close hid a log write failure: %v", err)
	}
	if _, err := (&boundedWriter{writer: io.Discard, remaining: 1}).Write([]byte("xx")); err == nil || !strings.Contains(err.Error(), "8 MiB") {
		t.Fatalf("profile output limit: %v", err)
	}
}
