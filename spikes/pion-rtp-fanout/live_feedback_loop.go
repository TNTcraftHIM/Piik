package fanoutoracle

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"time"
)

const (
	liveFeedbackTargetMinInterval = 2 * time.Second
	liveFeedbackMaxTargetUpdates  = 6
	liveFeedbackDropAfterArm      = 30
)

// LiveFeedbackLoopMetrics records the narrow stock-GCC-to-one-WebCodecs
// control loop. It is not a general congestion-control implementation.
type LiveFeedbackLoopMetrics struct {
	Verdict                  string                            `json:"verdict"`
	Policy                   string                            `json:"policy"`
	MinimumBitrate           int                               `json:"minimumBitrate"`
	MaximumBitrate           int                               `json:"maximumBitrate"`
	MinimumUpdateMillis      int64                             `json:"minimumUpdateMillis"`
	MaximumTargetUpdates     int                               `json:"maximumTargetUpdates"`
	Legs                     [feedbackLegCount]LiveFeedbackLeg `json:"legs"`
	PublishedTargets         []int                             `json:"publishedTargets"`
	AppliedTargets           []int                             `json:"appliedTargets"`
	CandidateTarget          int                               `json:"candidateTarget"`
	LastAppliedTarget        int                               `json:"lastAppliedTarget"`
	SuppressedTargetUpdates  int                               `json:"suppressedTargetUpdates"`
	OutstandingTargetUpdates int                               `json:"outstandingTargetUpdates"`
	FeedbackFrozen           bool                              `json:"feedbackFrozen"`
	ProductLinked            bool                              `json:"productLinked"`
}

// LiveFeedbackLeg is observed after stock Pion has processed Transport-CC.
type LiveFeedbackLeg struct {
	TransportCCPackets     int `json:"transportCcPackets"`
	TargetBitrateCallbacks int `json:"targetBitrateCallbacks"`
	LatestEstimate         int `json:"latestEstimate"`
}

type liveEncoderTarget struct {
	Generation    uint64 `json:"generation"`
	TargetBitrate int    `json:"targetBitrate"`
}

type liveEncoderTargetApplied struct {
	Kind                       string `json:"kind"`
	Generation                 uint64 `json:"generation"`
	TargetBitrate              int    `json:"targetBitrate"`
	EncoderInstances           int    `json:"encoderInstances"`
	EncoderConfigureCalls      int    `json:"encoderConfigureCalls"`
	FirstOutputTimestampMicros int64  `json:"firstOutputTimestampMicros"`
	FirstOutputKeyFrame        bool   `json:"firstOutputKeyFrame"`
}

type liveFeedbackController struct {
	mu              sync.Mutex
	now             func() time.Time
	minimumInterval time.Duration
	maximumUpdates  int
	selector        *sharedBitrateTarget
	legs            [feedbackLegCount]LiveFeedbackLeg
	candidate       int
	current         liveEncoderTarget
	awaitingAck     bool
	nextEligible    time.Time
	published       []int
	applied         []int
	suppressed      int
	frozen          bool
	finished        bool
}

func newLiveFeedbackController(
	now func() time.Time, minimumInterval time.Duration, maximumUpdates int,
) (*liveFeedbackController, error) {
	if now == nil {
		return nil, errors.New("live feedback clock is required")
	}
	if minimumInterval <= 0 || maximumUpdates < 1 {
		return nil, errors.New("live feedback update bounds must be positive")
	}
	selector, err := newSharedBitrateTarget(feedbackEncoderMinBitrate, feedbackEncoderMaxBitrate)
	if err != nil {
		return nil, err
	}
	return &liveFeedbackController{
		now:             now,
		minimumInterval: minimumInterval,
		maximumUpdates:  maximumUpdates,
		selector:        selector,
		published:       make([]int, 0, maximumUpdates),
		applied:         make([]int, 0, maximumUpdates),
	}, nil
}

func (controller *liveFeedbackController) ObserveTransportCC(leg, estimate int) error {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if controller.frozen || controller.finished {
		return nil
	}
	if leg < 0 || leg >= feedbackLegCount {
		return fmt.Errorf("live feedback leg = %d, want 0 or 1", leg)
	}
	controller.legs[leg].TransportCCPackets++
	return controller.updateEstimateLocked(leg, estimate)
}

func (controller *liveFeedbackController) ObserveTargetCallback(leg, estimate int) error {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if controller.frozen || controller.finished {
		return nil
	}
	if leg < 0 || leg >= feedbackLegCount {
		return fmt.Errorf("live feedback callback leg = %d, want 0 or 1", leg)
	}
	controller.legs[leg].TargetBitrateCallbacks++
	return controller.updateEstimateLocked(leg, estimate)
}

func (controller *liveFeedbackController) updateEstimateLocked(leg, estimate int) error {
	_, _, err := controller.selector.Update(leg, estimate)
	if err != nil {
		return err
	}
	controller.legs[leg].LatestEstimate = estimate
	if controller.legs[0].TransportCCPackets > 0 && controller.legs[1].TransportCCPackets > 0 {
		controller.candidate = controller.selector.selected
	}
	return nil
}

func (controller *liveFeedbackController) Target() liveEncoderTarget {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	controller.publishLocked()
	return controller.current
}

func (controller *liveFeedbackController) Freeze() error {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if controller.candidate == 0 {
		return errors.New("cannot freeze live feedback before both legs produce Transport-CC")
	}
	controller.frozen = true
	return nil
}

func (controller *liveFeedbackController) publishLocked() {
	if controller.awaitingAck || controller.candidate == 0 || controller.candidate == lastInt(controller.applied) {
		return
	}
	if !controller.nextEligible.IsZero() && controller.now().Before(controller.nextEligible) {
		return
	}
	if len(controller.published) >= controller.maximumUpdates {
		controller.suppressed++
		return
	}
	controller.current.Generation++
	controller.current.TargetBitrate = controller.candidate
	controller.published = append(controller.published, controller.candidate)
	controller.awaitingAck = true
}

func (controller *liveFeedbackController) Acknowledge(applied liveEncoderTargetApplied) (bool, error) {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if !controller.awaitingAck {
		return false, errors.New("live encoder target acknowledgment has no outstanding target")
	}
	if applied.Generation != controller.current.Generation || applied.TargetBitrate != controller.current.TargetBitrate {
		return false, fmt.Errorf(
			"live encoder target acknowledgment = %d/%d, want %d/%d",
			applied.Generation,
			applied.TargetBitrate,
			controller.current.Generation,
			controller.current.TargetBitrate,
		)
	}
	if applied.EncoderInstances != 1 || applied.EncoderConfigureCalls != len(controller.applied)+2 {
		return false, errors.New("live encoder target acknowledgment changed the encoder instance/configure contract")
	}
	if applied.FirstOutputTimestampMicros <= 0 || !applied.FirstOutputKeyFrame {
		return false, errors.New("live encoder target was not followed by a key-frame output")
	}
	first := len(controller.applied) == 0
	controller.applied = append(controller.applied, applied.TargetBitrate)
	controller.awaitingAck = false
	controller.nextEligible = controller.now().Add(controller.minimumInterval)
	return first, nil
}

func (controller *liveFeedbackController) Finish() error {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if !controller.frozen {
		return errors.New("live feedback loop finished before its bounded observation window froze")
	}
	if controller.awaitingAck {
		return errors.New("live feedback loop finished with an outstanding encoder target")
	}
	if controller.candidate == 0 || controller.candidate != lastInt(controller.applied) {
		return fmt.Errorf(
			"live feedback loop finished with candidate %d and applied target %d",
			controller.candidate,
			lastInt(controller.applied),
		)
	}
	controller.finished = true
	return nil
}

func (controller *liveFeedbackController) Snapshot() LiveFeedbackLoopMetrics {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	outstanding := 0
	if controller.awaitingAck {
		outstanding = 1
	}
	return LiveFeedbackLoopMetrics{
		Policy:                   "minimum-of-two-feedback-ready-stock-gcc-estimates",
		MinimumBitrate:           feedbackEncoderMinBitrate,
		MaximumBitrate:           feedbackEncoderMaxBitrate,
		MinimumUpdateMillis:      controller.minimumInterval.Milliseconds(),
		MaximumTargetUpdates:     controller.maximumUpdates,
		Legs:                     controller.legs,
		PublishedTargets:         slices.Clone(controller.published),
		AppliedTargets:           slices.Clone(controller.applied),
		CandidateTarget:          controller.candidate,
		LastAppliedTarget:        lastInt(controller.applied),
		SuppressedTargetUpdates:  controller.suppressed,
		OutstandingTargetUpdates: outstanding,
		FeedbackFrozen:           controller.frozen,
	}
}

func lastInt(values []int) int {
	if len(values) == 0 {
		return 0
	}
	return values[len(values)-1]
}

// RunLiveFeedbackLoopBrowserGate is an opt-in, isolated real-browser gate.
func RunLiveFeedbackLoopBrowserGate(
	ctx context.Context, options LiveBridgeOptions,
) (LiveBridgeResult, error) {
	result, err := runLiveBridge(ctx, options, liveBridgeRunOptions{
		primaryRetransmission: true,
		feedbackLoop:          true,
	})
	if err != nil {
		return LiveBridgeResult{}, err
	}
	if err = validatePrimaryRetransmissionResultWithOptions(result, primaryValidationOptions{
		expectedDropAttempt:      liveFeedbackDropAfterArm,
		allowCleanRecoveryMarker: true,
	}); err != nil {
		return LiveBridgeResult{}, err
	}
	if err = validateLiveFeedbackLoopResult(result); err != nil {
		return LiveBridgeResult{}, err
	}
	result.FeedbackLoop.Verdict = "go-bounded-live-shared-encoder-target"
	result.PrimaryRetransmission.Verdict = "go-bounded-primary-ssrc-retransmission"
	result.HardStops = []string{
		"the target loop is capped at six updates with a two-second interval; general hysteresis and sustained adaptation are unproven",
		"identical-sequence retransmission is not RFC4588 repair and can distort RTP/RTCP loss statistics",
		"one Chrome loopback run with one isolated packet loss does not prove browser, path, or loss-pattern diversity",
		"PLI/FIR-to-WebCodecs control, audio, TURN, reconnect, and product-controller integration are not implemented",
	}
	return result, nil
}

func validateLiveFeedbackLoopResult(result LiveBridgeResult) error {
	feedback := result.FeedbackLoop
	if feedback == nil {
		return errors.New("live feedback-loop metrics are missing")
	}
	if feedback.ProductLinked || feedback.Policy != "minimum-of-two-feedback-ready-stock-gcc-estimates" {
		return errors.New("live feedback-loop product or policy boundary changed")
	}
	if feedback.MinimumBitrate != feedbackEncoderMinBitrate || feedback.MaximumBitrate != feedbackEncoderMaxBitrate ||
		feedback.MinimumUpdateMillis != liveFeedbackTargetMinInterval.Milliseconds() ||
		feedback.MaximumTargetUpdates != liveFeedbackMaxTargetUpdates {
		return fmt.Errorf("live feedback-loop bounds changed: %+v", feedback)
	}
	if !feedback.FeedbackFrozen || feedback.SuppressedTargetUpdates != 0 || feedback.OutstandingTargetUpdates != 0 {
		return fmt.Errorf("live feedback-loop updates escaped the measured cadence: %+v", feedback)
	}
	if len(feedback.PublishedTargets) == 0 || !slices.Equal(feedback.PublishedTargets, feedback.AppliedTargets) {
		return fmt.Errorf("live feedback-loop targets were not all applied: %+v", feedback)
	}
	if len(feedback.AppliedTargets) > liveFeedbackMaxTargetUpdates || feedback.LastAppliedTarget != lastInt(feedback.AppliedTargets) {
		return fmt.Errorf("live feedback-loop application count is unbounded: %+v", feedback)
	}
	for index, leg := range feedback.Legs {
		if leg.TransportCCPackets < 1 || leg.LatestEstimate < feedbackEncoderMinBitrate || leg.LatestEstimate > feedbackEncoderMaxBitrate {
			return fmt.Errorf("feedback leg %d lacks a bounded stock GCC estimate: %+v", index+1, leg)
		}
	}
	wantTarget := min(feedback.Legs[0].LatestEstimate, feedback.Legs[1].LatestEstimate)
	wantTarget = max(feedbackEncoderMinBitrate, min(feedbackEncoderMaxBitrate, wantTarget))
	if feedback.CandidateTarget != wantTarget || feedback.LastAppliedTarget != wantTarget {
		return fmt.Errorf("live feedback-loop final target = candidate %d applied %d, want %d", feedback.CandidateTarget, feedback.LastAppliedTarget, wantTarget)
	}

	host := result.Host
	if host.InitialBitrate != liveFeedbackInitialBitrate || host.EncoderInstances != 1 ||
		host.TargetApplications != len(feedback.AppliedTargets) ||
		host.EncoderConfigureCalls != host.TargetApplications+1 ||
		!slices.Equal(host.AppliedTargetBitrates, feedback.AppliedTargets) {
		return fmt.Errorf("host did not apply targets on one encoder: %+v", host)
	}
	if host.EncoderInputsAfterTarget < primaryRetransmissionMinCallbacksAfterRecovery ||
		host.EncoderOutputsAfterTarget < primaryRetransmissionMinCallbacksAfterRecovery {
		return fmt.Errorf("host lacked sustained encoding after target application: %+v", host)
	}
	for index, downstream := range result.Downstream {
		browser := downstream.Browser
		if !browser.RecoveryObserved ||
			browser.FramesDecodedAfterRecovery < primaryRetransmissionMinCallbacksAfterRecovery ||
			browser.RenderedCallbacksAfterRecovery < primaryRetransmissionMinCallbacksAfterRecovery {
			return fmt.Errorf("viewer %d did not sustain decode/presentation after shared recovery: %+v", index+1, browser)
		}
	}
	return nil
}
