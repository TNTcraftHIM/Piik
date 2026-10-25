package bridge

import (
	"context"
	"crypto/tls"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	appconfig "github.com/TNTcraftHIM/Piik/internal/app/config"
	"github.com/TNTcraftHIM/Piik/internal/app/failure"
	"github.com/TNTcraftHIM/Piik/internal/app/lan"
	"github.com/TNTcraftHIM/Piik/internal/app/launcher"
	"github.com/TNTcraftHIM/Piik/internal/app/loopback"
	"github.com/TNTcraftHIM/Piik/internal/app/nativecontrol"
	"github.com/TNTcraftHIM/Piik/internal/app/publictunnel"
	serverapp "github.com/TNTcraftHIM/Piik/internal/server/app"
	"github.com/TNTcraftHIM/Piik/internal/server/config"
	"github.com/TNTcraftHIM/Piik/internal/server/webassets"
	"github.com/TNTcraftHIM/Piik/internal/tlsconfig"
)

// The App process owns the room runtime; the platform owns capture resources.
type Runtime struct {
	capture            *capture
	server             *serverapp.Server
	control            *loopback.Server
	launcher           *launcher.Server
	ctx                context.Context
	cancel             context.CancelFunc
	once               sync.Once
	url                string
	configMu           sync.Mutex
	configPath         string
	config             appconfig.Config
	tunnel             *publictunnel.Process
	tunnelExecutable   string
	temporaryDirectory string
	launchDone         chan struct{}
	closeErr           error
}

func Start(platform Platform, lanAddress string, codecCapabilities string, dataDirectory, temporaryDirectory, tunnelExecutable, activationURL string) (*Runtime, error) {
	if platform == nil {
		return nil, errors.New("mobile capture platform is unavailable")
	}
	if activationURL != "" && activationURL != "piik://media" {
		return nil, errors.New("mobile media activation URL is invalid")
	}
	if webassets.FS() == nil {
		return nil, errors.New("build the Piik Web assets before the mobile library")
	}
	if !filepath.IsAbs(temporaryDirectory) {
		return nil, errors.New("mobile cache directory is unavailable")
	}
	if err := os.MkdirAll(temporaryDirectory, 0700); err != nil {
		return nil, err
	}
	catalog, err := decodeEncoderCapabilities(codecCapabilities)
	if err != nil {
		return nil, err
	}
	preferences, err := appconfig.LoadOrCreate(filepath.Join(dataDirectory, "client.json"))
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := &Runtime{
		capture: &capture{
			platform: platform,
			encoders: catalog.Encoders,
			streams:  make(map[int64]*captureStream),
		},
		ctx: ctx, cancel: cancel,
		config: preferences, configPath: filepath.Join(dataDirectory, "client.json"),
		temporaryDirectory: temporaryDirectory, tunnelExecutable: tunnelExecutable,
	}
	capabilities := catalog.nativeCapabilities()
	microphones, microphoneErr := r.capture.ListMicrophones(ctx)
	capabilities.Microphone = microphoneErr == nil && len(microphones) > 0
	if microphoneErr != nil {
		slog.Debug("mobile microphone enumeration failed", "error", microphoneErr)
	}
	mediaCapabilities := catalog.mediaCapabilities()
	mediaCapabilities.Microphone = capabilities.Microphone
	mediaCapabilities.SourceCancellation = true
	r.control, err = loopback.Start(ctx, loopback.Options{
		ActivationURL:      activationURL,
		MaxControlSessions: 1,
		AllowedOrigins:     preferences.ApprovedSites(),
		NativeMedia:        mediaCapabilities,
		NewControl: func() loopback.ControlSession {
			return nativecontrol.NewWithCapture(capabilities, false, nil, r.capture)
		},
	})
	if err != nil {
		cancel()
		return nil, err
	}
	startup, err := launcher.LoadStartupSite(r.configPath, preferences.ApprovedSites()...)
	if err != nil {
		return nil, errors.Join(err, r.Close())
	}
	modes := []launcher.Mode{launcher.ModeLocal}
	if helper, statErr := os.Stat(tunnelExecutable); statErr == nil && filepath.IsAbs(tunnelExecutable) && helper.Mode().IsRegular() {
		modes = append(modes, launcher.ModeLink)
	}
	r.launcher, err = launcher.Start(ctx, webassets.FS(), launcher.Options{
		Modes: modes, LocalAccessPassword: preferences.LocalAccessPassword, DefaultMode: launcher.ModeLocal, Sites: preferences.ApprovedSites(), StartupSite: startup, LANAddress: lanAddress,
		ChangeSite: func(site string, allowed bool) ([]string, error) {
			var err error
			if allowed {
				_, err = r.approveSite(site)
			} else {
				err = r.revokeSite(site)
			}
			r.configMu.Lock()
			sites := r.config.ApprovedSites()
			r.configMu.Unlock()
			return sites, err
		},
		SaveStartupSite: func(site string) error { return launcher.SaveStartupSite(r.configPath, site) },
	})
	if err != nil {
		return nil, errors.Join(err, r.Close())
	}
	r.control.SetConnectURL(r.launcher.URL())
	r.configMu.Lock()
	err = r.syncAllowedOriginsLocked()
	r.configMu.Unlock()
	if err != nil {
		return nil, errors.Join(err, r.Close())
	}
	r.launchDone = make(chan struct{})
	go func() {
		defer close(r.launchDone)
		r.runLauncher(lanAddress)
	}()
	return r, nil
}

// Failed startup has already retired its resources before a new selection starts.
func (r *Runtime) runLauncher(lanAddress string) {
	for {
		select {
		case selected := <-r.launcher.Selection():
			target, err := r.startLocal(selected, lanAddress)
			r.launcher.SetResult(target, err)
			if err == nil {
				return
			}
		case <-r.ctx.Done():
			return
		}
	}
}

func (r *Runtime) URL() string      { return r.launcher.URL() }
func (r *Runtime) EntryURL() string { return r.launcher.EntryURL() }

func (r *Runtime) startLocal(selection launcher.Selection, address string) (target string, returnedErr error) {
	r.configMu.Lock()
	next := r.config
	next.LocalAccessPassword = selection.LocalAccessPassword
	err := appconfig.Save(r.configPath, next)
	if err == nil {
		r.config = next
	}
	r.configMu.Unlock()
	if err != nil {
		return "", err
	}
	if selection.LANAddress != nil {
		address = *selection.LANAddress
	}
	link := selection.Mode == launcher.ModeLink
	bind := "127.0.0.1:0"
	if link {
		bind = "0.0.0.0:0"
	}
	local, err := net.Listen("tcp4", bind)
	if err != nil {
		return "", err
	}
	port := local.Addr().(*net.TCPAddr).Port
	listeners := []net.Listener{local}
	var server *serverapp.Server
	var tunnel *publictunnel.Process
	committed := false
	defer func() {
		if committed {
			return
		}
		if server != nil {
			returnedErr = errors.Join(returnedErr, endRuntimeServer(server))
		}
		if tunnel != nil {
			returnedErr = errors.Join(returnedErr, tunnel.Close())
		}
		for _, listener := range listeners {
			_ = listener.Close()
		}
	}()
	options := config.LocalOptions{PublicAddress: address, Port: port, SiteAccessPassword: selection.LocalAccessPassword}
	if link {
		options.STUNURLs, options.NATPredictionSTUNURLs, err = appconfig.PublicSTUNURLs(os.Getenv("PIIK_STUN_URLS"))
		if err != nil {
			return "", err
		}
		tunnel, err = publictunnel.Start(r.ctx, r.tunnelExecutable, "http://127.0.0.1:"+strconv.Itoa(port), r.temporaryDirectory)
		if err != nil {
			return "", err
		}
		options.PublicOrigin = tunnel.Origin()
		options.AllowedAddresses, _ = lan.Addresses()
		// A public invitation does not require a currently selected LAN interface.
		options.PublicAddress = ""
	} else {
		secure, err := net.Listen("tcp4", net.JoinHostPort(address, strconv.Itoa(port)))
		if err != nil {
			return "", err
		}
		listeners = append(listeners, secure)
		certificate, err := tlsconfig.SelfSigned(address)
		if err != nil {
			return "", err
		}
		listeners[len(listeners)-1] = tls.NewListener(secure, certificate)
	}
	configuration, err := config.Local(options)
	if err != nil {
		return "", err
	}
	server, err = serverapp.New(serverapp.Options{Config: configuration, Assets: webassets.FS(), Listeners: listeners})
	if err != nil {
		return "", err
	}
	if _, err = server.Listen(r.ctx); err != nil {
		return "", err
	}
	target = launcher.LocalEntryURL("http://127.0.0.1:"+strconv.Itoa(port)+"/", selection.LocalAccessPassword)
	targetURL, _ := url.Parse(target)
	r.configMu.Lock()
	if r.ctx.Err() != nil {
		r.configMu.Unlock()
		return "", r.ctx.Err()
	}
	if err = r.syncAllowedOriginsLocked(targetURL.Scheme + "://" + targetURL.Host); err != nil {
		r.configMu.Unlock()
		return "", err
	}
	r.server, r.tunnel, r.url = server, tunnel, target
	committed = true
	r.configMu.Unlock()
	go r.watchRoom(server, tunnel)
	return target, nil
}

func endRuntimeServer(server *serverapp.Server) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := server.End(ctx)
	if errors.Is(err, context.Canceled) || errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (r *Runtime) watchRoom(server *serverapp.Server, tunnel *publictunnel.Process) {
	var tunnelDone <-chan struct{}
	if tunnel != nil {
		tunnelDone = tunnel.Done()
	}
	reason := failure.LocalServer
	select {
	case <-r.ctx.Done():
		return
	case <-server.Done():
	case <-tunnelDone:
		reason = failure.TunnelStopped
	}
	if r.ctx.Err() != nil {
		return
	}
	if err := r.Close(); err != nil {
		slog.Warn("mobile room cleanup failed", "error", err)
	}
	r.capture.platform.RuntimeStopped(string(reason))
}

// Sites retain the desktop configuration and exact-origin approval owner.
func (r *Runtime) approveSite(value string) (string, error) {
	site, err := appconfig.NormalizeSite(value)
	if err != nil || !strings.HasPrefix(site, "https://") {
		return "", errors.New("Enter an HTTPS Piik site origin")
	}
	r.configMu.Lock()
	sites := r.config.ApprovedSites()
	for _, current := range sites {
		if current == site {
			r.configMu.Unlock()
			return site, nil
		}
	}
	next := r.config
	next.SetApprovedSites(append(sites, site))
	if err = appconfig.Save(r.configPath, next); err != nil {
		r.configMu.Unlock()
		return "", err
	}
	r.config = next
	err = r.syncAllowedOriginsLocked()
	r.configMu.Unlock()
	r.capture.platform.SiteAccessChanged()
	return site, err
}
func (r *Runtime) revokeSite(value string) error {
	r.configMu.Lock()
	var sites []string
	for _, site := range r.config.ApprovedSites() {
		if site != value {
			sites = append(sites, site)
		}
	}
	next := r.config
	next.SetApprovedSites(sites)
	if err := appconfig.Save(r.configPath, next); err != nil {
		r.configMu.Unlock()
		return err
	}
	r.config = next
	err := r.syncAllowedOriginsLocked()
	r.configMu.Unlock()
	r.capture.platform.SiteAccessChanged()
	return err
}

// Caller holds configMu through the permission commit, so room startup cannot
// replay a stale Site snapshot or discard the newly installed local origin.
func (r *Runtime) syncAllowedOriginsLocked(pendingOrigins ...string) error {
	origins := append(r.localOriginsLocked(), pendingOrigins...)
	return r.control.SetAllowedOrigins(append(origins, r.config.ApprovedSites()...))
}

func (r *Runtime) localOrigins() []string {
	r.configMu.Lock()
	defer r.configMu.Unlock()
	return r.localOriginsLocked()
}

func (r *Runtime) localOriginsLocked() []string {
	origins := []string{}
	if r.url != "" {
		origins = append(origins, r.localOrigin())
	}
	if r.launcher != nil {
		u, _ := url.Parse(r.launcher.URL())
		origins = append(origins, u.Scheme+"://"+u.Host)
	}
	return origins
}
func (r *Runtime) localOrigin() string { u, _ := url.Parse(r.url); return u.Scheme + "://" + u.Host }
func (r *Runtime) TrustedURL(value string) bool {
	u, err := url.Parse(value)
	if err != nil || u.User != nil {
		return false
	}
	origin, err := appconfig.NormalizeSite(u.Scheme + "://" + u.Host)
	if err != nil {
		return false
	}
	for _, local := range r.localOrigins() {
		if origin == local {
			return true
		}
	}
	r.configMu.Lock()
	defer r.configMu.Unlock()
	for _, site := range r.config.ApprovedSites() {
		if site == origin {
			return true
		}
	}
	return false
}

func (r *Runtime) Close() error {
	r.once.Do(func() {
		r.cancel()
		if r.launchDone != nil {
			<-r.launchDone
		}
		r.configMu.Lock()
		server := r.server
		tunnel := r.tunnel
		r.configMu.Unlock()
		if server != nil {
			r.closeErr = errors.Join(r.closeErr, endRuntimeServer(server))
		}
		if tunnel != nil {
			r.closeErr = errors.Join(r.closeErr, tunnel.Close())
		}
		if r.control != nil {
			r.closeErr = errors.Join(r.closeErr, r.control.Close())
		}
		if r.launcher != nil {
			r.closeErr = errors.Join(r.closeErr, r.launcher.Close())
		}
		r.capture.mu.Lock()
		streams := make([]*captureStream, 0, len(r.capture.streams))
		for _, s := range r.capture.streams {
			streams = append(streams, s)
		}
		r.capture.mu.Unlock()
		for _, s := range streams {
			r.closeErr = errors.Join(r.closeErr, s.Close())
		}
	})
	return r.closeErr
}
