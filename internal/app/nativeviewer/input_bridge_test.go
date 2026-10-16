package nativeviewer

import (
	"strings"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/TNTcraftHIM/Piik/internal/app/remoteinput"
	"github.com/pion/webrtc/v4"
)

// Exercise the actual native receiver and local playback edge, not a second
// Browser-only path. An input channel must never propagate to a relay child.
func TestInputChannelUsesOnlyLocalPlayback(t *testing.T) {
	peer := func() *webrtc.PeerConnection {
		t.Helper()
		p, err := webrtc.NewPeerConnection(webrtc.Configuration{})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = p.Close() })
		return p
	}
	localDescription := func(p *webrtc.PeerConnection, description webrtc.SessionDescription) webrtc.SessionDescription {
		t.Helper()
		gathered := webrtc.GatheringCompletePromise(p)
		if err := p.SetLocalDescription(description); err != nil {
			t.Fatal(err)
		}
		select {
		case <-gathered:
		case <-time.After(5 * time.Second):
			t.Fatal("ICE gathering timed out")
		}
		return *p.LocalDescription()
	}
	upstream, playback := peer(), peer()
	if _, err := upstream.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo); err != nil {
		t.Fatal(err)
	}
	remote, err := upstream.CreateDataChannel(remoteinput.ChannelLabel, nil)
	if err != nil {
		t.Fatal(err)
	}
	requests := make(chan string, 10)
	remote.OnMessage(func(message webrtc.DataChannelMessage) { requests <- string(message.Data) })
	offer, err := upstream.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	offer = localDescription(upstream, offer)
	events := make(chan Event, 32)
	session, err := Start(t.Context(), Options{ShareID: "input-viewer", EdgeCapacity: 2, Events: events})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close() })
	result, err := session.AcceptOffer("upstream", offer, nil, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if err = upstream.SetRemoteDescription(result.Answer); err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			select {
			case event := <-events:
				if event.Type == "edge-candidate" && event.ConnectionID == "upstream" && event.Candidate != nil {
					_ = upstream.AddICECandidate(*event.Candidate)
				}
			case <-t.Context().Done():
				return
			}
		}
	}()
	opened := make(chan *webrtc.DataChannel, 1)
	states := make(chan string, 10)
	playback.OnDataChannel(func(channel *webrtc.DataChannel) {
		channel.OnMessage(func(message webrtc.DataChannelMessage) { states <- string(message.Data) })
		channel.OnOpen(func() { opened <- channel })
	})
	localOffer, err := session.PrepareLocalEdge("upstream", "playback", "local-offer", false)
	if err != nil {
		t.Fatal(err)
	}
	if err = playback.SetRemoteDescription(localOffer); err != nil {
		t.Fatal(err)
	}
	answer, err := playback.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = session.SetAnswer("playback", localDescription(playback, answer), "local-offer"); err != nil {
		t.Fatal(err)
	}
	var local *webrtc.DataChannel
	select {
	case local = <-opened:
	case <-time.After(5 * time.Second):
		t.Fatal("local input channel did not open")
	}
	waitMessage := func(messages <-chan string, want string) {
		t.Helper()
		timer := time.NewTimer(5 * time.Second)
		defer timer.Stop()
		for {
			select {
			case message := <-messages:
				if message == want {
					return
				}
			case <-timer.C:
				t.Fatalf("missing forwarded message %s", want)
			}
		}
	}
	waitMessage(requests, `{"type":"sync"}`)
	if err = remote.SendText(`{"state":"ready"}`); err != nil {
		t.Fatal(err)
	}
	waitMessage(states, `{"state":"ready"}`)
	if err = local.SendText(`{"type":"request"}`); err != nil {
		t.Fatal(err)
	}
	waitMessage(requests, `{"type":"request"}`)
	if err = session.UpdateProfile(nativecapture.VideoProfile{Width: 1280, Height: 720, Framerate: 30, Bitrate: 2_000_000, Preference: "balanced"}); err != nil {
		t.Fatal(err)
	}
	relay, err := session.PrepareEdge("upstream", "relay-child", nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(relay.SDP, "\nm=application ") {
		t.Fatal("input capability leaked to a relay child")
	}
	session.CloseEdge("playback")
	waitMessage(requests, `{"type":"release"}`)
}
