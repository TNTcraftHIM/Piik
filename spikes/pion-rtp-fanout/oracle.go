package fanoutoracle

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

const (
	oracleSequenceNumber = 4242
	oracleTimestamp      = 90000
	oracleSourceSSRC     = 0xdecafbad
)

var oraclePayload = []byte{
	0x10, 0x00, 0x9d, 0x01, 0x2a, 0x80, 0x07, 0x38,
	0x04, 0x66, 0x61, 0x6e, 0x6f, 0x75, 0x74,
}

// Result describes the RTP packets observed after one source WriteRTP call.
// It deliberately does not claim that the opaque payload was decoded.
type Result struct {
	SourceSSRC      uint32     `json:"sourceSsrc"`
	SourceWrites    int        `json:"sourceWrites"`
	Downstream      [2]RTPView `json:"downstream"`
	PayloadsEqual   bool       `json:"payloadsEqual"`
	IndependentSSRC bool       `json:"independentSsrc"`
}

// RTPView is the transport-specific RTP header and semantic payload observed
// by one independent receiver PeerConnection.
type RTPView struct {
	SSRC           uint32 `json:"ssrc"`
	PayloadType    uint8  `json:"payloadType"`
	SequenceNumber uint16 `json:"sequenceNumber"`
	Timestamp      uint32 `json:"timestamp"`
	Payload        []byte `json:"payload"`
}

type peerLeg struct {
	sender    *webrtc.PeerConnection
	receiver  *webrtc.PeerConnection
	packet    chan *rtp.Packet
	connected chan struct{}
	once      sync.Once
}

// Run binds one TrackLocalStaticRTP to two independent WebRTC transports and
// writes one opaque, already-packetized payload into the shared track.
func Run(ctx context.Context) (Result, error) {
	track, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000},
		"video",
		"oracle",
	)
	if err != nil {
		return Result{}, fmt.Errorf("create shared RTP track: %w", err)
	}

	legs := make([]*peerLeg, 0, 2)
	defer func() {
		for _, leg := range legs {
			_ = leg.sender.Close()
			_ = leg.receiver.Close()
		}
	}()

	for index := 0; index < 2; index++ {
		leg, legErr := newPeerLeg(track)
		if legErr != nil {
			return Result{}, fmt.Errorf("create downstream %d: %w", index+1, legErr)
		}
		legs = append(legs, leg)
		if legErr = connect(ctx, leg); legErr != nil {
			return Result{}, fmt.Errorf("connect downstream %d: %w", index+1, legErr)
		}
	}

	source := &rtp.Packet{
		Header: rtp.Header{
			Version:        2,
			PayloadType:    96,
			SequenceNumber: oracleSequenceNumber,
			Timestamp:      oracleTimestamp,
			SSRC:           oracleSourceSSRC,
			Marker:         true,
		},
		Payload: append([]byte(nil), oraclePayload...),
	}

	if err = track.WriteRTP(source); err != nil {
		return Result{}, fmt.Errorf("single shared track write: %w", err)
	}

	result := Result{SourceSSRC: source.SSRC, SourceWrites: 1}
	for index, leg := range legs {
		select {
		case packet := <-leg.packet:
			result.Downstream[index] = viewPacket(packet)
		case <-ctx.Done():
			return Result{}, fmt.Errorf("receive downstream %d: %w", index+1, ctx.Err())
		}
	}

	result.PayloadsEqual = bytes.Equal(result.Downstream[0].Payload, result.Downstream[1].Payload)
	result.IndependentSSRC = result.Downstream[0].SSRC != result.Downstream[1].SSRC

	if err = validate(source, result); err != nil {
		return Result{}, err
	}

	return result, nil
}

func newPeerLeg(track *webrtc.TrackLocalStaticRTP) (*peerLeg, error) {
	sender, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, fmt.Errorf("create sender PeerConnection: %w", err)
	}

	receiver, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		_ = sender.Close()
		return nil, fmt.Errorf("create receiver PeerConnection: %w", err)
	}

	leg := &peerLeg{
		sender:    sender,
		receiver:  receiver,
		packet:    make(chan *rtp.Packet, 1),
		connected: make(chan struct{}),
	}

	sender.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateConnected {
			leg.once.Do(func() { close(leg.connected) })
		}
	})
	receiver.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		packet, _, readErr := remote.ReadRTP()
		if readErr == nil {
			leg.packet <- packet
		}
	})

	rtpSender, err := sender.AddTrack(track)
	if err != nil {
		_ = sender.Close()
		_ = receiver.Close()
		return nil, fmt.Errorf("bind shared track: %w", err)
	}
	go func() {
		for {
			if _, _, readErr := rtpSender.ReadRTCP(); readErr != nil {
				return
			}
		}
	}()

	return leg, nil
}

func connect(ctx context.Context, leg *peerLeg) error {
	offer, err := leg.sender.CreateOffer(nil)
	if err != nil {
		return fmt.Errorf("create offer: %w", err)
	}

	offerGathering := webrtc.GatheringCompletePromise(leg.sender)
	if err = leg.sender.SetLocalDescription(offer); err != nil {
		return fmt.Errorf("set sender local description: %w", err)
	}
	select {
	case <-offerGathering:
	case <-ctx.Done():
		return ctx.Err()
	}

	if err = leg.receiver.SetRemoteDescription(*leg.sender.LocalDescription()); err != nil {
		return fmt.Errorf("set receiver remote description: %w", err)
	}

	answer, err := leg.receiver.CreateAnswer(nil)
	if err != nil {
		return fmt.Errorf("create answer: %w", err)
	}

	answerGathering := webrtc.GatheringCompletePromise(leg.receiver)
	if err = leg.receiver.SetLocalDescription(answer); err != nil {
		return fmt.Errorf("set receiver local description: %w", err)
	}
	select {
	case <-answerGathering:
	case <-ctx.Done():
		return ctx.Err()
	}

	if err = leg.sender.SetRemoteDescription(*leg.receiver.LocalDescription()); err != nil {
		return fmt.Errorf("set sender remote description: %w", err)
	}

	select {
	case <-leg.connected:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func viewPacket(packet *rtp.Packet) RTPView {
	return RTPView{
		SSRC:           packet.SSRC,
		PayloadType:    packet.PayloadType,
		SequenceNumber: packet.SequenceNumber,
		Timestamp:      packet.Timestamp,
		Payload:        append([]byte(nil), packet.Payload...),
	}
}

func validate(source *rtp.Packet, result Result) error {
	if !result.PayloadsEqual || !bytes.Equal(source.Payload, result.Downstream[0].Payload) {
		return errors.New("downstream semantic payloads differ from the single source payload")
	}
	if !result.IndependentSSRC {
		return errors.New("independent transports unexpectedly used the same SSRC")
	}
	for index, downstream := range result.Downstream {
		if downstream.SequenceNumber != source.SequenceNumber || downstream.Timestamp != source.Timestamp {
			return fmt.Errorf("downstream %d changed source sequence number or timestamp", index+1)
		}
	}
	if source.SSRC != oracleSourceSSRC || result.SourceSSRC != oracleSourceSSRC {
		return errors.New("TrackLocalStaticRTP mutated the caller's source packet")
	}

	return nil
}
