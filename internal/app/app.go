package app

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	appconfig "github.com/TNTcraftHIM/Piik/internal/app/config"
	"github.com/TNTcraftHIM/Piik/internal/app/failure"
	"github.com/TNTcraftHIM/Piik/internal/app/lan"
	"github.com/TNTcraftHIM/Piik/internal/app/launcher"
	"github.com/TNTcraftHIM/Piik/internal/app/loopback"
	"github.com/TNTcraftHIM/Piik/internal/app/mediaedge"
	"github.com/TNTcraftHIM/Piik/internal/app/nativeaudio"
	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/TNTcraftHIM/Piik/internal/app/nativecontrol"
	"github.com/TNTcraftHIM/Piik/internal/app/publictunnel"
	"github.com/TNTcraftHIM/Piik/internal/app/remoteinput"
	"github.com/TNTcraftHIM/Piik/internal/diagnostics"
	serverapp "github.com/TNTcraftHIM/Piik/internal/server/app"
	serverconfig "github.com/TNTcraftHIM/Piik/internal/server/config"
	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
	"github.com/TNTcraftHIM/Piik/internal/server/webassets"
	"github.com/TNTcraftHIM/Piik/internal/tlsconfig"
	"golang.org/x/mod/semver"
)

const (
	DefaultLocalPort       = 8787
	publicSTUNURL          = "stun:stun.cloudflare.com:3478"
	publicFallbackSTUNURLA = "stun:stun.miwifi.com:3478"
	publicFallbackSTUNURLB = "stun:stun.chat.bilibili.com:3478"
	// localShutdownTimeout bounds the ordered Local stop. The packaged smoke
	// allows 10 s between the stop request and the exit, so it stays well
	// inside that budget.
	localShutdownTimeout = 5 * time.Second
)

var BuildVersion = "development"
var BuildRevision = "development"

func buildVersion() string {
	version := strings.TrimSpace(BuildVersion)
	if version != "" && semver.Canonical(version) == version && semver.Prerelease(version) == "" {
		return version
	}
	return "development"
}

type Options struct {
	Site           string
	SiteSet        bool
	Local          bool
	Link           bool
	ConfigPath     string
	LANAddress     string
	Port           int
	DisableBrowser bool
	Debug          bool
	LogDir         string
	CaptureProcess string
	TunnelProcess  string
	Ready          func(string)
	console        *console
	logger         *slog.Logger
}

func Run(ctx context.Context, options Options) (returnedErr error) {
	ctx, cancel := context.WithCancel(ctx)
	options.Debug = options.Debug || debugEnabled(os.Getenv("PIIK_DEBUG"))
	options.console = newConsole(cancel, options.DisableBrowser)
	var recorder *diagnostics.Recorder
	var diagnosticsMu sync.Mutex
	var restoreLogger func()
	defer func() {
		cancel()
		diagnosticsMu.Lock()
		defer diagnosticsMu.Unlock()
		returnedErr = finishRun(options.console, recorder, restoreLogger, returnedErr)
	}()
	enableDiagnostics := func() error {
		if recorder != nil {
			return nil
		}
		var err error
		recorder, err = openDiagnostics(options.LogDir)
		if err != nil {
			return errors.Join(failure.Diagnostics, fmt.Errorf("Piik App diagnostics are unavailable: %w", err))
		}
		recorder.Context("build", map[string]any{"version": buildVersion(), "revision": BuildRevision})
		previous, previousWriter, previousFlags := slog.Default(), log.Writer(), log.Flags()
		var dependencyLog *diagnostics.LineWriter
		restoreLogger = func() {
			_ = dependencyLog.Close()
			slog.SetDefault(previous)
			log.SetOutput(previousWriter)
			log.SetFlags(previousFlags)
		}
		options.logger = recorder.Logger()
		slog.SetDefault(options.logger)
		dependencyLog = diagnostics.Writer("stdlib")
		log.SetOutput(dependencyLog)
		log.SetFlags(previousFlags)
		options.console.send(consoleDebug{logPath: recorder.LogPath(), export: recorder.Export})
		slog.Debug("piik-client", "event", "diagnostics-enabled")
		return nil
	}
	if options.Debug {
		if err := enableDiagnostics(); err != nil {
			return err
		}
	}
	slog.Debug("piik-client", "event", "start", "version", buildVersion(), "revision", BuildRevision)
	options.console.show(consoleView{state: "starting"})
	if err := validateMode(options); err != nil {
		return errors.Join(failure.Configuration, err)
	}
	if options.Port == 0 {
		options.Port = DefaultLocalPort
	}
	configPath := strings.TrimSpace(options.ConfigPath)
	if configPath == "" {
		var err error
		configPath, err = appconfig.DefaultPath()
		if err != nil {
			return errors.Join(failure.Configuration, fmt.Errorf("Piik App configuration is unavailable: %w", err))
		}
	}
	config, err := appconfig.LoadOrCreate(configPath)
	if err != nil {
		return errors.Join(failure.Configuration, fmt.Errorf("Piik App configuration is unavailable: %w", err))
	}
	config, err = applyMode(config, options)
	if err != nil {
		return errors.Join(failure.Configuration, err)
	}
	slog.Debug("piik-client", "event", "configuration", "siteConfigured", config.Site != "", "localAccessProtected", config.LocalAccessPassword != "")
	if options.SiteSet {
		if err = appconfig.Save(configPath, config); err != nil {
			return errors.Join(failure.Configuration, fmt.Errorf("Piik App configuration is unavailable: %w", err))
		}
	}
	nativeMedia := discoverNativeMedia(ctx, options.CaptureProcess)
	input, inputErr := remoteinput.New(ctx, nativeMedia.capture.RemoteInput)
	if inputErr != nil {
		slog.Warn("Remote control is unavailable", "reason", inputErr)
	}
	defer input.Close()
	nativeMedia.capabilities.RemoteInput = input != nil
	nativeMedia.capabilities.RemoteStopShortcut = input.SupportsStopShortcut()
	recordContext := func(selected Options, config appconfig.Config) {
		if recorder == nil {
			return
		}
		recorder.Context("configuration", map[string]any{"siteConfigured": config.Site != "", "local": selected.Local,
			"link": selected.Link, "port": selected.Port, "lanAddress": selected.LANAddress,
			"localAccessProtected": config.LocalAccessPassword != ""})
		recorder.Context("capture", nativeMedia.capture)
		recorder.Binary("captureExecutable", nativeMedia.captureProcess)
		slog.Debug("piik-client", "event", "native-capabilities",
			"video", nativeMedia.capabilities.Video, "processAudio", nativeMedia.capabilities.ProcessAudio,
			"systemAudio", nativeMedia.capabilities.SystemAudio, "hardwareH264", nativeMedia.capabilities.HardwareH264,
			"softwareVP8", nativeMedia.capabilities.SoftwareVP8, diagnostics.Error(nativeMedia.discoveryErr))
	}
	recordContext(options, config)
	qualityPreference, preferenceErr := appconfig.LoadQualityPreference(configPath)
	if preferenceErr != nil {
		slog.Debug("piik-client", "event", "quality-preference-load-failed", diagnostics.Error(preferenceErr))
	}
	control, err := loopback.Start(ctx, loopback.Options{
		AllowedOrigins:    allowedOrigins(config.ApprovedSites(), options.Port),
		NativeMedia:       nativeMedia.capabilities,
		NewControl:        nativeMedia.controlFactory(input),
		Presentation:      options.console.setLanguage,
		QualityPreference: qualityPreference,
	})
	if err != nil {
		return errors.Join(failure.NativeControl, fmt.Errorf("Piik App native control could not start: %w", err))
	}
	defer func() { returnedErr = errors.Join(returnedErr, control.Close()) }()
	slog.Debug("piik-client", "event", "control-ready")
	if options.console.machine {
		if err = printEndpoint(control.Endpoint()); err != nil {
			return err
		}
	}
	return runLauncher(ctx, options, configPath, config, control, input, func(selected *Options, config appconfig.Config) error {
		diagnosticsMu.Lock()
		defer diagnosticsMu.Unlock()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if selected.Debug {
			if err := enableDiagnostics(); err != nil {
				return err
			}
		}
		if recorder != nil {
			selected.Debug = true
			selected.logger = recorder.Logger()
		}
		recordContext(*selected, config)
		return nil
	})
}

func finishRun(console *console, recorder *diagnostics.Recorder, restoreLogger func(), err error) error {
	err = errors.Join(err, console.stop(err))
	exportPath := ""
	if recorder != nil {
		slog.Debug("piik-client", "event", "stopped", "failed", err != nil, diagnostics.Error(err))
		if console.program == nil || err != nil {
			path, exportErr := recorder.Export()
			console.send(consoleExportResult{path: path, err: exportErr})
			err = errors.Join(err, exportErr)
		}
		restoreLogger()
		err = errors.Join(err, recorder.Close())
		exportPath = recorder.LastExportPath()
	}
	console.finish(err, exportPath)
	return err
}

func explicitMode(options Options) bool {
	return options.SiteSet || options.Local || options.Link || options.DisableBrowser
}

func runLauncher(
	ctx context.Context,
	options Options,
	configPath string,
	config appconfig.Config,
	control *loopback.Server,
	input *remoteinput.Manager,
	configureDiagnostics func(*Options, appconfig.Config) error,
) (returnedErr error) {
	automatic := explicitMode(options)
	directRoom := automatic && (options.Local || options.Link || config.Site == "")
	initialOptions := options
	initialConfig := config
	mode, err := launcher.LoadMode(configPath)
	if err != nil {
		slog.Debug("Could not restore the last launcher mode", diagnostics.Error(err))
	}
	startupSite, err := launcher.LoadStartupSite(configPath, config.ApprovedSites()...)
	if err != nil {
		slog.Debug("Could not restore the startup Site", diagnostics.Error(err))
	}
	// Site approval and room startup mutate separate fields of one config.
	// Serialize persistence and publish only the complete successfully saved value.
	var configMu sync.Mutex
	launcherOrigin := ""
	updateConfig := func(change func(*appconfig.Config)) (appconfig.Config, error) {
		configMu.Lock()
		defer configMu.Unlock()
		next := config
		change(&next)
		if err := appconfig.Save(configPath, next); err != nil {
			return config, err
		}
		config = next
		err := control.SetAllowedOrigins(append(allowedOrigins(config.ApprovedSites(), initialOptions.Port), launcherOrigin))
		return config, err
	}
	launch, err := launcher.Start(
		ctx,
		webassets.FS(),
		launcher.Options{
			DefaultMode: mode,
			StartupSite: startupSite,
			SaveStartupSite: func(site string) error {
				return launcher.SaveStartupSite(configPath, site)
			},
			Sites: config.ApprovedSites(), Version: buildVersion(), Revision: BuildRevision,
			LocalAccessPassword: config.LocalAccessPassword,
			Debug:               options.Debug, LANAddress: options.LANAddress,
			ChangeSite: func(site string, allowed bool) ([]string, error) {
				current, err := updateConfig(func(next *appconfig.Config) {
					sites := next.ApprovedSites()
					if allowed {
						if !slices.Contains(sites, site) {
							sites = append(sites, site)
						}
					} else {
						sites = slices.DeleteFunc(sites, func(value string) bool { return value == site })
					}
					next.SetApprovedSites(sites)
				})
				return current.ApprovedSites(), err
			},
			EnableDebug: func() error {
				configMu.Lock()
				defer configMu.Unlock()
				selected := initialOptions
				selected.Debug = true
				return configureDiagnostics(&selected, config)
			},
		},
	)
	if err != nil {
		return errors.Join(failure.Launcher, err)
	}
	defer func() { returnedErr = errors.Join(returnedErr, launch.Close()) }()
	control.SetConnectURL(launch.URL())
	defer control.SetConnectURL("")
	// Launcher entry lives with the resident App, independently of room views.
	options.console.send(consoleLauncher(launch.URL()))
	defer options.console.send(consoleLauncher(""))
	launchAddress, err := url.Parse(launch.URL())
	if err != nil {
		return errors.Join(failure.Launcher, err)
	}
	configMu.Lock()
	launcherOrigin = launchAddress.Scheme + "://" + launchAddress.Host
	err = control.SetAllowedOrigins(append(allowedOrigins(config.ApprovedSites(), options.Port), launcherOrigin))
	configMu.Unlock()
	if err != nil {
		return errors.Join(failure.NativeControl, err)
	}
	if !automatic && startupSite == "" {
		options.console.show(consoleView{state: "setup", entry: launch.URL()})
		options.console.openBrowser(launch.URL())
	} else if initialConfig.Site != "" && !options.Local && !options.Link {
		// A starred Site changes only the opening page. --site also remains an
		// explicit approval shortcut; the launcher can start a Local room later.
		openSite(initialConfig.Site, options)
	}
	// An interactive room is a child of the resident App. Its failure must not
	// retire an unrelated Site's native sessions or its approval page. Explicit
	// CLI launches still return their outcome to the caller. Call only after the
	// room has retired, so neither approval nor process exit depends on its work.
	finishRoom := func(roomErr error) error {
		if directRoom || roomErr == nil || ctx.Err() != nil {
			return roomErr
		}
		launch.SetResult("", roomErr)
		options.console.show(consoleView{state: "setup", entry: launch.URL(), problem: roomErr})
		slog.Debug("piik-client", "event", "local-room-stopped", diagnostics.Error(roomErr))
		select {
		case <-ctx.Done():
		case err := <-control.Done():
			roomErr = errors.Join(roomErr, err)
		case err := <-launch.Done():
			roomErr = errors.Join(roomErr, err)
		}
		return roomErr
	}

	var selection launcher.Selection
	if directRoom {
		selection = launcher.Selection{Mode: launcher.ModeLocal, LocalAccessPassword: initialConfig.LocalAccessPassword}
		if options.Link {
			selection.Mode = launcher.ModeLink
		}
		launch.Begin()
	} else {
		select {
		case selection = <-launch.Selection():
		case <-ctx.Done():
			return nil
		case err = <-control.Done():
			return err
		case err = <-launch.Done():
			if err != nil {
				return errors.Join(failure.Launcher, fmt.Errorf("Piik App launcher stopped unexpectedly: %w", err))
			}
			return nil
		}
	}
	if selection.Language != "" {
		options.console.setLanguage(selection.Language)
	}
	if err := launcher.SaveMode(configPath, selection.Mode); err != nil {
		slog.Debug("Could not save the launcher mode", diagnostics.Error(err))
	}
	options.Local = selection.Mode == launcher.ModeLocal
	options.Link = selection.Mode == launcher.ModeLink
	options.Debug = options.Debug || selection.Debug
	if selection.LANAddress != nil {
		options.LANAddress = *selection.LANAddress
	}
	selectedConfig, err := updateConfig(func(next *appconfig.Config) {
		next.LocalAccessPassword = selection.LocalAccessPassword
	})
	if err != nil {
		err = errors.Join(failure.Configuration, fmt.Errorf("Piik App configuration could not be saved: %w", err))
		return finishRoom(err)
	}
	if err = configureDiagnostics(&options, selectedConfig); err != nil {
		return finishRoom(err)
	}
	if !directRoom {
		options.DisableBrowser = true
	}
	ready := make(chan string, 1)
	onReady := options.Ready
	options.Ready = func(target string) {
		if onReady != nil {
			onReady(target)
		}
		ready <- target
	}
	runtimeContext, cancelRuntime := context.WithCancel(ctx)
	runtimeDone := make(chan struct{})
	var runtimeErr error
	go func() {
		runtimeErr = runLocal(runtimeContext, options, selectedConfig, control)
		close(runtimeDone)
	}()
	var exitErr error
	select {
	case target := <-ready:
		launch.SetResult(target, nil)
		select {
		case <-runtimeDone:
		case exitErr = <-launch.Done():
		case <-ctx.Done():
		}
	case <-runtimeDone:
	case <-ctx.Done():
		launch.SetResult("", ctx.Err())
	}
	cancelRuntime()
	<-runtimeDone
	return finishRoom(errors.Join(exitErr, runtimeErr))
}

func applyMode(config appconfig.Config, options Options) (appconfig.Config, error) {
	if options.SiteSet && options.Local {
		return appconfig.Config{}, errors.New("choose either --site or --local")
	}
	if options.SiteSet {
		site, err := appconfig.NormalizeSite(options.Site)
		if err != nil || site == "" {
			return appconfig.Config{}, errors.New("Piik Site must be an HTTP or HTTPS origin")
		}
		sites, _ := appconfig.NormalizeSites(append([]string{site}, config.ApprovedSites()...))
		config.SetApprovedSites(sites)
	}
	return config, nil
}

func validateMode(options Options) error {
	if options.Link && (options.SiteSet || options.Local) {
		return errors.New("--link is a self-contained Local mode")
	}
	return nil
}

func debugEnabled(value string) bool {
	for _, component := range strings.Split(value, ",") {
		if strings.TrimSpace(component) == "client" {
			return true
		}
	}
	return false
}

func openDiagnostics(directory string) (*diagnostics.Recorder, error) {
	if directory = strings.TrimSpace(directory); directory == "" {
		directory = strings.TrimSpace(os.Getenv("PIIK_LOG_DIR"))
	}
	if directory != "" {
		return diagnostics.Open(directory, "client", BuildRevision)
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	recorder, err := diagnostics.Open(filepath.Join(filepath.Dir(executable), "logs"), "client", BuildRevision)
	if err == nil || !errors.Is(err, os.ErrPermission) && !errors.Is(err, syscall.EROFS) {
		return recorder, err
	}
	cache, cacheErr := os.UserCacheDir()
	if cacheErr != nil {
		return nil, errors.Join(err, cacheErr)
	}
	return diagnostics.Open(filepath.Join(cache, "Piik", "logs"), "client", BuildRevision)
}

func openSite(site string, options Options) {
	slog.Debug("piik-client", "event", "mode", "mode", "site")
	targetURL := launchURL(site)
	view := consoleView{mode: "site", state: "ready", entry: targetURL}
	options.console.show(view)
	if options.console.machine {
		fmt.Printf("Piik Site: %s\n", site)
	}
	if !options.DisableBrowser {
		options.console.openBrowser(targetURL)
	}
	if options.Ready != nil {
		options.Ready(targetURL)
	}
	slog.Debug("piik-client", "event", "site-ready")
}

func runLocal(ctx context.Context, options Options, config appconfig.Config,
	control *loopback.Server,
) (returnedErr error) {
	stunURLs, natPredictionStunURLs, err := localSTUNURLs(options.Link)
	if err != nil {
		return errors.Join(failure.Configuration, err)
	}
	view := consoleView{mode: "local", state: "starting", protected: config.LocalAccessPassword != ""}
	if options.Link {
		view.mode = "link"
	}
	slog.Debug("piik-client", "event", "mode", "mode", view.mode)
	options.console.show(view)
	bindAddress := net.IPv4zero
	if !options.Link {
		bindAddress = net.IPv4(127, 0, 0, 1)
	}
	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: bindAddress, Port: options.Port})
	if err != nil {
		return errors.Join(failure.LocalPort, fmt.Errorf("local server port is unavailable: %w", err))
	}
	listeners := []net.Listener{listener}
	defer func() {
		for _, owned := range listeners {
			_ = owned.Close()
		}
	}()
	addresses, lanErr := lan.Addresses()
	selectedAddress := ""
	if lanErr == nil {
		selectedAddress, lanErr = lan.Select(addresses, options.LANAddress)
	}
	// A public invitation only needs the tunnel origin; keep any resolved LAN
	// addresses as allowed local origins but never block link startup on LAN
	// selection (multi-interface hosts may not have one obvious address).
	if lanErr != nil && !options.Link {
		return errors.Join(failure.LocalNetwork, lanErr)
	}
	if !options.Link {
		configuration, err := tlsconfig.SelfSigned(selectedAddress)
		if err != nil {
			return errors.Join(failure.LocalServer, fmt.Errorf("local HTTPS certificate could not be created: %w", err))
		}
		secureListener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.ParseIP(selectedAddress), Port: options.Port})
		if err != nil {
			return errors.Join(failure.LocalPort, fmt.Errorf("local HTTPS port is unavailable: %w", err))
		}
		listeners = append(listeners, tls.NewListener(secureListener, configuration))
		view.certificate = tlsconfig.Fingerprint(configuration)
	}
	var tunnel *publictunnel.Process
	publicOrigin := ""
	if options.Link {
		tunnel, err = publictunnel.Start(
			ctx,
			tunnelExecutable(options.TunnelProcess),
			fmt.Sprintf("http://127.0.0.1:%d", options.Port),
		)
		if err != nil {
			// Only the caller's clean cancellation is a normal stopped outcome.
			// A startup or retirement failure racing cancellation remains an error.
			if err == context.Canceled && ctx.Err() == context.Canceled {
				return nil
			}
			return err
		}
		defer func() { returnedErr = errors.Join(returnedErr, tunnel.Close()) }()
		publicOrigin = tunnel.Origin()
		slog.Debug("piik-client", "event", "public-link-ready")
	}

	localConfig, err := serverconfig.Local(serverconfig.LocalOptions{
		Port:                  options.Port,
		PublicAddress:         selectedAddress,
		PublicOrigin:          publicOrigin,
		AllowedAddresses:      addresses,
		SiteAccessPassword:    config.LocalAccessPassword,
		STUNURLs:              stunURLs,
		NATPredictionSTUNURLs: natPredictionStunURLs,
	})
	if err != nil {
		return errors.Join(failure.Configuration, err)
	}
	logger := options.logger
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(options.console.logWriter(), nil))
	}
	localServer, err := serverapp.New(serverapp.Options{
		Config:    localConfig,
		Listeners: listeners,
		Assets:    webassets.FS(),
		Logger:    logger,
	})
	if err != nil {
		return errors.Join(failure.LocalServer, err)
	}
	listeners = nil // Ownership is now in the application's startup/shutdown path.
	defer func() { returnedErr = errors.Join(returnedErr, endLocalServer(localServer)) }()
	if _, err = localServer.Listen(ctx); err != nil {
		var socketError *net.OpError
		if errors.As(err, &socketError) && socketError.Op == "listen" {
			return errors.Join(failure.LocalPort, err)
		}
		return errors.Join(failure.LocalServer, err)
	}
	slog.Debug("piik-client", "event", "local-server-ready", "port", options.Port, "publicLink", publicOrigin != "")

	// The readiness lines follow the listener, which the packaged smoke and the
	// public-link gate both read from stdout before they probe the port.
	if options.console.machine {
		if config.LocalAccessPassword == "" {
			fmt.Println("Local access: open")
		} else {
			fmt.Printf("Local access password: %s\n", config.LocalAccessPassword)
		}
		if publicOrigin != "" {
			fmt.Printf("Public invitation origin: %s\n", publicOrigin)
		} else {
			fmt.Printf("LAN invitation origin: %s\n", serverconfig.Origin(localConfig.PublicBaseURL))
			fmt.Printf("LAN certificate SHA-256: %s\n", view.certificate)
		}
	}
	launchURL := launchURLWithLocalAccess(
		fmt.Sprintf("http://127.0.0.1:%d/", options.Port),
		config.LocalAccessPassword,
	)
	view.state, view.entry, view.invite = "ready", launchURL, publicOrigin
	if view.invite == "" {
		view.invite = serverconfig.Origin(localConfig.PublicBaseURL)
	}
	options.console.show(view)
	if !options.DisableBrowser {
		options.console.openBrowser(launchURL)
	}
	if options.Ready != nil {
		options.Ready(launchURL)
	}
	var tunnelDone <-chan struct{}
	if tunnel != nil {
		tunnelDone = tunnel.Done()
	}

	select {
	case <-ctx.Done():
		return nil
	case err = <-control.Done():
		if err != nil {
			return errors.Join(failure.NativeControl, fmt.Errorf("Piik App native control stopped unexpectedly: %w", err))
		}
		return nil
	case <-tunnelDone:
		if ctx.Err() != nil {
			return nil
		}
		return errors.Join(failure.TunnelStopped, errors.New("public invitation link stopped; reopen Piik to create a new link"))
	}
}

func launchURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	fragment, err := url.ParseQuery(parsed.EscapedFragment())
	if err != nil {
		return raw
	}
	fragment.Set("piik-client", "1")
	parsed.Fragment, parsed.RawFragment = "", ""
	return parsed.String() + "#" + fragment.Encode()
}

func launchURLWithLocalAccess(raw, password string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	fragment, err := url.ParseQuery(parsed.EscapedFragment())
	if err != nil {
		return launchURL(raw)
	}
	fragment.Del("client-access")
	if password != "" {
		fragment.Set("client-access", password)
	}
	fragment.Set("piik-client", "1")
	parsed.Fragment, parsed.RawFragment = "", ""
	return parsed.String() + "#" + fragment.Encode()
}

type nativeRuntime struct {
	capabilities   loopback.NativeMediaCapabilities
	capture        nativecapture.Capabilities
	captureProcess string
	discoveryErr   error
}

func (runtime nativeRuntime) controlFactory(input *remoteinput.Manager) func() loopback.ControlSession {
	return func() loopback.ControlSession {
		return nativecontrol.New(runtime.captureProcess, runtime.capture, true, input)
	}
}

func allowedOrigins(sites []string, localPort int) []string {
	origins := []string{
		fmt.Sprintf("http://localhost:%d", localPort),
		fmt.Sprintf("http://127.0.0.1:%d", localPort),
	}
	return append(origins, sites...)
}

func discoverNativeMedia(ctx context.Context, configuredPath string) nativeRuntime {
	path := strings.TrimSpace(configuredPath)
	if path == "" {
		path = nativecapture.PackagedExecutable()
	}
	capabilities, err := nativecapture.Discover(ctx, path)
	if err != nil {
		return nativeRuntime{captureProcess: path, discoveryErr: err,
			capabilities: loopback.NativeMediaCapabilities{ReceiverReuse: true, MaxRelayChildren: mediaedge.MaxRelayChildren}}
	}
	summary := capabilities.Summary()
	return nativeRuntime{
		captureProcess: path,
		capture:        capabilities,
		capabilities: loopback.NativeMediaCapabilities{
			MaxVideoResolution: protocol.QualityResolution{
				Width: nativecapture.MaxVideoDimension, Height: nativecapture.MaxVideoDimension,
			},
			MaxVideoPixels:               nativecapture.MaxVideoPixels,
			MaxVideoMacroblocksPerSecond: nativecapture.MaxVideoMacroblocksPerSecond,
			MaxVideoFramerate:            nativecapture.MaxVideoFramerate,
			MaxVideoBitrate:              nativecapture.MaxVideoBitrate,
			MaxAudioBitrate:              nativeaudio.MaxSendBitrate,
			ReceiverReuse:                true,
			MaxRelayChildren:             mediaedge.MaxRelayChildren,
			Video:                        summary.Video,
			CaptureBorderControl:         summary.CaptureBorderControl,
			Microphone:                   summary.Microphone,
			ShareVolume:                  true,
			ProcessAudio:                 summary.ProcessAudio,
			ProcessAudioExclusion:        summary.ProcessAudioExclusion,
			SystemAudio:                  summary.SystemAudio,
			HardwareH264:                 summary.HardwareH264,
			SoftwareVP8:                  summary.SoftwareVP8,
		},
	}
}

// localSTUNURLs supplies public-link discovery. Pure LAN discovery is composed
// by serverconfig.Local on the selected interface. Only --link configures public
// STUN and the bounded NAT prediction survey. Native edges use that authority;
// serverconfig.Local deliberately does not inherit Hosted environment settings.
// An explicit App override replaces every public destination, including the
// survey pair. With fewer than three servers only ordinary ICE is available.
func localSTUNURLs(link bool) (stunURLs []string, natPredictionSTUNURLs []string, err error) {
	if !link {
		return nil, nil, nil
	}
	stunURLs, err = serverconfig.ParseSTUNURLs(os.Getenv("PIIK_STUN_URLS"), "PIIK_STUN_URLS")
	if err != nil {
		return nil, nil, err
	}
	if len(stunURLs) == 0 {
		stunURLs = []string{publicSTUNURL, publicFallbackSTUNURLA, publicFallbackSTUNURLB}
	}
	if len(stunURLs) >= 3 {
		if len(stunURLs) > protocol.MaxIceServerURLs-protocol.MaxNatPredictionAuxiliaryStunURLs {
			return nil, nil, errors.New("PIIK_STUN_URLS must contain at most 6 URLs")
		}
		natPredictionSTUNURLs = stunURLs[1:3]
	}
	return stunURLs, natPredictionSTUNURLs, nil
}

// endLocalServer is step 1 of the ADR-0010 item 12 unwind: every room ends,
// signaling closes, the listener drains and the room store closes, all before
// the tunnel and the loopback server go away. serverapp.End is memoised, so the
// deferred call after an explicit stop is a no-op. A serve loop or a drain that
// was already stopping reports http.ErrServerClosed or context.Canceled;
// neither is an App failure, and Run turns any error into exit status 1,
// which is exactly what the packaged smoke fails on.
func endLocalServer(server *serverapp.Server) error {
	ctx, cancel := context.WithTimeout(context.Background(), localShutdownTimeout)
	defer cancel()
	err := server.End(ctx)
	if errors.Is(err, http.ErrServerClosed) || errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

func tunnelExecutable(configured string) string {
	if path := strings.TrimSpace(configured); path != "" {
		return filepath.Clean(path)
	}
	return publictunnel.PackagedExecutable()
}

func printEndpoint(endpoint loopback.Endpoint) error {
	payload, err := json.Marshal(endpoint)
	if err != nil {
		return errors.New("Piik App endpoint is unavailable")
	}
	fmt.Println(string(payload))
	return nil
}
