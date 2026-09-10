package nativecapture

import (
	"encoding/binary"
	"errors"
	"io"
	"time"
	"unicode/utf8"

	"github.com/TNTcraftHIM/Piik/internal/media/encoded"
)

const (
	envelopeHeaderBytes = 32
	maxMediaBytes       = encoded.MaxAccessUnitBytes
	maxStatusBytes      = 4 * 1024
	maxControlBytes     = 64
)

type FrameKind uint8

const (
	FramePCM              FrameKind = 1
	FrameH264             FrameKind = 2
	FrameStatus           FrameKind = 3
	FrameVP8              FrameKind = 4
	FrameBegin            FrameKind = 5
	FrameLayerUnavailable FrameKind = 6
	FrameControl          FrameKind = 7
)

type Frame struct {
	Kind FrameKind
	// KeyFrame denotes independent recovery, including H264 SPS/PPS when needed.
	KeyFrame  bool
	Layer     int
	Width     uint32
	Height    uint32
	Timestamp time.Duration
	Duration  time.Duration
	Data      []byte
}

func readFrame(input io.Reader) (Frame, error) {
	var header [envelopeHeaderBytes]byte
	if _, err := io.ReadFull(input, header[:]); err != nil {
		return Frame{}, err
	}
	frame, size, err := parseFrameHeader(header[:])
	if err != nil {
		return Frame{}, err
	}
	frame.Data = make([]byte, size)
	if _, err = io.ReadFull(input, frame.Data); err != nil {
		return Frame{}, err
	}
	if err = validateFrameData(frame); err != nil {
		return Frame{}, err
	}
	return frame, nil
}

func parseFrameHeader(header []byte) (Frame, uint32, error) {
	kind := FrameKind(header[5])
	size := binary.BigEndian.Uint32(header[28:32])
	maximum := uint32(maxMediaBytes)
	if kind == FrameStatus || kind == FrameLayerUnavailable {
		maximum = maxStatusBytes
	} else if kind == FrameControl {
		maximum = maxControlBytes
	}
	if string(header[:4]) != "SMED" || header[4] != 2 ||
		kind < FramePCM || kind > FrameControl || size > maximum ||
		(kind == FrameBegin) != (size == 0) {
		return Frame{}, 0, errors.New("native capture frame header is invalid")
	}
	timestamp100ns := binary.BigEndian.Uint64(header[8:16])
	duration100ns := binary.BigEndian.Uint64(header[16:24])
	width := uint32(binary.BigEndian.Uint16(header[24:26]))
	height := uint32(binary.BigEndian.Uint16(header[26:28]))
	layer := int(header[7])
	isVideo := kind == FrameH264 || kind == FrameVP8
	isTimed := isVideo || kind == FramePCM || kind == FrameBegin
	const maxTime100ns = uint64(1<<63-1) / 100
	if timestamp100ns > maxTime100ns || duration100ns > maxTime100ns ||
		(isTimed && duration100ns == 0) || (!isTimed && (timestamp100ns != 0 || duration100ns != 0)) ||
		(isVideo && (header[6] > 1 || layer >= maxOutputs || width < 2 || width > 2560 ||
			height < 2 || height > 1440 || width%2 != 0 || height%2 != 0)) ||
		(!isVideo && (header[6] != 0 || width != 0 || height != 0)) ||
		(kind == FrameLayerUnavailable && layer >= maxOutputs) ||
		(!isVideo && kind != FrameLayerUnavailable && layer != 0) {
		return Frame{}, 0, errors.New("native capture media frame is invalid")
	}
	return Frame{
		Kind:      kind,
		KeyFrame:  isVideo && header[6] == 1,
		Layer:     layer,
		Width:     width,
		Height:    height,
		Timestamp: time.Duration(timestamp100ns) * 100 * time.Nanosecond,
		Duration:  time.Duration(duration100ns) * 100 * time.Nanosecond,
	}, size, nil
}

func validateFrameData(frame Frame) error {
	if frame.Kind == FrameLayerUnavailable && !utf8.Valid(frame.Data) {
		return errors.New("native unavailable output diagnostic is invalid")
	}
	if frame.Kind == FrameControl {
		for _, value := range frame.Data {
			if value < 32 || value > 126 {
				return errors.New("native control payload is not ASCII")
			}
		}
	}
	return nil
}

func writeFrame(output io.Writer, frame Frame) error {
	if frame.Timestamp < 0 || frame.Duration < 0 || frame.Layer < 0 || frame.Layer > 255 ||
		frame.Width > 65_535 || frame.Height > 65_535 || len(frame.Data) > maxMediaBytes {
		return errors.New("native capture frame is outside its envelope")
	}
	var header [envelopeHeaderBytes]byte
	copy(header[:], "SMED")
	header[4], header[5], header[7] = 2, byte(frame.Kind), byte(frame.Layer)
	if frame.KeyFrame {
		header[6] = 1
	}
	binary.BigEndian.PutUint64(header[8:16], uint64(frame.Timestamp/(100*time.Nanosecond)))
	binary.BigEndian.PutUint64(header[16:24], uint64(frame.Duration/(100*time.Nanosecond)))
	binary.BigEndian.PutUint16(header[24:26], uint16(frame.Width))
	binary.BigEndian.PutUint16(header[26:28], uint16(frame.Height))
	binary.BigEndian.PutUint32(header[28:32], uint32(len(frame.Data)))
	if _, _, err := parseFrameHeader(header[:]); err != nil {
		return err
	}
	if err := validateFrameData(frame); err != nil {
		return err
	}
	for _, data := range [][]byte{header[:], frame.Data} {
		if len(data) == 0 {
			continue
		}
		n, err := output.Write(data)
		if err != nil {
			return err
		}
		if n != len(data) {
			return io.ErrShortWrite
		}
	}
	return nil
}
