//go:build !windows || !remotecontrol

package remoteinput

import (
	"context"
	"errors"
)

func newPlatformSink() (inputSink, error) { return nil, nil }
func displayBounds(string) (bounds, error) {
	return bounds{}, errors.New("remote input is unavailable")
}
func watchStopShortcut(context.Context, func()) error { return nil }
