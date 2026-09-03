package publictunnel

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
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
)

const (
	startupTimeout  = 30 * time.Second
	shutdownTimeout = 5 * time.Second
	maxLogLineBytes = 64 * 1024
)

var quickOriginPattern = regexp.MustCompile(
	`https://[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com`,
)

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
	if err := validateExecutable(executable); err != nil {
		return nil, err
	}
	if err := validateLocalOrigin(localOrigin); err != nil {
		return nil, err
	}
	configPath, err := writeTemporaryConfig()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	child := exec.CommandContext(
		ctx,
		executable,
		"tunnel",
		"--config", configPath,
		"--no-autoupdate",
		"--loglevel", "info",
		"--output", "json",
		"--url", localOrigin,
	)
	hideWindow(child)
	stdout, err := child.StdoutPipe()
	if err != nil {
		cancel()
		_ = os.Remove(configPath)
		return nil, errors.New("public tunnel output is unavailable")
	}
	stderr, err := child.StderrPipe()
	if err != nil {
		cancel()
		_ = os.Remove(configPath)
		return nil, errors.New("public tunnel output is unavailable")
	}
	child.WaitDelay = shutdownTimeout
	if err = child.Start(); err != nil {
		cancel()
		_ = os.Remove(configPath)
		return nil, errors.New("public tunnel could not start")
	}
	process := &Process{cancel: cancel, done: make(chan struct{})}
	discovered := make(chan string, 1)
	connected := make(chan struct{}, 1)
	var discoverOnce sync.Once
	var connectOnce sync.Once
	readOutput := func(reader io.Reader) {
		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 4096), maxLogLineBytes)
		for scanner.Scan() {
			line := scanner.Text()
			if origin, ok := originFromLogLine(line); ok {
				discoverOnce.Do(func() { discovered <- origin })
			}
			if connectionRegistered(line) {
				connectOnce.Do(func() { connected <- struct{}{} })
			}
		}
	}
	go readOutput(stdout)
	go readOutput(stderr)
	go func() {
		waitErr := child.Wait()
		_ = os.Remove(configPath)
		if ctx.Err() != nil {
			waitErr = nil
		}
		process.mu.Lock()
		process.err = waitErr
		process.mu.Unlock()
		close(process.done)
	}()

	timer := time.NewTimer(startupTimeout)
	defer timer.Stop()
	registered := false
	for process.origin == "" || !registered {
		select {
		case process.origin = <-discovered:
		case <-connected:
			registered = true
		case <-process.done:
			cancel()
			return nil, errors.New("public tunnel exited before it became available")
		case <-timer.C:
			_ = process.Close()
			return nil, errors.New("public tunnel startup timed out")
		case <-parent.Done():
			_ = process.Close()
			return nil, parent.Err()
		}
	}
	return process, nil
}

func writeTemporaryConfig() (string, error) {
	file, err := os.CreateTemp("", "screener-cloudflared-*.yml")
	if err != nil {
		return "", errors.New("public tunnel configuration is unavailable")
	}
	path := file.Name()
	if _, err = file.WriteString("metrics: 127.0.0.1:0\n"); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return "", errors.New("public tunnel configuration is unavailable")
	}
	if err = file.Close(); err != nil {
		_ = os.Remove(path)
		return "", errors.New("public tunnel configuration is unavailable")
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
	if err != nil || !metadata.Mode().IsRegular() {
		return errors.New("packaged public tunnel is unavailable")
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
