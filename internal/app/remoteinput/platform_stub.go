//go:build !windows || !remotecontrol

package remoteinput

import (
	"context"
)

func newPlatformSink() (inputSink, error)             { return nil, nil }
func watchStopShortcut(context.Context, func()) error { return nil }
