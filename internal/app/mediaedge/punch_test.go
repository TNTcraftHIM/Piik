package mediaedge

import (
	"bytes"
	"context"
	"errors"
	"math"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/pion/ice/v4"
	"github.com/pion/stun/v4"
	"github.com/pion/transport/v5/vnet"
	"github.com/pion/webrtc/v4"
)

var sequentialPunchNAT = vnet.NATType{MappingBehavior: vnet.EndpointAddrPortDependent, FilteringBehavior: vnet.EndpointAddrPortDependent}

func punchEngine(t *testing.T, network *punchLab, side int) *Engine {
	t.Helper()
	engine, err := NewEngine(EngineOptions{BindAddress: network.private[side] + ":0"})
	if err != nil {
		t.Fatal(err)
	}
	engine.listenPacket = func(_, address string) (net.PacketConn, error) {
		return network.nets[side].ListenPacket("udp4", address)
	}
	engine.settings.SetNet(network.nets[side])
	engine.settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	engine.settings.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	t.Cleanup(func() { _ = engine.Close() })
	return engine
}

func preparePunch(t *testing.T, engine *Engine, source *Source, id, secret string) (*PunchPreparation, *PunchPrediction) {
	t.Helper()
	preparation, err := engine.BeginPunch(id, source, []webrtc.ICEServer{{URLs: []string{
		"stun:" + punchSTUNIP + ":3478", "stun:" + punchSTUNIP + ":3479", "stun:" + punchSTUNIP + ":3480",
	}}}, secret)
	if err != nil {
		t.Fatal(err)
	}
	prediction, err := preparation.Prepare()
	if err != nil {
		t.Fatal(err)
	}
	return preparation, prediction
}

func TestPunchAdoptsProvedTupleIntoMediaAndFeedback(t *testing.T) {
	stable := vnet.NATType{MappingBehavior: vnet.EndpointIndependent, FilteringBehavior: vnet.EndpointAddrPortDependent}
	for _, scenario := range []struct {
		name        string
		left, right vnet.NATType
		skew        time.Duration
	}{
		{"sequential", sequentialPunchNAT, sequentialPunchNAT, 0},
		{"sequential-delayed", sequentialPunchNAT, sequentialPunchNAT, 250 * time.Millisecond},
		{"stable-sender", stable, sequentialPunchNAT, 250 * time.Millisecond},
		{"stable-receiver", sequentialPunchNAT, stable, 250 * time.Millisecond},
		{"both-stable", stable, stable, 0},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			network := newPunchLab(t, scenario.left, scenario.right)
			engines := [2]*Engine{punchEngine(t, network, 0), punchEngine(t, network, 1)}
			keyFrames := make(chan struct{}, 8)
			source, err := engines[0].NewSource("vp8", 1, 1, func([]int) {
				select {
				case keyFrames <- struct{}{}:
				default:
				}
			})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = source.Close() })
			left, leftPrediction := preparePunch(t, engines[0], source, "connection", strings.Repeat("42", 32))
			right, rightPrediction := preparePunch(t, engines[1], nil, "connection", strings.Repeat("42", 32))
			results := make(chan bool, 2)
			go func() { results <- left.Run(*rightPrediction) }()
			time.Sleep(scenario.skew)
			go func() { results <- right.Run(*leftPrediction) }()
			for range 2 {
				if !<-results {
					t.Fatal("authenticated preparation failed")
				}
			}
			// No fresh STUN mapping can replace the endpoint that proved this path.
			socket := engines[1].TakePunchedSocket("connection", nil)
			if socket == nil {
				t.Fatal("missing inbound winner")
			}
			t.Cleanup(func() { _ = socket.Close() })
			edge, err := engines[0].NewEdge(source, EdgeOptions{ConnectionID: "connection", Punched: true})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = edge.Close() })
			offer, err := edge.CreateOffer()
			if err != nil {
				t.Fatal(err)
			}
			receiver, answer, err := engines[1].NewReceiver(ReceiverOptions{Offer: offer, EdgeCapacity: 1, PunchedSocket: socket})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = receiver.Close() })
			if err := edge.SetAnswer(answer, ""); err != nil {
				t.Fatal(err)
			}
			waitConnected(t, edge.connection, "adopted Native edge")
			waitConnected(t, receiver.connection, "adopted Native receiver")
			deadline := time.Now().Add(3 * time.Second)
			timestamp := time.Second
			for {
				if err := writeSourceFrame(source, sfu.VP8KeyFrame8x8, timestamp, time.Second/30); err != nil {
					t.Fatal(err)
				}
				timestamp += time.Second / 30
				receiver.mu.Lock()
				received := receiver.videoSSRC != 0
				receiver.mu.Unlock()
				if received {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("adopted socket carried no SRTP video")
				}
				time.Sleep(20 * time.Millisecond)
			}
			for _, buffer := range source.media.GetAllBuffers() {
				if buffer != nil {
					buffer.SetPLIThrottle(0)
				}
			}
			for len(keyFrames) > 0 {
				<-keyFrames
			}
			receiver.RequestKeyFrame()
			waitSignal(t, keyFrames, "reverse SRTCP feedback")
			if engines[0].Punch("connection") != nil || engines[1].Punch("connection") != nil {
				t.Fatal("adoption retained a preparation owner")
			}
		})
	}
}

func TestPunchRetiresStableObservationSocket(t *testing.T) {
	stable := vnet.NATType{MappingBehavior: vnet.EndpointIndependent, FilteringBehavior: vnet.EndpointAddrPortDependent}
	for _, scenario := range []string{"connection", "source", "engine", "cancel-during", "no-response"} {
		t.Run(scenario, func(t *testing.T) {
			network := newPunchLab(t, stable, sequentialPunchNAT)
			engine := punchEngine(t, network, 0)
			var connections []*countedPunchConn
			engine.listenPacket = func(_, address string) (net.PacketConn, error) {
				conn, err := network.nets[0].ListenPacket("udp4", address)
				if err != nil {
					return nil, err
				}
				counted := &countedPunchConn{PacketConn: conn}
				connections = append(connections, counted)
				return counted, nil
			}
			source, err := engine.NewSource("vp8", 1, 1, nil)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = source.Close() })
			preparation, prediction := preparePunch(t, engine, source, "stable", strings.Repeat("42", 32))
			if prediction.Step != 0 || len(connections) != 1 || connections[0].closed.Load() {
				t.Fatal("stable observation did not retain its original socket")
			}
			if engine.TakePunchedSocket("stable", source) != nil {
				t.Fatal("observation alone authorized socket adoption")
			}
			before := connections[0].writes.Load()
			switch scenario {
			case "connection":
				engine.ClosePunch("stable")
			case "source":
				_ = source.Close()
			case "engine":
				_ = engine.Close()
			default:
				if scenario == "cancel-during" {
					connections[0].firstWrite = preparation.cancel
				}
				if preparation.Run(PunchPrediction{Address: network.public[1], Port: 5000, Step: 1}) {
					t.Fatal("unreachable peer completed preparation")
				}
				engine.ClosePunch("stable")
			}
			if len(connections) != 1 || !connections[0].closed.Load() || connections[0].writes.Load()-before > 8 {
				t.Fatal("stable preparation replaced or leaked its socket, or exceeded its send budget")
			}
		})
	}
}

func TestPunchRejectsAnotherGenerationOnStableMapping(t *testing.T) {
	stable := vnet.NATType{MappingBehavior: vnet.EndpointIndependent, FilteringBehavior: vnet.EndpointIndependent}
	network := newPunchLab(t, stable, stable)
	leftEngine, rightEngine := punchEngine(t, network, 0), punchEngine(t, network, 1)
	left, leftPrediction := preparePunch(t, leftEngine, nil, "left", strings.Repeat("42", 32))
	right, rightPrediction := preparePunch(t, rightEngine, nil, "right", strings.Repeat("24", 32))
	results := make(chan bool, 2)
	go func() { results <- left.Run(*rightPrediction) }()
	go func() { results <- right.Run(*leftPrediction) }()
	for range 2 {
		if <-results {
			t.Fatal("another generation's packets authorized adoption")
		}
	}
	if leftEngine.TakePunchedSocket("left", nil) != nil || rightEngine.TakePunchedSocket("right", nil) != nil {
		t.Fatal("unauthenticated preparation exposed a socket")
	}
}

func TestPunchSurveyViewRetiresWithoutClosingRetainedSocket(t *testing.T) {
	network := newPunchLab(t, sequentialPunchNAT, sequentialPunchNAT)
	socket, err := network.nets[0].ListenPacket("udp4", network.private[0]+":0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = socket.Close() })
	view := &punchSurveySocket{PacketConn: socket}
	if err := view.Close(); err != nil {
		t.Fatal(err)
	}
	if err := socket.SetDeadline(time.Now().Add(500 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 1024)
	remote := &net.UDPAddr{IP: net.ParseIP(punchSTUNIP), Port: 3478}
	if _, _, err := view.ReadFrom(buffer); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("closed survey view can read the next owner's socket: %v", err)
	}
	if _, err := view.WriteTo(buffer, remote); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("closed survey view can write the next owner's socket: %v", err)
	}
	if err := view.Close(); err != nil {
		t.Fatal(err)
	}
	request := stun.MustBuild(stun.TransactionID, stun.BindingRequest)
	if _, err := socket.WriteTo(request.Raw, remote); err != nil {
		t.Fatal(err)
	}
	if _, _, err := socket.ReadFrom(buffer); err != nil {
		t.Fatalf("retiring the view damaged the retained socket: %v", err)
	}
}

// A pipe models a backpressured write without timing-sensitive UDP buffers.
// The first successful send may be dropped to exercise Pion's retransmitter.
type blockedSurveyConn struct {
	net.PacketConn
	writer  net.Conn
	entered chan struct{}
	blockAt int32
	writes  atomic.Int32
	closed  atomic.Bool
	once    sync.Once
}

func (c *blockedSurveyConn) WriteTo(p []byte, _ net.Addr) (int, error) {
	if c.writes.Add(1) < c.blockAt {
		return len(p), nil
	}
	c.once.Do(func() { close(c.entered) })
	return c.writer.Write(p)
}

func (c *blockedSurveyConn) SetDeadline(deadline time.Time) error {
	return errors.Join(c.writer.SetWriteDeadline(deadline), c.PacketConn.SetDeadline(deadline))
}

func (c *blockedSurveyConn) Close() error {
	c.closed.Store(true)
	return errors.Join(c.writer.Close(), c.PacketConn.Close())
}

func TestPunchSurveyRetiresBlockedWrites(t *testing.T) {
	for _, phase := range []struct {
		name    string
		blockAt int32
	}{{"initial", 1}, {"retransmission", 2}} {
		for _, retirement := range []string{"cancel", "timeout"} {
			t.Run(phase.name+"/"+retirement, func(t *testing.T) {
				network := newPunchLab(t, sequentialPunchNAT, sequentialPunchNAT)
				engine := punchEngine(t, network, 0)
				packet, err := network.nets[0].ListenPacket("udp4", network.private[0]+":0")
				if err != nil {
					t.Fatal(err)
				}
				writer, reader := net.Pipe()
				socket := &blockedSurveyConn{PacketConn: packet, writer: writer, entered: make(chan struct{}), blockAt: phase.blockAt}
				t.Cleanup(func() { _ = socket.Close(); _ = reader.Close() })
				engine.listenPacket = func(_, _ string) (net.PacketConn, error) { return socket, nil }
				preparation, err := engine.BeginPunch("blocked", nil, []webrtc.ICEServer{{URLs: []string{
					"stun:" + punchSTUNIP + ":3478", "stun:" + punchSTUNIP + ":3479", "stun:" + punchSTUNIP + ":3480",
				}}}, strings.Repeat("42", 32))
				if err != nil {
					t.Fatal(err)
				}
				done := make(chan error, 1)
				go func() { _, err := preparation.Prepare(); done <- err }()
				waitSignal(t, socket.entered, "blocked STUN write")
				closed := make(chan struct{})
				wait := 2 * time.Second
				if retirement == "cancel" {
					wait = 500 * time.Millisecond
					go func() { engine.ClosePunch("blocked"); close(closed) }()
				}
				select {
				case err := <-done:
					if err == nil || !socket.closed.Load() {
						t.Fatal("failed survey succeeded or retained its socket")
					}
				case <-time.After(wait):
					t.Fatal("retirement did not release a blocked STUN write")
				}
				if retirement == "cancel" {
					waitSignal(t, closed, "blocked survey owner retirement")
				} else {
					engine.ClosePunch("blocked")
				}
				if engine.TakePunchedSocket("blocked", nil) != nil {
					t.Fatal("failed survey exposed a socket")
				}
			})
		}
	}
}

func TestPunchRetirementJoinsBeforeSlotReuse(t *testing.T) {
	for _, retire := range []string{"connection", "source", "engine", "context"} {
		t.Run(retire, func(t *testing.T) {
			network := newPunchLab(t, sequentialPunchNAT, sequentialPunchNAT)
			engine := punchEngine(t, network, 0)
			source, err := engine.NewSource("vp8", 1, 1, nil)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = source.Close() })
			preparation, _ := preparePunch(t, engine, source, "current", strings.Repeat("42", 32))
			// A worker held at an allocation boundary cannot be overtaken by a
			// premature commit or a replacement connection.
			entered, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			engine.listenPacket = func(_, _ string) (net.PacketConn, error) {
				once.Do(func() { close(entered); <-release })
				return nil, errors.New("retired fixture")
			}
			done := make(chan struct{})
			go func() { preparation.Run(PunchPrediction{Address: network.public[1], Port: 5000, Step: 1}); close(done) }()
			<-entered
			if engine.TakePunchedSocket("current", source) != nil || engine.Punch("current") != preparation {
				t.Fatal("premature commit released the worker's slot")
			}
			closed := make(chan struct{})
			go func() {
				switch retire {
				case "connection":
					engine.ClosePunch("current")
				case "source":
					_ = source.Close()
				case "engine":
					_ = engine.Close()
				case "context":
					preparation.cancel()
					preparation.close()
				}
				close(closed)
			}()
			select {
			case <-closed:
				t.Fatal("retirement returned before joining its worker")
			case <-time.After(10 * time.Millisecond):
			}
			if _, err := engine.BeginPunch("replacement", nil, nil, strings.Repeat("24", 32)); err == nil {
				t.Fatal("replacement overtook retiring worker")
			}
			close(release)
			waitSignal(t, done, "preparation worker retirement")
			waitSignal(t, closed, "preparation owner retirement")
		})
	}
}

type countedPunchConn struct {
	net.PacketConn
	closed     atomic.Bool
	writes     atomic.Int32
	firstWrite func()
}

func (c *countedPunchConn) Close() error { c.closed.Store(true); return c.PacketConn.Close() }
func (c *countedPunchConn) WriteTo(p []byte, a net.Addr) (int, error) {
	c.writes.Add(1)
	if c.firstWrite != nil {
		c.firstWrite()
	}
	return c.PacketConn.WriteTo(p, a)
}

func TestPunchSocketResourcesAreBoundedOnFailure(t *testing.T) {
	for _, scenario := range []string{"cancel-before", "cancel-during", "timeout", "allocation-failure", "invalid-secret"} {
		t.Run(scenario, func(t *testing.T) {
			network := newPunchLab(t, sequentialPunchNAT, sequentialPunchNAT)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if scenario == "cancel-before" {
				cancel()
			}
			var connections []*countedPunchConn
			listen := func() (net.PacketConn, error) {
				if scenario == "allocation-failure" && len(connections) == 3 {
					return nil, errors.New("fixture allocation failure")
				}
				conn, err := network.nets[0].ListenPacket("udp4", network.private[0]+":0")
				if err != nil {
					return nil, err
				}
				counted := &countedPunchConn{PacketConn: conn}
				if scenario == "cancel-during" {
					counted.firstWrite = cancel
				}
				connections = append(connections, counted)
				return counted, nil
			}
			secret := bytes.Repeat([]byte{42}, 32)
			if scenario == "invalid-secret" {
				secret = nil
			}
			winner, err := punchSocketArray(ctx, listen, &net.UDPAddr{IP: net.ParseIP(network.public[1]), Port: 50000}, secret, nil)
			if err == nil || winner != nil {
				t.Fatal("failed preparation transferred a socket")
			}
			var writes int32
			for _, conn := range connections {
				if !conn.closed.Load() {
					t.Error("preparation leaked a socket")
				}
				writes += conn.writes.Load()
			}
			if len(connections) > 8 || writes > 64 {
				t.Fatalf("resource bound exceeded: sockets=%d writes=%d", len(connections), writes)
			}
			if (scenario == "invalid-secret" || scenario == "cancel-before") && len(connections) != 0 {
				t.Fatal("invalid attempt allocated sockets")
			}
		})
	}
}

func TestPunchPredictionRejectsUnsafeDestinationsAndOverflow(t *testing.T) {
	for _, prediction := range []PunchPrediction{
		{Address: "127.0.0.1", Port: 5000, Step: 1}, {Address: "10.0.0.1", Port: 5000, Step: 1},
		{Address: "224.0.0.1", Port: 5000, Step: 1}, {Address: "::1", Port: 5000, Step: 1},
		{Address: "198.51.100.1", Port: math.MaxInt, Step: 1}, {Address: "198.51.100.1", Port: 65534, Step: 1},
		{Address: "198.51.100.1", Port: 1000, Step: 1}, {Address: "198.51.100.1", Port: 5000, Step: 17},
		{Address: "10.0.0.1", Port: 5000, Step: 0}, {Address: "198.51.100.1", Port: 5000, Step: -1},
	} {
		if _, err := prediction.Target(); err == nil {
			t.Fatalf("accepted unsafe prediction: %+v", prediction)
		}
	}
}
