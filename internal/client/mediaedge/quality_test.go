package mediaedge

import (
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/media/encoded"
	"github.com/TNTcraftHIM/Piik/internal/media/forwarding"
	"github.com/livekit/livekit-server/pkg/sfu"
)

type qualityAllocationReceiver struct{ sfu.TrackReceiver }

func (receiver qualityAllocationReceiver) GetLayeredBitrate() ([]int32, sfu.Bitrates) {
	return []int32{0, 1}, sfu.Bitrates{{100_000}, {900_000}}
}

func TestQualityDimensionsFollowAssignedSource(t *testing.T) {
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	engine, err := NewEngine(EngineOptions{BindAddress: "127.0.0.1:0", IncludeLoopback: true})
	check(err)
	defer engine.Close()
	source, err := engine.NewSource("vp8", 1, 2, nil)
	check(err)
	defer source.Close()
	check(source.SetFormat(0, 320, 180))
	check(source.SetFormat(1, 640, 360))
	check(source.ConfigureOutputs([]uint32{90_000, 300_000}))
	edge, receiver, _ := connectedReceiver(t, engine, source, "assigned-quality")
	defer receiver.Close()
	assigned, err := forwarding.NewEncodedSource(forwarding.SourceOptions{
		ID: string(source.media.TrackID()), StreamID: source.media.StreamID(), Codec: source.media.Codec(), MaxPackets: encoded.MaxPacketWindow,
		Formats: []forwarding.LayerFormat{{Width: 4, Height: 4, Bitrate: 45_000}, {Width: 8, Height: 8, Bitrate: 150_000}},
	})
	check(err)
	defer assigned.Close()
	check(assigned.BeginFrame(0, time.Now()))
	check(assigned.WriteFrame(1, encoded.Frame{Data: sfu.VP8KeyFrame8x8, Duration: time.Second / 30, Recovery: true}))
	check(edge.transport.ReplaceSource(assigned.Source))
	deadline := time.Now().Add(3 * time.Second)
	for frame := 1; time.Now().Before(deadline); frame++ {
		pts := time.Duration(frame) * time.Second / 30
		check(assigned.BeginFrame(pts, time.Now()))
		check(assigned.WriteFrame(1, encoded.Frame{Data: sfu.VP8KeyFrame8x8, PTS: pts, Duration: time.Second / 30, Recovery: true}))
		frames, _, format := edge.videoCounters()
		if frames > 0 && format == uint64(8)<<32|8 {
			return
		}
		time.Sleep(time.Second / 30)
	}
	_, _, format := edge.videoCounters()
	t.Fatalf("quality dimensions still refer to original source: %dx%d", uint32(format>>32), uint32(format))
}

func TestQualitySampleUsesEstimatorCapacityAgainstEncodedPayload(t *testing.T) {
	engine, err := NewEngine(EngineOptions{
		BindAddress: "127.0.0.1:0", IncludeLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close() })
	source, err := engine.NewSource("h264", 1, 2, nil)
	if err != nil {
		t.Fatal(err)
	}
	edge, receiver, _ := connectedReceiver(t, engine, source, "limited-edge")
	t.Cleanup(func() { _ = receiver.Close() })
	edge.targetBitrate = func() (int, bool) { return 100_000, true }
	// Encoded relay sources need no decoded dimensions to compare payload and capacity.
	started := time.Now()
	if _, ok := edge.QualitySample(started); ok {
		t.Fatal("first quality sample did not establish a baseline")
	}
	stats := edge.transport.Output.GetState().RTPStats
	stats.SetClockRate(videoClockRate)
	for frame := 0; frame < 60; frame++ {
		size := 16_666
		if frame == 59 {
			size += 40
		}
		stats.Update(started.Add(time.Duration(frame)*time.Second/30).UnixNano(),
			uint64(frame+1), uint64(frame*3000), true, 12, size, 0, false)
	}
	// The library does not publish a zero-duration statistics snapshot.
	time.Sleep(time.Millisecond)

	sample, ok := edge.QualitySample(started.Add(2 * time.Second))
	if !ok || sample.State != "degraded" || sample.Reason == nil ||
		*sample.Reason != "bandwidth" || sample.IntervalFramesEncoded != 60 ||
		sample.FramesPerSecond != 30 || sample.BitrateKbps != 4_000 ||
		sample.AvailableOutgoingKbps != 100 {
		t.Fatalf("quality sample = %+v, %v", sample, ok)
	}

	// Real library allocation remains deficient after selecting a layer that
	// fits the link; steady low delivery must not cancel quality convergence.
	output := edge.transport.Output
	output.SetReceiver(qualityAllocationReceiver{TrackReceiver: output.Receiver()})
	output.UpTrackMaxPublishedLayerChange(1)
	output.UpTrackMaxTemporalLayerSeenChange(0)
	output.SetMaxSpatialLayer(1)
	for index, check := range []struct {
		budget, sent int
		layer        int32
		state        string
	}{
		{200_000, 100_000, 0, "degraded"},
		{1_000_000, 900_000, 1, "healthy"},
	} {
		output.SetBudget(int64(check.budget))
		edge.targetBitrate = func() (int, bool) { return check.budget, true }
		if output.State().Target != check.layer || output.IsDeficient() != (check.state == "degraded") {
			t.Fatalf("fixture did not establish the expected committed allocation: %+v", output.State())
		}
		bytes := check.sent / 4
		for frame := 0; frame < 60; frame++ {
			number := uint64((index+1)*60 + frame + 1)
			size := bytes / 60
			if frame == 59 {
				size += bytes % 60
			}
			stats.Update(started.Add(time.Duration(number)*time.Second/30).UnixNano(), number,
				number*3000, true, 12, size, 0, false)
		}
		sample, ok = edge.QualitySample(started.Add(time.Duration(index+2) * 2 * time.Second))
		if !ok || sample.State != check.state || sample.BitrateKbps != float64(check.sent)/1000 {
			t.Fatalf("allocation %d quality = %+v, %v", index, sample, ok)
		}
	}
}
