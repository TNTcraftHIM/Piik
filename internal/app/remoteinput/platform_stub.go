//go:build ios || (!windows && !darwin && !linux) || (darwin && !cgo)

package remoteinput

import (
	"context"
)

func newPlatformSink(bool) (inputSink, error)                        { return nil, nil }
func watchStopShortcut(context.Context, int, func()) (func(), error) { return func() {}, nil }
