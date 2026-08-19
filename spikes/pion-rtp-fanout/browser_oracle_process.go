package fanoutoracle

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

type oracleBrowserProcess struct {
	cancel     context.CancelFunc
	command    *exec.Cmd
	done       chan error
	profileDir string
	stderr     *lockedBuffer
	once       sync.Once
}

type lockedBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (buffer *lockedBuffer) Write(value []byte) (int, error) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.buffer.Write(value)
}

func (buffer *lockedBuffer) String() string {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.buffer.String()
}

func resolveBrowserPath(configured string) (string, error) {
	if configured == "" {
		configured = os.Getenv("SCREENER_BROWSER_BIN")
	}
	if configured != "" {
		return validateBrowserPath(configured)
	}

	var candidates []string
	switch runtime.GOOS {
	case "windows":
		for _, root := range []string{os.Getenv("PROGRAMFILES"), os.Getenv("PROGRAMFILES(X86)"), os.Getenv("LOCALAPPDATA")} {
			if root == "" {
				continue
			}
			candidates = append(candidates,
				filepath.Join(root, "Google", "Chrome", "Application", "chrome.exe"),
				filepath.Join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
			)
		}
	case "darwin":
		candidates = []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
		}
	default:
		for _, name := range []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"} {
			if path, err := exec.LookPath(name); err == nil {
				candidates = append(candidates, path)
			}
		}
	}

	for _, candidate := range candidates {
		if path, err := validateBrowserPath(candidate); err == nil {
			return path, nil
		}
	}
	return "", errorsBrowserNotFound()
}

func validateBrowserPath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve browser path: %w", err)
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return "", fmt.Errorf("browser executable %q: %w", absolute, err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("browser executable %q is a directory", absolute)
	}
	return absolute, nil
}

func errorsBrowserNotFound() error {
	return fmt.Errorf("Chrome, Chromium, or Edge was not found; set SCREENER_BROWSER_BIN or pass -browser")
}

func launchOracleBrowser(ctx context.Context, browserPath, pageURL, label string) (*oracleBrowserProcess, error) {
	profileDir, err := os.MkdirTemp("", "screener-browser-oracle-"+label+"-")
	if err != nil {
		return nil, fmt.Errorf("create %s browser profile: %w", label, err)
	}

	processContext, cancel := context.WithCancel(ctx)
	stderr := &lockedBuffer{}
	command := exec.CommandContext(processContext, browserPath,
		"--headless=new",
		"--autoplay-policy=no-user-gesture-required",
		"--disable-background-networking",
		"--disable-background-timer-throttling",
		"--disable-backgrounding-occluded-windows",
		"--disable-breakpad",
		"--disable-component-update",
		"--disable-default-apps",
		"--disable-dev-shm-usage",
		"--disable-extensions",
		"--disable-features=MediaRouter",
		"--disable-renderer-backgrounding",
		"--metrics-recording-only",
		"--mute-audio",
		"--no-default-browser-check",
		"--no-first-run",
		"--remote-debugging-port=0",
		"--user-data-dir="+profileDir,
		"--window-size=640,480",
		pageURL,
	)
	command.Stdout = io.Discard
	command.Stderr = stderr
	if err = command.Start(); err != nil {
		cancel()
		_ = os.RemoveAll(profileDir)
		return nil, fmt.Errorf("launch %s browser: %w", label, err)
	}

	process := &oracleBrowserProcess{
		cancel:     cancel,
		command:    command,
		done:       make(chan error, 1),
		profileDir: profileDir,
		stderr:     stderr,
	}
	go func() {
		process.done <- command.Wait()
	}()
	return process, nil
}

func (process *oracleBrowserProcess) close() {
	process.once.Do(func() {
		process.cancel()
		select {
		case <-process.done:
		case <-time.After(time.Second):
			if process.command.Process != nil {
				_ = process.command.Process.Kill()
			}
			select {
			case <-process.done:
			case <-time.After(time.Second):
			}
		}
		for attempt := 0; attempt < 10; attempt++ {
			if err := os.RemoveAll(process.profileDir); err == nil {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
	})
}

func (process *oracleBrowserProcess) failureSuffix() string {
	output := strings.TrimSpace(process.stderr.String())
	if output == "" {
		return ""
	}
	const maxLogBytes = 4000
	if len(output) > maxLogBytes {
		output = output[len(output)-maxLogBytes:]
	}
	return "\nBrowser stderr:\n" + output
}
