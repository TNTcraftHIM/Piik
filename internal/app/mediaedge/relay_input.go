package mediaedge

import (
	"bytes"
	"encoding/hex"
	"errors"
	"fmt"
	"io"

	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/bluenviron/mediacommon/v2/pkg/codecs/h264"
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
	pending           bool
	pendingTimestamp  uint32
	latestTimestamp   uint32
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
		previous := input.builder
		var depacketizer rtp.Depacketizer = &codecs.H264Packet{}
		if input.codec == "vp8" {
			depacketizer = &codecs.VP8Packet{}
		}
		var builder *samplebuilder.SampleBuilder
		builder = samplebuilder.New(relayPacketLimit, depacketizer, videoClockRate,
			samplebuilder.WithPacketDroppedHandler(func() {
				// Old gaps cannot request another keyframe after its replacement
				// has arrived. Loss in the current assembly still owns recovery.
				if input.builder == builder && input.onPacketDropped != nil {
					input.onPacketDropped()
				}
			}))
		input.builder = builder
		input.pending = false
		if previous != nil {
			for {
				sample, _ := previous.ForcePopWithTimestamp()
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
	}
	if recovery {
		input.recoveryTimestamp, input.hasRecovery = packet.Timestamp, true
		input.recoverySequence = packet.SequenceNumber
	}
	if len(packet.Payload) > 0 {
		if !input.pending {
			input.pending, input.pendingTimestamp, input.latestTimestamp = true, packet.Timestamp, packet.Timestamp
		} else if int32(packet.Timestamp-input.latestTimestamp) > 0 {
			input.latestTimestamp = packet.Timestamp
		}
	}
	input.builder.Push(packet)
	return nil
}

func (input *relayVideoInput) pop() (*media.Sample, uint32) {
	sample, timestamp := input.builder.PopWithTimestamp()
	// The packet window bounds storage for large access units, not playout
	// delay. After a second of advancing media without a complete sample, let
	// the existing assembler discard the gap and request independent recovery.
	// RTP time leaves quiet sources alone and adds no timer or decode owner.
	if sample == nil && input.pending && int32(input.latestTimestamp-input.pendingTimestamp) > videoClockRate {
		if input.onPacketDropped != nil {
			input.onPacketDropped()
		}
		sample, timestamp = input.builder.ForcePopWithTimestamp()
		input.pending = false
	}
	if sample != nil {
		input.pending = false
	}
	return sample, timestamp
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
				width, height, err := relayH264Size(nal.Data)
				if err != nil {
					return frame, err
				}
				input.sps = append(input.sps[:0], nal.Data...)
				input.width, input.height = width, height
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

// A size summary is not a decoder allocation bound: one access unit may carry
// several SPS IDs, and a slice need not reference the last one. Admit every SPS
// before forwarding it to any platform decoder, including its uncropped storage.
func relayH264Size(nal []byte) (uint32, uint32, error) {
	if len(nal) < 4 || !forwardableH264("profile-level-id="+hex.EncodeToString(nal[1:4])+";packetization-mode=1") {
		return 0, 0, errors.New("native H264 input profile is unsupported")
	}
	var sps h264.SPS
	if err := sps.Unmarshal(nal); err != nil {
		return 0, 0, fmt.Errorf("invalid native H264 input SPS: %w", err)
	}
	width := (uint64(sps.PicWidthInMbsMinus1) + 1) * 16
	height := (uint64(sps.PicHeightInMapUnitsMinus1) + 1) * 16
	cropUnitY := uint64(2)
	if !sps.FrameMbsOnlyFlag {
		height *= 2
		cropUnitY *= 2
	}
	// Constrained Baseline uses 8-bit 4:2:0. Bound uncropped storage before
	// allowing padding to be removed from the visible picture.
	if sps.ChromaFormatIdc != 1 || !nativecapture.ValidCodedVideoSize(width, height) {
		return 0, 0, errors.New("native H264 input storage exceeds its bound")
	}
	bufferedFrames := max(1, sps.MaxNumRefFrames)
	if sps.VUI != nil && sps.VUI.BitstreamRestriction != nil {
		bufferedFrames = max(bufferedFrames, sps.VUI.BitstreamRestriction.MaxDecFrameBuffering,
			sps.VUI.BitstreamRestriction.MaxNumReorderFrames)
	}
	// Level 5.2 also bounds the decoded-picture buffer. A per-frame size check
	// alone would let a larger picture multiply the old 16-reference allocation.
	if bufferedFrames > 16 || width*height/256*uint64(bufferedFrames) > 184_320 {
		return 0, 0, errors.New("native H264 input reference storage exceeds its bound")
	}
	if crop := sps.FrameCropping; crop != nil {
		x := (uint64(crop.LeftOffset) + uint64(crop.RightOffset)) * 2
		y := (uint64(crop.TopOffset) + uint64(crop.BottomOffset)) * cropUnitY
		if x >= width || y >= height {
			return 0, 0, errors.New("native H264 input crop is outside its picture")
		}
		width, height = width-x, height-y
	}
	if !nativecapture.ValidVideoSize(uint32(width), uint32(height)) {
		return 0, 0, errors.New("native H264 input picture exceeds its bound")
	}
	return uint32(width), uint32(height), nil
}
