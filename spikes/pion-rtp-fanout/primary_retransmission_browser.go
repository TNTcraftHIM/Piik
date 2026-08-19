package fanoutoracle

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/pion/sdp/v3"
)

const primaryRetransmissionMinCallbacksAfterRecovery = 120

// PrimaryRetransmissionGateMetrics records the bounded no-RTX browser gate.
type PrimaryRetransmissionGateMetrics struct {
	Verdict                string                              `json:"verdict"`
	DropLeg                int                                 `json:"dropLeg"`
	NACKCachePackets       int                                 `json:"nackCachePackets"`
	Pacer                  string                              `json:"pacer"`
	PacerQueue             string                              `json:"pacerQueue"`
	ApplicationQueueFrames int                                 `json:"applicationQueueFrames"`
	Legs                   [feedbackLegCount]PrimaryControlLeg `json:"legs"`
	NoRTXCosts             []string                            `json:"noRtxCosts"`
}

// PrimaryControlLeg combines negotiated codec, stock GCC, loss, and browser
// observations for one independent PeerConnection.
type PrimaryControlLeg struct {
	OfferRTXNegotiated  bool               `json:"offerRtxNegotiated"`
	AnswerRTXNegotiated bool               `json:"answerRtxNegotiated"`
	OfferNACK           bool               `json:"offerNack"`
	AnswerNACK          bool               `json:"answerNack"`
	OfferTWCC           bool               `json:"offerTwcc"`
	AnswerTWCC          bool               `json:"answerTwcc"`
	SenderRTXSSRC       uint32             `json:"senderRtxSsrc"`
	GCCTargetBitrate    int                `json:"gccTargetBitrate"`
	SDPParseError       string             `json:"sdpParseError,omitempty"`
	Loss                PrimaryLossMetrics `json:"loss"`
}

type sdpControlCapabilities struct {
	rtx  bool
	nack bool
	twcc bool
}

// RunPrimaryRetransmissionBrowserGate runs one controlled asymmetric-loss
// experiment. It remains an isolated spike and has no product integration.
func RunPrimaryRetransmissionBrowserGate(
	ctx context.Context, options LiveBridgeOptions,
) (LiveBridgeResult, error) {
	result, err := runLiveBridge(ctx, options, liveBridgeRunOptions{primaryRetransmission: true})
	if err != nil {
		return LiveBridgeResult{}, err
	}
	if err = validatePrimaryRetransmissionResult(result); err != nil {
		return LiveBridgeResult{}, err
	}
	result.PrimaryRetransmission.Verdict = "go-bounded-primary-ssrc-retransmission"
	result.HardStops = []string{
		"identical-sequence retransmission is not RFC4588 repair and can distort RTP/RTCP loss statistics",
		"inbound retransmission-specific WebRTC stats are unavailable when RTX is not negotiated",
		"only Chrome loopback with one isolated packet loss was measured; wider browsers, networks, and loss patterns are unproven",
		"audio, A/V synchronization, TURN, reconnect, and product-controller integration are not implemented",
	}
	return result, nil
}

func (run *liveBridgeRun) primaryRetransmissionMetrics() *PrimaryRetransmissionGateMetrics {
	metrics := &PrimaryRetransmissionGateMetrics{
		DropLeg:                1,
		NACKCachePackets:       feedbackNACKCachePackets,
		Pacer:                  "gcc.NewNoOpPacer",
		PacerQueue:             "none",
		ApplicationQueueFrames: liveBridgeQueueCapacity,
		NoRTXCosts: []string{
			"RFC4588 repair SSRC, payload type, and original-sequence-number framing are not used",
			"same-stream duplicate sequence numbers can distort RTP/RTCP packet and loss statistics",
			"receivers cannot expose retransmission-specific inbound counters or rtxSsrc",
			"late originals and retransmissions are indistinguishable at the RTP layer",
		},
	}
	for index := range metrics.Legs {
		leg := run.leg(index)
		if leg == nil {
			continue
		}
		offer, offerErr := inspectControlSDP(leg.offer.SDP)
		answer, answerErr := inspectControlSDP(leg.answer.SDP)
		control := PrimaryControlLeg{
			OfferRTXNegotiated:  offer.rtx,
			AnswerRTXNegotiated: answer.rtx,
			OfferNACK:           offer.nack,
			AnswerNACK:          answer.nack,
			OfferTWCC:           offer.twcc,
			AnswerTWCC:          answer.twcc,
		}
		if offerErr != nil || answerErr != nil {
			control.SDPParseError = errors.Join(offerErr, answerErr).Error()
		}
		parameters := leg.sender.GetParameters()
		if len(parameters.Encodings) > 0 {
			control.SenderRTXSSRC = uint32(parameters.Encodings[0].RTX.SSRC)
		}
		if leg.estimator != nil {
			control.GCCTargetBitrate = leg.estimator.GetTargetBitrate()
		}
		if leg.loss != nil {
			control.Loss = leg.loss.snapshot()
		}
		metrics.Legs[index] = control
	}
	return metrics
}

func inspectControlSDP(raw string) (sdpControlCapabilities, error) {
	var description sdp.SessionDescription
	if err := description.Unmarshal([]byte(raw)); err != nil {
		return sdpControlCapabilities{}, err
	}
	var result sdpControlCapabilities
	for _, media := range description.MediaDescriptions {
		if !strings.EqualFold(media.MediaName.Media, "video") {
			continue
		}
		for _, attribute := range media.Attributes {
			value := strings.ToLower(attribute.Value)
			switch strings.ToLower(attribute.Key) {
			case "rtpmap":
				fields := strings.Fields(value)
				if len(fields) > 1 && strings.HasPrefix(fields[1], "rtx/") {
					result.rtx = true
				}
			case "fmtp":
				if strings.Contains(value, "apt=") {
					result.rtx = true
				}
			case "rtcp-fb":
				fields := strings.Fields(value)
				if len(fields) > 1 && fields[1] == "nack" {
					result.nack = true
				}
			case "extmap":
				if strings.Contains(value, transportCCHeaderExtensionURI) {
					result.twcc = true
				}
			}
		}
	}
	return result, nil
}

func validatePrimaryRetransmissionResult(result LiveBridgeResult) error {
	gate := result.PrimaryRetransmission
	if gate == nil {
		return errors.New("primary retransmission metrics are missing")
	}
	if gate.NACKCachePackets != feedbackNACKCachePackets || gate.Pacer != "gcc.NewNoOpPacer" || gate.PacerQueue != "none" {
		return fmt.Errorf("unbounded or non-stock transport controls: %+v", gate)
	}
	if result.Queue.Capacity != gate.ApplicationQueueFrames || result.Queue.MaxDepth > gate.ApplicationQueueFrames {
		return errors.New("application queue exceeded the primary retransmission gate bound")
	}

	for index, control := range gate.Legs {
		if control.SDPParseError != "" {
			return fmt.Errorf("downstream %d SDP: %s", index+1, control.SDPParseError)
		}
		if control.OfferRTXNegotiated || control.AnswerRTXNegotiated || control.SenderRTXSSRC != 0 {
			return fmt.Errorf("downstream %d negotiated or configured RFC4588 RTX", index+1)
		}
		if !control.OfferNACK || !control.AnswerNACK || !control.OfferTWCC || !control.AnswerTWCC {
			return fmt.Errorf("downstream %d lacks NACK or TWCC negotiation", index+1)
		}
		if control.GCCTargetBitrate < feedbackEncoderMinBitrate || control.GCCTargetBitrate > feedbackEncoderMaxBitrate {
			return fmt.Errorf("downstream %d GCC target = %d", index+1, control.GCCTargetBitrate)
		}
		browser := result.Downstream[index].Browser
		if browser.HasRetransmittedPacketsReceived || browser.HasRTXSSRC {
			return fmt.Errorf("downstream %d exposed RTX-only inbound stats", index+1)
		}
	}

	lossy := gate.Legs[0].Loss
	if lossy.ConfiguredDropAttempt != primaryRetransmissionDropAttempt || lossy.DroppedPackets != 1 {
		return fmt.Errorf("lossy leg did not drop exactly one configured packet: %+v", lossy)
	}
	if lossy.TargetNACKRequests < 1 || lossy.Retransmissions < 1 || lossy.Retransmissions > 8 {
		return fmt.Errorf("lossy leg NACK/retransmission did not stay within [1,8]: %+v", lossy)
	}
	if !lossy.RetransmissionSameIdentity || !lossy.DistinctTransportSequence {
		return fmt.Errorf("lossy leg did not retain RTP identity with fresh TWCC: %+v", lossy)
	}
	if lossy.OutstandingPackets != 0 || lossy.MaxOutstandingPackets != 1 || lossy.PacketsAfterRecovery < primaryRetransmissionMinCallbacksAfterRecovery {
		return fmt.Errorf("lossy leg recovery was not bounded and sustained: %+v", lossy)
	}
	lossyBrowser := result.Downstream[0].Browser
	if !lossyBrowser.RecoveryObserved ||
		lossyBrowser.FramesDecodedAfterRecovery < primaryRetransmissionMinCallbacksAfterRecovery ||
		lossyBrowser.RenderedCallbacksAfterRecovery < primaryRetransmissionMinCallbacksAfterRecovery {
		return fmt.Errorf("lossy viewer did not sustain presentation after retransmission: %+v", lossyBrowser)
	}

	clean := gate.Legs[1].Loss
	if clean.ConfiguredDropAttempt != 0 || clean.DroppedPackets != 0 || clean.Retransmissions != 0 || clean.TargetNACKRequests != 0 {
		return fmt.Errorf("clean leg was polluted by the lossy leg: %+v", clean)
	}
	if result.Downstream[1].RTCP.NACK != 0 || result.Downstream[1].Browser.RecoveryObserved {
		return errors.New("clean leg produced loss recovery feedback")
	}
	return nil
}
