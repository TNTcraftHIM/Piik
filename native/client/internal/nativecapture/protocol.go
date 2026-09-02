package nativecapture

import (
	"encoding/binary"
	"errors"
	"io"
	"time"
)

const (
	envelopeHeaderBytes = 28
	maxMediaBytes       = 1024 * 1024
	maxStatusBytes      = 4 * 1024
)

type FrameKind uint8

const (
	FramePCM    FrameKind = 1
	FrameH264   FrameKind = 2
	FrameStatus FrameKind = 3
)

type Frame struct {
	Kind      FrameKind
	KeyFrame  bool
	Timestamp time.Duration
	Duration  time.Duration
	Data      []byte
}

func readFrame(input io.Reader) (Frame, error) {
	header := make([]byte, envelopeHeaderBytes)
	if _, err := io.ReadFull(input, header); err != nil {
		return Frame{}, err
	}
	kind := FrameKind(header[5])
	size := binary.BigEndian.Uint32(header[24:])
	maximum := uint32(maxMediaBytes)
	if kind == FrameStatus {
		maximum = maxStatusBytes
	}
	if string(header[:4]) != "SMED" || header[4] != 1 || header[7] != 0 ||
		(kind != FramePCM && kind != FrameH264 && kind != FrameStatus) ||
		size == 0 || size > maximum {
		return Frame{}, errors.New("native capture frame header is invalid")
	}
	timestamp100ns := binary.BigEndian.Uint64(header[8:16])
	duration100ns := binary.BigEndian.Uint64(header[16:24])
	if kind == FrameStatus {
		if header[6] != 0 || timestamp100ns != 0 || duration100ns != 0 {
			return Frame{}, errors.New("native capture status frame is invalid")
		}
	} else if duration100ns == 0 || (kind == FramePCM && header[6] != 0) ||
		(kind == FrameH264 && header[6] > 1) {
		return Frame{}, errors.New("native capture media frame is invalid")
	}
	data := make([]byte, size)
	if _, err := io.ReadFull(input, data); err != nil {
		return Frame{}, err
	}
	return Frame{
		Kind:      kind,
		KeyFrame:  kind == FrameH264 && header[6] == 1,
		Timestamp: time.Duration(timestamp100ns) * 100 * time.Nanosecond,
		Duration:  time.Duration(duration100ns) * 100 * time.Nanosecond,
		Data:      data,
	}, nil
}
