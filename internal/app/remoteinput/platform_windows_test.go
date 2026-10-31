//go:build windows

package remoteinput

import (
	"context"
	"errors"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestWindowsInputRecoversItsDesktopAndPendingRelease(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	backend, err := newPlatformSink(false)
	if err != nil {
		t.Fatal(err)
	}
	sink := backend.(*windowsSink)
	active, _, _ := user32.NewProc("OpenInputDesktop").Call(0, 0, 0x81)
	if active == 0 {
		t.Skip("no accessible input desktop")
	}
	defer user32.NewProc("CloseDesktop").Call(active)
	activeName, ok := desktopName(active)
	if !ok || activeName != sink.desktop {
		t.Skip("test is not on the input desktop")
	}
	down, _, _ := user32.NewProc("GetAsyncKeyState").Call(1)
	if down&0x8000 != 0 {
		t.Skip("local mouse button is held")
	}
	thread, _, _ := user32.NewProc("GetThreadDesktop").Call(uintptr(windows.GetCurrentThreadId()))
	name, _ := windows.UTF16PtrFromString(t.Name())
	other, _, err := user32.NewProc("CreateDesktopW").Call(uintptr(unsafe.Pointer(name)), 0, 0, 0, 0x83, 0)
	if other == 0 {
		t.Fatalf("create isolated thread desktop: %v", err)
	}
	defer func() {
		if restored, _, err := user32.NewProc("SetThreadDesktop").Call(thread); restored == 0 {
			t.Errorf("restore test thread desktop: %v", err)
		}
		user32.NewProc("CloseDesktop").Call(other)
	}()
	if bound, _, err := user32.NewProc("SetThreadDesktop").Call(other); bound == 0 {
		t.Fatalf("bind isolated thread: %v", err)
	}
	// Never switch the visible desktop. Only this test thread leaves it.
	probe := winInput{Mouse: mouseInput{Flags: 1}}
	restricted := &windowsSink{desktop: windows.UTF16PtrToString(name)}
	if err := restricted.inject(probe); err == nil {
		t.Fatal("input escaped the backend's desktop")
	}
	if err := sink.inject(probe); err != nil {
		t.Fatalf("input did not recover to its own active desktop: %v", err)
	}
	current, _, _ := user32.NewProc("GetThreadDesktop").Call(uintptr(windows.GetCurrentThreadId()))
	currentName, _ := desktopName(current)
	if currentName != restricted.desktop {
		t.Fatal("injection changed the caller's desktop")
	}
	// A previously failed release must use the same recovery as fresh input.
	sink.buttons[0] = true
	m := &Manager{sink: sink, pendingButtons: map[int]bool{0: true}}
	if err := m.retryReleases(); err != nil || len(m.pendingButtons) != 0 || len(sink.buttons) != 0 {
		t.Fatalf("release debt did not recover: %v", err)
	}
	if err := sink.Apply(bounds{}, inputEvent{Type: "relative"}); err != nil {
		t.Fatalf("input remained blocked after cleanup: %v", err)
	}
}

func TestRejectedWindowsInputDiagnostics(t *testing.T) {
	for _, want := range []syscall.Errno{0, windows.ERROR_ACCESS_DENIED} {
		err := rejectedWindowsInput(0, 1, want)
		var code syscall.Errno
		if !errors.As(err, &code) || code != want {
			t.Fatalf("Windows rejection lost its system code: %v", err)
		}
		for _, fact := range []string{"Windows accepted 0 of 1", "input desktop accessible=", "input desktop matches thread=", "foreground present=", "foreground higher integrity="} {
			if !strings.Contains(err.Error(), fact) {
				t.Fatalf("Windows rejection lost %q: %v", fact, err)
			}
		}
	}
	if level, ok := tokenIntegrity(windows.GetCurrentProcessToken()); !ok || level == 0 {
		t.Fatalf("current process integrity was not observed: %d %v", level, ok)
	}
}

func TestNativeStopShortcutRegistrationLifetime(t *testing.T) {
	// Reserve an available chord through the OS API without injecting input.
	var reserved func()
	var key int
	for key = 1; key <= 11; key++ {
		var err error
		reserved, err = watchStopShortcut(t.Context(), key, func() {})
		if err == nil {
			break
		}
	}
	if reserved == nil {
		t.Fatal("no test shortcut is available")
	}
	t.Cleanup(reserved)
	m, err := New(t.Context(), false)
	if err != nil || m == nil {
		t.Fatalf("hotkey collision disabled the input backend: %v", err)
	}
	t.Cleanup(m.Close)
	m.stopKey = key
	state, err := m.ReadStopShortcut()
	if err != nil || state.Available {
		t.Fatalf("reserved chord was reported usable: %+v, %v", state, err)
	}
	reserved()
	state, err = m.ReadStopShortcut()
	if err != nil || !state.Available {
		t.Fatalf("released chord was not available: %+v, %v", state, err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	stop, err := watchStopShortcut(ctx, key, func() {})
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	stop()
	stop, err = watchStopShortcut(t.Context(), key, func() {})
	if err != nil {
		t.Fatalf("cancelled watcher retained its chord: %v", err)
	}
	stop()
}

func TestCommittedTextPackets(t *testing.T) {
	inputs := textInputs("A中😀")
	units := []uint16{0x41, 0x4e2d, 0xd83d, 0xde00}
	if len(inputs) != 2*len(units) {
		t.Fatalf("text packets: %d", len(inputs))
	}
	for i, input := range inputs {
		key := (*keyboardInput)(unsafe.Pointer(&input.Mouse))
		if input.Kind != 1 || key.VK != 0 || key.Scan != units[i/2] || key.Flags != uint32(4+2*(i%2)) {
			t.Fatalf("packet %d: %+v", i, key)
		}
	}
}

func TestMouseButtonPackets(t *testing.T) {
	for button, flags := range []uint32{2, 0x20, 8, 0x80, 0x80} {
		for _, down := range []bool{true, false} {
			input, err := buttonInput(button, down)
			wantFlags, wantData := flags, uint32(0)
			if !down {
				wantFlags <<= 1
			}
			if button >= 3 {
				wantData = 1 << (button - 3)
			}
			if err != nil || input.Kind != 0 || input.Mouse.Flags != wantFlags || input.Mouse.Data != wantData {
				t.Fatalf("button %d down=%v: %+v, %v", button, down, input, err)
			}
		}
	}
	if _, err := buttonInput(5, true); err == nil {
		t.Fatal("unknown button accepted")
	}
}
