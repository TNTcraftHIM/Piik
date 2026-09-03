package mediaedge

import (
	"testing"
	"time"
)

type fixedTargetEstimator struct {
	target int
}

func (estimator fixedTargetEstimator) GetTargetBitrate() int {
	return estimator.target
}

func (estimator fixedTargetEstimator) OnTargetBitrateChange(callback func(int)) {
	callback(estimator.target)
}

func TestQualitySampleUsesEstimatorCapacityAgainstEncodedPayload(t *testing.T) {
	engine, err := NewEngine(EngineOptions{
		BindAddress: "127.0.0.1:0", IncludeLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close() })
	source, err := engine.NewSource(1, nil)
	if err != nil {
		t.Fatal(err)
	}
	edge, receiver, _ := connectedReceiver(t, engine, source, "limited-edge")
	t.Cleanup(func() { _ = receiver.Close() })
	edge.bandwidth = newBandwidthObserver(fixedTargetEstimator{target: 100_000})
	source.SetFormat(1280, 720)
	started := time.Now()
	if _, ok := edge.QualitySample(started); ok {
		t.Fatal("first quality sample did not establish a baseline")
	}
	source.frames.Add(60)
	source.bytes.Add(1_000_000)

	sample, ok := edge.QualitySample(started.Add(2 * time.Second))
	if !ok || sample.State != "degraded" || sample.Reason == nil ||
		*sample.Reason != "bandwidth" || sample.IntervalFramesEncoded != 60 ||
		sample.FramesPerSecond != 30 || sample.BitrateKbps != 4_000 ||
		sample.AvailableOutgoingKbps != 100 {
		t.Fatalf("quality sample = %+v, %v", sample, ok)
	}
}
