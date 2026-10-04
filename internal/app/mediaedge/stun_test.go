package mediaedge

import (
	"context"
	"net"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/pion/rtp"
	"github.com/pion/stun/v3"
	"github.com/pion/webrtc/v4"
)

func bindingServer(t *testing.T, respond func(*stun.Message, *net.UDPAddr, *net.UDPConn)) *net.UDPAddr {
	t.Helper()
	listener, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		buffer := make([]byte, 1500)
		for {
			n, sender, err := listener.ReadFromUDP(buffer)
			if err != nil {
				return
			}
			message := &stun.Message{Raw: append([]byte(nil), buffer[:n]...)}
			if message.Decode() == nil && message.Type == stun.BindingRequest {
				respond(message, sender, listener)
			}
		}
	}()
	return listener.LocalAddr().(*net.UDPAddr)
}

func answerBinding(request *stun.Message, sender *net.UDPAddr, listener *net.UDPConn, port int) {
	response := stun.MustBuild(stun.NewTransactionIDSetter(request.TransactionID), stun.BindingSuccess,
		&stun.XORMappedAddress{IP: sender.IP, Port: port})
	_, _ = listener.WriteToUDP(response.Raw, sender)
}

func TestNativeGatheringRefreshesMappingWithoutInterruptingSibling(t *testing.T) {
	engine, err := NewEngine(EngineOptions{BindAddress: "127.0.0.1:0", IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close() })
	source, err := engine.NewSource("vp8", 2, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = source.Close() })
	sibling, err := engine.NewEdge(source, EdgeOptions{ConnectionID: "healthy"})
	if err != nil {
		t.Fatal(err)
	}
	receiver := newReceiverWithAudio(t, false, "127.0.0.1:0")
	t.Cleanup(func() { _ = receiver.Close() })
	packets := make(chan *rtp.Packet, 16)
	receiver.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			packet, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			packets <- packet
		}
	})
	connectEdgeToReceiver(t, sibling, receiver)
	var mappedPort, requests atomic.Int32
	var observedLocalPort atomic.Int32
	mappedPort.Store(40000)
	server := bindingServer(t, func(request *stun.Message, sender *net.UDPAddr, listener *net.UDPConn) {
		requests.Add(1)
		observedLocalPort.Store(int32(sender.Port))
		answerBinding(request, sender, listener, int(mappedPort.Load()))
	})
	for attempt := range 3 {
		wantPort := 40000 + attempt
		mappedPort.Store(int32(wantPort))
		candidates := make(chan *webrtc.ICECandidateInit, 16)
		edge, err := engine.NewEdge(source, EdgeOptions{
			ConnectionID: "recover-" + strconv.Itoa(attempt),
			ICEServers:   []webrtc.ICEServer{{URLs: []string{"stun:" + server.String()}}},
			Events:       EdgeEvents{LocalCandidate: func(candidate *webrtc.ICECandidateInit) { candidates <- candidate }},
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = edge.CreateOffer(); err != nil {
			t.Fatal(err)
		}
		found := false
		for !found {
			select {
			case candidate := <-candidates:
				if candidate == nil {
					t.Fatal("gathering ended without a fresh STUN observation")
				}
				if strings.HasPrefix(candidate.Candidate, "candidate:ns") {
					fields := strings.Fields(candidate.Candidate)
					if observedLocalPort.Load() != int32(edge.socket.localPort) || fields[len(fields)-1] != strconv.Itoa(edge.socket.localPort) {
						t.Fatal("STUN and candidate discovery left the edge's media socket")
					}
					if fields[5] != strconv.Itoa(wantPort) {
						t.Fatalf("attempt %d reused mapping %s; want %d", attempt, fields[5], wantPort)
					}
					found = true
				}
			case <-time.After(2 * time.Second):
				t.Fatal("fresh mapping was not gathered")
			}
		}
		_ = edge.Close()
		if err = writeSourceFrame(source, sfu.VP8KeyFrame8x8, time.Duration(attempt+1)*time.Second, time.Second/30); err != nil {
			t.Fatal(err)
		}
		_ = waitPacket(t, packets)
		if sibling.State() != webrtc.PeerConnectionStateConnected {
			t.Fatal("refreshing a mapping retired a healthy media connection")
		}
	}
	if requests.Load() < 3 {
		t.Fatal("later gatherings did not query STUN again")
	}
}

func TestSurveyRetriesLostBindingAndIgnoresUnmatchedResponse(t *testing.T) {
	engine, err := NewEngine(EngineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close() })
	socket := testICESocket(t, engine)
	var requests atomic.Int32
	server := bindingServer(t, func(request *stun.Message, sender *net.UDPAddr, listener *net.UDPConn) {
		if requests.Add(1) == 1 {
			// A delayed response from another transaction must not satisfy this
			// observation. Lose the real response to exercise stock retransmission.
			answerBinding(stun.MustBuild(stun.TransactionID, stun.BindingRequest), sender, listener, 40000)
			return
		}
		answerBinding(request, sender, listener, 40001)
	})
	observations := 0
	socket.surveySTUN(t.Context(), []webrtc.ICEServer{{URLs: []string{"stun:" + server.String()}}}, func(mapped mappedAddress) {
		observations++
		if mapped.port != 40001 {
			t.Errorf("accepted an unmatched STUN transaction: %+v", mapped)
		}
	})
	if requests.Load() < 2 || observations != 1 {
		t.Fatalf("a lost Binding response prevented discovery: requests=%d observations=%d", requests.Load(), observations)
	}
}

func TestConcurrentSurveyCancellationAndEngineRetirement(t *testing.T) {
	engine, err := NewEngine(EngineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close() })
	socket := testICESocket(t, engine)
	var answer atomic.Bool
	requested := make(chan struct{}, 16)
	server := bindingServer(t, func(request *stun.Message, sender *net.UDPAddr, listener *net.UDPConn) {
		select {
		case requested <- struct{}{}:
		default:
		}
		if answer.Load() {
			answerBinding(request, sender, listener, 40001)
		}
	})
	servers := []webrtc.ICEServer{{URLs: []string{"stun:" + server.String()}}}
	retiringContext, cancel := context.WithCancel(t.Context())
	retired := make(chan struct{})
	go func() {
		defer close(retired)
		socket.surveySTUN(retiringContext, servers, func(mappedAddress) { t.Error("retired survey emitted a candidate") })
	}()
	waitSignal(t, requested, "initial Binding request")
	const siblings = 3
	results := make(chan mappedAddress, siblings)
	for range siblings {
		go socket.surveySTUN(t.Context(), servers, func(mapped mappedAddress) { results <- mapped })
	}
	cancel()
	waitSignal(t, retired, "retired gathering")
	answer.Store(true)
	for range siblings {
		select {
		case value := <-results:
			if value.port != 40001 {
				t.Fatal("concurrent gathering received a stale observation")
			}
		case <-time.After(2 * time.Second):
			t.Fatal("retiring a gathering canceled healthy siblings")
		}
	}
	// A completed transaction must not keep a cached result; the next blocked
	// query belongs to the same Engine and must retire with it.
	answer.Store(false)
	for len(requested) > 0 {
		<-requested
	}
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		socket.surveySTUN(t.Context(), servers, func(mappedAddress) { t.Error("retained a completed mapping") })
	}()
	waitSignal(t, requested, "new Binding request after success")
	_ = engine.Close()
	waitSignal(t, stopped, "Engine shutdown during discovery")
}
