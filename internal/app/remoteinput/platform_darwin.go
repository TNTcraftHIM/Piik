//go:build darwin && cgo

package remoteinput

/*
#cgo LDFLAGS: -framework ApplicationServices -framework AppKit
#include "platform_darwin.h"
*/
import "C"

import (
	"context"
	"errors"
	"strconv"
	"time"
	"unicode/utf16"
	"unsafe"

	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
)

type macSink struct {
	source  C.CGEventSourceRef
	keys    map[uint16]bool
	buttons map[int]bool
	clicks  [5]C.PiikInputClick
	caps    bool
}

func newPlatformSink(bool) (inputSink, error) {
	source := C.CGEventSourceCreate(C.kCGEventSourceStatePrivate)
	if source == 0 {
		return nil, errors.New("macOS input is unavailable")
	}
	return &macSink{source: source, keys: map[uint16]bool{}, buttons: map[int]bool{},
		caps: C.CGEventSourceFlagsState(C.kCGEventSourceStateCombinedSessionState)&C.kCGEventFlagMaskAlphaShift != 0}, nil
}

func (*macSink) Authorize() error {
	if !bool(C.CGPreflightPostEventAccess()) && !bool(C.CGRequestPostEventAccess()) {
		return errors.New("remote input requires macOS Accessibility permission")
	}
	return nil
}

func (*macSink) Target(target nativecapture.CaptureTarget, _ *nativecapture.Stream) (bounds, bool, error) {
	if !bool(C.CGPreflightPostEventAccess()) {
		return bounds{}, false, errors.New("macOS input permission was revoked")
	}
	id, err := strconv.ParseUint(target.SourceID, 10, 32)
	if err != nil || id == 0 || (target.Kind != "display" && target.Kind != "window") {
		return bounds{}, false, errors.New("shared source is unavailable")
	}
	created, _ := strconv.ParseUint(target.CreationTime, 10, 64)
	var b C.PiikInputBounds
	if !bool(C.piik_input_target(C.bool(target.Kind == "window"), C.uint32_t(id), C.uint32_t(target.PID), C.uint64_t(created), &b)) {
		return bounds{}, false, errors.New("shared source is unavailable")
	}
	return bounds{int32(b.left), int32(b.top), int32(b.width), int32(b.height)}, bool(b.focused), nil
}

func (s *macSink) flags() C.uint64_t {
	var flags uint64
	if s.caps {
		flags |= 1 << 16
	}
	for key := range s.keys {
		switch key {
		case 56, 60:
			flags |= 1 << 17
		case 59, 62:
			flags |= 1 << 18
		case 58, 61:
			flags |= 1 << 19
		case 54, 55:
			flags |= 1 << 20
		}
	}
	return C.uint64_t(flags)
}

func (s *macSink) Apply(b bounds, e inputEvent) error {
	ok := true
	switch e.Type {
	case "move", "relative":
		x, y := float64(b.left)+e.X*float64(b.width-1), float64(b.top)+e.Y*float64(b.height-1)
		if e.Type == "relative" {
			if e.DX < -32767 || e.DX > 32767 || e.DY < -32767 || e.DY > 32767 {
				return errors.New("invalid pointer delta")
			}
			x, y = float64(e.DX), float64(e.DY)
		} else if e.X < 0 || e.X > 1 || e.Y < 0 || e.Y > 1 {
			return errors.New("invalid pointer position")
		}
		drag := -1
		for button := 0; button < 5; button++ {
			if s.buttons[button] {
				drag = button
				break
			}
		}
		ok = bool(C.piik_input_pointer(s.source, C.double(x), C.double(y), -1, false, C.int(drag), C.bool(e.Type == "relative"), s.flags(), nil))
	case "button":
		if e.Button < 0 || e.Button > 4 {
			return errors.New("invalid pointer button")
		}
		button := [...]int{0, 2, 1, 3, 4}[e.Button]
		if !e.Down && !s.buttons[button] {
			return nil
		}
		ok = bool(C.piik_input_pointer(s.source, 0, 0, C.int(button), C.bool(e.Down), -1, false, s.flags(), &s.clicks[button]))
		if ok {
			if e.Down {
				s.buttons[button] = true
			} else {
				delete(s.buttons, button)
			}
		}
	case "wheel":
		if e.Delta < -1200 || e.Delta > 1200 {
			return errors.New("invalid scroll delta")
		}
		ok = bool(C.piik_input_scroll(s.source, C.int32_t(e.Delta), s.flags()))
	case "key":
		code, known := macKeyCodes[e.Code]
		if !known {
			return nil
		}
		held := s.keys[code]
		if !e.Down && !held {
			return nil
		}
		caps := s.caps
		if code == 57 && e.Down && !held {
			s.caps = !s.caps
		}
		if e.Down {
			s.keys[code] = true
		} else {
			delete(s.keys, code)
		}
		ok = bool(C.piik_input_key(s.source, C.uint16_t(code), C.bool(e.Down), s.flags(), C.bool(held && e.Down)))
		if !ok {
			s.caps = caps
			if held {
				s.keys[code] = true
			} else {
				delete(s.keys, code)
			}
		}
	case "text":
		text := utf16.Encode([]rune(e.Text))
		ok = bool(C.piik_input_text(s.source, (*C.uint16_t)(unsafe.Pointer(&text[0])), C.size_t(len(text))))
	default:
		return errors.New("unsupported input")
	}
	if !ok {
		return errors.New("macOS could not create the input event")
	}
	return nil
}

func (s *macSink) Reset() error {
	var result error
	for code := range s.keys {
		delete(s.keys, code)
		if !bool(C.piik_input_key(s.source, C.uint16_t(code), false, s.flags(), false)) {
			s.keys[code] = true
			result = errors.New("macOS could not release held input")
		}
	}
	for button := range s.buttons {
		if bool(C.piik_input_pointer(s.source, 0, 0, C.int(button), false, -1, false, s.flags(), &s.clicks[button])) {
			delete(s.buttons, button)
		} else {
			result = errors.New("macOS could not release held input")
		}
	}
	s.clicks = [5]C.PiikInputClick{}
	return result
}

func (s *macSink) Close() error {
	_ = s.Reset()
	C.CFRelease(C.CFTypeRef(s.source))
	return nil
}

func watchStopShortcut(ctx context.Context, key int, stop func()) (func(), error) {
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	code := macKeyCodes["F"+strconv.Itoa(key)]
	go func() {
		defer close(done)
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		held := false
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				pressed := bool(C.piik_input_stop_pressed(C.uint16_t(code)))
				if pressed && !held {
					stop()
				}
				held = pressed
			}
		}
	}()
	return func() { cancel(); <-done }, nil
}

// Physical KeyboardEvent.code -> macOS virtual key, independent of text/IME.
var macKeyCodes = map[string]uint16{
	"KeyA": 0, "KeyS": 1, "KeyD": 2, "KeyF": 3, "KeyH": 4, "KeyG": 5, "KeyZ": 6, "KeyX": 7, "KeyC": 8, "KeyV": 9,
	"IntlBackslash": 10, "KeyB": 11, "KeyQ": 12, "KeyW": 13, "KeyE": 14, "KeyR": 15, "KeyY": 16, "KeyT": 17,
	"Digit1": 18, "Digit2": 19, "Digit3": 20, "Digit4": 21, "Digit6": 22, "Digit5": 23, "Equal": 24, "Digit9": 25,
	"Digit7": 26, "Minus": 27, "Digit8": 28, "Digit0": 29, "BracketRight": 30, "KeyO": 31, "KeyU": 32, "BracketLeft": 33,
	"KeyI": 34, "KeyP": 35, "Enter": 36, "KeyL": 37, "KeyJ": 38, "Quote": 39, "KeyK": 40, "Semicolon": 41, "Backslash": 42,
	"Comma": 43, "Slash": 44, "KeyN": 45, "KeyM": 46, "Period": 47, "Tab": 48, "Space": 49, "Backquote": 50, "Backspace": 51,
	"Escape": 53, "MetaRight": 54, "MetaLeft": 55, "ShiftLeft": 56, "CapsLock": 57, "AltLeft": 58, "ControlLeft": 59,
	"ShiftRight": 60, "AltRight": 61, "ControlRight": 62, "NumpadDecimal": 65, "NumpadMultiply": 67, "NumpadAdd": 69,
	"NumLock": 71, "NumpadDivide": 75, "NumpadEnter": 76, "NumpadSubtract": 78, "NumpadEqual": 81, "Numpad0": 82,
	"Numpad1": 83, "Numpad2": 84, "Numpad3": 85, "Numpad4": 86, "Numpad5": 87, "Numpad6": 88, "Numpad7": 89,
	"Numpad8": 91, "Numpad9": 92, "F5": 96, "F6": 97, "F7": 98, "F3": 99, "F8": 100, "F9": 101, "F11": 103,
	"F13": 105, "F16": 106, "F14": 107, "F10": 109, "F12": 111, "F15": 113, "Insert": 114, "Home": 115, "PageUp": 116,
	"Delete": 117, "F4": 118, "End": 119, "F2": 120, "PageDown": 121, "F1": 122, "ArrowLeft": 123, "ArrowRight": 124,
	"ArrowDown": 125, "ArrowUp": 126, "F17": 64, "F18": 79, "F19": 80, "F20": 90,
}
