package clientapp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/TNTcraftHIM/Screener/native/client/internal/browser"
	"github.com/TNTcraftHIM/Screener/native/client/internal/clientconfig"
	"github.com/TNTcraftHIM/Screener/native/client/internal/lan"
	"github.com/TNTcraftHIM/Screener/native/client/internal/loopback"
	"github.com/TNTcraftHIM/Screener/native/client/internal/supervisor"
)

const DefaultLocalPort = 8787

var BuildRevision = "development"

type Options struct {
	Site           string
	SiteSet        bool
	Local          bool
	NodePath       string
	AppDirectory   string
	ConfigPath     string
	LANAddress     string
	Port           int
	DisableBrowser bool
}

func Run(ctx context.Context, options Options) error {
	if options.SiteSet && options.Local {
		return errors.New("choose either --site or --local")
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
	if options.SiteSet {
		config.Site, err = clientconfig.NormalizeSite(options.Site)
		if err != nil || config.Site == "" {
			return errors.New("Screener Site must be an HTTP or HTTPS origin")
		}
	} else if options.Local {
		config.Site = ""
	}
	if options.SiteSet || options.Local {
		if err = clientconfig.Save(configPath, config); err != nil {
			return errors.New("Screener Client configuration is unavailable")
		}
	}
	if config.Site != "" {
		return runSite(ctx, config.Site, options.DisableBrowser)
	}
	return runLocal(ctx, options, config)
}

func runSite(ctx context.Context, site string, disableBrowser bool) error {
	client, err := loopback.Start(ctx, loopback.Options{AllowedOrigin: site})
	if err != nil {
		return errors.New("Screener Client could not start")
	}
	defer client.Close()
	if err = printEndpoint(client.Endpoint()); err != nil {
		return err
	}
	if !disableBrowser {
		if err = browser.Open(site); err != nil {
			return errors.New("Screener Client could not open the Site")
		}
	}
	if err = <-client.Done(); err != nil {
		return errors.New("Screener Client stopped unexpectedly")
	}
	return nil
}

func runLocal(ctx context.Context, options Options, config clientconfig.Config) error {
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
	})
	if err != nil {
		return errors.New("Screener Client could not start")
	}
	defer client.Close()
	if err = printEndpoint(client.Endpoint()); err != nil {
		return err
	}

	entry := filepath.Join(appDirectory, "dist", "server", "server", "local-index.js")
	localServer, err := supervisor.Start(ctx, supervisor.Command{
		Path:        nodePath,
		Args:        []string{entry},
		Directory:   appDirectory,
		Environment: localEnvironment(options.Port, selectedAddress, addresses, config.LocalAccessPassword),
		Stdout:      os.Stdout,
		Stderr:      os.Stderr,
		HealthURL:   fmt.Sprintf("http://127.0.0.1:%d/healthz", options.Port),
	})
	if err != nil {
		return err
	}
	defer localServer.Close()

	fmt.Printf("Local access password: %s\n", config.LocalAccessPassword)
	fmt.Printf("LAN invitation origin: http://%s:%d\n", selectedAddress, options.Port)
	if !options.DisableBrowser {
		launchURL := fmt.Sprintf(
			"http://localhost:%d/#client-access=%s",
			options.Port,
			config.LocalAccessPassword,
		)
		if err = browser.Open(launchURL); err != nil {
			return errors.New("Screener Client could not open the Local page")
		}
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

func localEnvironment(port int, publicAddress string, addresses []string, password string) []string {
	overrides := map[string]string{
		"SCREENER_CLIENT_PORT":                  fmt.Sprint(port),
		"SCREENER_CLIENT_LAN_ADDRESS":           publicAddress,
		"SCREENER_CLIENT_ALLOWED_LAN_ADDRESSES": strings.Join(addresses, ","),
		"SCREENER_CLIENT_LOCAL_PASSWORD":        password,
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
