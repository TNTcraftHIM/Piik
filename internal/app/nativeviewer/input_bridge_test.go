package nativeviewer

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/TNTcraftHIM/Piik/internal/app/remoteinput"
	"github.com/pion/webrtc/v4"
)

// Delay the real Native callback while Pion and SCTP recover independently.
type delayedInputStateHandler struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (h *delayedInputStateHandler) Enabled(context.Context, slog.Level) bool { return true }
func (h *delayedInputStateHandler) Handle(_ context.Context, record slog.Record) error {
	var event, direction, state string
	record.Attrs(func(a slog.Attr) bool {
		switch a.Key {
		case "event":
			event = a.Value.String()
		case "direction":
			direction = a.Value.String()
		case "state":
			state = a.Value.String()
		}
		return true
	})
	if event == "media-connection-state" && direction == "inbound" && state == "connecting" {
		h.once.Do(func() { close(h.entered); <-h.release })
	}
	return nil
}
func (h *delayedInputStateHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h *delayedInputStateHandler) WithGroup(string) slog.Handler      { return h }

// Exercise the actual native receiver and local playback edge, not a second
// Browser-only path. Both local playback and relay children use the media tree.
func TestInputChannelUsesPlaybackAndRelay(t *testing.T) {
	previous := slog.Default()
	delayed := &delayedInputStateHandler{entered: make(chan struct{}), release: make(chan struct{})}
	slog.SetDefault(slog.New(delayed))
	var releaseOnce sync.Once
	resume := func() { releaseOnce.Do(func() { close(delayed.release) }) }
	t.Cleanup(func() { resume(); slog.SetDefault(previous) })
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
	observed := make(chan Event, 32)
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
				} else {
					observed <- event
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
	waitMessage(requests, `{"ready":true}`)
	if err = remote.SendText(`{"ready":true}`); err != nil {
		t.Fatal(err)
	}
	waitMessage(states, `{"ready":true}`)
	const packet = `{"id":"0123456789abcdef0123456789abcdef","epoch":"0123456789abcdef0123456789abcdef","data":"encrypted"}`
	const closed = `{"id":"0123456789abcdef0123456789abcdef","epoch":"0123456789abcdef0123456789abcdef","closed":true}`
	if err = local.SendText(packet); err != nil {
		t.Fatal(err)
	}
	waitMessage(requests, packet)
	// Restart the same Native PC, but delay its transient loss callback until
	// the current connection and input handshake have recovered.
	offer, err = upstream.CreateOffer(&webrtc.OfferOptions{ICERestart: true})
	if err != nil {
		t.Fatal(err)
	}
	offer = localDescription(upstream, offer)
	result, err = session.AcceptOffer("upstream", offer, nil, true, false)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Reused {
		t.Fatal("restart replaced the Native receiver")
	}
	if err = upstream.SetRemoteDescription(result.Answer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-delayed.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("Native connecting callback was not delayed")
	}
	// ICE restart retires the selected pair and enters Checking directly. Input
	// must release on that ordered event, before this queued media projection.
	waitMessage(states, `{"ready":false}`)
	waitMessage(requests, `{"ready":true}`)
	if err = remote.SendText(`{"ready":true}`); err != nil {
		t.Fatal(err)
	}
	waitMessage(states, `{"ready":true}`)
	if err = local.SendText(packet); err != nil {
		t.Fatal(err)
	}
	waitMessage(requests, packet)
	resume()
	// Wait until the delayed real callback has delivered its projection. Input
	// already recovered on the ordered transport observer; this older callback
	// must not demand another handshake or retire the fresh return path.
	completed := time.NewTimer(5 * time.Second)
	defer completed.Stop()
	for {
		select {
		case event := <-observed:
			if event.ConnectionID == "upstream" && event.State == "connecting" {
				goto resumed
			}
		case <-completed.C:
			t.Fatal("delayed Native projection did not finish")
		}
	}
resumed:
	if err = local.SendText(packet); err != nil {
		t.Fatal(err)
	}
	waitMessage(requests, packet)

	if err = session.UpdateProfile(nativecapture.VideoProfile{Width: 1280, Height: 720, Framerate: 30, Bitrate: 2_000_000, Preference: "balanced"}); err != nil {
		t.Fatal(err)
	}
	relay, err := session.PrepareEdge("upstream", "relay-child", nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(relay.SDP, "\nm=application ") {
		t.Fatal("relay child has no input return path")
	}
	session.CloseEdge("playback")
	waitMessage(requests, closed)
}
