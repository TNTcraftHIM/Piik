// Command piik-server is the Hosted Piik entry point: it loads the
// environment, serves the embedded Browser UI together with the signaling and
// room API, and stops on SIGINT or SIGTERM.
//
// Two maintenance modes exit without serving: --check-config validates the
// environment (the release wrapper runs it as the service user before cutover)
// and --check-release compares this binary with the latest published
// release (see release.go).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/diagnostics"
	"github.com/TNTcraftHIM/Piik/internal/server/app"
	"github.com/TNTcraftHIM/Piik/internal/server/config"
	"github.com/TNTcraftHIM/Piik/internal/server/webassets"
)

// shutdownTimeout bounds the ordered stop (signaling, listener, room store).
// systemd's tracked TimeoutStopSec is 20s, so the process must be gone first.
const shutdownTimeout = 15 * time.Second

// environmentFile is read from the working directory, which systemd pins to the
// release directory. Hosted keeps its real values in the service secret store.
const environmentFile = ".env"

// The packager injects the product version and full source revision together.
var (
	BuildVersion  = "development"
	BuildRevision = "development"
)

func main() {
	checkConfig := flag.Bool("check-config", false, "validate the environment and exit")
	checkRelease := flag.Bool("check-release", false,
		"report whether a newer published release exists and exit")
	apiURL := flag.String("api-url", defaultReleaseAPIURL,
		"release metadata endpoint used by --check-release")
	debug := flag.Bool("debug", false, "save opt-in server diagnostics to rotated files")
	flag.Parse()

	if err := loadEnvironmentFile(environmentFile); err != nil {
		fail(err)
	}
	switch {
	case *checkRelease:
		os.Exit(checkDeployedRelease(context.Background(), *apiURL, os.Stdout))
	case *checkConfig:
		if _, err := config.Load(environment()); err != nil {
			fail(err)
		}
		fmt.Println("config=ok")
	default:
		if err := serve(*debug); err != nil {
			fail(err)
		}
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

// serve runs the application until the first SIGINT or SIGTERM, then stops it
// with Close rather than End: durable room authority survives a restart.
func serve(debug bool) (returnedErr error) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{ReplaceAttr: diagnostics.ReplaceAttr}))
	var recorder *diagnostics.Recorder
	if debug || serverDebugEnabled(os.Getenv("PIIK_DEBUG")) {
		var err error
		recorder, err = diagnostics.Open(serverLogDirectory(), "server", BuildRevision)
		if err != nil {
			return fmt.Errorf("Piik server diagnostics are unavailable: %w", err)
		}
		logger = slog.New(slog.NewMultiHandler(logger.Handler(), recorder.Logger().Handler()))
		previous, previousWriter, previousFlags := slog.Default(), log.Writer(), log.Flags()
		slog.SetDefault(logger)
		dependencyLog := diagnostics.Writer("stdlib")
		log.SetOutput(dependencyLog)
		log.SetFlags(previousFlags)
		fmt.Fprintln(os.Stderr, "Piik diagnostic log:", recorder.LogPath())
		stopExport := watchDiagnosticExport(recorder)
		defer func() {
			stopExport()
			_ = dependencyLog.Close()
			returnedErr = errors.Join(returnedErr, exportServerDiagnostics(recorder), recorder.Close())
			slog.SetDefault(previous)
			log.SetOutput(previousWriter)
			log.SetFlags(previousFlags)
		}()
		logger.Info("piik-server", "event", "start", "version", BuildVersion, "revision", BuildRevision)
	}
	defer func() {
		logger.Info("piik-server", "event", "stopped", "failed", returnedErr != nil, diagnostics.Error(returnedErr))
	}()
	configuration, err := config.Load(environment())
	if err != nil {
		return err
	}
	if recorder != nil {
		recorder.Context("configuration", map[string]any{
			"environment": configuration.Env, "port": configuration.Port,
			"sqlite": configuration.RoomDatabasePath != "", "siteAccessProtected": configuration.SiteAccessPassword != "",
			"maxViewers": configuration.MaxViewersPerRoom, "endpointCapacity": configuration.EndpointMediaCopyCapacity,
			"sfu": configuration.SFU, "stunURLs": configuration.STUNURLs,
			"natPrediction": configuration.NATPredictionEnabled,
		})
	}
	server, err := app.New(app.Options{
		Config: configuration,
		Assets: webassets.FS(),
		Logger: logger,
	})
	if err != nil {
		return err
	}
	// Install ordered shutdown after startup; a stop during startup retains the
	// operating system's default signal handling.
	port, err := server.Listen(context.Background())
	if err != nil {
		return err
	}
	logger.Info("Piik server is listening", "event", "ready", "version", BuildVersion, "revision", BuildRevision,
		"host", configuration.ListenHost, "port", port, "publicUrl", config.Origin(configuration.PublicBaseURL),
		"sqlite", configuration.RoomDatabasePath != "", "siteAccessProtected", configuration.SiteAccessPassword != "",
		"sfu", configuration.SFU != nil, "natPrediction", configuration.NATPredictionEnabled)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	// One bounded background lookup never delays serving. Join it before closing
	// diagnostic outputs so shutdown cannot leave a late writer behind.
	releaseChecked := make(chan struct{})
	go func() {
		defer close(releaseChecked)
		result := checkRelease(ctx, BuildVersion, BuildRevision, defaultReleaseAPIURL, os.Getenv("GITHUB_TOKEN"), mirrorReleaseAPIURL)
		if ctx.Err() == nil {
			logReleaseNotice(logger, result)
		}
	}()
	defer func() {
		stop()
		<-releaseChecked
	}()
	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	return server.Close(shutdownCtx)
}

func serverDebugEnabled(value string) bool {
	for _, component := range strings.Split(value, ",") {
		switch strings.TrimSpace(component) {
		case "server", "route":
			return true
		}
	}
	return false
}

func serverLogDirectory() string {
	if directory := strings.TrimSpace(os.Getenv("PIIK_LOG_DIR")); directory != "" {
		return directory
	}
	if directories := filepath.SplitList(os.Getenv("LOGS_DIRECTORY")); len(directories) > 0 && directories[0] != "" {
		return directories[0]
	}
	return "logs"
}

func exportServerDiagnostics(recorder *diagnostics.Recorder) error {
	path, err := recorder.Export()
	if err != nil {
		fmt.Fprintln(os.Stderr, "Piik diagnostic export failed:", err)
		return err
	}
	fmt.Fprintln(os.Stderr, "Piik diagnostic bundle:", path)
	return nil
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

// loadEnvironmentFile reads optional startup overrides. An absent file is the
// ordinary case and every other read failure stops startup. A name the process
// already carries is never overwritten, so a
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
