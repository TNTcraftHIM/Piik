package publictunnel

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/diagnostics"
)

const (
	startupTimeout    = 30 * time.Second
	startupAttempts   = 4
	startupRetryDelay = time.Second
	shutdownTimeout   = 5 * time.Second
	maxLogLineBytes   = 64 * 1024
)

var quickOriginPattern = regexp.MustCompile(
	`https://[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com`,
)

var errStartupExited = errors.New("public invitation service exited before connecting; reopen Piik to try again")

type Process struct {
	origin string
	cancel context.CancelFunc
	done   chan struct{}
	once   sync.Once

	mu  sync.Mutex
	err error
}

func PackagedExecutable() string {
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	name := "cloudflared"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(filepath.Dir(executable), "runtime", "tunnel", name)
}

func Start(
	parent context.Context,
	executable string,
	localOrigin string,
) (*Process, error) {
	if parent == nil {
		parent = context.Background()
	}
	if err := parent.Err(); err != nil {
		return nil, err
	}
	if err := validateExecutable(executable); err != nil {
		return nil, err
	}
	if err := validateLocalOrigin(localOrigin); err != nil {
		return nil, err
	}
	startup, cancel := context.WithTimeout(parent, startupTimeout)
	defer cancel()
	var err error
	for attempt := 1; attempt <= startupAttempts; attempt++ {
		var process *Process
		process, err = startAttempt(startup, executable, localOrigin)
		if err == nil {
			return process, nil
		}
		if startup.Err() != nil || !errors.Is(err, errStartupExited) || attempt == startupAttempts {
			break
		}
		// Only a retired, pre-ready child is retried. Ready tunnel recovery
		// remains cloudflared's job; all startup attempts share one deadline.
		slog.Debug("public-tunnel", "event", "startup-retry", "attempt", attempt+1, "total", startupAttempts)
		timer := time.NewTimer(startupRetryDelay)
		select {
		case <-startup.Done():
			timer.Stop()
		case <-timer.C:
		}
		if startup.Err() != nil {
			// No child is live during the retry pause; stopping here is clean.
			err = startup.Err()
			break
		}
	}
	if startup.Err() != nil {
		if err != startup.Err() {
			err = errors.Join(startup.Err(), err)
		}
		if parent.Err() == nil {
			err = errors.Join(errors.New("public invitation service did not connect within 30 seconds; check your Internet connection and reopen Piik to try again"), err)
		}
	}
	return nil, err
}

func startAttempt(parent context.Context, executable, localOrigin string) (*Process, error) {
	if err := parent.Err(); err != nil {
		return nil, err
	}
	configPath, err := writeTemporaryConfig()
	if err != nil {
		return nil, err
	}
	// The caller cancels startup, then explicitly closes a ready tunnel after
	// sending room-closed and draining its server. Root cancellation cannot
	// kill that transport ahead of the ordered shutdown.
	ctx, cancel := context.WithCancel(context.WithoutCancel(parent))
	child := exec.CommandContext(
		ctx,
		executable,
		"tunnel",
		"--config", configPath,
		"--no-autoupdate",
		"--loglevel", "info",
		"--output", "json",
		// Quick Tunnels otherwise force QUIC. Let cloudflared try TCP after
		// the first failed edge attempt, within our bounded startup window.
		"--protocol", "auto",
		"--max-edge-addr-retries", "0",
		"--url", localOrigin,
	)
	hideWindow(child)
	stdout, err := child.StdoutPipe()
	if err != nil {
		cancel()
		_ = os.Remove(configPath)
		return nil, fmt.Errorf("public tunnel output is unavailable: %w", err)
	}
	stderr, err := child.StderrPipe()
	if err != nil {
		cancel()
		_ = os.Remove(configPath)
		return nil, fmt.Errorf("public tunnel output is unavailable: %w", err)
	}
	child.WaitDelay = shutdownTimeout
	if err = child.Start(); err != nil {
		cancel()
		_ = os.Remove(configPath)
		return nil, fmt.Errorf("public tunnel could not start: %w", err)
	}
	process := &Process{cancel: cancel, done: make(chan struct{})}
	discovered := make(chan string, 1)
	connected := make(chan struct{}, 1)
	var discoverOnce sync.Once
	var connectOnce sync.Once
	var outputDone sync.WaitGroup
	outputDone.Add(2)
	readOutput := func(reader io.Reader) {
		defer outputDone.Done()
		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 4096), maxLogLineBytes)
		for scanner.Scan() {
			line := scanner.Text()
			var entry struct {
				Level   string `json:"level"`
				Message string `json:"message"`
				Error   string `json:"error"`
			}
			if json.Unmarshal([]byte(line), &entry) != nil {
				slog.Debug("public-tunnel", "event", "dependency-output", "message", diagnostics.SafeText(line))
			} else if entry.Level == "error" || entry.Level == "warn" || entry.Level == "fatal" {
				slog.Debug("public-tunnel", "event", "dependency-output", "level", entry.Level,
					"message", diagnostics.SafeText(entry.Message), "cause", diagnostics.SafeText(entry.Error))
			}
			if origin, ok := originFromLogLine(line); ok {
				discoverOnce.Do(func() { discovered <- origin })
			}
			if connectionRegistered(line) {
				connectOnce.Do(func() { connected <- struct{}{} })
			}
		}
		if err := scanner.Err(); err != nil {
			slog.Debug("public-tunnel", "event", "output-read-failed", diagnostics.Error(err))
		}
	}
	go readOutput(stdout)
	go readOutput(stderr)
	go func() {
		waitErr := child.Wait()
		// Classify the observed exit before draining logs: later owner cleanup
		// cannot turn a dependency failure into a successful cancellation.
		if ctx.Err() != nil {
			waitErr = nil
		}
		process.mu.Lock()
		process.err = waitErr
		process.mu.Unlock()
		// Wait closes the pipe readers; join them before App closes its recorder.
		// Do not wait before Wait: that would bypass its bounded pipe shutdown.
		outputDone.Wait()
		_ = os.Remove(configPath)
		close(process.done)
	}()

	registered := false
	for process.origin == "" || !registered {
		select {
		case process.origin = <-discovered:
		case <-connected:
			registered = true
		case <-process.done:
			cancel()
			return nil, errors.Join(errStartupExited, process.Err())
		case <-parent.Done():
			if err := process.Close(); err != nil {
				return nil, errors.Join(parent.Err(), err)
			}
			return nil, parent.Err()
		}
	}
	select {
	case <-parent.Done():
		if err := process.Close(); err != nil {
			return nil, errors.Join(parent.Err(), err)
		}
		return nil, parent.Err()
	case <-process.done:
		cancel()
		return nil, errors.Join(errStartupExited, process.Err())
	default:
	}
	return process, nil
}

func writeTemporaryConfig() (string, error) {
	file, err := os.CreateTemp("", "piik-cloudflared-*.yml")
	if err != nil {
		return "", fmt.Errorf("public tunnel temporary file could not be created: %w", err)
	}
	path := file.Name()
	if _, err = file.WriteString("metrics: 127.0.0.1:0\n"); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return "", fmt.Errorf("public tunnel temporary file could not be written: %w", err)
	}
	if err = file.Close(); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("public tunnel temporary file could not be saved: %w", err)
	}
	return path, nil
}

func (process *Process) Origin() string {
	return process.origin
}

func (process *Process) Done() <-chan struct{} {
	return process.done
}

func (process *Process) Err() error {
	select {
	case <-process.done:
		process.mu.Lock()
		defer process.mu.Unlock()
		return process.err
	default:
		return nil
	}
}

func (process *Process) Close() error {
	process.once.Do(process.cancel)
	<-process.done
	return process.Err()
}

func originFromLogLine(line string) (string, bool) {
	line = logMessage(line)
	origin := quickOriginPattern.FindString(strings.ToLower(line))
	if origin == "" {
		return "", false
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme != "https" || parsed.Path != "" ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", false
	}
	return parsed.Scheme + "://" + parsed.Host, true
}

func connectionRegistered(line string) bool {
	return strings.Contains(logMessage(line), "Registered tunnel connection")
}

func logMessage(line string) string {
	var entry struct {
		Message string `json:"message"`
	}
	if json.Unmarshal([]byte(line), &entry) == nil && entry.Message != "" {
		return entry.Message
	}
	return line
}

func validateExecutable(path string) error {
	path = strings.TrimSpace(path)
	metadata, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("packaged public tunnel is unavailable; extract the complete Piik archive again: %w", err)
	}
	if !metadata.Mode().IsRegular() {
		return errors.New("packaged public tunnel is not a file; extract the complete Piik archive again")
	}
	return nil
}

func validateLocalOrigin(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "http" || parsed.User != nil ||
		parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("public tunnel Local origin is invalid")
	}
	ip := net.ParseIP(parsed.Hostname())
	if ip == nil || !ip.IsLoopback() || parsed.Port() == "" {
		return errors.New("public tunnel Local origin is invalid")
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port < 1 || port > 65_535 {
		return errors.New("public tunnel Local origin is invalid")
	}
	return nil
}
