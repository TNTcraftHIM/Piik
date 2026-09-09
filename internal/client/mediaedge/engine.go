package mediaedge

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/TNTcraftHIM/Screener/internal/client/portmapping"
	"github.com/TNTcraftHIM/Screener/internal/diagnostics"
	"github.com/TNTcraftHIM/Screener/internal/media/encoded"
	"github.com/TNTcraftHIM/Screener/internal/media/forwarding"
	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
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
	api            *webrtc.API
	settings       webrtc.SettingEngine
	mux            *ice.UniversalUDPMuxDefault
	listenAddress  string
	localPort      int
	portMapping    *portmapping.Mapping
	initialBitrate int
	ctx            context.Context
	cancel         context.CancelFunc

	mu           sync.Mutex
	edges        map[*Edge]struct{}
	publications map[*Publication]struct{}
	closed       bool
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
	loggerFactory := diagnostics.PionLoggerFactory()
	ready := make(chan struct{})
	mux := ice.NewUniversalUDPMuxDefault(ice.UniversalUDPMuxParams{
		Logger:  loggerFactory.NewLogger("screener-ice"),
		UDPConn: &initializingUDPConn{UDPConn: connection, ready: ready},
	})
	close(ready)
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
	if err = webrtc.RegisterDefaultInterceptors(mediaEngine, registry); err != nil {
		_ = mux.Close()
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	if options.InitialBitrate <= 0 {
		options.InitialBitrate = defaultNativeSourceInitialBitrate
	}
	engine := &Engine{
		api: webrtc.NewAPI(
			webrtc.WithMediaEngine(mediaEngine),
			webrtc.WithInterceptorRegistry(registry),
			webrtc.WithSettingEngine(settingEngine),
		),
		mux:            mux,
		settings:       settingEngine,
		listenAddress:  connection.LocalAddr().String(),
		localPort:      connection.LocalAddr().(*net.UDPAddr).Port,
		initialBitrate: options.InitialBitrate,
		ctx:            ctx,
		cancel:         cancel,
		edges:          make(map[*Edge]struct{}),
		publications:   make(map[*Publication]struct{}),
	}
	if options.PortMapping {
		engine.portMapping = portmapping.Start(connection.LocalAddr().(*net.UDPAddr).Port)
	}
	return engine, nil
}

// Pion starts its reader before publishing the embedded UDP mux. Both receive
// paths wait for construction; the AddrPort interface preserves its fast path.
type initializingUDPConn struct {
	*net.UDPConn
	ready <-chan struct{}
}

var _ ice.AddrPortReaderWriter = (*initializingUDPConn)(nil)

func (connection *initializingUDPConn) ReadFrom(buffer []byte) (int, net.Addr, error) {
	<-connection.ready
	return connection.UDPConn.ReadFrom(buffer)
}

func (connection *initializingUDPConn) ReadFromAddrPort(buffer []byte) (int, netip.AddrPort, error) {
	<-connection.ready
	return connection.UDPConn.ReadFromUDPAddrPort(buffer)
}

func (connection *initializingUDPConn) WriteToAddrPort(buffer []byte, address netip.AddrPort) (int, error) {
	return connection.UDPConn.WriteToUDPAddrPort(buffer, address)
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
				slog.DebugContext(ctx, "nat-survey", "event", "resolve-failed", "host", uri.Host, diagnostics.Error(err))
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
			started := time.Now()
			mapped, err := engine.mux.GetXORMappedAddrContext(
				surveyContext,
				address,
				stunSurveyTimeout,
			)
			if err != nil || mapped == nil || mapped.IP.To4() == nil ||
				mapped.Port < 1 || mapped.Port > 65_535 {
				slog.DebugContext(surveyContext, "nat-survey", "event", "binding-failed", "serverPort", address.Port,
					"durationMs", time.Since(started).Milliseconds(), diagnostics.Error(err))
				return
			}
			slog.DebugContext(surveyContext, "nat-survey", "event", "binding", "serverPort", address.Port,
				"localPort", engine.localPort, "mappedAddress", diagnostics.ID(mapped.IP.String()), "mappedPort", mapped.Port,
				"durationMs", time.Since(started).Milliseconds())
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

func (engine *Engine) NewSource(codec string, capacity, layers int, requestKeyFrame func()) (*Source, error) {
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
		ID: "screen", StreamID: "screener-native", Codec: videoCodecs[codec],
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
	engine.mu.Unlock()
	closeEdges(edges)
	for _, publication := range publications {
		_ = publication.Close()
	}
	if engine.portMapping != nil {
		engine.portMapping.Close()
	}
	return engine.mux.Close()
}
