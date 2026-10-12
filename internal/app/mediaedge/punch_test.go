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
	for _, skew := range []time.Duration{0, 250 * time.Millisecond} {
		t.Run(skew.String(), func(t *testing.T) {
			network := newPunchLab(t, sequentialPunchNAT, sequentialPunchNAT)
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
			time.Sleep(skew)
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
			winner, err := punchSocketArray(ctx, listen, &net.UDPAddr{IP: net.ParseIP(network.public[1]), Port: 50000}, secret)
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
	} {
		if _, err := prediction.Target(); err == nil {
			t.Fatalf("accepted unsafe prediction: %+v", prediction)
		}
	}
}
