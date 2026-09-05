package mediaedge

import (
	"context"
	"errors"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/TNTcraftHIM/Screener/native/client/internal/portmapping"
	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/logging"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/stun/v3"
	"github.com/pion/webrtc/v4"
)

const H264ProfileLevelID = "42c033"
const stunSurveyTimeout = 5 * time.Second

var h264Capability = webrtc.RTPCodecCapability{
	MimeType:    webrtc.MimeTypeH264,
	ClockRate:   90_000,
	SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=" + H264ProfileLevelID,
	RTCPFeedback: []webrtc.RTCPFeedback{
		{Type: "goog-remb"},
		{Type: webrtc.TypeRTCPFBTransportCC},
		{Type: "ccm", Parameter: "fir"},
		{Type: "nack"},
		{Type: "nack", Parameter: "pli"},
	},
}

var vp8Capability = webrtc.RTPCodecCapability{
	MimeType:     webrtc.MimeTypeVP8,
	ClockRate:    videoClockRate,
	RTCPFeedback: h264Capability.RTCPFeedback,
}

var videoCodecs = map[string]webrtc.RTPCodecParameters{
	"h264": {RTPCodecCapability: h264Capability, PayloadType: h264PayloadType},
	"vp8":  {RTPCodecCapability: vp8Capability, PayloadType: vp8PayloadType},
}

type EngineOptions struct {
	BindAddress     string
	IncludeLoopback bool
	PortMapping     bool
	InitialBitrate  int
}

type Engine struct {
	api           *webrtc.API
	mux           *ice.UniversalUDPMuxDefault
	listenAddress string
	localPort     int
	portMapping   *portmapping.Mapping
	bandwidth     *bandwidthObservers
	ctx           context.Context
	cancel        context.CancelFunc

	mu     sync.Mutex
	edges  map[*Edge]struct{}
	closed bool
}

func NewEngine(options EngineOptions) (*Engine, error) {
	bindAddress := options.BindAddress
	if bindAddress == "" {
		bindAddress = "0.0.0.0:0"
	}
	address, err := net.ResolveUDPAddr("udp4", bindAddress)
	if err != nil {
		return nil, errors.New("native media UDP bind address is invalid")
	}
	connection, err := net.ListenUDP("udp4", address)
	if err != nil {
		return nil, errors.New("native media UDP socket is unavailable")
	}
	loggerFactory := logging.NewDefaultLoggerFactory()
	mux := ice.NewUniversalUDPMuxDefault(ice.UniversalUDPMuxParams{
		Logger:  loggerFactory.NewLogger("screener-ice"),
		UDPConn: connection,
	})
	settingEngine := webrtc.SettingEngine{LoggerFactory: loggerFactory}
	settingEngine.SetICEUDPMux(mux)
	settingEngine.SetIncludeLoopbackCandidate(options.IncludeLoopback)

	mediaEngine := &webrtc.MediaEngine{}
	for _, codec := range []string{"h264", "vp8"} {
		if err = mediaEngine.RegisterCodec(videoCodecs[codec], webrtc.RTPCodecTypeVideo); err != nil {
			_ = mux.Close()
			return nil, err
		}
	}
	if err = mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: opusCapability,
		PayloadType:        111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		_ = mux.Close()
		return nil, err
	}
	registry := &interceptor.Registry{}
	bandwidth, err := configureBandwidthObservers(
		mediaEngine,
		registry,
		options.InitialBitrate,
	)
	if err != nil {
		_ = mux.Close()
		return nil, err
	}
	if err = webrtc.RegisterDefaultInterceptors(mediaEngine, registry); err != nil {
		_ = mux.Close()
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	engine := &Engine{
		api: webrtc.NewAPI(
			webrtc.WithMediaEngine(mediaEngine),
			webrtc.WithInterceptorRegistry(registry),
			webrtc.WithSettingEngine(settingEngine),
		),
		mux:           mux,
		listenAddress: connection.LocalAddr().String(),
		localPort:     connection.LocalAddr().(*net.UDPAddr).Port,
		bandwidth:     bandwidth,
		ctx:           ctx,
		cancel:        cancel,
		edges:         make(map[*Edge]struct{}),
	}
	if options.PortMapping {
		engine.portMapping = portmapping.Start(connection.LocalAddr().(*net.UDPAddr).Port)
	}
	return engine, nil
}

type mappedAddress struct {
	address string
	port    int
}

func (engine *Engine) surveySTUN(
	ctx context.Context,
	servers []webrtc.ICEServer,
	emit func(mappedAddress),
) {
	surveyContext, cancel := context.WithTimeout(ctx, stunSurveyTimeout)
	defer cancel()
	type surveyTarget struct {
		address *net.UDPAddr
	}
	targets := make([]surveyTarget, 0)
	for _, server := range servers {
		for _, rawURL := range server.URLs {
			uri, err := stun.ParseURI(rawURL)
			if err != nil || uri.Scheme != stun.SchemeTypeSTUN ||
				uri.Proto != stun.ProtoTypeUDP {
				continue
			}
			addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip4", uri.Host)
			if err != nil || len(addresses) == 0 {
				continue
			}
			serverAddress, err := net.ResolveUDPAddr(
				"udp4",
				net.JoinHostPort(addresses[0].String(), strconv.Itoa(uri.Port)),
			)
			if err == nil {
				targets = append(targets, surveyTarget{address: serverAddress})
			}
		}
	}
	if len(targets) == 0 {
		return
	}
	results := make(chan mappedAddress, len(targets))
	for _, target := range targets {
		go func(address *net.UDPAddr) {
			mapped, err := engine.mux.GetXORMappedAddrContext(
				surveyContext,
				address,
				stunSurveyTimeout,
			)
			if err != nil || mapped == nil || mapped.IP.To4() == nil ||
				mapped.Port < 1 || mapped.Port > 65_535 {
				return
			}
			select {
			case results <- mappedAddress{address: mapped.IP.String(), port: mapped.Port}:
			case <-surveyContext.Done():
			}
		}(target.address)
	}
	seen := map[string]struct{}{}
	for remaining := len(targets); remaining > 0; remaining-- {
		select {
		case value := <-results:
			key := value.address + ":" + strconv.Itoa(value.port)
			if _, found := seen[key]; found {
				continue
			}
			seen[key] = struct{}{}
			emit(value)
		case <-surveyContext.Done():
			return
		}
	}
}

func stunServers(servers []webrtc.ICEServer) []webrtc.ICEServer {
	result := make([]webrtc.ICEServer, 0, len(servers))
	for _, server := range servers {
		urls := make([]string, 0, len(server.URLs))
		for _, rawURL := range server.URLs {
			if strings.HasPrefix(strings.ToLower(rawURL), "stun:") {
				urls = append(urls, rawURL)
			}
		}
		if len(urls) > 0 {
			result = append(result, webrtc.ICEServer{URLs: urls})
		}
	}
	return result
}

func (engine *Engine) ListenAddress() string {
	return engine.listenAddress
}

func (engine *Engine) NewSource(codec string, capacity int, requestKeyFrame func()) (*Source, error) {
	parameters, supported := videoCodecs[codec]
	if !supported {
		return nil, errors.New("native video codec is unsupported")
	}
	if capacity < 1 || capacity > 4 {
		return nil, errors.New("native media source capacity is outside the route bound")
	}
	engine.mu.Lock()
	defer engine.mu.Unlock()
	if engine.closed {
		return nil, errors.New("native media engine is closed")
	}
	track, err := webrtc.NewTrackLocalStaticRTP(
		parameters.RTPCodecCapability,
		"screen",
		"screener-native",
	)
	if err != nil {
		return nil, err
	}
	var payloader rtp.Payloader = &codecs.H264Payloader{}
	if codec == "vp8" {
		payloader = &codecs.VP8Payloader{EnablePictureID: true}
	}
	return &Source{
		engine: engine,
		track:  track,
		codec:  codec,
		packetizer: rtp.NewPacketizer(
			videoPacketMTU,
			uint8(parameters.PayloadType),
			0,
			payloader,
			rtp.NewRandomSequencer(),
			videoClockRate,
		),
		capacity:        capacity,
		requestKeyFrame: requestKeyFrame,
		edges:           make(map[*Edge]bool),
	}, nil
}

func (engine *Engine) register(edge *Edge) error {
	engine.mu.Lock()
	defer engine.mu.Unlock()
	if engine.closed {
		return errors.New("native media engine is closed")
	}
	engine.edges[edge] = struct{}{}
	return nil
}

func (engine *Engine) remove(edge *Edge) {
	engine.mu.Lock()
	delete(engine.edges, edge)
	engine.mu.Unlock()
}

func (engine *Engine) Close() error {
	engine.mu.Lock()
	if engine.closed {
		engine.mu.Unlock()
		return nil
	}
	engine.closed = true
	engine.cancel()
	edges := make([]*Edge, 0, len(engine.edges))
	for edge := range engine.edges {
		edges = append(edges, edge)
	}
	engine.mu.Unlock()
	for _, edge := range edges {
		_ = edge.Close()
	}
	if engine.portMapping != nil {
		engine.portMapping.Close()
	}
	return engine.mux.Close()
}
