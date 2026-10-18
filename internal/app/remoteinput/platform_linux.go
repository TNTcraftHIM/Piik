//go:build linux

package remoteinput

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
)

type portalSink struct{ capture *nativecapture.Stream }

func newPlatformSink(captureInput bool) (inputSink, error) {
	if !captureInput {
		return nil, nil
	}
	return &portalSink{}, nil
}

func (*portalSink) Authorize() error { return nil } // The capture owner obtains Portal consent.

func (s *portalSink) Target(_ nativecapture.CaptureTarget, capture *nativecapture.Stream) (bounds, bool, error) {
	if !capture.RemoteInput() {
		return bounds{}, false, errors.New("shared screen input is unavailable")
	}
	s.capture = capture
	return bounds{width: 1, height: 1}, true, nil // Portal maps normalized positions to logical screen coordinates.
}

func (s *portalSink) Apply(_ bounds, e inputEvent) error {
	var command string
	down := 0
	if e.Down {
		down = 1
	}
	switch e.Type {
	case "move":
		if e.X < 0 || e.X > 1 || e.Y < 0 || e.Y > 1 {
			return errors.New("invalid pointer position")
		}
		command = fmt.Sprintf("M %.9f %.9f", e.X, e.Y)
	case "relative":
		if e.DX < -32767 || e.DX > 32767 || e.DY < -32767 || e.DY > 32767 {
			return errors.New("invalid pointer delta")
		}
		command = fmt.Sprintf("R %d %d", e.DX, e.DY)
	case "button":
		if e.Button < 0 || e.Button > 4 {
			return errors.New("invalid pointer button")
		}
		command = fmt.Sprintf("B %d %d", e.Button, down)
	case "key":
		code := evdevCode(e.Code)
		if code == 0 {
			return nil
		}
		command = fmt.Sprintf("K %d %d", code, down)
	case "wheel":
		if e.Delta < -1200 || e.Delta > 1200 {
			return errors.New("invalid scroll delta")
		}
		command = fmt.Sprintf("W %d", e.Delta)
	case "text":
		for _, r := range e.Text {
			if err := s.capture.SendRemoteInput(fmt.Sprintf("U %d", r)); err != nil {
				return err
			}
		}
		return nil
	default:
		return errors.New("unsupported input")
	}
	return s.capture.SendRemoteInput(command)
}

func (s *portalSink) Reset() error {
	if s.capture == nil {
		return nil
	}
	return s.capture.SendRemoteInput("Z")
}

// The compositor owns its global stop shortcut. The page's stop action/chord
// remains available; we do not grab global keys or request a second permission.
func watchStopShortcut(context.Context, func()) error { return nil }

func evdevCode(code string) uint16 {
	if scan := scanCodes[code]; scan > 0 && scan <= 0x58 {
		return scan
	}
	if len(code) >= 3 && code[0] == 'F' {
		if f, err := strconv.Atoi(code[1:]); err == nil && f >= 13 && f <= 24 {
			return uint16(183 + f - 13)
		}
	}
	return map[string]uint16{
		"NumpadEnter": 96, "ControlRight": 97, "NumpadDivide": 98, "PrintScreen": 99, "AltRight": 100,
		"Home": 102, "ArrowUp": 103, "PageUp": 104, "ArrowLeft": 105, "ArrowRight": 106, "End": 107,
		"ArrowDown": 108, "PageDown": 109, "Insert": 110, "Delete": 111, "Pause": 119,
		"MetaLeft": 125, "MetaRight": 126, "ContextMenu": 127,
	}[code]
}
