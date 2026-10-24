package androidbridge

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"net"
	"sync"
	"time"

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
	capture *capture
	server  *serverapp.Server
	control *loopback.Server
	cancel  context.CancelFunc
	once    sync.Once
	url     string
}

func Start(platform Platform, lanAddress string, codecCapabilities string) (*Runtime, error) {
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
	audio := device.Video
	configuration, err := config.Local(config.LocalOptions{PublicAddress: lanAddress, Port: 8787})
	if err != nil {
		return nil, err
	}
	local, err := net.Listen("tcp4", "127.0.0.1:8787")
	if err != nil {
		return nil, err
	}
	secure, err := net.Listen("tcp4", net.JoinHostPort(lanAddress, "8787"))
	if err != nil {
		local.Close()
		return nil, err
	}
	certificate, err := tlsconfig.SelfSigned(lanAddress)
	if err != nil {
		local.Close()
		secure.Close()
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := &Runtime{
		capture: &capture{
			platform: platform,
			codec:    device.Codec,
			streams:  make(map[int64]*captureStream),
		},
		cancel: cancel,
		url:    "http://127.0.0.1:8787/#piik-client=1",
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
		AllowedOrigins:     []string{"http://127.0.0.1:8787"},
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
		local.Close()
		secure.Close()
		return nil, err
	}
	r.server, err = serverapp.New(serverapp.Options{
		Config:    configuration,
		Assets:    webassets.FS(),
		Listeners: []net.Listener{local, tls.NewListener(secure, certificate)},
	})
	if err != nil {
		r.control.Close()
		cancel()
		local.Close()
		secure.Close()
		return nil, err
	}
	if _, err = r.server.Listen(ctx); err != nil {
		r.Close()
		return nil, err
	}
	return r, nil
}

func (r *Runtime) URL() string { return r.url }
func (r *Runtime) Close() {
	r.once.Do(func() {
		r.cancel()
		r.control.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if r.server != nil {
			r.server.End(ctx)
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
