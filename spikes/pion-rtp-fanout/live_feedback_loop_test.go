package fanoutoracle

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

func TestLiveFeedbackLoopWithRealChromium(t *testing.T) {
	if os.Getenv("SCREENER_RUN_LIVE_FEEDBACK_LOOP") != "1" {
		t.Skip("set SCREENER_RUN_LIVE_FEEDBACK_LOOP=1 to run the one-shot 720p browser gate")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 55*time.Second)
	defer cancel()
	if _, err := RunLiveFeedbackLoopBrowserGate(ctx, LiveBridgeOptions{}); err != nil {
		t.Fatal(err)
	}
}

func TestLiveFeedbackControllerWaitsForBothTransportCCLegsAndAppliesMinimum(t *testing.T) {
	now := time.Unix(100, 0)
	controller, err := newLiveFeedbackController(func() time.Time { return now }, 2*time.Second, 3)
	if err != nil {
		t.Fatal(err)
	}

	if err = controller.ObserveTargetCallback(0, 600_000); err != nil {
		t.Fatal(err)
	}
	if err = controller.ObserveTargetCallback(1, 550_000); err != nil {
		t.Fatal(err)
	}
	if target := controller.Target(); target.Generation != 0 || target.TargetBitrate != 0 {
		t.Fatalf("target before Transport-CC = %+v", target)
	}
	if err = controller.ObserveTransportCC(0, 500_000); err != nil {
		t.Fatal(err)
	}
	if target := controller.Target(); target.Generation != 0 {
		t.Fatalf("target before second Transport-CC leg = %+v", target)
	}
	if err = controller.ObserveTransportCC(1, 400_000); err != nil {
		t.Fatal(err)
	}
	target := controller.Target()
	if target.Generation != 1 || target.TargetBitrate != 400_000 {
		t.Fatalf("first target = %+v", target)
	}

	first, err := controller.Acknowledge(liveEncoderTargetApplied{
		Kind:                       "target-applied",
		Generation:                 1,
		TargetBitrate:              400_000,
		EncoderInstances:           1,
		EncoderConfigureCalls:      2,
		FirstOutputTimestampMicros: 33333,
		FirstOutputKeyFrame:        true,
	})
	if err != nil || !first {
		t.Fatalf("first acknowledgment = %v, %v", first, err)
	}

	if err = controller.ObserveTargetCallback(0, 300_000); err != nil {
		t.Fatal(err)
	}
	if target = controller.Target(); target.Generation != 1 {
		t.Fatalf("target escaped the minimum interval = %+v", target)
	}
	now = now.Add(2 * time.Second)
	target = controller.Target()
	if target.Generation != 2 || target.TargetBitrate != 300_000 {
		t.Fatalf("coalesced second target = %+v", target)
	}
	if _, err = controller.Acknowledge(liveEncoderTargetApplied{
		Kind:                       "target-applied",
		Generation:                 2,
		TargetBitrate:              300_000,
		EncoderInstances:           1,
		EncoderConfigureCalls:      3,
		FirstOutputTimestampMicros: 66666,
		FirstOutputKeyFrame:        true,
	}); err != nil {
		t.Fatal(err)
	}
	if err = controller.Freeze(); err != nil {
		t.Fatal(err)
	}
	if err = controller.Finish(); err != nil {
		t.Fatal(err)
	}

	metrics := controller.Snapshot()
	if metrics.PublishedTargets[0] != 400_000 || metrics.PublishedTargets[1] != 300_000 ||
		metrics.LastAppliedTarget != 300_000 || metrics.OutstandingTargetUpdates != 0 {
		t.Fatalf("controller metrics = %+v", metrics)
	}
}

func TestLiveFeedbackControllerRejectsUnprovenApplicationAndCapsUpdates(t *testing.T) {
	now := time.Unix(200, 0)
	controller, err := newLiveFeedbackController(func() time.Time { return now }, time.Second, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err = controller.ObserveTransportCC(0, 600_000); err != nil {
		t.Fatal(err)
	}
	if err = controller.ObserveTransportCC(1, 500_000); err != nil {
		t.Fatal(err)
	}
	target := controller.Target()
	if _, err = controller.Acknowledge(liveEncoderTargetApplied{
		Generation:                 target.Generation,
		TargetBitrate:              target.TargetBitrate,
		EncoderInstances:           1,
		EncoderConfigureCalls:      2,
		FirstOutputTimestampMicros: 33333,
		FirstOutputKeyFrame:        false,
	}); err == nil {
		t.Fatal("accepted a target without a post-config key-frame output")
	}
	if _, err = controller.Acknowledge(liveEncoderTargetApplied{
		Generation:                 target.Generation,
		TargetBitrate:              target.TargetBitrate,
		EncoderInstances:           1,
		EncoderConfigureCalls:      2,
		FirstOutputTimestampMicros: 33333,
		FirstOutputKeyFrame:        true,
	}); err != nil {
		t.Fatal(err)
	}
	if err = controller.ObserveTargetCallback(0, 300_000); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Second)
	if got := controller.Target(); got.Generation != target.Generation {
		t.Fatalf("target generation exceeded cap: %+v", got)
	}
	if metrics := controller.Snapshot(); metrics.SuppressedTargetUpdates != 1 {
		t.Fatalf("suppressed updates = %d, want 1", metrics.SuppressedTargetUpdates)
	}
}

func TestLiveFeedbackHostPageUsesBounded720pProfile(t *testing.T) {
	page := liveBridgeHostPage("token", liveFeedbackBridgeProfile())
	for _, want := range []string{
		`"width":1280`,
		`"height":720`,
		`"frameCount":390`,
		`"initialBitrate":1200000`,
		`"feedbackLoop":true`,
		`await encoder.flush()`,
		`encoder.configure(targetSupport.config)`,
	} {
		if !strings.Contains(page, want) {
			t.Fatalf("host page lacks %q", want)
		}
	}
}
