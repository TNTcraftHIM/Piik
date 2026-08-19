package fanoutoracle

import (
	"bytes"
	"sync"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
)

const primaryRetransmissionDropAttempt = 90

// PrimaryLossMetrics is measured at the last cleartext RTP boundary before
// SRTP. It has one configured outstanding packet and owns no packet queue.
type PrimaryLossMetrics struct {
	ConfiguredDropAttempt       int    `json:"configuredDropAttempt"`
	PrimaryAttempts             int    `json:"primaryAttempts"`
	DeliveredPackets            uint64 `json:"deliveredPackets"`
	DroppedPackets              int    `json:"droppedPackets"`
	DroppedSSRC                 uint32 `json:"droppedSsrc"`
	DroppedSequence             uint16 `json:"droppedSequence"`
	TargetNACKRequests          int    `json:"targetNackRequests"`
	Retransmissions             int    `json:"retransmissions"`
	RetransmissionSameIdentity  bool   `json:"retransmissionSameIdentity"`
	OriginalTransportSequence   uint16 `json:"originalTransportSequence"`
	RetransmitTransportSequence uint16 `json:"retransmitTransportSequence"`
	DistinctTransportSequence   bool   `json:"distinctTransportSequence"`
	PacketsAfterRecovery        int    `json:"packetsAfterRecovery"`
	OutstandingPackets          int    `json:"outstandingPackets"`
	MaxOutstandingPackets       int    `json:"maxOutstandingPackets"`
}

type primaryPacketIdentity struct {
	ssrc        uint32
	payloadType uint8
	sequence    uint16
	timestamp   uint32
	marker      bool
	payload     []byte
}

type primaryLossBoundary struct {
	mu            sync.Mutex
	recorder      *rtpRecorder
	targetAttempt int
	target        primaryPacketIdentity
	targetSet     bool
	recovered     bool
	transportCCID uint8
	metrics       PrimaryLossMetrics
}

func newPrimaryLossBoundary(targetAttempt int, recorder *rtpRecorder) *primaryLossBoundary {
	return &primaryLossBoundary{
		recorder:      recorder,
		targetAttempt: targetAttempt,
		metrics: PrimaryLossMetrics{
			ConfiguredDropAttempt: targetAttempt,
		},
	}
}

func (boundary *primaryLossBoundary) snapshot() PrimaryLossMetrics {
	boundary.mu.Lock()
	defer boundary.mu.Unlock()
	metrics := boundary.metrics
	metrics.DeliveredPackets = boundary.recorder.snapshot().Packets
	return metrics
}

func (boundary *primaryLossBoundary) isRecovered() bool {
	boundary.mu.Lock()
	defer boundary.mu.Unlock()
	return boundary.recovered
}

func (boundary *primaryLossBoundary) observeNACK(sequence uint16) {
	boundary.mu.Lock()
	defer boundary.mu.Unlock()
	if boundary.targetSet && sequence == boundary.target.sequence {
		boundary.metrics.TargetNACKRequests++
	}
}

type primaryLossBoundaryFactory struct {
	boundary *primaryLossBoundary
}

func (factory *primaryLossBoundaryFactory) NewInterceptor(string) (interceptor.Interceptor, error) {
	return &primaryLossBoundaryInterceptor{boundary: factory.boundary}, nil
}

type primaryLossBoundaryInterceptor struct {
	interceptor.NoOp
	boundary *primaryLossBoundary
}

func (observer *primaryLossBoundaryInterceptor) BindLocalStream(
	info *interceptor.StreamInfo, writer interceptor.RTPWriter,
) interceptor.RTPWriter {
	observer.boundary.mu.Lock()
	for _, extension := range info.RTPHeaderExtensions {
		if extension.URI == transportCCHeaderExtensionURI {
			observer.boundary.transportCCID = uint8(extension.ID)
			break
		}
	}
	observer.boundary.mu.Unlock()

	return interceptor.RTPWriterFunc(func(
		header *rtp.Header, payload []byte, attributes interceptor.Attributes,
	) (int, error) {
		boundary := observer.boundary
		boundary.mu.Lock()
		identity := primaryPacketIdentity{
			ssrc:        header.SSRC,
			payloadType: header.PayloadType,
			sequence:    header.SequenceNumber,
			timestamp:   header.Timestamp,
			marker:      header.Marker,
			payload:     payload,
		}

		if boundary.targetSet && samePrimaryPacket(identity, boundary.target) {
			transportSequence, hasTransportSequence := transportSequenceFromHeader(header, boundary.transportCCID)
			boundary.mu.Unlock()
			written, err := writer.Write(header, payload, attributes)
			if err != nil {
				return written, err
			}
			boundary.recorder.record(header, payload)
			boundary.mu.Lock()
			boundary.metrics.Retransmissions++
			boundary.metrics.RetransmissionSameIdentity = true
			if hasTransportSequence {
				boundary.metrics.RetransmitTransportSequence = transportSequence
				boundary.metrics.DistinctTransportSequence = transportSequence != boundary.metrics.OriginalTransportSequence
			}
			boundary.recovered = true
			boundary.metrics.OutstandingPackets = 0
			boundary.mu.Unlock()
			return written, nil
		}

		boundary.metrics.PrimaryAttempts++
		if boundary.recovered {
			boundary.metrics.PacketsAfterRecovery++
		}
		if boundary.targetAttempt > 0 && boundary.metrics.PrimaryAttempts == boundary.targetAttempt {
			identity.payload = append([]byte(nil), payload...)
			boundary.target = identity
			boundary.targetSet = true
			boundary.metrics.DroppedPackets = 1
			boundary.metrics.DroppedSSRC = header.SSRC
			boundary.metrics.DroppedSequence = header.SequenceNumber
			boundary.metrics.OutstandingPackets = 1
			boundary.metrics.MaxOutstandingPackets = 1
			if sequence, ok := transportSequenceFromHeader(header, boundary.transportCCID); ok {
				boundary.metrics.OriginalTransportSequence = sequence
			}
			boundary.mu.Unlock()
			return header.MarshalSize() + len(payload), nil
		}
		boundary.mu.Unlock()

		written, err := writer.Write(header, payload, attributes)
		if err != nil {
			return written, err
		}
		boundary.recorder.record(header, payload)
		return written, nil
	})
}

func samePrimaryPacket(left, right primaryPacketIdentity) bool {
	return left.ssrc == right.ssrc &&
		left.payloadType == right.payloadType &&
		left.sequence == right.sequence &&
		left.timestamp == right.timestamp &&
		left.marker == right.marker &&
		bytes.Equal(left.payload, right.payload)
}

func transportSequenceFromHeader(header *rtp.Header, extensionID uint8) (uint16, bool) {
	if extensionID == 0 {
		return 0, false
	}
	payload := header.GetExtension(extensionID)
	if payload == nil {
		return 0, false
	}
	var extension rtp.TransportCCExtension
	if err := extension.Unmarshal(payload); err != nil {
		return 0, false
	}
	return extension.TransportSequence, true
}
