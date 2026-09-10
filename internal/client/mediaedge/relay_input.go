package mediaedge

import (
	"bytes"
	"errors"
	"io"

	"github.com/TNTcraftHIM/Piik/internal/client/nativecapture"
	mediacodec "github.com/livekit/mediatransportutil/pkg/codec"
	"github.com/livekit/server-sdk-go/v2/pkg/samplebuilder"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4/pkg/media"
	"github.com/pion/webrtc/v4/pkg/media/h264reader"
)

// Decoder configuration belongs to this received stream, not a child encoder.
type relayVideoInput struct {
	codec             string
	sps               []byte
	pps               []byte
	width             uint32
	height            uint32
	builder           *samplebuilder.SampleBuilder
	onPacketDropped   func()
	recoveryTimestamp uint32
	recoverySequence  uint16
	hasRecovery       bool
}

func (input *relayVideoInput) push(packet *rtp.Packet) error {
	if input.hasRecovery && int32(packet.Timestamp-input.recoveryTimestamp) < 0 {
		return nil
	}
	recovery := mediacodec.IsKeyFrame(input.codec, packet.Payload)
	if recovery && input.hasRecovery && packet.Timestamp == input.recoveryTimestamp && packet.SequenceNumber == input.recoverySequence {
		return nil
	}
	if input.builder == nil || recovery && (!input.hasRecovery || packet.Timestamp != input.recoveryTimestamp) {
		if input.builder != nil {
			for {
				sample, _ := input.builder.ForcePopWithTimestamp()
				if sample == nil {
					break
				}
				// Keep completed H264 configuration, never replay expired video.
				if input.codec == "h264" {
					if _, err := input.frame(sample.Data); err != nil {
						return err
					}
				}
			}
		}
		var depacketizer rtp.Depacketizer = &codecs.H264Packet{}
		if input.codec == "vp8" {
			depacketizer = &codecs.VP8Packet{}
		}
		input.builder = samplebuilder.New(relayPacketLimit, depacketizer, videoClockRate,
			samplebuilder.WithPacketDroppedHandler(func() {
				if input.onPacketDropped != nil {
					input.onPacketDropped()
				}
			}))
	}
	if recovery {
		input.recoveryTimestamp, input.hasRecovery = packet.Timestamp, true
		input.recoverySequence = packet.SequenceNumber
	}
	input.builder.Push(packet)
	return nil
}

func (input *relayVideoInput) pop() (*media.Sample, uint32) {
	return input.builder.PopWithTimestamp()
}

func (input *relayVideoInput) frame(data []byte) (nativecapture.Frame, error) {
	frame := nativecapture.Frame{Data: data}
	if input.codec == "vp8" {
		frame.Kind = nativecapture.FrameVP8
		frame.KeyFrame = len(data) >= 10 && data[0]&1 == 0
		size := mediacodec.ExtractVP8VideoSize(&mediacodec.VP8{IsKeyFrame: frame.KeyFrame}, data)
		if size.Width > 0 && size.Height > 0 {
			input.width, input.height = size.Width, size.Height
		}
	} else {
		frame.Kind = nativecapture.FrameH264
		reader, err := h264reader.NewReader(bytes.NewReader(data))
		if err != nil {
			return frame, err
		}
		for {
			nal, err := reader.NextNAL()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return frame, err
			}
			switch nal.UnitType {
			case h264reader.NalUnitTypeSPS:
				input.sps = append(input.sps[:0], nal.Data...)
				size := mediacodec.ExtractH264VideoSize(nal.Data)
				if size.Width > 0 && size.Height > 0 {
					input.width, input.height = size.Width, size.Height
				}
			case h264reader.NalUnitTypePPS:
				input.pps = append(input.pps[:0], nal.Data...)
			case h264reader.NalUnitTypeCodedSliceIdr:
				frame.KeyFrame = true
			}
		}
		if frame.KeyFrame {
			frame.KeyFrame = len(input.sps) > 0 && len(input.pps) > 0
			if frame.KeyFrame {
				// Browser senders can put parameter sets in an earlier access unit.
				prefix := make([]byte, 0, len(input.sps)+len(input.pps)+len(data)+8)
				for _, nal := range [][]byte{input.sps, input.pps} {
					prefix = append(prefix, 0, 0, 0, 1)
					prefix = append(prefix, nal...)
				}
				frame.Data = append(prefix, data...)
			}
		}
	}
	frame.Width, frame.Height = input.width, input.height
	return frame, nil
}
