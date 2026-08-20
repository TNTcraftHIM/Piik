package windowaudio

import (
	"context"
	"errors"
)

var ErrUnavailable = errors.New("Windows 11 process audio is unavailable")

type Target struct {
	PID          uint32
	CreationTime uint64
	Title        string
}

type PCMChunk struct {
	Timestamp100ns uint64
	Duration100ns  uint64
	Data           []byte
}

type Provider interface {
	List(context.Context) ([]Target, error)
	Capture(context.Context, Target, func(PCMChunk) error) error
}
