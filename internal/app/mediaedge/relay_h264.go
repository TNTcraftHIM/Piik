package mediaedge

import (
	"bytes"
	"encoding/hex"
	"errors"
	"fmt"
	"io"

	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/TNTcraftHIM/Piik/internal/media/encoded"
	"github.com/bluenviron/mediacommon/v2/pkg/bits"
	"github.com/bluenviron/mediacommon/v2/pkg/codecs/h264"
	"github.com/pion/webrtc/v4/pkg/media/h264reader"
)

type relaySPS struct {
	id            uint32
	nal           []byte
	width, height uint32
}

type relayPPS struct {
	sequence uint32
	nal      []byte
}

type relayH264Parameters struct {
	sequences [32]*relaySPS
	pictures  [256]*relayPPS
	bytes     int
	emitted   *relayPPS
}

// These header fields precede the slice payload. Even three 63-bit Exp-Golomb
// fields fit in 48 EBSP bytes with emulation prevention.
func relayH264IDs(nal []byte, fields int) ([3]uint32, error) {
	rbsp := h264.EmulationPreventionRemove(nal[1:min(len(nal), 49)])
	pos := 0
	var values [3]uint32
	for i := range fields {
		start := pos
		value, err := bits.ReadGolombUnsigned(rbsp, &pos)
		if err != nil || pos-start > 63 {
			return values, errors.New("invalid native H264 parameter reference")
		}
		values[i] = value
	}
	return values, nil
}

func (sets *relayH264Parameters) store(nal *h264reader.NAL) error {
	switch nal.UnitType {
	case h264reader.NalUnitTypeSPS:
		sps, err := parseRelaySPS(nal.Data)
		if err != nil {
			return err
		}
		if old := sets.sequences[sps.id]; old != nil {
			sets.bytes -= len(old.nal)
		}
		sets.sequences[sps.id] = sps
	case h264reader.NalUnitTypePPS:
		ids, err := relayH264IDs(nal.Data, 2)
		if err != nil || ids[0] >= uint32(len(sets.pictures)) || ids[1] >= uint32(len(sets.sequences)) {
			return errors.New("invalid native H264 PPS reference")
		}
		if old := sets.pictures[ids[0]]; old != nil {
			sets.bytes -= len(old.nal)
		}
		sets.pictures[ids[0]] = &relayPPS{sequence: ids[1], nal: nal.Data}
	}
	sets.emitted = nil
	sets.bytes += len(nal.Data)
	if sets.bytes > encoded.MaxAccessUnitBytes {
		return errors.New("native H264 parameter sets exceed their bound")
	}
	return nil
}

func (input *relayVideoInput) h264Frame(data []byte, parametersOnly bool) (nativecapture.Frame, error) {
	var frame nativecapture.Frame
	reader, err := h264reader.NewReader(bytes.NewReader(data))
	if err != nil {
		return frame, err
	}
	sets := &input.h264
	var picture *relayPPS
	var sequence *relaySPS
	var firstHeader byte
	var inlineSPS, inlinePPS []byte
	var invalid, attach bool
	for {
		nal, err := reader.NextNAL()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return frame, err
		}
		switch nal.UnitType {
		case h264reader.NalUnitTypeSPS, h264reader.NalUnitTypePPS:
			if err := sets.store(nal); err != nil {
				return frame, err
			}
			if nal.UnitType == h264reader.NalUnitTypeSPS {
				inlineSPS, inlinePPS = nal.Data, nil
			} else {
				inlinePPS = nal.Data
			}
		case h264reader.NalUnitTypeCodedSliceIdr, h264reader.NalUnitTypeCodedSliceNonIdr:
			if parametersOnly {
				continue
			}
			ids, err := relayH264IDs(nal.Data, 3)
			if err != nil || ids[2] >= uint32(len(sets.pictures)) {
				invalid = true
				continue
			}
			pps := sets.pictures[ids[2]]
			if pps == nil || sets.sequences[pps.sequence] == nil {
				invalid = true
				continue
			}
			sps := sets.sequences[pps.sequence]
			if firstHeader != 0 {
				if pps != picture || sps != sequence || firstHeader&31 != byte(nal.UnitType) {
					invalid = true
				}
				continue
			}
			firstHeader, picture, sequence = nal.Data[0], pps, sps
			attach = (nal.UnitType == h264reader.NalUnitTypeCodedSliceIdr || sets.emitted != pps) &&
				(!bytes.Equal(inlineSPS, sps.nal) || !bytes.Equal(inlinePPS, pps.nal))
		case h264reader.NalUnitTypeCodedSliceDataPartitionA, h264reader.NalUnitTypeCodedSliceDataPartitionB, h264reader.NalUnitTypeCodedSliceDataPartitionC:
			invalid = !parametersOnly
		}
	}
	if invalid {
		if input.onPacketDropped != nil {
			input.onPacketDropped()
		}
		return frame, nil
	}
	if picture == nil {
		return frame, nil
	}
	if attach {
		size := len(data) + len(sequence.nal) + len(picture.nal) + 8
		if size > encoded.MaxAccessUnitBytes {
			return frame, errors.New("native H264 access unit exceeds its bound")
		}
		// A start code cannot occur inside an escaped NAL. Insert immediately
		// before the first slice, preserving AUD, SEI and other in-band NALs.
		at := bytes.Index(data, []byte{0, 0, 1, firstHeader}) + 3
		out := make([]byte, 0, size)
		out = append(out, data[:at]...)
		out = append(out, sequence.nal...)
		out = append(out, 0, 0, 0, 1)
		out = append(out, picture.nal...)
		out = append(out, 0, 0, 0, 1)
		data = append(out, data[at:]...)
	}
	// An SPS with the same ID may follow the picture in this access unit.
	if sets.sequences[picture.sequence] == sequence {
		sets.emitted = picture
	}
	return nativecapture.Frame{Kind: nativecapture.FrameH264, Data: data, KeyFrame: firstHeader&31 == 5,
		Width: sequence.width, Height: sequence.height}, nil
}

// A size summary is not a decoder allocation bound: one access unit may carry
// several SPS IDs, and a slice need not reference the last one. Admit every SPS
// before forwarding it to any platform decoder, including its uncropped storage.
func parseRelaySPS(nal []byte) (*relaySPS, error) {
	if len(nal) < 4 || !forwardableH264("profile-level-id="+hex.EncodeToString(nal[1:4])+";packetization-mode=1") {
		return nil, errors.New("native H264 input profile is unsupported")
	}
	var sps h264.SPS
	if err := sps.Unmarshal(nal); err != nil {
		return nil, fmt.Errorf("invalid native H264 input SPS: %w", err)
	}
	if sps.ID > 31 {
		return nil, errors.New("invalid native H264 SPS ID")
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
		return nil, errors.New("native H264 input storage exceeds its bound")
	}
	bufferedFrames := max(1, sps.MaxNumRefFrames)
	if sps.VUI != nil && sps.VUI.BitstreamRestriction != nil {
		bufferedFrames = max(bufferedFrames, sps.VUI.BitstreamRestriction.MaxDecFrameBuffering,
			sps.VUI.BitstreamRestriction.MaxNumReorderFrames)
	}
	// Level 5.2 also bounds the decoded-picture buffer. A per-frame size check
	// alone would let a larger picture multiply the old 16-reference allocation.
	if bufferedFrames > 16 || width*height/256*uint64(bufferedFrames) > 184_320 {
		return nil, errors.New("native H264 input reference storage exceeds its bound")
	}
	if crop := sps.FrameCropping; crop != nil {
		x := (uint64(crop.LeftOffset) + uint64(crop.RightOffset)) * 2
		y := (uint64(crop.TopOffset) + uint64(crop.BottomOffset)) * cropUnitY
		if x >= width || y >= height {
			return nil, errors.New("native H264 input crop is outside its picture")
		}
		width, height = width-x, height-y
	}
	if !nativecapture.ValidVideoSize(uint32(width), uint32(height)) {
		return nil, errors.New("native H264 input picture exceeds its bound")
	}
	return &relaySPS{id: sps.ID, nal: nal, width: uint32(width), height: uint32(height)}, nil
}
