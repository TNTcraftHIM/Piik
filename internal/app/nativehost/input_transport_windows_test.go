//go:build windows

package nativehost

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/app/mediaedge"
	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/TNTcraftHIM/Piik/internal/app/remoteinput"
	"github.com/TNTcraftHIM/Piik/internal/media/forwarding"
	"github.com/TNTcraftHIM/Piik/internal/media/inputroute"
	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
)

type inputLossSocket struct {
	net.PacketConn
	drop atomic.Bool
}

func (s *inputLossSocket) WriteTo(p []byte, addr net.Addr) (int, error) {
	if s.drop.Load() {
		return len(p), nil
	}
	return s.PacketConn.WriteTo(p, addr)
}
func (s *inputLossSocket) ReadFrom(p []byte) (int, net.Addr, error) {
	for {
		n, addr, err := s.PacketConn.ReadFrom(p)
		if err != nil || !s.drop.Load() {
			return n, addr, err
		}
	}
}

// Real ICE/DTLS/SCTP and the production permission owner. Approving control
// does not inject input; no key, button or pointer event is sent by this fixture.
func TestInputTransportLossRetiresOnlyItsPreviousApproval(t *testing.T) {
	for _, kind := range []string{"edge", "publication"} {
		t.Run(kind, func(t *testing.T) { checkInputTransportOwner(t, kind) })
	}
}
func checkInputTransportOwner(t *testing.T, kind string) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	wait := func(check func() bool, what string) {
		t.Helper()
		for !check() {
			select {
			case <-ctx.Done():
				t.Fatal("timeout: " + what)
			case <-time.After(10 * time.Millisecond):
			}
		}
	}
	engine, err := mediaedge.NewEngine(mediaedge.EngineOptions{BindAddress: "127.0.0.1:0", IncludeLoopback: true})
	check(err)
	defer engine.Close()
	source, err := engine.NewSource("vp8", 1, 1, nil)
	check(err)
	defer source.Close()
	check(source.SetFormat(0, 320, 180))
	check(source.ConfigureOutputs([]uint32{300000}))
	manager, err := remoteinput.New(ctx, false)
	check(err)
	defer manager.Close()
	input := manager.NewSession()
	input.SetTarget(nativecapture.CaptureTarget{Kind: "display", SourceID: "1"}, nil)
	policy, err := input.BeginPolicy(ctx, "ask", "", false)
	check(err)
	check(policy.Apply())
	binding := protocol.RemoteInputPeer{PeerID: "test-viewer", EndpointID: strings.Repeat("a", 32), Secret: strings.Repeat("b", 64)}
	check(input.SetPeers([]protocol.RemoteInputPeer{binding}))
	events := make(chan Event, 64)
	session := &Session{shareID: "input-loss", engine: engine, source: source, remoteInput: input, ctx: ctx, edges: map[string]*mediaedge.Edge{}, events: func(_ context.Context, event Event) { events <- event }}
	defer session.CloseEdge("input-edge")
	defer session.ClosePublication("input-generation", "input-edge")
	packet, err := net.ListenPacket("udp4", "127.0.0.1:0")
	check(err)
	socket := &inputLossSocket{PacketConn: packet}
	defer socket.Close()
	mux := forwarding.NewUDPMux(ice.UDPMuxParams{UDPConn: socket})
	defer mux.Close()
	settings := webrtc.SettingEngine{}
	settings.SetICEUDPMux(mux)
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetICETimeouts(time.Second, 15*time.Second, 100*time.Millisecond)
	viewer, err := webrtc.NewAPI(webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
	check(err)
	defer viewer.Close()
	viewer.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate != nil {
			value := candidate.ToJSON()
			if kind == "publication" {
				publication, e := session.Publication("input-generation", "input-edge")
				if e == nil {
					_ = publication.AddRemoteCandidate(&value)
				}
			} else {
				_ = session.AddCandidate("input-edge", &value)
			}
		}
	})
	channel := make(chan *webrtc.DataChannel, 1)
	viewer.OnDataChannel(func(dc *webrtc.DataChannel) { dc.OnOpen(func() { channel <- dc }) })
	var offer webrtc.SessionDescription
	var setAnswer func(webrtc.SessionDescription) error
	var localState func() webrtc.PeerConnectionState
	if kind == "publication" {
		offer, _, err = session.PreparePublication("input-generation", "input-edge", nil)
		check(err)
		publication, e := session.Publication("input-generation", "input-edge")
		check(e)
		setAnswer = publication.SetAnswer
	} else {
		offer, err = session.PrepareEdge("input-edge", nil, false)
		check(err)
		localState = session.edge("input-edge").State
		setAnswer = func(answer webrtc.SessionDescription) error { return session.SetAnswer("input-edge", answer, "") }
	}
	check(viewer.SetRemoteDescription(offer))
	answer, err := viewer.CreateAnswer(nil)
	check(err)
	check(viewer.SetLocalDescription(answer))
	check(setAnswer(answer))
	// Native trickle candidates can precede the remote description, so drain them only now.
	connected := false
	for !connected {
		select {
		case event := <-events:
			if event.Candidate != nil {
				check(viewer.AddICECandidate(*event.Candidate))
			}
			connected = event.State == "connected"
		case <-ctx.Done():
			t.Fatal("edge never connected")
		}
	}
	var dc *webrtc.DataChannel
	select {
	case dc = <-channel:
	case <-ctx.Done():
		t.Fatal("input channel did not open")
	}
	key, _ := hex.DecodeString(binding.Secret)
	block, _ := aes.NewCipher(key)
	aead, _ := cipher.NewGCM(block)
	epoch := strings.Repeat("c", 32)
	type inputReply struct {
		Grant  string `json:"grant"`
		CoPlay *bool  `json:"coPlay"`
	}
	replies := make(chan inputReply, 64)
	dc.OnMessage(func(message webrtc.DataChannelMessage) {
		var packet inputroute.Packet
		if json.Unmarshal(message.Data, &packet) != nil {
			return
		}
		data, e := base64.StdEncoding.DecodeString(packet.Data)
		if e != nil || len(data) < 36 {
			return
		}
		aad := append(append([]byte{1}, data[:8]...), []byte(packet.Epoch)...)
		plain, e := aead.Open(nil, data[8:20], data[20:], aad)
		if e != nil {
			return
		}
		var reply inputReply
		if json.Unmarshal(plain, &reply) == nil {
			replies <- reply
		}
	})
	var sequence uint64
	send := func(plain []byte, epoch string) {
		t.Helper()
		sequence++
		header := make([]byte, 20)
		binary.BigEndian.PutUint64(header, sequence)
		_, err := rand.Read(header[8:20])
		check(err)
		aad := append(append([]byte{0}, header[:8]...), []byte(epoch)...)
		encrypted := aead.Seal(header, header[8:20], plain, aad)
		data, _ := json.Marshal(inputroute.Packet{ID: binding.EndpointID, Epoch: epoch, Data: base64.StdEncoding.EncodeToString(encrypted)})
		check(dc.SendText(string(data)))
	}
	send([]byte(`{"type":"request","intent":"dddddddddddddddddddddddddddddddd"}`), epoch)
	wait(func() bool { return len(input.State().Requests) == 1 }, "pending approval")
	oldRequest := input.State().Requests[0].ID

	session.mu.Lock()
	locked := true
	defer func() {
		if locked {
			session.mu.Unlock()
		}
	}()
	socket.drop.Store(true)
	// Pion default disconnect timeout is five seconds. Keep the fixture outage
	// beyond it while the Host lock delays asynchronous media projections.
	select {
	case <-time.After(9 * time.Second):
	case <-ctx.Done():
		t.Fatal("outage deadline")
	}
	if requests := input.State().Requests; len(requests) != 0 {
		t.Errorf("transport loss kept its previous approval while Host projection was queued: %+v", requests)
	}
	socket.drop.Store(false)
	wait(func() bool { return viewer.ConnectionState() == webrtc.PeerConnectionStateConnected }, "remote recovered while native callback delayed")
	if localState != nil {
		wait(func() bool { return localState() == webrtc.PeerConnectionStateConnected }, "native recovered while callback delayed")
	}
	freshEpoch := strings.Repeat("e", 32)
	send([]byte(`{"type":"request","intent":"ffffffffffffffffffffffffffffffff"}`), freshEpoch)
	wait(func() bool {
		requests := input.State().Requests
		return len(requests) == 1 && requests[0].ID != oldRequest
	}, "new epoch request before native loss cleanup")
	freshRequest := input.State().Requests[0]
	check(input.Decide(freshRequest.ID, true))
	session.mu.Unlock()
	locked = false
	for {
		select {
		case event := <-events:
			if event.State == "disconnected" {
				goto observed
			}
		case <-ctx.Done():
			t.Fatal("missing loss callback")
		}
	}
observed:
	if requests := input.State().Requests; len(requests) != 1 {
		t.Fatalf("delayed old loss revoked new post-recovery grant: %+v", requests)
	}
	// The new grant must remain usable over the same physical SCTP channel.
	// A capability reply has an explicit coPlay field, unlike earlier replies.
	send([]byte(`{"type":"capabilities"}`), freshEpoch)
	for {
		select {
		case reply := <-replies:
			if reply.CoPlay != nil && reply.Grant != "" {
				goto acknowledged
			}
		case <-ctx.Done():
			t.Fatal("new grant did not survive capability round trip")
		}
	}
acknowledged:
	if kind == "publication" {
		session.ClosePublication("input-generation", "input-edge")
	} else {
		session.CloseEdge("input-edge")
	}
	wait(func() bool { return len(input.State().Requests) == 0 }, "closed transport permission release")
}
