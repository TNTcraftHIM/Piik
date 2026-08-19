package fanoutoracle

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"sync"

	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/gcc"
	"github.com/pion/interceptor/pkg/nack"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
)

// NACKRTXTrace records two independent public-API NACK responders.
type NACKRTXTrace struct {
	ResponderCachePackets int                               `json:"responderCachePackets"`
	IndependentLegs       bool                              `json:"independentLegs"`
	OldestPacketEvicted   bool                              `json:"oldestPacketEvicted"`
	Legs                  [feedbackLegCount]NACKRTXLegTrace `json:"legs"`
}

// NACKRTXLegTrace records one transport-local retransmission.
type NACKRTXLegTrace struct {
	PrimarySSRC              uint32 `json:"primarySsrc"`
	RTXSSRC                  uint32 `json:"rtxSsrc"`
	PrimaryPackets           int    `json:"primaryPackets"`
	RTXPackets               int    `json:"rtxPackets"`
	RetransmittedOriginalSeq uint16 `json:"retransmittedOriginalSequence"`
}

// StockGCCRTXTrace records the released GCC pacer's RTX behavior.
type StockGCCRTXTrace struct {
	Pacer            string `json:"pacer"`
	InitialBitrate   int    `json:"initialBitrate"`
	PrimaryDelivered bool   `json:"primaryDelivered"`
	RTXDelivered     bool   `json:"rtxDelivered"`
	UnknownSSRC      bool   `json:"unknownSsrc"`
	Error            string `json:"error"`
}

type recordedRTPPacket struct {
	header  rtp.Header
	payload []byte
}

type traceRTPWriter struct {
	mu      sync.Mutex
	packets []recordedRTPPacket
	notify  chan struct{}
}

func newTraceRTPWriter() *traceRTPWriter {
	return &traceRTPWriter{notify: make(chan struct{}, 1)}
}

func (writer *traceRTPWriter) Write(
	header *rtp.Header, payload []byte, _ interceptor.Attributes,
) (int, error) {
	writer.mu.Lock()
	writer.packets = append(writer.packets, recordedRTPPacket{
		header:  header.Clone(),
		payload: append([]byte(nil), payload...),
	})
	writer.mu.Unlock()
	select {
	case writer.notify <- struct{}{}:
	default:
	}
	return header.MarshalSize() + len(payload), nil
}

func (writer *traceRTPWriter) snapshot() []recordedRTPPacket {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	result := make([]recordedRTPPacket, len(writer.packets))
	copy(result, writer.packets)
	return result
}

func (writer *traceRTPWriter) waitForCount(ctx context.Context, count int) ([]recordedRTPPacket, error) {
	for {
		packets := writer.snapshot()
		if len(packets) >= count {
			return packets, nil
		}
		select {
		case <-writer.notify:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

type traceRTCPReader struct {
	mu      sync.Mutex
	payload []byte
}

func (reader *traceRTCPReader) set(packet rtcp.Packet) error {
	payload, err := packet.Marshal()
	if err != nil {
		return err
	}
	reader.mu.Lock()
	reader.payload = payload
	reader.mu.Unlock()
	return nil
}

func (reader *traceRTCPReader) Read(buffer []byte, attributes interceptor.Attributes) (int, interceptor.Attributes, error) {
	reader.mu.Lock()
	defer reader.mu.Unlock()
	if len(reader.payload) == 0 {
		return 0, attributes, io.EOF
	}
	if len(buffer) < len(reader.payload) {
		return 0, attributes, io.ErrShortBuffer
	}
	n := copy(buffer, reader.payload)
	reader.payload = nil
	return n, attributes, nil
}

type nackTraceLeg struct {
	chain      interceptor.Interceptor
	info       interceptor.StreamInfo
	writer     interceptor.RTPWriter
	rtcpSource *traceRTCPReader
	rtcpReader interceptor.RTCPReader
	output     *traceRTPWriter
}

func newNACKTraceLeg(id string, primarySSRC, rtxSSRC uint32) (*nackTraceLeg, error) {
	responder, err := nack.NewResponderInterceptor(nack.ResponderSize(feedbackNACKCachePackets))
	if err != nil {
		return nil, err
	}
	registry := &interceptor.Registry{}
	registry.Add(responder)
	chain, err := registry.Build(id)
	if err != nil {
		return nil, err
	}
	info := interceptor.StreamInfo{
		ID:                        id,
		SSRC:                      primarySSRC,
		SSRCRetransmission:        rtxSSRC,
		PayloadType:               96,
		PayloadTypeRetransmission: 97,
		RTCPFeedback:              []interceptor.RTCPFeedback{{Type: "nack"}},
	}
	output := newTraceRTPWriter()
	rtcpSource := &traceRTCPReader{}
	return &nackTraceLeg{
		chain:      chain,
		info:       info,
		writer:     chain.BindLocalStream(&info, output),
		rtcpSource: rtcpSource,
		rtcpReader: chain.BindRTCPReader(rtcpSource),
		output:     output,
	}, nil
}

func (leg *nackTraceLeg) writePrimary(sequence uint16) error {
	_, err := leg.writer.Write(&rtp.Header{
		Version:        2,
		PayloadType:    leg.info.PayloadType,
		SequenceNumber: sequence,
		SSRC:           leg.info.SSRC,
	}, []byte{byte(sequence), byte(sequence >> 8)}, nil)
	return err
}

func (leg *nackTraceLeg) nack(sequences ...uint16) error {
	packet := &rtcp.TransportLayerNack{
		SenderSSRC: leg.info.SSRC + 10,
		MediaSSRC:  leg.info.SSRC,
		Nacks:      rtcp.NackPairsFromSequenceNumbers(sequences),
	}
	if err := leg.rtcpSource.set(packet); err != nil {
		return err
	}
	buffer := make([]byte, 1500)
	_, _, err := leg.rtcpReader.Read(buffer, nil)
	return err
}

func (leg *nackTraceLeg) close() {
	leg.chain.UnbindLocalStream(&leg.info)
	_ = leg.chain.Close()
}

func runNACKRTXTrace(ctx context.Context) (NACKRTXTrace, recordedRTPPacket, error) {
	legs := [feedbackLegCount]*nackTraceLeg{}
	var err error
	legs[0], err = newNACKTraceLeg("feedback-leg-1", 1001, 2001)
	if err != nil {
		return NACKRTXTrace{}, recordedRTPPacket{}, err
	}
	defer legs[0].close()
	legs[1], err = newNACKTraceLeg("feedback-leg-2", 1002, 2002)
	if err != nil {
		return NACKRTXTrace{}, recordedRTPPacket{}, err
	}
	defer legs[1].close()

	const firstSequence = uint16(10_000)
	for offset := 0; offset <= feedbackNACKCachePackets; offset++ {
		if err = legs[0].writePrimary(firstSequence + uint16(offset)); err != nil {
			return NACKRTXTrace{}, recordedRTPPacket{}, err
		}
	}
	if err = legs[1].writePrimary(30_000); err != nil {
		return NACKRTXTrace{}, recordedRTPPacket{}, err
	}
	if _, err = legs[0].output.waitForCount(ctx, feedbackNACKCachePackets+1); err != nil {
		return NACKRTXTrace{}, recordedRTPPacket{}, err
	}
	if _, err = legs[1].output.waitForCount(ctx, 1); err != nil {
		return NACKRTXTrace{}, recordedRTPPacket{}, err
	}

	newestSequence := firstSequence + feedbackNACKCachePackets
	if err = legs[0].nack(firstSequence, newestSequence); err != nil {
		return NACKRTXTrace{}, recordedRTPPacket{}, err
	}
	legOnePackets, err := legs[0].output.waitForCount(ctx, feedbackNACKCachePackets+2)
	if err != nil {
		return NACKRTXTrace{}, recordedRTPPacket{}, err
	}
	legOneRTX := legOnePackets[len(legOnePackets)-1]
	legOneOriginal, err := originalSequenceFromRTX(legOneRTX)
	if err != nil {
		return NACKRTXTrace{}, recordedRTPPacket{}, err
	}
	legOnePacketsBeforeLegTwoNACK := len(legs[0].output.snapshot())

	if err = legs[1].nack(30_000); err != nil {
		return NACKRTXTrace{}, recordedRTPPacket{}, err
	}
	legTwoPackets, err := legs[1].output.waitForCount(ctx, 2)
	if err != nil {
		return NACKRTXTrace{}, recordedRTPPacket{}, err
	}
	legTwoRTX := legTwoPackets[len(legTwoPackets)-1]
	legTwoOriginal, err := originalSequenceFromRTX(legTwoRTX)
	if err != nil {
		return NACKRTXTrace{}, recordedRTPPacket{}, err
	}
	legOneFinalPackets := legs[0].output.snapshot()
	legTwoFinalPackets := legs[1].output.snapshot()
	legOneRTXPackets := len(legOneFinalPackets) - (feedbackNACKCachePackets + 1)
	legTwoRTXPackets := len(legTwoFinalPackets) - 1

	result := NACKRTXTrace{
		ResponderCachePackets: feedbackNACKCachePackets,
		IndependentLegs: legOneRTX.header.SSRC == legs[0].info.SSRCRetransmission &&
			legTwoRTX.header.SSRC == legs[1].info.SSRCRetransmission &&
			len(legOneFinalPackets) == legOnePacketsBeforeLegTwoNACK &&
			legOneRTX.header.SSRC != legTwoRTX.header.SSRC,
		OldestPacketEvicted: legOneRTXPackets == 1 && legOneOriginal == newestSequence,
		Legs: [feedbackLegCount]NACKRTXLegTrace{
			{
				PrimarySSRC:              legs[0].info.SSRC,
				RTXSSRC:                  legOneRTX.header.SSRC,
				PrimaryPackets:           feedbackNACKCachePackets + 1,
				RTXPackets:               legOneRTXPackets,
				RetransmittedOriginalSeq: legOneOriginal,
			},
			{
				PrimarySSRC:              legs[1].info.SSRC,
				RTXSSRC:                  legTwoRTX.header.SSRC,
				PrimaryPackets:           1,
				RTXPackets:               legTwoRTXPackets,
				RetransmittedOriginalSeq: legTwoOriginal,
			},
		},
	}
	return result, legOneRTX, nil
}

func originalSequenceFromRTX(packet recordedRTPPacket) (uint16, error) {
	if len(packet.payload) < 2 {
		return 0, errors.New("RTX payload has no original sequence number")
	}
	return binary.BigEndian.Uint16(packet.payload[:2]), nil
}

func runStockGCCRTXTrace(rtxPacket recordedRTPPacket) (StockGCCRTXTrace, error) {
	pacer := gcc.NewNoOpPacer()
	estimator, err := gcc.NewSendSideBWE(
		gcc.SendSideBWEInitialBitrate(feedbackEncoderMaxBitrate),
		gcc.SendSideBWEMinBitrate(feedbackEncoderMinBitrate),
		gcc.SendSideBWEMaxBitrate(feedbackEncoderMaxBitrate),
		gcc.SendSideBWEPacer(pacer),
	)
	if err != nil {
		return StockGCCRTXTrace{}, err
	}
	defer func() { _ = estimator.Close() }()

	delivered := newTraceRTPWriter()
	info := &interceptor.StreamInfo{SSRC: 1001, SSRCRetransmission: rtxPacket.header.SSRC}
	writer := estimator.AddStream(info, delivered)
	_, primaryErr := writer.Write(&rtp.Header{Version: 2, SSRC: info.SSRC, SequenceNumber: 1}, []byte{1}, nil)
	if primaryErr != nil {
		return StockGCCRTXTrace{}, fmt.Errorf("write primary through stock GCC: %w", primaryErr)
	}
	primaryDelivered := len(delivered.snapshot()) == 1
	_, rtxErr := writer.Write(&rtxPacket.header, rtxPacket.payload, nil)
	result := StockGCCRTXTrace{
		Pacer:            "gcc.NewNoOpPacer",
		InitialBitrate:   estimator.GetTargetBitrate(),
		PrimaryDelivered: primaryDelivered,
		RTXDelivered:     len(delivered.snapshot()) > 1,
	}
	if rtxErr != nil {
		result.Error = rtxErr.Error()
	}
	result.UnknownSSRC = errors.Is(rtxErr, gcc.ErrUnknownStream)
	if !errors.Is(rtxErr, gcc.ErrUnknownStream) {
		return StockGCCRTXTrace{}, fmt.Errorf("stock GCC RTX error = %v, want %v", rtxErr, gcc.ErrUnknownStream)
	}
	return result, nil
}
