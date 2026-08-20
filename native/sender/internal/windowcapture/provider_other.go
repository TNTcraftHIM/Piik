//go:build !windows

package windowcapture

import "context"

type unsupportedProvider struct{}

func NewProvider() Provider { return unsupportedProvider{} }

func (unsupportedProvider) List(context.Context) ([]Target, error) { return nil, ErrUnavailable }

func (unsupportedProvider) CaptureAudio(context.Context, Target, func(PCMChunk) error) error {
	return ErrUnavailable
}

func (unsupportedProvider) CaptureWindow(
	context.Context,
	Target,
	<-chan struct{},
	func(PCMChunk) error,
	func(H264AccessUnit) error,
	func(Status) error,
) error {
	return ErrUnavailable
}
