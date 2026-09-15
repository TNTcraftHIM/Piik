package diagnostics

import (
	"archive/zip"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"go.uber.org/zap/zapcore"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestRecorderRotationAndExport(t *testing.T) {
	directory := t.TempDir()
	const private = "private-environment-and-media-sentinel"
	t.Setenv("PIIK_DIAGNOSTICS_TEST_SECRET", private)
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
	expected := map[string]bool{"client.log": false, "client.log.1": false, "metadata.json": false, "memory.json": false, "heap.pprof": false, "goroutines.txt": false, "context.json": false, "README.txt": false}
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
			if metadata["revision"] != "test-revision" || metadata["component"] != "client" || metadata["goos"] != runtime.GOOS || metadata["reportId"] == "" || metadata["partial"] != true {
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
	if err != nil || second == archivePath || recorder.LastExportPath() != second {
		t.Fatalf("export must have a unique path: %q, %v", second, err)
	}
	_ = recorder.Close()
	reopened, err := Open(directory, "client", "next-process")
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.log.retention()["earlierHistoryMayBeMissing"] != true {
		t.Fatal("restart incorrectly claimed complete prior history")
	}
}

func TestRecorderKeepsTheLastSuccessfulExportAfterFailureAndClose(t *testing.T) {
	recorder, err := Open(t.TempDir(), "client", "test")
	if err != nil {
		t.Fatal(err)
	}
	defer recorder.Close()
	if path := recorder.LastExportPath(); path != "" {
		t.Fatalf("unexpected initial report: %q", path)
	}
	saved, err := recorder.Export()
	if err != nil {
		t.Fatal(err)
	}
	original := recorder.log.path
	// A regular file in the directory position makes archive creation fail on every OS.
	recorder.log.path = filepath.Join(original, "unavailable", "client.log")
	path, exportErr := recorder.Export()
	recorder.log.path = original
	if path != "" || exportErr == nil || recorder.LastExportPath() != saved {
		t.Fatalf("failed export replaced the saved report: %q, %v", path, exportErr)
	}
	if err := recorder.Close(); err != nil {
		t.Fatal(err)
	}
	if path, err := recorder.Export(); path != "" || !errors.Is(err, os.ErrClosed) || recorder.LastExportPath() != saved {
		t.Fatalf("closed recorder lost the saved report: %q, %v", path, err)
	}
	archive, err := zip.OpenReader(saved)
	if err != nil {
		t.Fatalf("saved report is unavailable or incomplete: %v", err)
	}
	_ = archive.Close()
}

type exportContext func() ([]byte, error)

func (value exportContext) MarshalJSON() ([]byte, error) { return value() }

func TestRecorderCloseWaitsForAnExportAlreadyInProgress(t *testing.T) {
	recorder, err := Open(t.TempDir(), "client", "test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = recorder.Close() })
	started, release := make(chan struct{}), make(chan struct{})
	resume := sync.OnceFunc(func() { close(release) })
	defer resume()
	recorder.context = map[string]any{"barrier": exportContext(func() ([]byte, error) {
		close(started)
		<-release
		return []byte("null"), nil
	})}
	type result struct {
		path string
		err  error
	}
	exported := make(chan result, 1)
	go func() {
		path, err := recorder.Export()
		exported <- result{path, err}
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("export did not reach the archive writer")
	}
	closing, closed := make(chan struct{}), make(chan error, 1)
	go func() { close(closing); closed <- recorder.Close() }()
	<-closing
	select {
	case err := <-closed:
		t.Fatalf("Close returned before the archive finished: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	resume()
	completed := <-exported
	if err := <-closed; err != nil || completed.err != nil || completed.path == "" || recorder.LastExportPath() != completed.path {
		t.Fatalf("Close lost the completed report: %v, %v, %q", err, completed.err, completed.path)
	}
	archive, err := zip.OpenReader(completed.path)
	if err != nil {
		t.Fatalf("Close exposed an unfinished archive: %v", err)
	}
	_ = archive.Close()
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
	partial, err := failing.Export()
	if err != nil {
		t.Fatalf("one failed log writer discarded usable runtime evidence: %v", err)
	}
	archive, err := zip.OpenReader(partial)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	entry, err := archive.Open("metadata.json")
	if err != nil {
		t.Fatal(err)
	}
	var metadata map[string]any
	if err = json.NewDecoder(entry).Decode(&metadata); err != nil {
		t.Fatal(err)
	}
	_ = entry.Close()
	if metadata["partial"] != true || len(metadata["collectorErrors"].([]any)) == 0 {
		t.Fatalf("partial export hid failed collection: %v", metadata)
	}
	if err := failing.Close(); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("close hid a log write failure: %v", err)
	}
	if _, err := (&boundedWriter{writer: io.Discard, remaining: 1}).Write([]byte("xx")); err == nil || !strings.Contains(err.Error(), "8 MiB") {
		t.Fatalf("profile output limit: %v", err)
	}
}

func TestDependencyDiagnosticsPreserveCausesWithoutSecrets(t *testing.T) {
	recorder, err := Open(t.TempDir(), "client", "test")
	if err != nil {
		t.Fatal(err)
	}
	defer recorder.Close()
	previous := slog.Default()
	slog.SetDefault(recorder.Logger())
	defer slog.SetDefault(previous)
	const secret = "must-not-appear-in-report"
	recorder.Logger().Error("operation", Error(fmt.Errorf("interface enumeration: %w", syscall.EAFNOSUPPORT)),
		"requestId", "request-17", "nested", map[string]any{"instanceToken": secret, "state": "checking"})
	PionLoggerFactory().NewLogger("ice").Debugf("Started agent: remoteUfrag: %q, remotePwd: %q", secret, secret)
	PionLoggerFactory().NewLogger("ice").Warnf("mismatch username expected(%x) actual(%x)", secret, secret)
	PionLoggerFactory().NewLogger("pc").Errorf("dropping candidate with ufrag %s because it doesn't match", secret)
	PionLoggerFactory().NewLogger("ice").Warnf("Failed to get TCP connections by ufrag: tcp4 127.0.0.1:1 %s", secret)
	PionLoggerFactory().NewLogger("pc").Debugf("got new track: &{id:%s streamID:private-track-identity peeked:[1 2]}", secret)
	writer := Writer("capture")
	for _, part := range []string{"stage=device-open\nAuthorization: Bear", "er " + secret + "\n",
		"-----BEGIN PRIVATE KEY-----\n", secret + "\n-----END PRIVATE KEY-----\n",
		"https://example.test/r/1234#v=" + secret + "\n", "hresult=0x80070005"} {
		if _, err := writer.Write([]byte(part)); err != nil {
			t.Fatal(err)
		}
	}
	_ = writer.Close()
	MediaLogger("test").Warnw("media initialization", fmt.Errorf("network adapter unavailable"), "trackId", "private-track-identity", "stats", diagnosticObject{value: secret})
	data, err := os.ReadFile(recorder.LogPath())
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{secret, fmt.Sprintf("%x", secret), "private-track-identity"} {
		if bytes.Contains(data, []byte(forbidden)) {
			t.Fatalf("sensitive value retained: %q", forbidden)
		}
	}
	for _, useful := range []string{"request-17", "interface enumeration", "systemCode", "device-open", "0x80070005", "network adapter unavailable", "checking", `"jitter":12`} {
		if !bytes.Contains(data, []byte(useful)) {
			t.Fatalf("missing diagnostic context: %q", useful)
		}
	}
}

type diagnosticObject struct{ value string }

func (object diagnosticObject) MarshalLogObject(encoder zapcore.ObjectEncoder) error {
	encoder.AddInt("jitter", 12)
	encoder.AddString("password", object.value)
	return nil
}
