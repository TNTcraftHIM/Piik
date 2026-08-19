package fanoutoracle

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"time"

	"github.com/pion/rtcp"
)

const (
	feedbackLegCount          = 2
	feedbackNACKCachePackets  = 512
	feedbackEncoderMinBitrate = 150_000
	feedbackEncoderMaxBitrate = 600_000
)

// FeedbackControlOracleResult records the bounded transport-control decision.
// A successful run is expected to report a no-go for stock Pion GCC plus RTX.
type FeedbackControlOracleResult struct {
	Verdict       string             `json:"verdict"`
	KeyFrames     KeyFrameMergeTrace `json:"keyFrames"`
	Bitrate       SharedBitrateTrace `json:"bitrate"`
	NACKRTX       NACKRTXTrace       `json:"nackRtx"`
	StockGCCRTX   StockGCCRTXTrace   `json:"stockGccRtx"`
	ProductLinked bool               `json:"productLinked"`
	HardStops     []string           `json:"hardStops"`
}

// KeyFrameMergeTrace is a deterministic PLI/FIR merge trace.
type KeyFrameMergeTrace struct {
	PLIByLeg                [feedbackLegCount]int `json:"pliByLeg"`
	FIREntriesByLeg         [feedbackLegCount]int `json:"firEntriesByLeg"`
	DuplicateFIR            int                   `json:"duplicateFir"`
	FIRRetriesAfterTwoRTT   int                   `json:"firRetriesAfterTwoRtt"`
	CoalescedWhilePending   int                   `json:"coalescedWhilePending"`
	EncoderRequests         int                   `json:"encoderRequests"`
	ObservedKeyFrames       int                   `json:"observedKeyFrames"`
	RequestToKeyFrameMillis []int64               `json:"requestToKeyFrameMillis"`
}

// SharedBitrateTrace records the conservative one-encode target policy.
type SharedBitrateTrace struct {
	Policy                 string                `json:"policy"`
	MinimumBitrate         int                   `json:"minimumBitrate"`
	MaximumBitrate         int                   `json:"maximumBitrate"`
	NoTargetBeforeBothLegs bool                  `json:"noTargetBeforeBothLegs"`
	LegEstimates           [feedbackLegCount]int `json:"legEstimates"`
	SelectedTargets        []int                 `json:"selectedTargets"`
}

type firIdentity struct {
	leg        int
	senderSSRC uint32
	targetSSRC uint32
}

type firState struct {
	sequence       uint8
	hasSequence    bool
	lastRefresh    time.Time
	hasLastRefresh bool
}

type keyFrameMerger struct {
	mu           sync.Mutex
	now          func() time.Time
	emit         func() error
	pending      bool
	pendingSince time.Time
	pendingFIR   map[firIdentity]struct{}
	fir          map[firIdentity]firState
	metrics      KeyFrameMergeTrace
}

func newKeyFrameMerger(now func() time.Time, emit func() error) *keyFrameMerger {
	return &keyFrameMerger{
		now:        now,
		emit:       emit,
		pendingFIR: map[firIdentity]struct{}{},
		fir:        map[firIdentity]firState{},
	}
}

func (merger *keyFrameMerger) HandleRTCP(leg int, packets []rtcp.Packet, rtt time.Duration) error {
	if leg < 0 || leg >= feedbackLegCount {
		return fmt.Errorf("feedback leg = %d, want 0 or 1", leg)
	}

	merger.mu.Lock()
	defer merger.mu.Unlock()
	for _, packet := range packets {
		switch feedback := packet.(type) {
		case *rtcp.PictureLossIndication:
			merger.metrics.PLIByLeg[leg]++
			if err := merger.requestLocked(); err != nil {
				return err
			}
		case *rtcp.FullIntraRequest:
			for _, entry := range feedback.FIR {
				merger.metrics.FIREntriesByLeg[leg]++
				identity := firIdentity{leg: leg, senderSSRC: feedback.SenderSSRC, targetSSRC: entry.SSRC}
				state := merger.fir[identity]
				sameSequence := state.hasSequence && state.sequence == entry.SequenceNumber
				if sameSequence {
					// RFC 5104 repeats one FIR sequence until the prior refresh has had two RTTs to arrive.
					if !state.hasLastRefresh || rtt <= 0 || merger.now().Sub(state.lastRefresh) <= 2*rtt {
						merger.metrics.DuplicateFIR++
						continue
					}
					merger.metrics.FIRRetriesAfterTwoRTT++
				}

				if err := merger.requestLocked(); err != nil {
					return err
				}
				if !sameSequence {
					state.sequence = entry.SequenceNumber
					state.hasSequence = true
					state.hasLastRefresh = false
					merger.fir[identity] = state
				}
				merger.pendingFIR[identity] = struct{}{}
			}
		}
	}
	return nil
}

func (merger *keyFrameMerger) requestLocked() error {
	if merger.pending {
		merger.metrics.CoalescedWhilePending++
		return nil
	}
	if err := merger.emit(); err != nil {
		return err
	}
	merger.pending = true
	merger.pendingSince = merger.now()
	merger.metrics.EncoderRequests++
	return nil
}

func (merger *keyFrameMerger) ObserveKeyFrame() {
	merger.mu.Lock()
	defer merger.mu.Unlock()
	merger.metrics.ObservedKeyFrames++
	if !merger.pending {
		return
	}

	now := merger.now()
	merger.metrics.RequestToKeyFrameMillis = append(
		merger.metrics.RequestToKeyFrameMillis,
		now.Sub(merger.pendingSince).Milliseconds(),
	)
	for identity := range merger.pendingFIR {
		state := merger.fir[identity]
		state.lastRefresh = now
		state.hasLastRefresh = true
		merger.fir[identity] = state
		delete(merger.pendingFIR, identity)
	}
	merger.pending = false
}

func (merger *keyFrameMerger) Snapshot() KeyFrameMergeTrace {
	merger.mu.Lock()
	defer merger.mu.Unlock()
	result := merger.metrics
	result.RequestToKeyFrameMillis = append([]int64(nil), merger.metrics.RequestToKeyFrameMillis...)
	return result
}

type sharedBitrateTarget struct {
	minimum  int
	maximum  int
	estimate [feedbackLegCount]int
	ready    [feedbackLegCount]bool
	selected int
}

// newSharedBitrateTarget keeps one representation within encoder bounds while
// leaving each transport's bandwidth estimator independent.
func newSharedBitrateTarget(minimum, maximum int) (*sharedBitrateTarget, error) {
	if minimum <= 0 || maximum < minimum {
		return nil, fmt.Errorf("invalid encoder bitrate bounds %d..%d", minimum, maximum)
	}
	return &sharedBitrateTarget{minimum: minimum, maximum: maximum}, nil
}

func (target *sharedBitrateTarget) Update(leg, estimate int) (int, bool, error) {
	if leg < 0 || leg >= feedbackLegCount {
		return 0, false, fmt.Errorf("bitrate leg = %d, want 0 or 1", leg)
	}
	if estimate <= 0 {
		return 0, false, fmt.Errorf("bitrate estimate = %d, want positive", estimate)
	}
	target.estimate[leg] = estimate
	target.ready[leg] = true
	if !target.ready[0] || !target.ready[1] {
		return 0, false, nil
	}

	selected := min(target.estimate[0], target.estimate[1])
	selected = max(target.minimum, min(target.maximum, selected))
	if selected == target.selected {
		return selected, false, nil
	}
	target.selected = selected
	return selected, true, nil
}

// RunFeedbackControlOracle executes only deterministic traces. It does not
// start browsers or connect the spike to Screener's product media path.
func RunFeedbackControlOracle(ctx context.Context) (FeedbackControlOracleResult, error) {
	keyFrames, err := runKeyFrameMergeTrace()
	if err != nil {
		return FeedbackControlOracleResult{}, err
	}
	bitrate, err := runSharedBitrateTrace()
	if err != nil {
		return FeedbackControlOracleResult{}, err
	}
	nackRTX, rtxPacket, err := runNACKRTXTrace(ctx)
	if err != nil {
		return FeedbackControlOracleResult{}, err
	}
	stockGCCRTX, err := runStockGCCRTXTrace(rtxPacket)
	if err != nil {
		return FeedbackControlOracleResult{}, err
	}

	result := FeedbackControlOracleResult{
		Verdict:       "no-go-stock-pion-gcc-rtx",
		KeyFrames:     keyFrames,
		Bitrate:       bitrate,
		NACKRTX:       nackRTX,
		StockGCCRTX:   stockGCCRTX,
		ProductLinked: false,
		HardStops: []string{
			"Pion interceptor v0.1.47 stock GCC pacers reject negotiated RTX SSRC writes",
			"a custom RTX-aware pacer or interceptor reordering is not accepted by this spike",
			"the deterministic PLI/FIR policy is not wired to a real encoder",
			"the minimum-of-two bitrate policy is not driven by two live browser paths",
			"pacing, TURN, reconnect, audio, and sustained-load behavior remain unverified",
		},
	}
	if err = validateFeedbackControlOracle(result); err != nil {
		return FeedbackControlOracleResult{}, err
	}
	return result, nil
}

func runKeyFrameMergeTrace() (KeyFrameMergeTrace, error) {
	now := time.Unix(0, 0)
	requests := 0
	merger := newKeyFrameMerger(func() time.Time { return now }, func() error {
		requests++
		return nil
	})

	if err := merger.HandleRTCP(0, []rtcp.Packet{&rtcp.PictureLossIndication{}}, 50*time.Millisecond); err != nil {
		return KeyFrameMergeTrace{}, err
	}
	now = now.Add(10 * time.Millisecond)
	if err := merger.HandleRTCP(1, []rtcp.Packet{&rtcp.PictureLossIndication{}}, 50*time.Millisecond); err != nil {
		return KeyFrameMergeTrace{}, err
	}
	fir := &rtcp.FullIntraRequest{SenderSSRC: 10, FIR: []rtcp.FIREntry{{SSRC: 20, SequenceNumber: 7}}}
	now = now.Add(10 * time.Millisecond)
	if err := merger.HandleRTCP(0, []rtcp.Packet{fir}, 50*time.Millisecond); err != nil {
		return KeyFrameMergeTrace{}, err
	}
	now = now.Add(5 * time.Millisecond)
	if err := merger.HandleRTCP(1, []rtcp.Packet{fir}, 50*time.Millisecond); err != nil {
		return KeyFrameMergeTrace{}, err
	}
	now = now.Add(5 * time.Millisecond)
	if err := merger.HandleRTCP(0, []rtcp.Packet{fir}, 50*time.Millisecond); err != nil {
		return KeyFrameMergeTrace{}, err
	}
	now = now.Add(10 * time.Millisecond)
	merger.ObserveKeyFrame()

	now = now.Add(40 * time.Millisecond)
	if err := merger.HandleRTCP(0, []rtcp.Packet{fir}, 50*time.Millisecond); err != nil {
		return KeyFrameMergeTrace{}, err
	}
	now = now.Add(80 * time.Millisecond)
	if err := merger.HandleRTCP(0, []rtcp.Packet{fir}, 50*time.Millisecond); err != nil {
		return KeyFrameMergeTrace{}, err
	}
	now = now.Add(20 * time.Millisecond)
	merger.ObserveKeyFrame()

	now = now.Add(20 * time.Millisecond)
	fir.FIR[0].SequenceNumber = 8
	if err := merger.HandleRTCP(0, []rtcp.Packet{fir}, 50*time.Millisecond); err != nil {
		return KeyFrameMergeTrace{}, err
	}
	now = now.Add(20 * time.Millisecond)
	merger.ObserveKeyFrame()

	result := merger.Snapshot()
	if requests != result.EncoderRequests {
		return KeyFrameMergeTrace{}, errors.New("key-frame request callback and metrics differ")
	}
	return result, nil
}

func runSharedBitrateTrace() (SharedBitrateTrace, error) {
	target, err := newSharedBitrateTarget(feedbackEncoderMinBitrate, feedbackEncoderMaxBitrate)
	if err != nil {
		return SharedBitrateTrace{}, err
	}
	result := SharedBitrateTrace{
		Policy:                 "minimum-of-two-ready-leg-estimates",
		MinimumBitrate:         feedbackEncoderMinBitrate,
		MaximumBitrate:         feedbackEncoderMaxBitrate,
		NoTargetBeforeBothLegs: true,
	}
	updates := [][2]int{{0, 900_000}, {1, 700_000}, {0, 400_000}, {1, 100_000}, {0, 1_200_000}, {1, 2_000_000}}
	for index, update := range updates {
		selected, changed, updateErr := target.Update(update[0], update[1])
		if updateErr != nil {
			return SharedBitrateTrace{}, updateErr
		}
		if index == 0 && (selected != 0 || changed) {
			result.NoTargetBeforeBothLegs = false
		}
		if changed {
			result.SelectedTargets = append(result.SelectedTargets, selected)
		}
	}
	result.LegEstimates = target.estimate
	return result, nil
}

func validateFeedbackControlOracle(result FeedbackControlOracleResult) error {
	if result.Verdict != "no-go-stock-pion-gcc-rtx" || result.ProductLinked {
		return errors.New("feedback-control verdict or product boundary changed")
	}
	if result.KeyFrames.PLIByLeg != [feedbackLegCount]int{1, 1} ||
		result.KeyFrames.FIREntriesByLeg != [feedbackLegCount]int{5, 1} ||
		result.KeyFrames.EncoderRequests != 3 || result.KeyFrames.ObservedKeyFrames != 3 ||
		result.KeyFrames.CoalescedWhilePending != 3 ||
		result.KeyFrames.DuplicateFIR != 2 || result.KeyFrames.FIRRetriesAfterTwoRTT != 1 {
		return fmt.Errorf("unexpected key-frame merge trace: %+v", result.KeyFrames)
	}
	if !slices.Equal(result.KeyFrames.RequestToKeyFrameMillis, []int64{40, 20, 20}) {
		return fmt.Errorf("unexpected key-frame response times: %v", result.KeyFrames.RequestToKeyFrameMillis)
	}
	wantTargets := []int{600_000, 400_000, 150_000, 600_000}
	if !slices.Equal(result.Bitrate.SelectedTargets, wantTargets) || !result.Bitrate.NoTargetBeforeBothLegs {
		return fmt.Errorf("unexpected shared bitrate trace: %+v", result.Bitrate)
	}
	if !result.NACKRTX.IndependentLegs || !result.NACKRTX.OldestPacketEvicted ||
		result.NACKRTX.ResponderCachePackets != feedbackNACKCachePackets ||
		result.NACKRTX.Legs[0].RTXPackets != 1 || result.NACKRTX.Legs[1].RTXPackets != 1 {
		return fmt.Errorf("unexpected NACK/RTX trace: %+v", result.NACKRTX)
	}
	if !result.StockGCCRTX.PrimaryDelivered || result.StockGCCRTX.RTXDelivered ||
		!result.StockGCCRTX.UnknownSSRC || result.StockGCCRTX.Error == "" {
		return fmt.Errorf("stock GCC did not reproduce the RTX SSRC failure: %+v", result.StockGCCRTX)
	}
	return nil
}
