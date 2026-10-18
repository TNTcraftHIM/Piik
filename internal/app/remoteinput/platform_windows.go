//go:build windows

package remoteinput

import (
	"context"
	"errors"
	"math"
	"runtime"
	"unicode/utf16"
	"unicode/utf8"
	"unsafe"

	"golang.org/x/sys/windows"
)

var user32 = windows.NewLazySystemDLL("user32.dll")
var sendInput = user32.NewProc("SendInput")
var metrics = user32.NewProc("GetSystemMetrics")

type mouseInput struct {
	X, Y              int32
	Data, Flags, Time uint32
	Extra             uintptr
}
type keyboardInput struct {
	VK, Scan    uint16
	Flags, Time uint32
	Extra       uintptr
}
type winInput struct {
	Kind  uint32
	Mouse mouseInput
}
type windowsSink struct {
	keys    map[uint16]bool
	buttons map[int]bool
}

func newPlatformSink(bool) (inputSink, error) {
	if err := sendInput.Find(); err != nil {
		return nil, err
	}
	// The capture helper reports physical pixels. Match that coordinate space
	// before reading monitor bounds in this Go process (including mixed DPI).
	user32.NewProc("SetProcessDpiAwarenessContext").Call(^uintptr(3))
	return &windowsSink{keys: map[uint16]bool{}, buttons: map[int]bool{}}, nil
}

func (*windowsSink) Authorize() error { return nil }

func inject(inputs ...winInput) error {
	n, _, _ := sendInput.Call(uintptr(len(inputs)), uintptr(unsafe.Pointer(&inputs[0])), unsafe.Sizeof(inputs[0]))
	if n != uintptr(len(inputs)) {
		return errors.New("Windows did not accept input")
	}
	return nil
}

func keyInput(scan uint16, down bool) winInput {
	input := winInput{Kind: 1}
	k := (*keyboardInput)(unsafe.Pointer(&input.Mouse))
	k.Scan, k.Flags = scan&0xff, 8 // KEYEVENTF_SCANCODE: physical key, not text.
	if !down {
		k.Flags |= 2
	}
	if scan&0xff00 == 0xe000 {
		k.Flags |= 1
	}
	return input
}

// Soft keyboards and IMEs supply committed text, not physical scan codes.
// Send complete UTF-16 pairs through Windows' standard VK_PACKET path.
func textInputs(text string) ([]winInput, error) {
	if len(text) == 0 || len(text) > 512 || !utf8.ValidString(text) {
		return nil, errors.New("invalid input text")
	}
	var inputs []winInput
	for _, r := range text {
		if r < 0x20 || r == 0x7f {
			return nil, errors.New("text contains a control character")
		}
	}
	for _, unit := range utf16.Encode([]rune(text)) {
		for _, flags := range []uint32{4, 6} { // KEYEVENTF_UNICODE, then KEYUP.
			input := winInput{Kind: 1}
			k := (*keyboardInput)(unsafe.Pointer(&input.Mouse))
			k.Scan, k.Flags = unit, flags
			inputs = append(inputs, input)
		}
	}
	return inputs, nil
}

func buttonInput(button int, down bool) (winInput, error) {
	flags := [...]uint32{2, 0x20, 8, 0x80, 0x80} // left, middle, right, X1, X2
	if button < 0 || button >= len(flags) {
		return winInput{}, errors.New("invalid button")
	}
	input := winInput{Mouse: mouseInput{Flags: flags[button]}}
	if button >= 3 {
		input.Mouse.Data = 1 << (button - 3)
	}
	if !down {
		input.Mouse.Flags <<= 1
	}
	return input, nil
}

func (s *windowsSink) Apply(b bounds, e inputEvent) error {
	switch e.Type {
	case "move":
		if math.IsNaN(e.X) || math.IsNaN(e.Y) || e.X < 0 || e.X > 1 || e.Y < 0 || e.Y > 1 {
			return errors.New("invalid pointer")
		}
		x, _, _ := metrics.Call(76)
		y, _, _ := metrics.Call(77)
		w, _, _ := metrics.Call(78)
		h, _, _ := metrics.Call(79)
		if int32(w) < 2 || int32(h) < 2 {
			return errors.New("desktop is unavailable")
		}
		px := float64(b.left) + e.X*float64(b.width-1) - float64(int32(x))
		py := float64(b.top) + e.Y*float64(b.height-1) - float64(int32(y))
		return inject(winInput{Mouse: mouseInput{X: int32(px * 65535 / float64(int32(w)-1)), Y: int32(py * 65535 / float64(int32(h)-1)), Flags: 0xc001}})
	case "relative":
		if e.DX < -32767 || e.DX > 32767 || e.DY < -32767 || e.DY > 32767 {
			return errors.New("invalid relative pointer")
		}
		return inject(winInput{Mouse: mouseInput{X: e.DX, Y: e.DY, Flags: 1}})
	case "button":
		input, err := buttonInput(e.Button, e.Down)
		if err != nil {
			return err
		}
		if !e.Down && !s.buttons[e.Button] {
			return nil
		}
		if err := inject(input); err != nil {
			return err
		}
		if e.Down {
			s.buttons[e.Button] = true
		} else {
			delete(s.buttons, e.Button)
		}
	case "wheel":
		if e.Delta < -1200 || e.Delta > 1200 {
			return errors.New("invalid wheel")
		}
		return inject(winInput{Mouse: mouseInput{Data: uint32(int32(e.Delta)), Flags: 0x800}})
	case "key":
		key := scanCodes[e.Code]
		if key == 0 {
			return nil
		}
		if !e.Down && !s.keys[key] {
			return nil
		}
		if err := inject(keyInput(key, e.Down)); err != nil {
			return err
		}
		if e.Down {
			s.keys[key] = true
		} else {
			delete(s.keys, key)
		}
	case "text":
		inputs, err := textInputs(e.Text)
		if err != nil {
			return err
		}
		// Text submission is self-contained; a prior modifier must not turn it
		// into a shortcut. Existing physical input retains its scan-code path.
		if err := s.Reset(); err != nil {
			return err
		}
		return inject(inputs...)
	default:
		return errors.New("unsupported input")
	}
	return nil
}

func (s *windowsSink) Reset() error {
	var result error
	for key := range s.keys {
		if err := inject(keyInput(key, false)); err != nil {
			result = errors.Join(result, err)
		} else {
			delete(s.keys, key)
		}
	}
	for button := range s.buttons {
		result = errors.Join(result, s.Apply(bounds{}, inputEvent{Type: "button", Button: button}))
	}
	return result
}

// A native hotkey supplies local revocation even while a Browser has focus.
// It observes this shortcut only; no keyboard hook or key recording is installed.
func watchStopShortcut(ctx context.Context, stop func()) error {
	ready := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		tid := windows.GetCurrentThreadId()
		var msg struct {
			Window  uintptr
			Message uint32
			WParam  uintptr
			LParam  uintptr
			Time    uint32
			X, Y    int32
			Private uint32
		}
		user32.NewProc("PeekMessageW").Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0, 0)
		ok, _, _ := user32.NewProc("RegisterHotKey").Call(0, 1, 0x4003, 0x79) // Ctrl+Alt+F10; no repeat.
		if ok == 0 {
			ready <- errors.New("Ctrl+Alt+F10 is already in use")
			return
		}
		defer user32.NewProc("UnregisterHotKey").Call(0, 1)
		ready <- nil
		done := make(chan struct{})
		defer close(done)
		go func() {
			select {
			case <-ctx.Done():
				user32.NewProc("PostThreadMessageW").Call(uintptr(tid), 0x12, 0, 0)
			case <-done:
			}
		}()
		for {
			n, _, _ := user32.NewProc("GetMessageW").Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
			if int32(n) <= 0 {
				return
			}
			if msg.Message == 0x312 {
				stop()
			}
		}
	}()
	return <-ready
}
