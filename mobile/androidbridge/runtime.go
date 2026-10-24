package androidbridge

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	appconfig "github.com/TNTcraftHIM/Piik/internal/app/config"
	"github.com/TNTcraftHIM/Piik/internal/app/launcher"
	"github.com/TNTcraftHIM/Piik/internal/app/loopback"
	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/TNTcraftHIM/Piik/internal/app/nativecontrol"
	serverapp "github.com/TNTcraftHIM/Piik/internal/server/app"
	"github.com/TNTcraftHIM/Piik/internal/server/config"
	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
	"github.com/TNTcraftHIM/Piik/internal/server/webassets"
	"github.com/TNTcraftHIM/Piik/internal/tlsconfig"
)

// The App process owns the room runtime. Its foreground service owns capture.
type Runtime struct {
	capture    *capture
	server     *serverapp.Server
	control    *loopback.Server
	launcher   *launcher.Server
	ctx        context.Context
	cancel     context.CancelFunc
	once       sync.Once
	url        string
	entry      string
	configMu   sync.Mutex
	configPath string
	config     appconfig.Config
}

func Start(platform Platform, lanAddress string, codecCapabilities string, dataDirectory string) (*Runtime, error) {
	if platform == nil {
		return nil, errors.New("Android capture platform is unavailable")
	}
	if webassets.FS() == nil {
		return nil, errors.New("build the Piik Web assets before the Android library")
	}
	var device struct {
		Video       bool   `json:"video"`
		Width       int    `json:"width"`
		Height      int    `json:"height"`
		Pixels      int    `json:"pixels"`
		Macroblocks int    `json:"macroblocks"`
		FPS         int    `json:"fps"`
		Bitrate     int    `json:"bitrate"`
		Name        string `json:"name"`
		Codec       string `json:"codec"`
	}
	if err := json.Unmarshal([]byte(codecCapabilities), &device); err != nil {
		return nil, errors.New("Android codec capabilities are invalid")
	}
	preferences, err := appconfig.LoadOrCreate(filepath.Join(dataDirectory, "client.json"))
	if err != nil {
		return nil, err
	}
	audio := device.Video
	ctx, cancel := context.WithCancel(context.Background())
	r := &Runtime{
		capture: &capture{
			platform: platform,
			codec:    device.Codec,
			streams:  make(map[int64]*captureStream),
		},
		ctx: ctx, cancel: cancel,
		config: preferences, configPath: filepath.Join(dataDirectory, "client.json"),
	}
	capabilities := nativecapture.Capabilities{
		Protocol:     7,
		Platform:     "android",
		VideoCapture: device.Video,
		SystemAudio:  audio,
		Adapters:     []nativecapture.Adapter{},
	}
	if device.Video {
		capabilities.Adapters = []nativecapture.Adapter{{Index: 0, Name: "Android MediaCodec", Identity: "android", HardwareH264: []nativecapture.Encoder{}}}
		if device.Codec == "h264" {
			capabilities.Adapters[0].HardwareH264 = []nativecapture.Encoder{{Index: 0, Name: device.Name, Identity: device.Name}}
		}
	}
	capabilities.SoftwareVP8 = device.Video && device.Codec == "vp8"
	r.control, err = loopback.Start(ctx, loopback.Options{
		MaxControlSessions: 1,
		AllowedOrigins:     preferences.ApprovedSites(),
		NativeMedia: loopback.NativeMediaCapabilities{
			Video:            device.Video,
			HardwareH264:     device.Video && device.Codec == "h264",
			SoftwareVP8:      capabilities.SoftwareVP8,
			SystemAudio:      audio,
			ShareVolume:      audio,
			ReceiverReuse:    true,
			MaxRelayChildren: protocol.MaxViewersPerRoomLimit,
			MaxVideoResolution: protocol.QualityResolution{
				Width:  protocol.Int(device.Width),
				Height: protocol.Int(device.Height),
			},
			MaxVideoPixels:               device.Pixels,
			MaxVideoMacroblocksPerSecond: device.Macroblocks,
			MaxVideoFramerate:            device.FPS,
			MaxVideoBitrate:              device.Bitrate,
			MaxAudioBitrate:              320000,
		},
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
		r.Close()
		return nil, err
	}
	r.launcher, err = launcher.Start(ctx, webassets.FS(), launcher.Options{
		Modes: []launcher.Mode{launcher.ModeLocal}, LocalAccessPassword: preferences.LocalAccessPassword, DefaultMode: launcher.ModeLocal, Sites: preferences.ApprovedSites(), StartupSite: startup, LANAddress: lanAddress,
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
		r.Close()
		return nil, err
	}
	r.entry = r.launcher.URL()
	if startup != "" {
		r.entry = startup + "/#piik-client=1"
	}
	r.control.SetConnectURL(r.launcher.URL())
	if err = r.control.SetAllowedOrigins(append(r.localOrigins(), preferences.ApprovedSites()...)); err != nil {
		r.Close()
		return nil, err
	}
	go func() {
		select {
		case selected := <-r.launcher.Selection():
			if selected.Mode != launcher.ModeLocal {
				r.launcher.SetResult("", errors.New("Use an HTTPS Piik site for sharing over the internet"))
				return
			}
			target, err := r.startLocal(selected, lanAddress)
			r.launcher.SetResult(target, err)
		case <-ctx.Done():
		}
	}()
	return r, nil
}

func (r *Runtime) URL() string      { return r.launcher.URL() }
func (r *Runtime) EntryURL() string { return r.entry }

// SiteURL navigates only. App permission still belongs to the launcher approval flow.
func (r *Runtime) SiteURL(value string) (string, error) {
	value = strings.TrimSpace(value)
	if !strings.Contains(value, "://") {
		value = "https://" + value
	}
	target, err := url.Parse(value)
	if err != nil || target.Scheme != "https" || target.Host == "" || target.User != nil {
		return "", errors.New("Enter an HTTPS Piik address")
	}
	origin := *target
	origin.Path, origin.RawPath, origin.RawQuery, origin.Fragment, origin.RawFragment = "", "", "", "", ""
	site, err := appconfig.NormalizeSite(origin.String())
	if err != nil || site == "" {
		return "", errors.New("Enter an HTTPS Piik address")
	}
	normalized, _ := url.Parse(site)
	target.Host = normalized.Host
	if target.Path == "" {
		target.Path = "/"
	}
	fragment, err := url.ParseQuery(target.Fragment)
	if err != nil {
		return "", errors.New("Piik address has an invalid fragment")
	}
	fragment.Set("piik-client", "1")
	target.Fragment, target.RawFragment = fragment.Encode(), ""
	return target.String(), nil
}

func (r *Runtime) startLocal(selection launcher.Selection, address string) (string, error) {
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
	local, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	port := local.Addr().(*net.TCPAddr).Port
	configuration, err := config.Local(config.LocalOptions{PublicAddress: address, Port: port, SiteAccessPassword: selection.LocalAccessPassword})
	if err != nil {
		local.Close()
		return "", err
	}
	secure, err := net.Listen("tcp4", net.JoinHostPort(address, strconv.Itoa(port)))
	if err != nil {
		local.Close()
		return "", err
	}
	certificate, err := tlsconfig.SelfSigned(address)
	if err != nil {
		local.Close()
		secure.Close()
		return "", err
	}
	server, err := serverapp.New(serverapp.Options{Config: configuration, Assets: webassets.FS(), Listeners: []net.Listener{local, tls.NewListener(secure, certificate)}})
	if err != nil {
		local.Close()
		secure.Close()
		return "", err
	}
	if _, err = server.Listen(r.ctx); err != nil {
		return "", err
	}
	target := launcher.LocalEntryURL("http://127.0.0.1:"+strconv.Itoa(port)+"/", selection.LocalAccessPassword)
	r.configMu.Lock()
	if r.ctx.Err() != nil {
		r.configMu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.End(ctx)
		return "", r.ctx.Err()
	}
	r.server = server
	r.url = target
	sites := r.config.ApprovedSites()
	r.configMu.Unlock()
	if err = r.control.SetAllowedOrigins(append(r.localOrigins(), sites...)); err != nil {
		return "", err
	}
	return target, nil
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
	r.configMu.Unlock()
	return site, r.control.SetAllowedOrigins(append(r.localOrigins(), next.ApprovedSites()...))
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
	r.configMu.Unlock()
	return r.control.SetAllowedOrigins(append(r.localOrigins(), sites...))
}
func (r *Runtime) localOrigins() []string {
	r.configMu.Lock()
	defer r.configMu.Unlock()
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

func (r *Runtime) Close() {
	r.once.Do(func() {
		r.cancel()
		r.control.Close()
		if r.launcher != nil {
			_ = r.launcher.Close()
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		r.configMu.Lock()
		server := r.server
		r.configMu.Unlock()
		if server != nil {
			server.End(ctx)
		}
		r.capture.mu.Lock()
		streams := make([]*captureStream, 0, len(r.capture.streams))
		for _, s := range r.capture.streams {
			streams = append(streams, s)
		}
		r.capture.mu.Unlock()
		for _, s := range streams {
			s.Close()
		}
	})
}
