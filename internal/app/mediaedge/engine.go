package mediaedge

import (
	"context"
	"errors"
	"net"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/TNTcraftHIM/Piik/internal/diagnostics"
	"github.com/TNTcraftHIM/Piik/internal/media/encoded"
	"github.com/TNTcraftHIM/Piik/internal/media/forwarding"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

// Use the browser-standard spelling of Constrained Baseline in SDP. Pion's
// codec ordering prefers literal profile matches over equivalent constraint bits.
const H264ProfileLevelID = "42e033"

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
	media          *webrtc.MediaEngine
	interceptors   *interceptor.Registry
	settings       webrtc.SettingEngine
	bindAddress    string
	portMapping    bool
	listenPacket   func(string, string) (net.PacketConn, error)
	initialBitrate int
	ctx            context.Context
	cancel         context.CancelFunc

	mu           sync.Mutex
	edges        map[*Edge]struct{}
	publications map[*Publication]struct{}
	sockets      map[*iceSocket]struct{}
	closed       bool
}

func NewEngine(options EngineOptions) (*Engine, error) {
	bindAddress := options.BindAddress
	if bindAddress == "" {
		bindAddress = ":0"
	}
	if _, err := net.ResolveUDPAddr("udp", bindAddress); err != nil {
		return nil, errors.New("native media UDP bind address is invalid")
	}
	loggerFactory := diagnostics.PionLoggerFactory()
	settingEngine := webrtc.SettingEngine{LoggerFactory: loggerFactory}
	settingEngine.SetIncludeLoopbackCandidate(options.IncludeLoopback)

	mediaEngine := &webrtc.MediaEngine{}
	for _, codec := range []string{"h264", "vp8"} {
		if err := mediaEngine.RegisterCodec(videoCodecs[codec], webrtc.RTPCodecTypeVideo); err != nil {
			return nil, err
		}
	}
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: opusCapability,
		PayloadType:        111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, err
	}
	registry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(mediaEngine, registry); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	if options.InitialBitrate <= 0 {
		options.InitialBitrate = defaultNativeSourceInitialBitrate
	}
	engine := &Engine{
		media:          mediaEngine,
		interceptors:   registry,
		settings:       settingEngine,
		bindAddress:    bindAddress,
		listenPacket:   net.ListenPacket,
		portMapping:    options.PortMapping,
		initialBitrate: options.InitialBitrate,
		ctx:            ctx,
		cancel:         cancel,
		edges:          make(map[*Edge]struct{}),
		publications:   make(map[*Publication]struct{}),
		sockets:        make(map[*iceSocket]struct{}),
	}
	return engine, nil
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

// NewSource coalesces recovery requests by physical output slot; [-1] requests
// all outputs. The callback runs outside the source lock and forwarding path.
func (engine *Engine) NewSource(codec string, capacity, layers int, requestKeyFrame func([]int)) (*Source, error) {
	_, supported := videoCodecs[codec]
	if !supported {
		return nil, errors.New("native video codec is unsupported")
	}
	if capacity < 1 || capacity > 4 {
		return nil, errors.New("native media source capacity is outside the route bound")
	}
	if layers < 1 || layers > 3 {
		return nil, errors.New("native media source output count is invalid")
	}
	engine.mu.Lock()
	defer engine.mu.Unlock()
	if engine.closed {
		return nil, errors.New("native media engine is closed")
	}
	source := &Source{
		engine: engine, codec: codec, formats: make([]atomic.Uint64, layers),
		capacity: capacity, requestKeyFrame: requestKeyFrame, edges: make(map[*Edge]bool),
		publications: make(map[*Publication]struct{}),
	}
	media, err := forwarding.NewEncodedSource(forwarding.SourceOptions{
		ID: "screen", StreamID: "piik-native", Codec: videoCodecs[codec],
		Formats: make([]forwarding.LayerFormat, layers), MaxPackets: encoded.MaxPacketWindow,
		OnRTCP: func(layer int, packets []rtcp.Packet) {
			for _, packet := range packets {
				switch packet.(type) {
				case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
					source.requestLayerKeyFrame(layer)
				}
			}
		},
	})
	if err != nil {
		return nil, err
	}
	source.media = media
	if requestKeyFrame != nil {
		source.recoveryRequests = make(chan struct{}, 1)
		source.recoveryStopped = make(chan struct{})
		go source.runRecovery()
	}
	return source, nil
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
	publications := make([]*Publication, 0, len(engine.publications))
	for publication := range engine.publications {
		publications = append(publications, publication)
	}
	sockets := make([]*iceSocket, 0, len(engine.sockets))
	for socket := range engine.sockets {
		sockets = append(sockets, socket)
	}
	engine.mu.Unlock()
	closeEdges(edges)
	for _, publication := range publications {
		_ = publication.Close()
	}
	for _, socket := range sockets {
		socket.close()
	}
	return nil
}
