// Package diagnostics persists bounded structured logs and exports local runtime diagnostics.
package diagnostics

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"runtime/pprof"
	"sync"
	"time"
)

const maxFileBytes = 8 << 20

type Recorder struct {
	exportMu  sync.Mutex
	log       *rotatingLog
	logger    *slog.Logger
	component string
	revision  string
	started   time.Time
}

// Open appends to the component's current log, retaining one rotated backup.
// Callers own the directory choice and must pass sanitized structured events.
func Open(directory, component, revision string) (*Recorder, error) {
	if component != "client" && component != "server" {
		return nil, errors.New("diagnostics component must be client or server")
	}
	if directory == "" {
		return nil, errors.New("diagnostics directory is empty")
	}
	directory, err := filepath.Abs(directory)
	if err != nil {
		return nil, fmt.Errorf("resolve diagnostics directory: %w", err)
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, fmt.Errorf("create diagnostics directory: %w", err)
	}
	path := filepath.Join(directory, component+".log")
	for _, name := range []string{path, path + ".1"} {
		if err := checkLogFile(name); err != nil {
			return nil, err
		}
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return nil, fmt.Errorf("open diagnostics log: %w", err)
	}
	info, err := file.Stat()
	if err != nil {
		return nil, errors.Join(err, file.Close())
	}
	log := &rotatingLog{file: file, path: path, size: info.Size()}
	return &Recorder{
		log: log, logger: slog.New(slog.NewJSONHandler(log, &slog.HandlerOptions{Level: slog.LevelDebug})),
		component: component, revision: revision, started: time.Now(),
	}, nil
}

func (r *Recorder) Logger() *slog.Logger { return r.logger }
func (r *Recorder) LogPath() string      { return r.log.path }

// Export samples this process without forcing GC or collecting raw memory,
// configuration, environment variables, media, or arbitrary directory contents.
func (r *Recorder) Export() (path string, returnedErr error) {
	r.exportMu.Lock()
	defer r.exportMu.Unlock()
	logs, err := r.log.snapshot()
	if err != nil {
		return "", fmt.Errorf("snapshot diagnostics logs: %w", err)
	}
	now := time.Now()
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	file, err := os.CreateTemp(filepath.Dir(r.LogPath()), r.component+"-diagnostics-"+now.UTC().Format("20060102T150405Z")+"-*.zip")
	if err != nil {
		return "", fmt.Errorf("create diagnostics archive: %w", err)
	}
	archive := zip.NewWriter(file)
	defer func() {
		returnedErr = errors.Join(returnedErr, archive.Close(), file.Sync(), file.Close())
		if returnedErr != nil {
			returnedErr = errors.Join(returnedErr, os.Remove(file.Name()))
			path = ""
		}
	}()
	for _, log := range logs {
		entry, err := archive.Create(log.name)
		if err != nil {
			return "", err
		}
		if _, err := entry.Write(log.data); err != nil {
			return "", err
		}
	}
	metadata := struct {
		Component     string    `json:"component"`
		Revision      string    `json:"revision"`
		GOOS          string    `json:"goos"`
		GOARCH        string    `json:"goarch"`
		GoVersion     string    `json:"goVersion"`
		CollectedAt   time.Time `json:"collectedAt"`
		UptimeSeconds float64   `json:"uptimeSeconds"`
	}{r.component, r.revision, runtime.GOOS, runtime.GOARCH, runtime.Version(), now.UTC(), now.Sub(r.started).Seconds()}
	for _, item := range []struct {
		name  string
		value any
	}{{"metadata.json", metadata}, {"memory.json", memory}} {
		entry, err := archive.Create(item.name)
		if err != nil {
			return "", err
		}
		if err := json.NewEncoder(entry).Encode(item.value); err != nil {
			return "", err
		}
	}
	for _, profile := range []struct {
		name  string
		file  string
		debug int
	}{{"heap", "heap.pprof", 0}, {"goroutine", "goroutines.txt", 1}} {
		entry, err := archive.Create(profile.file)
		if err != nil {
			return "", err
		}
		if err := pprof.Lookup(profile.name).WriteTo(&boundedWriter{writer: entry, remaining: maxFileBytes}, profile.debug); err != nil {
			return "", fmt.Errorf("write %s profile: %w", profile.name, err)
		}
	}
	return file.Name(), nil
}

// Close waits for an export already in progress. It is safe to call repeatedly.
func (r *Recorder) Close() error {
	r.exportMu.Lock()
	defer r.exportMu.Unlock()
	r.log.mu.Lock()
	defer r.log.mu.Unlock()
	if r.log.file != nil {
		r.log.err = errors.Join(r.log.err, r.log.file.Sync(), r.log.file.Close())
		r.log.file = nil
	}
	return r.log.err
}

type rotatingLog struct {
	mu   sync.Mutex
	file *os.File
	path string
	size int64
	err  error
}

func (l *rotatingLog) Write(data []byte) (n int, err error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file == nil {
		return 0, os.ErrClosed
	}
	// slog discards handler errors; retain the first failure for Export and Close.
	defer func() {
		if err != nil && l.err == nil {
			l.err = err
		}
	}()
	if len(data) > maxFileBytes {
		return 0, errors.New("diagnostics log record exceeds 8 MiB")
	}
	if l.size+int64(len(data)) > maxFileBytes {
		if err := l.rotate(); err != nil {
			return 0, err
		}
	}
	n, err = l.file.Write(data)
	l.size += int64(n)
	return n, err
}

func (l *rotatingLog) rotate() error {
	err := l.file.Close()
	l.file = nil
	if err != nil {
		return err
	}
	if err := os.Remove(l.path + ".1"); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(l.path, l.path+".1"); err != nil {
		return err
	}
	l.file, err = os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	l.size = 0
	return err
}

type logSnapshot struct {
	name string
	data []byte
}

func (l *rotatingLog) snapshot() ([]logSnapshot, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.err != nil {
		return nil, l.err
	}
	if l.file == nil {
		return nil, os.ErrClosed
	}
	if err := l.file.Sync(); err != nil {
		return nil, err
	}
	// ponytail: at most 16 MiB copied under the log lock; compression runs outside it.
	var logs []logSnapshot
	for _, path := range []string{l.path + ".1", l.path} {
		if err := checkLogFile(path); err != nil {
			return nil, err
		}
		file, err := os.Open(path)
		if errors.Is(err, os.ErrNotExist) && path != l.path {
			continue
		}
		if err != nil {
			return nil, err
		}
		data, readErr := io.ReadAll(io.LimitReader(file, maxFileBytes+1))
		if err := errors.Join(readErr, file.Close()); err != nil {
			return nil, err
		}
		if len(data) > maxFileBytes {
			return nil, errors.New("diagnostics log exceeds 8 MiB")
		}
		logs = append(logs, logSnapshot{filepath.Base(path), data})
	}
	return logs, nil
}

func checkLogFile(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > maxFileBytes {
		return fmt.Errorf("diagnostics log %q must be a regular file no larger than 8 MiB", path)
	}
	return nil
}

type boundedWriter struct {
	writer    io.Writer
	remaining int
}

func (w *boundedWriter) Write(data []byte) (int, error) {
	if len(data) > w.remaining {
		return 0, errors.New("diagnostics profile exceeds 8 MiB")
	}
	n, err := w.writer.Write(data)
	w.remaining -= n
	return n, err
}
