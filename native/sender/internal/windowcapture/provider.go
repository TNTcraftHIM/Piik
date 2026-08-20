package windowcapture

import (
	"context"
	"errors"
)

var ErrUnavailable = errors.New("Windows 11 window capture is unavailable")

type Target struct {
	WindowHandle uint64
	PID          uint32
	CreationTime uint64
	Title        string
}

type PCMChunk struct {
	Timestamp100ns uint64
	Duration100ns  uint64
	Data           []byte
}

type H264AccessUnit struct {
	KeyFrame       bool
	Timestamp100ns uint64
	Duration100ns  uint64
	Data           []byte
}

type Status struct {
	State          string `json:"state"`
	HardwareOnly   bool   `json:"hardwareOnly"`
	AdapterIndex   *uint  `json:"adapterIndex,omitempty"`
	AdapterName    string `json:"adapterName,omitempty"`
	AdapterLUID    string `json:"adapterLuid,omitempty"`
	MFTIndex       *uint  `json:"mftIndex,omitempty"`
	MFTName        string `json:"mftName,omitempty"`
	MFTCLSID       string `json:"mftClsid,omitempty"`
	ProfileLevelID string `json:"profileLevelId,omitempty"`
	Width          int    `json:"width,omitempty"`
	Height         int    `json:"height,omitempty"`
	FPS            int    `json:"fps,omitempty"`
}

type Provider interface {
	List(context.Context) ([]Target, error)
	CaptureAudio(context.Context, Target, func(PCMChunk) error) error
	CaptureWindow(
		context.Context,
		Target,
		<-chan struct{},
		func(PCMChunk) error,
		func(H264AccessUnit) error,
		func(Status) error,
	) error
}
