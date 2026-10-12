package mediaedge

import (
	"context"
	"encoding/hex"
	"errors"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/stun/v4"
	"github.com/pion/webrtc/v4"
)

// PunchPrediction is a transient mapping observation, not a NAT
// classification. Only an authenticated peer in the current route may supply it.
type PunchPrediction struct {
	Address string `json:"address"`
	Port    int    `json:"port"`
	Step    int    `json:"step"`
}

func (prediction PunchPrediction) Target() (*net.UDPAddr, error) {
	address, err := netip.ParseAddr(prediction.Address)
	if err != nil || !address.Is4() || !address.IsGlobalUnicast() || address.IsPrivate() ||
		address.IsLinkLocalUnicast() || prediction.Step < 0 || prediction.Step > 16 ||
		prediction.Port < 1024 || prediction.Port > 65535 {
		return nil, errors.New("unsupported peer mapping observation")
	}
	port := prediction.Port + 4*prediction.Step
	if port > 65535 {
		return nil, errors.New("unsupported peer mapping observation")
	}
	return net.UDPAddrFromAddrPort(netip.AddrPortFrom(address, uint16(port))), nil
}

// One optional preparation per Engine, within an existing acquisition retry.
// It owns no media source/copy, persists no address, and expires even if SDP never
// follows. Cancellation and socket transfer share this owner; there is no retry loop.
type PunchPreparation struct {
	engine       *Engine
	connectionID string
	source       *Source
	servers      []webrtc.ICEServer
	secret       []byte
	ctx          context.Context
	cancel       context.CancelFunc
	mu           sync.Mutex
	workMu       sync.Mutex
	stage        string
	socket       *PunchedSocket
}

// Keep the proved peer tuple with the socket. A later STUN observation on a
// destination-dependent NAT describes a different mapping, not this path.
type PunchedSocket struct {
	net.PacketConn
	remote *net.UDPAddr
}

// STUN owns its reader only until Client.Close joins it. Retain the UDP socket
// across sequential observations, then either close it or use its stable mapping.
type punchSurveySocket struct {
	net.PacketConn
	closed atomic.Bool
}

func (socket *punchSurveySocket) Close() error {
	if socket.closed.Swap(true) {
		return nil
	}
	return socket.SetReadDeadline(time.Now())
}

func (socket *punchSurveySocket) ReadFrom(buffer []byte) (int, net.Addr, error) {
	if socket.closed.Load() {
		return 0, nil, net.ErrClosed
	}
	return socket.PacketConn.ReadFrom(buffer)
}

func (socket *punchSurveySocket) WriteTo(buffer []byte, address net.Addr) (int, error) {
	if socket.closed.Load() {
		return 0, net.ErrClosed
	}
	return socket.PacketConn.WriteTo(buffer, address)
}

func (engine *Engine) BeginPunch(connectionID string, source *Source, servers []webrtc.ICEServer, secret string) (*PunchPreparation, error) {
	key, err := hex.DecodeString(secret)
	if err != nil || len(key) != 32 || connectionID == "" || len(connectionID) > 256 {
		return nil, errors.New("invalid connection preparation")
	}
	if source != nil {
		source.mu.Lock()
		defer source.mu.Unlock()
		if source.engine != engine || source.closed {
			return nil, errors.New("media source is unavailable")
		}
	}
	engine.mu.Lock()
	defer engine.mu.Unlock()
	if engine.closed || engine.punch != nil {
		return nil, errors.New("connection preparation is unavailable")
	}
	ctx, cancel := context.WithTimeout(engine.ctx, 5*time.Second)
	preparation := &PunchPreparation{
		engine: engine, connectionID: connectionID, source: source, servers: servers,
		secret: key, ctx: ctx, cancel: cancel, stage: "new",
	}
	engine.punch = preparation
	context.AfterFunc(ctx, func() {
		preparation.close()
		engine.mu.Lock()
		if engine.punch == preparation {
			engine.punch = nil
		}
		engine.mu.Unlock()
	})
	return preparation, nil
}

// Prepare observes three destinations in order before any peer checks. A stable
// mapping retains this socket. The ordinary initial ICE attempt never enters here.
func (preparation *PunchPreparation) Prepare() (*PunchPrediction, error) {
	if !preparation.workMu.TryLock() {
		return nil, errors.New("connection preparation is busy")
	}
	defer preparation.workMu.Unlock()
	if !preparation.transition("new", "survey") {
		return nil, errors.New("connection preparation was retired")
	}
	ctx, cancel := context.WithTimeout(preparation.ctx, 1500*time.Millisecond)
	defer cancel()
	socket, err := preparation.engine.listenPacket("udp", preparation.engine.bindAddress)
	if err != nil {
		return nil, err
	}
	defer func() {
		if socket != nil {
			_ = socket.Close()
		}
	}()
	deadline, _ := ctx.Deadline()
	if err := socket.SetDeadline(deadline); err != nil {
		return nil, err
	}
	// Pion's initial and retransmission writes are synchronous. Bound both I/O
	// directions, and join cancellation before this socket can change owners.
	surveySocket := socket
	deadlineDone := make(chan struct{})
	stopDeadline := context.AfterFunc(ctx, func() {
		defer close(deadlineDone)
		_ = surveySocket.SetDeadline(time.Now())
	})
	stopSurvey := func() {
		if stopDeadline != nil {
			if !stopDeadline() {
				<-deadlineDone
			}
			stopDeadline = nil
		}
	}
	defer stopSurvey()
	var observations []*stun.XORMappedAddress
	seen := make(map[string]bool)
	for _, server := range preparation.servers {
		for _, raw := range server.URLs {
			uri, parseErr := stun.ParseURI(raw)
			if parseErr != nil || uri.Scheme != stun.SchemeTypeSTUN || uri.Proto != stun.ProtoTypeUDP {
				continue
			}
			addresses, resolveErr := net.DefaultResolver.LookupNetIP(ctx, "ip4", uri.Host)
			if resolveErr != nil || len(addresses) == 0 {
				return nil, errors.New("connection preparation discovery unavailable")
			}
			address := net.UDPAddrFromAddrPort(netip.AddrPortFrom(addresses[0], uint16(uri.Port)))
			if seen[address.String()] {
				continue
			}
			seen[address.String()] = true
			mapped, mappingErr := querySTUNBinding(ctx, &punchSurveySocket{PacketConn: socket}, address,
				stun.MustBuild(stun.TransactionID, stun.BindingRequest))
			if mappingErr != nil {
				return nil, mappingErr
			}
			if err := socket.SetReadDeadline(deadline); err != nil {
				return nil, err
			}
			observations = append(observations, mapped)
			if len(observations) == 3 {
				first, second, third := observations[0], observations[1], observations[2]
				prediction := PunchPrediction{Address: third.IP.String(), Port: third.Port, Step: third.Port - second.Port}
				_, valid := prediction.Target()
				if valid != nil || !first.IP.Equal(second.IP) || !second.IP.Equal(third.IP) || second.Port-first.Port != prediction.Step {
					return nil, errors.New("no usable mapping observation")
				}
				stopSurvey()
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				if err := socket.SetDeadline(time.Time{}); err != nil {
					return nil, err
				}
				preparation.mu.Lock()
				defer preparation.mu.Unlock()
				if preparation.ctx.Err() != nil || preparation.stage != "survey" {
					return nil, errors.New("connection preparation was retired")
				}
				preparation.stage = "ready"
				if prediction.Step == 0 {
					// A stable observed endpoint is usable only with this exact socket.
					preparation.socket = &PunchedSocket{PacketConn: socket}
					socket = nil
				}
				return &prediction, nil
			}
		}
	}
	return nil, errors.New("three distinct discovery destinations are required")
}

func (preparation *PunchPreparation) Run(remote PunchPrediction) bool {
	if !preparation.workMu.TryLock() {
		return false
	}
	defer preparation.workMu.Unlock()
	target, err := remote.Target()
	if err != nil || !preparation.transition("ready", "running") {
		return false
	}
	preparation.mu.Lock()
	var retained net.PacketConn
	if preparation.socket != nil {
		retained = preparation.socket.PacketConn
		preparation.socket = nil
	}
	preparation.mu.Unlock()
	winner, err := punchSocketArray(preparation.ctx, func() (net.PacketConn, error) {
		return preparation.engine.listenPacket("udp", preparation.engine.bindAddress)
	}, target, preparation.secret, retained)
	preparation.mu.Lock()
	defer preparation.mu.Unlock()
	if err != nil || preparation.ctx.Err() != nil || preparation.stage != "running" {
		if winner != nil {
			_ = winner.Close()
		}
		return false
	}
	preparation.socket = &PunchedSocket{PacketConn: winner, remote: target}
	preparation.stage = "complete"
	return true
}

func (preparation *PunchPreparation) transition(from, to string) bool {
	preparation.mu.Lock()
	defer preparation.mu.Unlock()
	if preparation.ctx.Err() != nil || preparation.stage != from {
		return false
	}
	preparation.stage = to
	return true
}

func (preparation *PunchPreparation) close() {
	preparation.cancel()
	preparation.mu.Lock()
	preparation.stage = "closed"
	if preparation.socket != nil {
		_ = preparation.socket.Close()
		preparation.socket = nil
	}
	preparation.mu.Unlock()
	preparation.workMu.Lock()
	preparation.workMu.Unlock()
}

func (engine *Engine) Punch(connectionID string) *PunchPreparation {
	engine.mu.Lock()
	defer engine.mu.Unlock()
	preparation := engine.punch
	if preparation != nil && preparation.connectionID == connectionID {
		return preparation
	}
	return nil
}

// TakePunchedSocket transfers ownership once, after both endpoints report a
// successful preparation. The caller must adopt it or close it on every exit.
func (engine *Engine) TakePunchedSocket(connectionID string, source *Source) *PunchedSocket {
	engine.mu.Lock()
	preparation := engine.punch
	if preparation == nil || preparation.connectionID != connectionID || preparation.source != source {
		engine.mu.Unlock()
		return nil
	}
	engine.mu.Unlock()
	// A premature commit must not free the slot while its workers still own
	// sockets. Run publishes its result only after its finite work has ended.
	if !preparation.workMu.TryLock() {
		return nil
	}
	preparation.mu.Lock()
	if preparation.stage != "complete" || preparation.ctx.Err() != nil {
		preparation.mu.Unlock()
		preparation.workMu.Unlock()
		return nil
	}
	connection := preparation.socket
	preparation.socket = nil
	preparation.stage = "closed"
	preparation.mu.Unlock()
	preparation.workMu.Unlock()
	preparation.close()
	engine.mu.Lock()
	if engine.punch == preparation {
		engine.punch = nil
	}
	engine.mu.Unlock()
	return connection
}

// An empty identity is Engine retirement. Source retirement uses the same slot.
func (engine *Engine) ClosePunch(connectionID string) {
	engine.mu.Lock()
	preparation := engine.punch
	if preparation != nil && connectionID != "" && preparation.connectionID != connectionID {
		preparation = nil
	}
	engine.mu.Unlock()
	if preparation != nil {
		preparation.close()
		engine.mu.Lock()
		if engine.punch == preparation {
			engine.punch = nil
		}
		engine.mu.Unlock()
	}
}

func (engine *Engine) closeSourcePunch(source *Source) {
	engine.mu.Lock()
	preparation := engine.punch
	if preparation != nil && preparation.source != source {
		preparation = nil
	}
	engine.mu.Unlock()
	if preparation != nil {
		preparation.close()
		engine.mu.Lock()
		if engine.punch == preparation {
			engine.punch = nil
		}
		engine.mu.Unlock()
	}
}
