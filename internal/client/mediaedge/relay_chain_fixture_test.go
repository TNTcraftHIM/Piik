package mediaedge

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Screener/internal/client/nativecapture"
	"github.com/TNTcraftHIM/Screener/internal/media/encoded"
	"github.com/pion/webrtc/v4"
)

// Replays actual SDK encoder output through independent Pion connections. The
// relays retain derivation capability, but healthy children need only raw reuse.
func TestRelayChainEncodedFixture(t *testing.T) {
	fixture := os.Getenv("SCREENER_POOL_CHAIN_FIXTURE")
	if fixture == "" {
		t.Skip("set SCREENER_POOL_CHAIN_FIXTURE and SCREENER_NATIVE_CAPTURE")
	}
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	executable := os.Getenv("SCREENER_NATIVE_CAPTURE")
	info, err := os.Stat(executable)
	check(err)
	if info.IsDir() {
		t.Fatal("SCREENER_NATIVE_CAPTURE must name the existing capture executable")
	}
	input, err := os.Open(fixture)
	check(err)
	defer input.Close()
	info, err = input.Stat()
	check(err)
	if info.Size() > 64<<20 {
		t.Fatal("encoded chain fixture exceeds 64 MiB")
	}
	type fixtureFrame struct {
		Index, Width, Height int
		Recovery             bool
		DataHex              string
		Data                 []byte `json:"-"`
	}
	var frames []fixtureFrame
	identities := make(map[[sha256.Size]byte][]int)
	decoder := json.NewDecoder(input)
	for {
		var frame fixtureFrame
		if err = decoder.Decode(&frame); err == io.EOF {
			break
		}
		check(err)
		if len(frames) >= 400 || frame.Index != len(frames) || frame.Width <= 0 || frame.Height <= 0 ||
			frame.Width > 2560 || frame.Height > 1440 || len(frame.DataHex) == 0 || len(frame.DataHex) > 8<<20 ||
			len(frame.DataHex)%2 != 0 {
			t.Fatal("encoded chain fixture has invalid or excessive frames")
		}
		frame.Data, err = hex.DecodeString(frame.DataHex)
		check(err)
		frame.DataHex = ""
		if len(frame.Data) < 3 || (frame.Data[0]&1 == 0) != frame.Recovery {
			t.Fatal("fixture recovery metadata does not match VP8")
		}
		if len(frames) > 0 && (frame.Width != frames[0].Width || frame.Height != frames[0].Height) {
			t.Fatal("encoded chain fixture must retain one format")
		}
		hash := sha256.Sum256(frame.Data)
		identities[hash] = append(identities[hash], frame.Index)
		frames = append(frames, frame)
	}
	if len(frames) < 180 || !frames[0].Recovery {
		t.Fatal("encoded chain fixture needs at least 180 frames beginning with recovery")
	}

	var engines []*Engine
	var edges []*Edge
	var relays []*Receiver
	var leaves []*webrtc.PeerConnection
	closeAll := func() {
		for _, leaf := range leaves {
			if closeErr := leaf.Close(); closeErr != nil {
				t.Error(closeErr)
			}
		}
		for i := len(relays) - 1; i >= 0; i-- {
			if closeErr := relays[i].Close(); closeErr != nil {
				t.Error(closeErr)
			}
		}
		for _, edge := range edges {
			if closeErr := edge.Close(); closeErr != nil {
				t.Error(closeErr)
			}
		}
		for _, engine := range engines {
			if closeErr := engine.Close(); closeErr != nil {
				t.Error(closeErr)
			}
		}
	}
	t.Cleanup(closeAll)
	for range 3 {
		engine, createErr := NewEngine(EngineOptions{
			BindAddress: "127.0.0.1:0", IncludeLoopback: true, InitialBitrate: 10_000_000,
		})
		check(createErr)
		engines = append(engines, engine)
	}
	host, err := engines[0].NewSource("vp8", 2, 1, nil)
	check(err)
	t.Cleanup(func() { _ = host.Close() })
	check(host.SetFormat(0, uint32(frames[0].Width), uint32(frames[0].Height)))
	check(host.ConfigureOutputs([]uint32{2_000_000}))
	sources := []*Source{host}
	for hop := 0; hop < 2; hop++ {
		edge, createErr := engines[hop].NewEdge(sources[hop], EdgeOptions{ConnectionID: fmt.Sprintf("chain-hop-%d", hop+1)})
		check(createErr)
		edges = append(edges, edge)
		gathered := webrtc.GatheringCompletePromise(edge.connection)
		_, err = edge.CreateOffer()
		check(err)
		waitSignal(t, gathered, "chain offer gathering")
		receiver, _, createErr := engines[hop+1].NewReceiver(ReceiverOptions{
			Offer: *edge.connection.LocalDescription(), EdgeCapacity: 2,
			Relay: &RelayOptions{CaptureProcess: executable, Capabilities: nativecapture.Capabilities{
				SoftwareVP8: true, Adapters: []nativecapture.Adapter{{Index: 0}},
			}},
		})
		check(createErr)
		relays = append(relays, receiver)
		waitSignal(t, webrtc.GatheringCompletePromise(receiver.connection), "chain answer gathering")
		check(edge.SetAnswer(*receiver.connection.LocalDescription()))
		waitConnected(t, edge.connection, "chain upstream")
		waitConnected(t, receiver.connection, "chain native receiver")
		check(receiver.Source().SetRelayProfile(nativecapture.VideoProfile{
			Width: 1280, Height: 720, Framerate: 30, Bitrate: 2_000_000, Preference: "balanced",
		}))
		if receiver.Source().relay == nil {
			t.Fatal("native relay derivation capability was not enabled")
		}
		sources = append(sources, receiver.Source())
	}

	type leafResult struct {
		Frames        int    `json:"frames"`
		FirstIndex    int    `json:"firstIndex"`
		LastIndex     int    `json:"lastIndex"`
		LastTimestamp uint32 `json:"-"`
		SSRC          uint32 `json:"-"`
	}
	var resultMu sync.Mutex
	var results [3]leafResult
	var leafDone [3]chan struct{}
	errors := make(chan error, 1)
	fail := func(err error) {
		select {
		case errors <- err:
		default:
		}
	}
	for leaf := range 3 {
		edge, createErr := engines[leaf].NewEdge(sources[leaf], EdgeOptions{ConnectionID: fmt.Sprintf("chain-leaf-%d", leaf)})
		check(createErr)
		edges = append(edges, edge)
		receiver := newReceiver(t)
		leaves = append(leaves, receiver)
		leafDone[leaf] = make(chan struct{})
		receiver.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
			defer close(leafDone[leaf])
			video := relayVideoInput{codec: "vp8", onPacketDropped: func() {
				fail(fmt.Errorf("leaf %d discarded an incomplete access unit", leaf))
			}}
			for {
				packet, _, readErr := track.ReadRTP()
				if readErr != nil {
					return
				}
				if err := video.push(packet); err != nil {
					fail(err)
					return
				}
				for {
					sample, timestamp := video.pop()
					if sample == nil {
						break
					}
					// SampleBuilder removes the hop-specific VP8 RTP descriptor.
					candidates := identities[sha256.Sum256(sample.Data)]
					resultMu.Lock()
					result := &results[leaf]
					matched := -1
					for _, index := range candidates {
						if result.Frames == 0 || index > result.LastIndex {
							matched = index
							break
						}
					}
					if matched < 0 || result.Frames == 0 && !frames[matched].Recovery ||
						result.Frames > 0 && (matched != result.LastIndex+1 ||
							int32(timestamp-result.LastTimestamp) <= 0 || result.SSRC != packet.SSRC) {
						resultMu.Unlock()
						fail(fmt.Errorf("leaf %d received altered, repeated, or non-monotonic encoded media", leaf))
						return
					}
					if result.Frames == 0 {
						result.FirstIndex = matched
					}
					result.Frames++
					result.LastIndex, result.LastTimestamp, result.SSRC = matched, timestamp, packet.SSRC
					resultMu.Unlock()
				}
			}
		})
		connectEdgeToReceiver(t, edge, receiver)
	}
	checkIdleRelays := func() {
		for hop, receiver := range relays {
			relay := receiver.Source().relay
			relay.mu.Lock()
			started := relay.run != nil
			relay.mu.Unlock()
			if started {
				t.Fatalf("relay %d started derivation for a healthy reused representation", hop+1)
			}
		}
	}
	period := time.Second / 30
	ticker := time.NewTicker(period)
	defer ticker.Stop()
	for index, frame := range frames {
		select {
		case <-ticker.C:
		case readErr := <-errors:
			t.Fatal(readErr)
		}
		pts := time.Duration(index) * period
		_, err = host.BeginFrame(pts)
		check(err)
		check(host.WriteVideo(0, encoded.Frame{Data: frame.Data, PTS: pts, Duration: period, Recovery: frame.Recovery}))
		checkIdleRelays()
	}
	select {
	case readErr := <-errors:
		t.Fatal(readErr)
	case <-time.After(500 * time.Millisecond):
	}
	checkIdleRelays()
	closeAll()
	check(host.Close())
	for _, done := range leafDone {
		waitSignal(t, done, "chain leaf reader shutdown")
	}
	select {
	case readErr := <-errors:
		t.Fatal(readErr)
	default:
	}
	resultMu.Lock()
	actual := results
	resultMu.Unlock()
	for _, receiver := range relays {
		check(receiver.connection.GracefulClose())
		if receiver.connection.ConnectionState() != webrtc.PeerConnectionStateClosed {
			t.Fatal("chain retained a native inbound PeerConnection after cleanup")
		}
	}
	for leaf, result := range actual {
		if result.Frames < 120 {
			t.Fatalf("leaf %d has insufficient encoded reuse: %+v", leaf, result)
		}
	}
	for _, edge := range edges {
		// Close can return while a concurrent close is still retiring transport.
		check(edge.connection.GracefulClose())
		if edge.connection.ConnectionState() != webrtc.PeerConnectionStateClosed {
			t.Fatal("chain retained an outbound PeerConnection after cleanup")
		}
	}
	summary, err := json.Marshal(struct {
		InputFrames        int           `json:"inputFrames"`
		RelayHops          int           `json:"relayHops"`
		Leaves             [3]leafResult `json:"leaves"`
		DerivationObserved bool          `json:"derivationObserved"`
		Cleanup            bool          `json:"cleanup"`
	}{len(frames), 2, actual, false, true})
	check(err)
	t.Log(string(summary))
	if output := os.Getenv("SCREENER_POOL_CHAIN_OUTPUT"); output != "" {
		check(os.WriteFile(output, append(summary, '\n'), 0o600))
	}
}
