package fanoutoracle

import (
	"bytes"
	"context"
	"fmt"

	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/gcc"
	"github.com/pion/interceptor/pkg/nack"
	"github.com/pion/interceptor/pkg/twcc"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
)

const transportCCHeaderExtensionURI = "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01"

// PrimaryRetransmissionTrace records a NACK retransmission without an RFC4588
// repair stream. The retransmission retains RTP identity but gets a fresh TWCC
// transport sequence before it passes through stock Pion GCC and its NoOpPacer.
type PrimaryRetransmissionTrace struct {
	ResponderCachePackets       int    `json:"responderCachePackets"`
	Pacer                       string `json:"pacer"`
	PacerQueue                  string `json:"pacerQueue"`
	RTXNegotiated               bool   `json:"rtxNegotiated"`
	PrimarySSRC                 uint32 `json:"primarySsrc"`
	OriginalSequence            uint16 `json:"originalSequence"`
	RetransmittedSequence       uint16 `json:"retransmittedSequence"`
	OriginalTransportSequence   uint16 `json:"originalTransportSequence"`
	RetransmitTransportSequence uint16 `json:"retransmitTransportSequence"`
	PrimaryDelivered            bool   `json:"primaryDelivered"`
	RetransmissionDelivered     bool   `json:"retransmissionDelivered"`
	SameRTPIdentity             bool   `json:"sameRtpIdentity"`
	DistinctTransportSequence   bool   `json:"distinctTransportSequence"`
}

func runPrimaryRetransmissionTrace(ctx context.Context) (PrimaryRetransmissionTrace, error) {
	const (
		primarySSRC = uint32(4001)
		sequence    = uint16(12000)
		extensionID = 3
	)

	pacer := gcc.NewNoOpPacer()
	estimator, err := gcc.NewSendSideBWE(
		gcc.SendSideBWEInitialBitrate(feedbackEncoderMaxBitrate),
		gcc.SendSideBWEMinBitrate(feedbackEncoderMinBitrate),
		gcc.SendSideBWEMaxBitrate(feedbackEncoderMaxBitrate),
		gcc.SendSideBWEPacer(pacer),
	)
	if err != nil {
		return PrimaryRetransmissionTrace{}, err
	}
	defer func() { _ = estimator.Close() }()

	info := interceptor.StreamInfo{
		ID:           "primary-retransmission",
		SSRC:         primarySSRC,
		PayloadType:  96,
		RTCPFeedback: []interceptor.RTCPFeedback{{Type: "nack"}},
		RTPHeaderExtensions: []interceptor.RTPHeaderExtension{{
			URI: transportCCHeaderExtensionURI,
			ID:  extensionID,
		}},
	}
	output := newTraceRTPWriter()
	gccWriter := estimator.AddStream(&info, output)

	twccFactory, err := twcc.NewHeaderExtensionInterceptor()
	if err != nil {
		return PrimaryRetransmissionTrace{}, err
	}
	twccRegistry := &interceptor.Registry{}
	twccRegistry.Add(twccFactory)
	twccChain, err := twccRegistry.Build("primary-retransmission-twcc")
	if err != nil {
		return PrimaryRetransmissionTrace{}, err
	}
	defer func() { _ = twccChain.Close() }()
	twccWriter := twccChain.BindLocalStream(&info, gccWriter)
	defer twccChain.UnbindLocalStream(&info)

	responderFactory, err := nack.NewResponderInterceptor(nack.ResponderSize(feedbackNACKCachePackets))
	if err != nil {
		return PrimaryRetransmissionTrace{}, err
	}
	responderRegistry := &interceptor.Registry{}
	responderRegistry.Add(responderFactory)
	responderChain, err := responderRegistry.Build("primary-retransmission-nack")
	if err != nil {
		return PrimaryRetransmissionTrace{}, err
	}
	defer func() { _ = responderChain.Close() }()
	writer := responderChain.BindLocalStream(&info, twccWriter)
	defer responderChain.UnbindLocalStream(&info)

	payload := []byte{0x80, 0x01, 0x02, 0x03}
	header := &rtp.Header{
		Version:        2,
		PayloadType:    info.PayloadType,
		SequenceNumber: sequence,
		Timestamp:      90000,
		SSRC:           info.SSRC,
		Marker:         true,
	}
	if _, err = writer.Write(header, payload, nil); err != nil {
		return PrimaryRetransmissionTrace{}, fmt.Errorf("write primary packet: %w", err)
	}
	if _, err = output.waitForCount(ctx, 1); err != nil {
		return PrimaryRetransmissionTrace{}, fmt.Errorf("wait for primary packet: %w", err)
	}

	rtcpSource := &traceRTCPReader{}
	rtcpReader := responderChain.BindRTCPReader(rtcpSource)
	if err = rtcpSource.set(&rtcp.TransportLayerNack{
		SenderSSRC: primarySSRC + 1,
		MediaSSRC:  primarySSRC,
		Nacks:      rtcp.NackPairsFromSequenceNumbers([]uint16{sequence}),
	}); err != nil {
		return PrimaryRetransmissionTrace{}, err
	}
	buffer := make([]byte, 1500)
	if _, _, err = rtcpReader.Read(buffer, nil); err != nil {
		return PrimaryRetransmissionTrace{}, fmt.Errorf("read NACK: %w", err)
	}
	packets, err := output.waitForCount(ctx, 2)
	if err != nil {
		return PrimaryRetransmissionTrace{}, fmt.Errorf("wait for retransmission: %w", err)
	}

	originalTransportSequence, err := transportSequence(packets[0], extensionID)
	if err != nil {
		return PrimaryRetransmissionTrace{}, fmt.Errorf("original packet TWCC: %w", err)
	}
	retransmitTransportSequence, err := transportSequence(packets[1], extensionID)
	if err != nil {
		return PrimaryRetransmissionTrace{}, fmt.Errorf("retransmitted packet TWCC: %w", err)
	}
	sameRTPIdentity := packets[0].header.SSRC == packets[1].header.SSRC &&
		packets[0].header.PayloadType == packets[1].header.PayloadType &&
		packets[0].header.SequenceNumber == packets[1].header.SequenceNumber &&
		packets[0].header.Timestamp == packets[1].header.Timestamp &&
		bytes.Equal(packets[0].payload, packets[1].payload)

	return PrimaryRetransmissionTrace{
		ResponderCachePackets:       feedbackNACKCachePackets,
		Pacer:                       "gcc.NewNoOpPacer",
		PacerQueue:                  "none",
		RTXNegotiated:               info.SSRCRetransmission != 0 || info.PayloadTypeRetransmission != 0,
		PrimarySSRC:                 info.SSRC,
		OriginalSequence:            packets[0].header.SequenceNumber,
		RetransmittedSequence:       packets[1].header.SequenceNumber,
		OriginalTransportSequence:   originalTransportSequence,
		RetransmitTransportSequence: retransmitTransportSequence,
		PrimaryDelivered:            len(packets) >= 1,
		RetransmissionDelivered:     len(packets) >= 2,
		SameRTPIdentity:             sameRTPIdentity,
		DistinctTransportSequence:   originalTransportSequence != retransmitTransportSequence,
	}, nil
}

func transportSequence(packet recordedRTPPacket, extensionID uint8) (uint16, error) {
	extension := packet.header.GetExtension(extensionID)
	if extension == nil {
		return 0, fmt.Errorf("header extension %d is missing", extensionID)
	}
	var transportCC rtp.TransportCCExtension
	if err := transportCC.Unmarshal(extension); err != nil {
		return 0, err
	}
	return transportCC.TransportSequence, nil
}
