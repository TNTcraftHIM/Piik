package mediaedge

import (
	"errors"
	"net"
	"sync"

	"github.com/TNTcraftHIM/Screener/native/client/internal/portmapping"
	"github.com/pion/interceptor"
	"github.com/pion/logging"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
)

const H264ProfileLevelID = "42c01f"

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

type EngineOptions struct {
	BindAddress     string
	IncludeLoopback bool
	PortMapping     bool
}

type Engine struct {
	api           *webrtc.API
	mux           interface{ Close() error }
	listenAddress string
	portMapping   *portmapping.Mapping
	bandwidth     *bandwidthObservers

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
	mux := webrtc.NewICEUDPMux(loggerFactory.NewLogger("screener-ice"), connection)
	settingEngine := webrtc.SettingEngine{LoggerFactory: loggerFactory}
	settingEngine.SetICEUDPMux(mux)
	settingEngine.SetIncludeLoopbackCandidate(options.IncludeLoopback)

	mediaEngine := &webrtc.MediaEngine{}
	if err = mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: h264Capability,
		PayloadType:        h264PayloadType,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		_ = mux.Close()
		return nil, err
	}
	if err = mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: opusCapability,
		PayloadType:        111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		_ = mux.Close()
		return nil, err
	}
	registry := &interceptor.Registry{}
	bandwidth, err := configureBandwidthObservers(mediaEngine, registry)
	if err != nil {
		_ = mux.Close()
		return nil, err
	}
	if err = webrtc.RegisterDefaultInterceptors(mediaEngine, registry); err != nil {
		_ = mux.Close()
		return nil, err
	}
	engine := &Engine{
		api: webrtc.NewAPI(
			webrtc.WithMediaEngine(mediaEngine),
			webrtc.WithInterceptorRegistry(registry),
			webrtc.WithSettingEngine(settingEngine),
		),
		mux:           mux,
		listenAddress: connection.LocalAddr().String(),
		bandwidth:     bandwidth,
		edges:         make(map[*Edge]struct{}),
	}
	if options.PortMapping {
		engine.portMapping = portmapping.Start(connection.LocalAddr().(*net.UDPAddr).Port)
	}
	return engine, nil
}

func (engine *Engine) ListenAddress() string {
	return engine.listenAddress
}

func (engine *Engine) NewSource(capacity int, requestKeyFrame func()) (*Source, error) {
	if capacity < 1 || capacity > 4 {
		return nil, errors.New("native media source capacity is outside the route bound")
	}
	engine.mu.Lock()
	defer engine.mu.Unlock()
	if engine.closed {
		return nil, errors.New("native media engine is closed")
	}
	track, err := webrtc.NewTrackLocalStaticRTP(
		h264Capability,
		"screen",
		"screener-native",
	)
	if err != nil {
		return nil, err
	}
	return &Source{
		engine: engine,
		track:  track,
		packetizer: rtp.NewPacketizer(
			h264PacketMTU,
			h264PayloadType,
			0,
			&codecs.H264Payloader{},
			rtp.NewRandomSequencer(),
			h264ClockRate,
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
