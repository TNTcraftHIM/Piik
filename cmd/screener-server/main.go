// Command screener-server is the Hosted Screener entry point: it loads the
// environment, serves the embedded Browser UI together with the signaling and
// room API, and stops on SIGINT or SIGTERM. It replaces src/server/index.ts.
//
// Two maintenance modes exit without serving: --check-config validates the
// environment (the release wrapper runs it as the service user before cutover)
// and --check-release compares the deployed revision with the latest published
// release (see release.go).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/TNTcraftHIM/Screener/internal/server/app"
	"github.com/TNTcraftHIM/Screener/internal/server/config"
	"github.com/TNTcraftHIM/Screener/internal/server/webassets"
)

// shutdownTimeout bounds the ordered stop (signaling, listener, room store).
// systemd's tracked TimeoutStopSec is 20s, so the process must be gone first.
const shutdownTimeout = 15 * time.Second

// environmentFile is read from the working directory, which systemd pins to the
// release directory. Hosted keeps its real values in the service secret store.
const environmentFile = ".env"

// BuildRevision is the full Git revision the release packager links in with
// -ldflags. It matches the REVISION file shipped beside the binary and is
// reported at startup so one journal line identifies the running release.
var BuildRevision = "development"

func main() {
	checkConfig := flag.Bool("check-config", false, "validate the environment and exit")
	checkRelease := flag.Bool("check-release", false,
		"report whether a newer published release exists and exit")
	currentFile := flag.String("current-file", "",
		"path to the deployed REVISION file read by --check-release")
	apiURL := flag.String("api-url", defaultReleaseAPIURL,
		"release metadata endpoint used by --check-release")
	flag.Parse()

	if err := loadEnvironmentFile(environmentFile); err != nil {
		fail(err)
	}
	switch {
	case *checkRelease:
		os.Exit(checkDeployedRelease(context.Background(), *currentFile, *apiURL, os.Stdout))
	case *checkConfig:
		if _, err := config.Load(environment()); err != nil {
			fail(err)
		}
		fmt.Println("config=ok")
	default:
		if err := serve(); err != nil {
			fail(err)
		}
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

// serve runs the application until the first SIGINT or SIGTERM, then stops it
// with Close rather than End: Hosted rooms are leased in the database and must
// survive a restart (DECISIONS D6).
func serve() error {
	configuration, err := config.Load(environment())
	if err != nil {
		return err
	}
	server, err := app.New(app.Options{
		Config: configuration,
		Assets: webassets.FS(),
		Logger: slog.New(slog.NewTextHandler(os.Stderr, nil)),
	})
	if err != nil {
		return err
	}
	// Startup does not take the stop signal: index.ts registered its SIGINT and
	// SIGTERM handlers only after `await server.listen()` resolved, so a stop
	// during the LiveKit reconciliation ended the process by the signal's
	// default disposition. Cancelling startup instead would abort it and exit
	// non-zero, which systemd records as a failed unit. Each LiveKit call keeps
	// its own 5 s bound (D1).
	port, err := server.Listen(context.Background())
	if err != nil {
		return err
	}
	fmt.Printf("Screener %s is listening on %s:%d; public URL %s\n",
		BuildRevision, configuration.ListenHost, port, config.Origin(configuration.PublicBaseURL))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	return server.Close(shutdownCtx)
}

// environment is the process environment in the form config.Load expects.
func environment() map[string]string {
	values := make(map[string]string)
	for _, entry := range os.Environ() {
		if name, value, found := strings.Cut(entry, "="); found {
			values[name] = value
		}
	}
	return values
}

// loadEnvironmentFile ports the src/server/index.ts loadEnvFile() call: an
// absent file is the ordinary case and every other read failure stops startup.
// Like Node, a name the process already carries is never overwritten, so a
// systemd EnvironmentFile still wins over a stale file in the release
// directory. The accepted syntax is DECISIONS D8: KEY=value lines, whole-line
// '#' comments, an optional 'export ' prefix, and a single- or double-quoted
// value. Quoted values keep their content verbatim; nothing is expanded.
func loadEnvironmentFile(name string) error {
	content, err := os.ReadFile(name)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(content), "\n") {
		line = strings.TrimSpace(line)
		line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, assigned := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !assigned || key == "" {
			continue
		}
		if _, present := os.LookupEnv(key); present {
			continue
		}
		if err := os.Setenv(key, unquote(strings.TrimSpace(value))); err != nil {
			return err
		}
	}
	return nil
}

// unquote removes one matching pair of surrounding single or double quotes.
func unquote(value string) string {
	if len(value) < 2 || value[0] != value[len(value)-1] {
		return value
	}
	if value[0] != '"' && value[0] != '\'' {
		return value
	}
	return value[1 : len(value)-1]
}
