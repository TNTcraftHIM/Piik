package clientapp

import (
	"context"
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
	"strings"
	"syscall"
	"time"

	"github.com/TNTcraftHIM/Screener/internal/client/browser"
	"github.com/TNTcraftHIM/Screener/internal/client/clientconfig"
	"github.com/TNTcraftHIM/Screener/internal/client/lan"
	"github.com/TNTcraftHIM/Screener/internal/client/launcher"
	"github.com/TNTcraftHIM/Screener/internal/client/loopback"
	"github.com/TNTcraftHIM/Screener/internal/client/nativecapture"
	"github.com/TNTcraftHIM/Screener/internal/client/nativecontrol"
	"github.com/TNTcraftHIM/Screener/internal/client/publictunnel"
	"github.com/TNTcraftHIM/Screener/internal/diagnostics"
	serverapp "github.com/TNTcraftHIM/Screener/internal/server/app"
	serverconfig "github.com/TNTcraftHIM/Screener/internal/server/config"
	"github.com/TNTcraftHIM/Screener/internal/server/webassets"
)

const (
	DefaultLocalPort            = 8787
	publicSTUNURL               = "stun:stun.cloudflare.com:3478"
	publicNATPredictionSTUNURLA = "stun:stun.miwifi.com:3478"
	publicNATPredictionSTUNURLB = "stun:stun.chat.bilibili.com:3478"
	// localShutdownTimeout bounds the ordered Local stop. The packaged smoke
	// allows 10 s between the stop request and the exit, so it stays well
	// inside that budget.
	localShutdownTimeout = 5 * time.Second
)

var BuildRevision = "development"

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
	console        *clientConsole
	logger         *slog.Logger
}

func Run(ctx context.Context, options Options) (returnedErr error) {
	ctx, cancel := context.WithCancel(ctx)
	options.Debug = options.Debug || clientDebugEnabled(os.Getenv("SCREENER_DEBUG"))
	options.console = newClientConsole(cancel, options.DisableBrowser)
	var recorder *diagnostics.Recorder
	var restoreLogger func()
	defer func() {
		cancel()
		if recorder != nil {
			slog.Debug("screener-client", "event", "stopped", "failed", returnedErr != nil, diagnostics.Error(returnedErr))
			if options.console.program == nil {
				path, err := recorder.Export()
				options.console.send(consoleExportResult{path: path, err: err})
				returnedErr = errors.Join(returnedErr, err)
			}
			restoreLogger()
			returnedErr = errors.Join(returnedErr, recorder.Close())
		}
		returnedErr = errors.Join(returnedErr, options.console.finish(returnedErr))
	}()
	if options.Debug {
		var err error
		recorder, err = openClientDiagnostics(options.LogDir)
		if err != nil {
			return fmt.Errorf("Screener Client diagnostics are unavailable: %w", err)
		}
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
	}
	slog.Debug("screener-client", "event", "start", "revision", BuildRevision)
	options.console.show(consoleView{state: "starting"})
	if err := validateMode(options); err != nil {
		return err
	}
	if options.Port == 0 {
		options.Port = DefaultLocalPort
	}
	configPath := strings.TrimSpace(options.ConfigPath)
	if configPath == "" {
		var err error
		configPath, err = clientconfig.DefaultPath()
		if err != nil {
			return errors.New("Screener Client configuration is unavailable")
		}
	}
	config, err := clientconfig.LoadOrCreate(configPath)
	if err != nil {
		return errors.New("Screener Client configuration is unavailable")
	}
	config, err = applyMode(config, options)
	if err != nil {
		return err
	}
	slog.Debug("screener-client", "event", "configuration", "siteConfigured", config.Site != "", "localAccessProtected", config.LocalAccessPassword != "")
	if options.SiteSet || options.Local {
		if err = clientconfig.Save(configPath, config); err != nil {
			return errors.New("Screener Client configuration is unavailable")
		}
	}
	nativeMedia := discoverNativeMedia(ctx, options.CaptureProcess)
	if recorder != nil {
		recorder.Context("configuration", map[string]any{"siteConfigured": config.Site != "", "local": options.Local,
			"link": options.Link, "port": options.Port, "localAccessProtected": config.LocalAccessPassword != ""})
		recorder.Context("capture", nativeMedia.capture)
		recorder.Binary("captureExecutable", nativeMedia.captureProcess)
	}
	slog.Debug("screener-client", "event", "native-capabilities",
		"video", nativeMedia.capabilities.Video, "processAudio", nativeMedia.capabilities.ProcessAudio,
		"systemAudio", nativeMedia.capabilities.SystemAudio, "hardwareH264", nativeMedia.capabilities.HardwareH264,
		"softwareVP8", nativeMedia.capabilities.SoftwareVP8)
	client, err := loopback.Start(ctx, loopback.Options{
		AllowedOrigins: clientOrigins(config.Site, options.Port),
		NativeMedia:    nativeMedia.capabilities,
		NewControl:     nativeMedia.controlFactory(),
		Presentation:   options.console.setLanguage,
	})
	if err != nil {
		return errors.New("Screener Client could not start")
	}
	defer client.Close()
	slog.Debug("screener-client", "event", "control-ready")
	if options.console.machine {
		if err = printEndpoint(client.Endpoint()); err != nil {
			return err
		}
	}
	if !explicitMode(options) {
		return runLauncher(ctx, options, configPath, config, client)
	}
	return runConfigured(ctx, options, config, client)
}

func explicitMode(options Options) bool {
	return options.SiteSet || options.Local || options.Link || options.DisableBrowser
}

func runConfigured(
	ctx context.Context,
	options Options,
	config clientconfig.Config,
	client *loopback.Server,
) error {
	if config.Site != "" && !options.Local && !options.Link {
		return runSite(config.Site, options, client)
	}
	return runLocal(ctx, options, config, client)
}

func runLauncher(
	ctx context.Context,
	options Options,
	configPath string,
	config clientconfig.Config,
	client *loopback.Server,
) error {
	launch, err := launcher.Start(
		ctx,
		webassets.FS(),
		config.Site,
		BuildRevision,
		config.LocalAccessPassword,
	)
	if err != nil {
		return err
	}
	defer launch.Close()
	launchAddress, err := url.Parse(launch.URL())
	if err != nil {
		return err
	}
	client.SetAllowedOrigins(append(
		clientOrigins(config.Site, options.Port),
		launchAddress.Scheme+"://"+launchAddress.Host,
	))
	options.console.show(consoleView{state: "setup", entry: launch.URL()})
	if err = browser.Open(launch.URL()); err != nil {
		return errors.New("Screener Client could not open its launcher")
	}

	var selection launcher.Selection
	select {
	case selection = <-launch.Selection():
	case <-ctx.Done():
		return nil
	case err = <-launch.Done():
		if err != nil {
			return errors.New("Screener Client launcher stopped unexpectedly")
		}
		return nil
	}
	options.console.setLanguage(selection.Language)
	if selection.Mode == launcher.ModeSite {
		config.Site = selection.Site
	} else {
		config.LocalAccessPassword = selection.LocalAccessPassword
	}
	if err = clientconfig.Save(configPath, config); err != nil {
		launch.SetResult("", err)
		<-launch.Handled()
		return errors.New("Screener Client configuration is unavailable")
	}
	client.SetAllowedOrigins(clientOrigins(config.Site, options.Port))
	options.SiteSet = false
	options.Local = selection.Mode == launcher.ModeLocal
	options.Link = selection.Mode == launcher.ModeLink
	options.DisableBrowser = true
	ready := make(chan string, 1)
	options.Ready = func(target string) { ready <- target }
	runtimeContext, cancelRuntime := context.WithCancel(ctx)
	runtimeDone := make(chan struct{})
	var runtimeErr error
	go func() {
		runtimeErr = runConfigured(runtimeContext, options, config, client)
		close(runtimeDone)
	}()
	defer func() {
		cancelRuntime()
		<-runtimeDone
	}()

	select {
	case target := <-ready:
		launch.SetResult(target, nil)
	case <-runtimeDone:
		launch.SetResult("", runtimeErr)
		<-launch.Handled()
		return runtimeErr
	case <-ctx.Done():
		launch.SetResult("", ctx.Err())
		return nil
	}

	select {
	case <-launch.Handled():
		_ = launch.Close()
	case <-runtimeDone:
		return runtimeErr
	case <-ctx.Done():
		return nil
	}
	select {
	case <-runtimeDone:
		return runtimeErr
	case <-ctx.Done():
		return nil
	}
}

func applyMode(config clientconfig.Config, options Options) (clientconfig.Config, error) {
	if options.SiteSet && options.Local {
		return clientconfig.Config{}, errors.New("choose either --site or --local")
	}
	if options.SiteSet {
		var err error
		config.Site, err = clientconfig.NormalizeSite(options.Site)
		if err != nil || config.Site == "" {
			return clientconfig.Config{}, errors.New("Screener Site must be an HTTP or HTTPS origin")
		}
	} else if options.Local {
		config.Site = ""
	}
	return config, nil
}

func validateMode(options Options) error {
	if options.Link && (options.SiteSet || options.Local) {
		return errors.New("--link is a self-contained Local mode")
	}
	return nil
}

func clientDebugEnabled(value string) bool {
	for _, component := range strings.Split(value, ",") {
		if strings.TrimSpace(component) == "client" {
			return true
		}
	}
	return false
}

func openClientDiagnostics(directory string) (*diagnostics.Recorder, error) {
	if directory = strings.TrimSpace(directory); directory == "" {
		directory = strings.TrimSpace(os.Getenv("SCREENER_LOG_DIR"))
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
	return diagnostics.Open(filepath.Join(cache, "Screener", "logs"), "client", BuildRevision)
}

// runSite opens the configured Screener Site in the Browser and waits for the
// loopback server, which is the only thing this mode owns. It takes no context:
// cancellation reaches it through client.Done().
func runSite(site string, options Options, client *loopback.Server) error {
	var err error
	slog.Debug("screener-client", "event", "mode", "mode", "site")
	launchURL := clientLaunchURL(site)
	view := consoleView{mode: "site", state: "starting", entry: launchURL}
	options.console.show(view)
	if options.console.machine {
		fmt.Printf("Screener Site: %s\n", site)
	}
	if !options.DisableBrowser {
		if err = browser.Open(launchURL); err != nil {
			return errors.New("Screener Client could not open the Site")
		}
	} else if options.Ready != nil {
		options.Ready(launchURL)
	}
	view.state = "ready"
	slog.Debug("screener-client", "event", "site-ready")
	options.console.show(view)
	if err = <-client.Done(); err != nil {
		return errors.New("Screener Client stopped unexpectedly")
	}
	return nil
}

func runLocal(ctx context.Context, options Options, config clientconfig.Config,
	client *loopback.Server,
) error {
	view := consoleView{mode: "local", state: "starting", protected: config.LocalAccessPassword != ""}
	if options.Link {
		view.mode = "link"
	}
	slog.Debug("screener-client", "event", "mode", "mode", view.mode)
	options.console.show(view)
	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4zero, Port: options.Port})
	if err != nil {
		return fmt.Errorf("local server port is unavailable: %w", err)
	}
	defer func() {
		if listener != nil {
			_ = listener.Close()
		}
	}()
	addresses, err := lan.Addresses()
	if err != nil {
		return err
	}
	selectedAddress, err := lan.Select(addresses, options.LANAddress)
	if err != nil {
		return err
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
			return err
		}
		defer tunnel.Close()
		publicOrigin = tunnel.Origin()
		slog.Debug("screener-client", "event", "public-link-ready")
	}

	stunURLs, natPredictionStunURLs := localSTUNURLs(options.Link)
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
		return err
	}
	logger := options.logger
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(options.console.logWriter(), nil))
	}
	localServer, err := serverapp.New(serverapp.Options{
		Config:   localConfig,
		Listener: listener,
		Assets:   webassets.FS(),
		Logger:   logger,
	})
	if err != nil {
		return err
	}
	listener = nil // Ownership is now in the application's startup/shutdown path.
	defer func() { _ = endLocalServer(localServer) }()
	if _, err = localServer.Listen(ctx); err != nil {
		return err
	}
	slog.Debug("screener-client", "event", "local-server-ready", "port", options.Port, "publicLink", publicOrigin != "")

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
			fmt.Printf("LAN invitation origin: http://%s:%d\n", selectedAddress, options.Port)
		}
	}
	launchURL := clientLaunchURLWithLocalAccess(
		fmt.Sprintf("http://127.0.0.1:%d/", options.Port),
		config.LocalAccessPassword,
	)
	if !options.DisableBrowser {
		if err = browser.Open(launchURL); err != nil {
			return errors.New("Screener Client could not open the Local page")
		}
	} else if options.Ready != nil {
		options.Ready(launchURL)
	}
	view.state, view.entry, view.invite = "ready", launchURL, publicOrigin
	if view.invite == "" {
		view.invite = fmt.Sprintf("http://%s:%d", selectedAddress, options.Port)
	}
	options.console.show(view)
	var tunnelDone <-chan struct{}
	if tunnel != nil {
		tunnelDone = tunnel.Done()
	}

	select {
	case <-ctx.Done():
		return endLocalServer(localServer)
	case err = <-client.Done():
		if err != nil {
			return errors.New("Screener Client runtime stopped unexpectedly")
		}
		return nil
	case <-tunnelDone:
		return errors.New("public invitation link stopped unexpectedly")
	}
}

func clientLaunchURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	fragment, err := url.ParseQuery(parsed.Fragment)
	if err != nil {
		return raw
	}
	fragment.Set("screener-client", "1")
	parsed.Fragment = fragment.Encode()
	return parsed.String()
}

func clientLaunchURLWithLocalAccess(raw, password string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	fragment, err := url.ParseQuery(parsed.Fragment)
	if err != nil {
		return clientLaunchURL(raw)
	}
	fragment.Del("client-access")
	if password != "" {
		fragment.Set("client-access", password)
	}
	fragment.Set("screener-client", "1")
	parsed.Fragment = fragment.Encode()
	return parsed.String()
}

type nativeRuntime struct {
	capabilities   loopback.NativeMediaCapabilities
	capture        nativecapture.Capabilities
	captureProcess string
}

func (runtime nativeRuntime) controlFactory() func() loopback.ControlSession {
	return func() loopback.ControlSession {
		return nativecontrol.New(runtime.captureProcess, runtime.capture, true)
	}
}

func clientOrigins(site string, localPort int) []string {
	origins := []string{
		fmt.Sprintf("http://localhost:%d", localPort),
		fmt.Sprintf("http://127.0.0.1:%d", localPort),
	}
	if site = strings.TrimSpace(site); site != "" {
		origins = append(origins, site)
	}
	return origins
}

func discoverNativeMedia(ctx context.Context, configuredPath string) nativeRuntime {
	path := strings.TrimSpace(configuredPath)
	if path == "" {
		path = nativecapture.PackagedExecutable()
	}
	capabilities, err := nativecapture.Discover(ctx, path)
	if err != nil {
		return nativeRuntime{}
	}
	summary := capabilities.Summary()
	return nativeRuntime{
		captureProcess: path,
		capture:        capabilities,
		capabilities: loopback.NativeMediaCapabilities{
			Video:        summary.Video,
			ProcessAudio: summary.ProcessAudio,
			SystemAudio:  summary.SystemAudio,
			HardwareH264: summary.HardwareH264,
			SoftwareVP8:  summary.SoftwareVP8,
		},
	}
}

// localSTUNURLs is the Local room authority's ICE configuration. Only --link
// has a public path, so only --link configures public STUN and the bounded NAT
// prediction survey. The lists are literals on purpose: a gate that sets
// STUN_URLS is configuring the Client's own Pion edge, and that value must not
// reach the room server (which is why serverconfig.Local reads no environment).
func localSTUNURLs(link bool) (stunURLs []string, natPredictionSTUNURLs []string) {
	if !link {
		return nil, nil
	}
	return []string{publicSTUNURL},
		[]string{publicNATPredictionSTUNURLA, publicNATPredictionSTUNURLB}
}

// endLocalServer is step 1 of the ADR-0010 item 12 unwind: every room ends,
// signaling closes, the listener drains and the room store closes, all before
// the tunnel and the loopback server go away. serverapp.End is memoised, so the
// deferred call after an explicit stop is a no-op. A serve loop or a drain that
// was already stopping reports http.ErrServerClosed or context.Canceled;
// neither is a Client failure, and Run turns any error into exit status 1,
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
		return errors.New("Screener Client endpoint is unavailable")
	}
	fmt.Println(string(payload))
	return nil
}
