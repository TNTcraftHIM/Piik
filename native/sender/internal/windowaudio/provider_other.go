//go:build !windows

package windowaudio

import "context"

type unsupportedProvider struct{}

func NewProvider() Provider { return unsupportedProvider{} }

func (unsupportedProvider) List(context.Context) ([]Target, error) { return nil, ErrUnavailable }

func (unsupportedProvider) Capture(context.Context, Target, func(PCMChunk) error) error {
	return ErrUnavailable
}
