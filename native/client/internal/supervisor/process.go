package supervisor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"sync"
	"time"
)

const (
	readinessTimeout = 15 * time.Second
	pollInterval     = 100 * time.Millisecond
	requestTimeout   = 500 * time.Millisecond
	shutdownTimeout  = 5 * time.Second
)

type Command struct {
	Path        string
	Args        []string
	Directory   string
	Environment []string
	Stdout      io.Writer
	Stderr      io.Writer
	HealthURL   string
}

type Process struct {
	cancel context.CancelFunc
	done   chan struct{}
	once   sync.Once
	mu     sync.Mutex
	err    error
}

func Start(parent context.Context, command Command) (*Process, error) {
	if parent == nil {
		parent = context.Background()
	}
	if command.Path == "" || command.HealthURL == "" {
		return nil, errors.New("supervised process command is incomplete")
	}
	ctx, cancel := context.WithCancel(parent)
	child := exec.CommandContext(ctx, command.Path, command.Args...)
	child.Dir = command.Directory
	child.Env = command.Environment
	child.Stdout = command.Stdout
	child.Stderr = command.Stderr
	stdin, err := child.StdinPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("open supervised process stdin: %w", err)
	}
	child.Cancel = stdin.Close
	child.WaitDelay = shutdownTimeout
	if err = child.Start(); err != nil {
		cancel()
		return nil, fmt.Errorf("start supervised process: %w", err)
	}
	process := &Process{cancel: cancel, done: make(chan struct{})}
	go func() {
		waitErr := child.Wait()
		if ctx.Err() != nil && (waitErr == nil || errors.Is(waitErr, context.Canceled)) {
			waitErr = nil
		}
		process.mu.Lock()
		process.err = waitErr
		process.mu.Unlock()
		close(process.done)
	}()
	if err = waitUntilReady(ctx, process, command.HealthURL); err != nil {
		process.cancel()
		<-process.done
		return nil, err
	}
	return process, nil
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

func waitUntilReady(ctx context.Context, process *Process, healthURL string) error {
	deadline := time.NewTimer(readinessTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	transport := &http.Transport{Proxy: nil}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Timeout:   requestTimeout,
		Transport: transport,
	}
	for {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, healthURL, nil)
		if err != nil {
			return errors.New("supervised process health URL is invalid")
		}
		response, requestErr := client.Do(request)
		if requestErr == nil {
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-process.done:
			if err = process.Err(); err != nil {
				return fmt.Errorf("supervised process exited before readiness: %w", err)
			}
			return errors.New("supervised process exited before readiness")
		case <-deadline.C:
			return errors.New("supervised process readiness timed out")
		case <-ticker.C:
		}
	}
}
