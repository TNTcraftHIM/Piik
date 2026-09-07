package mediaedge

import (
	"testing"
	"time"
)

func TestQualitySampleUsesEstimatorCapacityAgainstEncodedPayload(t *testing.T) {
	engine, err := NewEngine(EngineOptions{
		BindAddress: "127.0.0.1:0", IncludeLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close() })
	source, err := engine.NewSource("h264", 1, 1, nil)
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
}
