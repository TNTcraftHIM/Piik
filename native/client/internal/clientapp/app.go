package clientapp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/TNTcraftHIM/Screener/native/client/internal/browser"
	"github.com/TNTcraftHIM/Screener/native/client/internal/clientconfig"
	"github.com/TNTcraftHIM/Screener/native/client/internal/lan"
	"github.com/TNTcraftHIM/Screener/native/client/internal/loopback"
	"github.com/TNTcraftHIM/Screener/native/client/internal/nativecapture"
	"github.com/TNTcraftHIM/Screener/native/client/internal/nativecontrol"
	"github.com/TNTcraftHIM/Screener/native/client/internal/publictunnel"
	"github.com/TNTcraftHIM/Screener/native/client/internal/supervisor"
)

const (
	DefaultLocalPort = 8787
	publicSTUNURL    = "stun:stun.cloudflare.com:3478"
)

var BuildRevision = "development"

type Options struct {
	Site               string
	SiteSet            bool
	Local              bool
	Link               bool
	NodePath           string
	AppDirectory       string
	ConfigPath         string
	LANAddress         string
	Port               int
	DisableBrowser     bool
	CaptureProcess     string
	TunnelProcess      string
	Native             bool
	NativeWindowTitle  string
	NativeAdapterIndex int
	NativeEncoderIndex int
}

func Run(ctx context.Context, options Options) error {
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
	if options.Native && !nativeMedia.available() {
		return errors.New("Screener Client native capture is unavailable")
	}
	if config.Site != "" && !options.Link {
		return runSite(ctx, config.Site, options, nativeMedia)
	}
	return runLocal(ctx, options, config, nativeMedia)
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
	nativeMedia nativeRuntime,
) error {
	client, err := loopback.Start(ctx, loopback.Options{
		AllowedOrigin: site,
		NativeMedia:   nativeMedia.capabilities,
		NewControl:    nativeMedia.newControl,
	})
	if err != nil {
		return errors.New("Screener Client could not start")
	}
	defer client.Close()
	if err = printEndpoint(client.Endpoint()); err != nil {
		return err
	}
	if !options.DisableBrowser {
		if err = browser.Open(launchURL(site, options)); err != nil {
			return errors.New("Screener Client could not open the Site")
		}
	}
	if err = <-client.Done(); err != nil {
		return errors.New("Screener Client stopped unexpectedly")
	}
	return nil
}

func runLocal(ctx context.Context, options Options, config clientconfig.Config,
	nativeMedia nativeRuntime,
) error {
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
	client, err := loopback.Start(ctx, loopback.Options{
		AllowedOrigin: fmt.Sprintf("http://localhost:%d", options.Port),
		NativeMedia:   nativeMedia.capabilities,
		NewControl:    nativeMedia.newControl,
	})
	if err != nil {
		return errors.New("Screener Client could not start")
	}
	defer client.Close()
	if err = printEndpoint(client.Endpoint()); err != nil {
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
	if options.Link {
		stunURLs = []string{publicSTUNURL}
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
			publicOrigin,
		),
		Stdout:    os.Stdout,
		Stderr:    os.Stderr,
		HealthURL: fmt.Sprintf("http://127.0.0.1:%d/healthz", options.Port),
	})
	if err != nil {
		return err
	}
	defer localServer.Close()

	fmt.Printf("Local access password: %s\n", config.LocalAccessPassword)
	if publicOrigin != "" {
		fmt.Printf("Public invitation origin: %s\n", publicOrigin)
	} else {
		fmt.Printf("LAN invitation origin: http://%s:%d\n", selectedAddress, options.Port)
	}
	if !options.DisableBrowser {
		launchURL := launchURL(fmt.Sprintf(
			"http://localhost:%d/#client-access=%s",
			options.Port,
			config.LocalAccessPassword,
		), options)
		if err = browser.Open(launchURL); err != nil {
			return errors.New("Screener Client could not open the Local page")
		}
	}
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

func launchURL(raw string, options Options) string {
	if !options.Native {
		return raw
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	query := parsed.Query()
	query.Set("screener-native", "1")
	if value := strings.TrimSpace(options.NativeWindowTitle); value != "" {
		query.Set("screener-native-window", value)
	}
	if options.NativeAdapterIndex >= 0 {
		query.Set("screener-native-adapter", fmt.Sprint(options.NativeAdapterIndex))
	}
	if options.NativeEncoderIndex >= 0 {
		query.Set("screener-native-encoder", fmt.Sprint(options.NativeEncoderIndex))
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

type nativeRuntime struct {
	capabilities   loopback.NativeMediaCapabilities
	capture        nativecapture.Capabilities
	captureProcess string
}

func (runtime nativeRuntime) available() bool {
	return runtime.capabilities.WindowVideo && runtime.capabilities.HardwareH264 &&
		runtime.captureProcess != ""
}

func (runtime nativeRuntime) newControl() loopback.ControlSession {
	if !runtime.available() {
		return nil
	}
	return nativecontrol.New(runtime.captureProcess, runtime.capture)
}

func discoverNativeMedia(ctx context.Context, configuredPath string) nativeRuntime {
	path := strings.TrimSpace(configuredPath)
	if path == "" {
		path = nativecapture.PackagedExecutable()
	}
	capabilities, err := nativecapture.Discover(ctx, path)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Screener Client native capture is unavailable")
		return nativeRuntime{}
	}
	summary := capabilities.Summary()
	return nativeRuntime{
		captureProcess: path,
		capture:        capabilities,
		capabilities: loopback.NativeMediaCapabilities{
			WindowVideo:  summary.WindowVideo,
			ProcessAudio: summary.ProcessAudio,
			HardwareH264: summary.HardwareH264,
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
	publicOrigin string,
) []string {
	overrides := map[string]string{
		"SCREENER_CLIENT_PORT":                  fmt.Sprint(port),
		"SCREENER_CLIENT_LAN_ADDRESS":           publicAddress,
		"SCREENER_CLIENT_ALLOWED_LAN_ADDRESSES": strings.Join(addresses, ","),
		"SCREENER_CLIENT_LOCAL_PASSWORD":        password,
		"SCREENER_CLIENT_PUBLIC_ORIGIN":         publicOrigin,
		"STUN_URLS":                             strings.Join(stunURLs, ","),
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
