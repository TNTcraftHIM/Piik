//go:build windows && remotecontrol

package remoteinput

import (
	"context"
	"errors"
	"math"
	"runtime"
	"strconv"
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

func newPlatformSink() (inputSink, error) {
	if err := sendInput.Find(); err != nil {
		return nil, err
	}
	// The capture helper reports physical pixels. Match that coordinate space
	// before reading monitor bounds in this Go process (including mixed DPI).
	user32.NewProc("SetProcessDpiAwarenessContext").Call(^uintptr(3))
	return &windowsSink{keys: map[uint16]bool{}, buttons: map[int]bool{}}, nil
}

func displayBounds(id string) (bounds, error) {
	monitor, err := strconv.ParseUint(id, 10, 64)
	if err != nil {
		return bounds{}, err
	}
	type rect struct{ Left, Top, Right, Bottom int32 }
	info := struct {
		Size          uint32
		Monitor, Work rect
		Flags         uint32
	}{}
	info.Size = uint32(unsafe.Sizeof(info))
	ok, _, _ := user32.NewProc("GetMonitorInfoW").Call(uintptr(monitor), uintptr(unsafe.Pointer(&info)))
	if ok == 0 {
		return bounds{}, errors.New("shared display is unavailable")
	}
	return bounds{info.Monitor.Left, info.Monitor.Top, info.Monitor.Right - info.Monitor.Left, info.Monitor.Bottom - info.Monitor.Top}, nil
}

func inject(input winInput) error {
	n, _, _ := sendInput.Call(1, uintptr(unsafe.Pointer(&input)), unsafe.Sizeof(input))
	if n != 1 {
		return errors.New("Windows did not accept input")
	}
	return nil
}

func keyInput(key uint16, down bool) winInput {
	input := winInput{Kind: 1}
	k := (*keyboardInput)(unsafe.Pointer(&input.Mouse))
	k.VK = key
	if !down {
		k.Flags = 2
	}
	if key >= 0x21 && key <= 0x2e || key == 0xa3 || key == 0xa5 || key == 0x5b || key == 0x5c {
		k.Flags |= 1
	}
	return input
}

func keyCode(code string) uint16 {
	if len(code) == 4 && code[:3] == "Key" && code[3] >= 'A' && code[3] <= 'Z' {
		return uint16(code[3])
	}
	if len(code) == 6 && code[:5] == "Digit" && code[5] >= '0' && code[5] <= '9' {
		return uint16(code[5])
	}
	if len(code) >= 2 && code[0] == 'F' {
		n, _ := strconv.Atoi(code[1:])
		if n >= 1 && n <= 12 {
			return uint16(0x6f + n)
		}
	}
	return map[string]uint16{"Backspace": 8, "Tab": 9, "Enter": 13, "Escape": 27, "Space": 32,
		"PageUp": 33, "PageDown": 34, "End": 35, "Home": 36, "ArrowLeft": 37, "ArrowUp": 38, "ArrowRight": 39, "ArrowDown": 40,
		"Insert": 45, "Delete": 46, "ShiftLeft": 0xa0, "ShiftRight": 0xa1, "ControlLeft": 0xa2, "ControlRight": 0xa3,
		"AltLeft": 0xa4, "AltRight": 0xa5, "MetaLeft": 0x5b, "MetaRight": 0x5c,
		"Semicolon": 0xba, "Equal": 0xbb, "Comma": 0xbc, "Minus": 0xbd, "Period": 0xbe, "Slash": 0xbf,
		"Backquote": 0xc0, "BracketLeft": 0xdb, "Backslash": 0xdc, "BracketRight": 0xdd, "Quote": 0xde}[code]
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
	case "button":
		flags := map[int]uint32{0: 2, 1: 0x20, 2: 8}[e.Button]
		if flags == 0 {
			return errors.New("invalid button")
		}
		if !e.Down && !s.buttons[e.Button] {
			return nil
		}
		if !e.Down {
			flags <<= 1
		}
		if err := inject(winInput{Mouse: mouseInput{Flags: flags}}); err != nil {
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
		key := keyCode(e.Code)
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
	default:
		return errors.New("unsupported input")
	}
	return nil
}

func (s *windowsSink) Reset() error {
	var result error
	for key := range s.keys {
		result = errors.Join(result, inject(keyInput(key, false)))
		delete(s.keys, key)
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
