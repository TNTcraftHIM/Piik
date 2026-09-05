package clientapp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/TNTcraftHIM/Screener/native/client/internal/browser"
	"github.com/TNTcraftHIM/Screener/native/client/internal/clientconfig"
	"github.com/TNTcraftHIM/Screener/native/client/internal/lan"
	"github.com/TNTcraftHIM/Screener/native/client/internal/launcher"
	"github.com/TNTcraftHIM/Screener/native/client/internal/loopback"
	"github.com/TNTcraftHIM/Screener/native/client/internal/nativecapture"
	"github.com/TNTcraftHIM/Screener/native/client/internal/nativecontrol"
	"github.com/TNTcraftHIM/Screener/native/client/internal/publictunnel"
	"github.com/TNTcraftHIM/Screener/native/client/internal/supervisor"
)

const (
	DefaultLocalPort            = 8787
	publicSTUNURL               = "stun:stun.cloudflare.com:3478"
	publicNATPredictionSTUNURLA = "stun:stun.miwifi.com:3478"
	publicNATPredictionSTUNURLB = "stun:stun.chat.bilibili.com:3478"
)

var BuildRevision = "development"

type Options struct {
	Site           string
	SiteSet        bool
	Local          bool
	Link           bool
	NodePath       string
	AppDirectory   string
	ConfigPath     string
	LANAddress     string
	Port           int
	DisableBrowser bool
	CaptureProcess string
	TunnelProcess  string
	Ready          func(string)
	console        *clientConsole
}

func Run(ctx context.Context, options Options) (returnedErr error) {
	ctx, cancel := context.WithCancel(ctx)
	options.console = newClientConsole(cancel, options.DisableBrowser)
	defer func() {
		cancel()
		returnedErr = errors.Join(returnedErr, options.console.finish(returnedErr))
	}()
	options.console.show(consoleView{state: "starting"})
	if err := validateMode(options); err != nil {
		return err
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
	if options.SiteSet || options.Local {
		if err = clientconfig.Save(configPath, config); err != nil {
			return errors.New("Screener Client configuration is unavailable")
		}
	}
	nativeMedia := discoverNativeMedia(ctx, options.CaptureProcess)
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
		return runSite(ctx, config.Site, options, client)
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
	_, appDirectory, err := packagePaths(options.NodePath, options.AppDirectory)
	if err != nil {
		return err
	}
	launch, err := launcher.Start(
		ctx,
		filepath.Join(appDirectory, "dist", "client"),
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

func runSite(ctx context.Context, site string, options Options,
	client *loopback.Server,
) error {
	var err error
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
	options.console.show(view)
	addresses, err := lan.Addresses()
	if err != nil {
		return err
	}
	selectedAddress, err := lan.Select(addresses, options.LANAddress)
	if err != nil {
		return err
	}
	nodePath, appDirectory, err := packagePaths(options.NodePath, options.AppDirectory)
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
	}

	entry := filepath.Join(appDirectory, "dist", "server", "server", "local-index.js")
	stunURLs := []string(nil)
	natPredictionStunURLs := []string(nil)
	if options.Link {
		stunURLs = []string{publicSTUNURL}
		natPredictionStunURLs = []string{
			publicNATPredictionSTUNURLA,
			publicNATPredictionSTUNURLB,
		}
	}
	var stdout, stderr io.Writer = os.Stdout, os.Stderr
	if !options.console.machine {
		stdout, stderr = io.Discard, options.console.logWriter()
	}
	localServer, err := supervisor.Start(ctx, supervisor.Command{
		Path:      nodePath,
		Args:      []string{entry},
		Directory: appDirectory,
		Environment: localEnvironment(
			options.Port,
			selectedAddress,
			addresses,
			config.LocalAccessPassword,
			stunURLs,
			natPredictionStunURLs,
			publicOrigin,
		),
		Stdout:    stdout,
		Stderr:    stderr,
		HealthURL: fmt.Sprintf("http://127.0.0.1:%d/healthz", options.Port),
	})
	if err != nil {
		return err
	}
	defer localServer.Close()

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
		fmt.Sprintf("http://localhost:%d/", options.Port),
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
		return localServer.Close()
	case <-localServer.Done():
		if err = localServer.Err(); err != nil {
			return errors.New("Screener Client local server stopped unexpectedly")
		}
		return nil
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

func packagePaths(nodePath, appDirectory string) (string, string, error) {
	root := ""
	if strings.TrimSpace(nodePath) == "" || strings.TrimSpace(appDirectory) == "" {
		executable, err := os.Executable()
		if err != nil {
			return "", "", errors.New("Screener Client package location is unavailable")
		}
		root = filepath.Dir(executable)
	}
	if strings.TrimSpace(nodePath) == "" {
		nodeName := "node"
		if runtime.GOOS == "windows" {
			nodeName += ".exe"
		}
		nodePath = filepath.Join(root, "runtime", "node", nodeName)
	}
	if strings.TrimSpace(appDirectory) == "" {
		appDirectory = filepath.Join(root, "app")
	}
	nodePath = filepath.Clean(nodePath)
	appDirectory = filepath.Clean(appDirectory)
	if _, err := os.Stat(nodePath); err != nil {
		return "", "", errors.New("bundled Node runtime is unavailable")
	}
	if _, err := os.Stat(filepath.Join(appDirectory, "dist", "server", "server", "local-index.js")); err != nil {
		return "", "", errors.New("bundled Screener application is unavailable")
	}
	if BuildRevision != "development" {
		revision, err := os.ReadFile(filepath.Join(appDirectory, "REVISION"))
		if err != nil || strings.TrimSpace(string(revision)) != BuildRevision {
			return "", "", errors.New("Client and application revisions do not match")
		}
	}
	return nodePath, appDirectory, nil
}

func tunnelExecutable(configured string) string {
	if path := strings.TrimSpace(configured); path != "" {
		return filepath.Clean(path)
	}
	return publictunnel.PackagedExecutable()
}

func localEnvironment(
	port int,
	publicAddress string,
	addresses []string,
	password string,
	stunURLs []string,
	natPredictionStunURLs []string,
	publicOrigin string,
) []string {
	overrides := map[string]string{
		"SCREENER_CLIENT_PORT":                     fmt.Sprint(port),
		"SCREENER_CLIENT_LAN_ADDRESS":              publicAddress,
		"SCREENER_CLIENT_ALLOWED_LAN_ADDRESSES":    strings.Join(addresses, ","),
		"SCREENER_CLIENT_LOCAL_PASSWORD":           password,
		"SCREENER_CLIENT_PUBLIC_ORIGIN":            publicOrigin,
		"STUN_URLS":                                strings.Join(stunURLs, ","),
		"SCREENER_CLIENT_NAT_PREDICTION_STUN_URLS": strings.Join(natPredictionStunURLs, ","),
	}
	result := make([]string, 0, len(os.Environ())+len(overrides))
	for _, entry := range os.Environ() {
		name, _, found := strings.Cut(entry, "=")
		if _, replaced := overrides[name]; found && replaced {
			continue
		}
		result = append(result, entry)
	}
	for name, value := range overrides {
		result = append(result, name+"="+value)
	}
	return result
}

func printEndpoint(endpoint loopback.Endpoint) error {
	payload, err := json.Marshal(endpoint)
	if err != nil {
		return errors.New("Screener Client endpoint is unavailable")
	}
	fmt.Println(string(payload))
	return nil
}
