package mediaedge

import (
	"errors"
	"fmt"
	"io"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/media/encoded"
	"github.com/TNTcraftHIM/Piik/internal/media/forwarding"
	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/livekit/livekit-server/pkg/sfu/streamtracker"
	"github.com/pion/webrtc/v4"
	"google.golang.org/protobuf/proto"
)

func TestSourceFrameSurvivesRetiringEdge(t *testing.T) {
	for _, layers := range []int{1, 2} {
		t.Run(fmt.Sprint(layers), func(t *testing.T) {
			engine, err := NewEngine(EngineOptions{BindAddress: "127.0.0.1:0", IncludeLoopback: true})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = engine.Close() })
			source, err := engine.NewSource("vp8", 2, layers, nil)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = source.Close() })
			if err = source.ConfigureOutputs([]uint32{300_000, 1_200_000}[:layers]); err != nil {
				t.Fatal(err)
			}
			healthy, _, packets := connectedReceiver(t, engine, source, "healthy")
			observed, _, _ := connectedReceiver(t, engine, source, "retiring-observation")
			retired, err := forwarding.NewTransport(forwarding.TransportOptions{
				Source: source.media.Source, ConnectionID: "retiring", InitialBitrate: 1_200_000,
			})
			if err != nil {
				t.Fatal(err)
			}
			if err = retired.Close(); err != nil {
				t.Fatal(err)
			}
			// Model the interleaving after observing connected but before attachment:
			// the transport has closed, while the source still holds the edge snapshot.
			// Borrow an independently live PC for that observation; no running edge is mutated.
			stale := &Edge{engine: engine, source: source, connection: observed.connection, transport: retired}
			source.mu.Lock()
			delete(source.edges, observed)
			source.edges[stale] = false
			source.mu.Unlock()
			for i := 0; i < 3; i++ {
				pts := time.Duration(i) * time.Second / 30
				if _, err = source.BeginFrame(pts); err != nil {
					t.Fatalf("edge close stopped source: %v", err)
				}
				if err = source.WriteVideo(layers-1, encoded.Frame{Data: sfu.VP8KeyFrame8x8, PTS: pts, Duration: time.Second / 30, Recovery: true}); err != nil {
					t.Fatal(err)
				}
			}
			if !stale.closed || healthy.State() != webrtc.PeerConnectionStateConnected {
				t.Fatal("retirement did not isolate the failed edge")
			}
			select {
			case <-packets:
			case <-time.After(5 * time.Second):
				t.Fatal("healthy sibling lost media")
			}
			if err = source.Close(); err != nil {
				t.Fatal(err)
			}
			if _, err = source.BeginFrame(time.Second); !errors.Is(err, io.ErrClosedPipe) {
				t.Fatalf("actual source closure was hidden: %v", err)
			}
		})
	}
}

func TestSourceFormatAdaptationPreservesLiveLayers(t *testing.T) {
	// A source needs no socket or codec process to exercise its RTP state.
	source, err := (&Engine{}).NewSource("vp8", 2, 2, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = source.Close() })
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	check(source.SetFormat(0, 640, 360))
	check(source.SetFormat(1, 1280, 720))
	check(source.ConfigureOutputs([]uint32{300_000, 1_200_000}))
	check(source.media.UpdateDimensions(0, 320, 180))
	check(source.SetFormat(0, 640, 360))
	if source.media.TrackInfo().Layers[0].Width != 640 {
		t.Fatal("unchanged actual dimensions did not replace stale metadata")
	}
	initialInfo := source.media.TrackInfo()
	buffers := source.media.GetAllBuffers()
	trackers := source.media.StreamTrackerManager()
	const period = time.Second / 25
	var pts time.Duration
	write := func() {
		t.Helper()
		// This check owns input explicitly; no consumer is present to request
		// codec activation through the separate demand planner.
		check(source.beginGroupFrame(pts, time.Now()))
		for layer := range 2 {
			check(source.WriteVideo(layer, encoded.Frame{Data: sfu.VP8KeyFrame8x8, PTS: pts, Duration: period}))
		}
		pts += period
	}
	ticker := time.NewTicker(period)
	defer ticker.Stop()
	deadline := time.NewTimer(6 * time.Second)
	defer deadline.Stop()
	for {
		select {
		case <-ticker.C:
		case <-deadline.C:
			t.Fatal("live layers produced no measured bitrate")
		}
		write()
		_, rates := source.media.GetLayeredBitrate()
		if rates[0][0] > 0 && rates[1][0] > 0 {
			break
		}
	}
	want := source.media.TrackInfo()
	for _, width := range []uint32{320, 320, 640} {
		before := source.media.TrackInfo()
		clock := buffers[0].GetSenderReportData()
		check(source.SetFormat(0, width, width*9/16))
		want.Layers[0].Width, want.Layers[0].Height = width, width*9/16
		want.Codecs[0].Layers[0].Width, want.Codecs[0].Layers[0].Height = width, width*9/16
		if !proto.Equal(source.media.TrackInfo(), want) || source.formats[0].Load() != uint64(width)<<32|uint64(width*9/16) {
			t.Fatal("adapted dimensions did not reach layer and codec metadata")
		}
		before.Layers[1].Width = 1
		if source.media.TrackInfo().Layers[1].Width != 1280 || initialInfo.Layers[0].Width != 640 {
			t.Fatal("dimension metadata escaped its immutable snapshot")
		}
		for layer := range 2 {
			tracker := trackers.GetTracker(int32(layer))
			if tracker == nil || tracker.Status() != streamtracker.StreamStatusActive || tracker.BitrateTemporalCumulative()[0] == 0 ||
				source.media.GetAllBuffers()[layer] != buffers[layer] {
				t.Fatalf("dimension update reset live layer %d", layer)
			}
		}
		if !proto.Equal(clock, buffers[0].GetSenderReportData()) {
			t.Fatal("dimension update changed the source clock or counters")
		}
		write()
		after := buffers[0].GetSenderReportData()
		if after.Packets != clock.Packets+1 || after.Octets <= clock.Octets || after.RtpTimestamp-clock.RtpTimestamp != 3600 ||
			after.NtpTimestamp <= clock.NtpTimestamp {
			t.Fatal("adapted output did not retain the source RTP timeline")
		}
	}
	for _, format := range [][3]int{{-1, 320, 180}, {2, 320, 180}, {0, 0, 180}, {0, 320, 0}} {
		if source.SetFormat(format[0], uint32(format[1]), uint32(format[2])) == nil ||
			source.media.UpdateDimensions(format[0], uint32(format[1]), uint32(format[2])) == nil {
			t.Fatal("invalid output dimensions were accepted")
		}
	}
	if !proto.Equal(source.media.TrackInfo(), want) {
		t.Fatal("invalid format changed source metadata")
	}
	check(source.Close())
	if !errors.Is(source.SetFormat(0, 640, 360), io.ErrClosedPipe) ||
		!errors.Is(source.media.UpdateDimensions(0, 640, 360), sfu.ErrReceiverClosed) {
		t.Fatal("closed source accepted new dimensions")
	}
}
