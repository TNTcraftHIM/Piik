package mediaedge

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/netip"
	"strconv"
	"sync"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/app/portmapping"
	"github.com/TNTcraftHIM/Piik/internal/diagnostics"
	"github.com/pion/ice/v4"
	"github.com/pion/stun/v3"
	"github.com/pion/webrtc/v4"
	"golang.org/x/sync/singleflight"
)

const stunSurveyTimeout = 5 * time.Second

// One physical connection owns one socket: Pion's UDP mux cannot distinguish
// concurrent DTLS/SRTP sessions with the same remote IP:port. Discovery and
// media share this socket; ICE restart retains it, replacement never does.
type iceSocket struct {
	engine      *Engine
	mux         *ice.UDPMuxDefault
	localPort   int
	portMapping *portmapping.Mapping
	stunQueries singleflight.Group
	ctx         context.Context
	cancel      context.CancelFunc
	closeOnce   sync.Once
}

func (engine *Engine) newICESocket(servers []webrtc.ICEServer, mapping bool) (*iceSocket, error) {
	// Go keeps wildcard UDP dual-stack where supported; a concrete IPv4 bind
	// remains IPv4-only. The same address family selection serves every edge.
	connection, err := engine.listenPacket("udp", engine.bindAddress)
	if err != nil {
		return nil, errors.New("native media UDP socket is unavailable")
	}
	ctx, cancel := context.WithCancel(engine.ctx)
	socket := &iceSocket{
		engine: engine, ctx: ctx, cancel: cancel,
		localPort: connection.LocalAddr().(*net.UDPAddr).Port,
		mux: ice.NewUDPMuxDefault(ice.UDPMuxParams{
			Logger: diagnostics.PionLoggerFactory().NewLogger("piik-ice"), UDPConn: connection,
		}),
	}
	if engine.portMapping && mapping && len(stunServers(servers)) > 0 {
		socket.portMapping = portmapping.Start(socket.localPort)
	}
	engine.mu.Lock()
	closed := engine.closed
	if !closed {
		engine.sockets[socket] = struct{}{}
	}
	engine.mu.Unlock()
	if closed {
		socket.close()
		return nil, errors.New("native media engine is closed")
	}
	return socket, nil
}

func (socket *iceSocket) settings() webrtc.SettingEngine {
	settings := socket.engine.settings
	settings.SetICEUDPMux(socket.mux)
	return settings
}

func (socket *iceSocket) newPeerConnection() (*webrtc.PeerConnection, error) {
	return webrtc.NewAPI(
		webrtc.WithMediaEngine(socket.engine.media),
		webrtc.WithInterceptorRegistry(socket.engine.interceptors),
		webrtc.WithSettingEngine(socket.settings()),
	).NewPeerConnection(webrtc.Configuration{})
}

func (socket *iceSocket) close() {
	if socket == nil {
		return
	}
	socket.closeOnce.Do(func() {
		socket.cancel()
		// Keep the port reserved until gateway cleanup settles: a late deletion
		// must not remove a replacement connection's mapping on a recycled port.
		if socket.portMapping != nil {
			socket.portMapping.Close()
		}
		_ = socket.mux.Close()
		socket.engine.mu.Lock()
		delete(socket.engine.sockets, socket)
		socket.engine.mu.Unlock()
	})
}

type mappedAddress struct {
	address string
	port    int
}

func (socket *iceSocket) surveySTUN(
	ctx context.Context,
	servers []webrtc.ICEServer,
	emit func(mappedAddress),
) {
	surveyContext, cancel := context.WithTimeout(ctx, stunSurveyTimeout)
	defer cancel()
	// One survey retains its resolver even while canceled workers are settling.
	resolver := net.DefaultResolver
	results := make(chan mappedAddress)
	var pending sync.WaitGroup
	for _, server := range servers {
		for _, rawURL := range server.URLs {
			uri, err := stun.ParseURI(rawURL)
			if err != nil || uri.Scheme != stun.SchemeTypeSTUN ||
				uri.Proto != stun.ProtoTypeUDP || uri.Port < 1 || uri.Port > 65_535 {
				continue
			}
			pending.Add(1)
			go func() {
				defer pending.Done()
				// Resolve each destination independently inside the same bound as
				// its Binding request; one broken resolver must not stall healthy STUN.
				addresses, err := resolver.LookupNetIP(surveyContext, "ip4", uri.Host)
				if err != nil || len(addresses) == 0 {
					slog.DebugContext(surveyContext, "nat-survey", "event", "resolve-failed", "host", uri.Host, diagnostics.Error(err))
					return
				}
				address := net.UDPAddrFromAddrPort(netip.AddrPortFrom(addresses[0], uint16(uri.Port)))
				started := time.Now()
				mapped, err := socket.stunMapping(surveyContext, address)
				if err != nil || mapped == nil || mapped.IP.To4() == nil ||
					mapped.Port < 1 || mapped.Port > 65_535 {
					slog.DebugContext(surveyContext, "nat-survey", "event", "binding-failed", "serverPort", address.Port,
						"durationMs", time.Since(started).Milliseconds(), diagnostics.Error(err))
					return
				}
				slog.DebugContext(surveyContext, "nat-survey", "event", "binding", "serverPort", address.Port,
					"localPort", socket.localPort, "mappedAddress", diagnostics.ID(mapped.IP.String()), "mappedPort", mapped.Port,
					"durationMs", time.Since(started).Milliseconds())
				select {
				case results <- mappedAddress{address: mapped.IP.String(), port: mapped.Port}:
				case <-surveyContext.Done():
				}
			}()
		}
	}
	go func() {
		pending.Wait()
		close(results)
	}()
	seen := map[string]struct{}{}
	for {
		select {
		case value, ok := <-results:
			if !ok {
				return
			}
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
