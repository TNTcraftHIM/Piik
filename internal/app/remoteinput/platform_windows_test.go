//go:build windows

package remoteinput

import (
	"context"
	"errors"
	"os"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"

	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"golang.org/x/sys/windows"
)

func requireDesktopInputAcceptance(t *testing.T) {
	t.Helper()
	if os.Getenv("PIIK_INPUT_GATE") != "1" {
		t.Skip("set PIIK_INPUT_GATE=1 for desktop input and hotkey acceptance")
	}
}

func TestWindowsInputRecoversItsDesktopAndPendingRelease(t *testing.T) {
	requireDesktopInputAcceptance(t)
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
	if _, err := restricted.sendOnDesktop(probe); err == nil {
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
	requireDesktopInputAcceptance(t)
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

func TestNativeStopShortcutModifierGroup(t *testing.T) {
	requireDesktopInputAcceptance(t)
	m, err := New(t.Context(), false)
	if err != nil || m == nil {
		t.Fatalf("create input manager: %v", err)
	}
	defer m.Close()
	var keys []int
	for key := 1; key <= 11 && len(keys) < 2; key++ {
		if key != defaultStopKey {
			if _, err := m.SetStopShortcut(key); err == nil {
				keys = append(keys, key)
			}
		}
	}
	if len(keys) != 2 {
		t.Fatal("need two available non-default function keys on the isolated desktop")
	}
	next, current := keys[0], keys[1]
	s := m.NewSession()
	defer s.Close()
	s.SetTarget(nativecapture.CaptureTarget{Kind: "display", SourceID: "1"}, nil)
	if err := setTestPolicy(s, "room", ""); err != nil {
		t.Fatal(err)
	}

	// Occupy only the final Ctrl+Alt+Shift+Win variant on another OS thread.
	func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		const id = 27
		ok, _, err := user32.NewProc("RegisterHotKey").Call(0, id, 0x400f, uintptr(0x6f+next))
		if ok == 0 {
			t.Fatalf("reserve final variant on F%d: %v", next, err)
		}
		defer user32.NewProc("UnregisterHotKey").Call(0, id)
		if _, err := m.SetStopShortcut(next); err == nil {
			t.Fatal("replacement succeeded despite occupied final variant")
		}
	}()

	// The previous binding must still revoke through the real Windows queue.
	sink := m.sink.(*windowsSink)
	for i, extra := range [][]string{nil, {"ShiftLeft"}, {"MetaLeft"}, {"ShiftLeft", "MetaLeft"}} {
		name := strings.Join(append([]string{"Ctrl+Alt"}, extra...), "+")
		if !t.Run(name, func(t *testing.T) {
			// The first activation must use the binding left by the failed replacement.
			if i > 0 {
				if err := setTestPolicy(s, "room", ""); err != nil {
					t.Fatal(err)
				}
			}
			for _, key := range append(extra, "ControlLeft", "AltLeft", "F"+strconv.Itoa(current)) {
				scan := scanCodes[key]
				if err := sink.inject(keyInput(scan, true)); err != nil {
					t.Fatalf("press %s: %v", key, err)
				}
				defer func() {
					if err := sink.inject(keyInput(scan, false)); err != nil {
						t.Errorf("release %s: %v", key, err)
					}
				}()
			}
			deadline := time.After(5 * time.Second)
			for s.State().Mode != "ask" {
				select {
				case <-s.Changes():
				case <-deadline:
					t.Fatalf("F%d did not revoke control", current)
				}
			}
		}) {
			return
		}
	}
	if _, err := m.SetStopShortcut(next); err != nil {
		t.Fatalf("could not reacquire complete F%d group after rollback: %v", next, err)
	}
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

type scriptedWindowsSink struct{ *windowsSink }

func (scriptedWindowsSink) Target(nativecapture.CaptureTarget, *nativecapture.Stream) (bounds, bool, error) {
	return bounds{width: 100, height: 100}, true, nil
}

func TestWindowsPartialUnicodeRelease(t *testing.T) {
	sink := scriptedWindowsSink{&windowsSink{}}
	batch := textInputs("A😀Z")
	var calls [][]winInput
	// Accept A and the high surrogate press. Its KEYUP only succeeds after retirement.
	counts := []uintptr{3, 0, 0, 0, 1}
	sink.send = func(inputs ...winInput) (uintptr, error) {
		calls = append(calls, inputs)
		if len(calls) > len(counts) {
			t.Fatal("unexpected extra input")
		}
		n := counts[len(calls)-1]
		if n != uintptr(len(inputs)) {
			return n, errors.New("short SendInput")
		}
		return n, nil
	}
	m := &Manager{sink: sink, connections: map[endpointKey]*connection{}}
	s, peers := coPlaySession(t, m, true)
	s.coPlay = false
	c := peers[0]
	sendTestInput(m, c, inputEvent{Type: "request"})
	grant := c.grant
	sendTestInput(m, c, inputEvent{Type: "text", Text: "A😀Z"})
	if grant == "" || c.grant != grant || !c.inputFailed {
		t.Fatal("partial text changed grant or hid input failure")
	}
	if got := m.Diagnostics().PendingKeyReleases; got != 1 {
		t.Fatalf("pending releases after partial text = %d, want 1 (calls = %d)", got, len(calls))
	}
	sendTestInput(m, c, inputEvent{Type: "relative", DX: 1})
	m.release()
	m.retryReleases()
	m.retryReleases()
	up := batch[3:4]
	if !reflect.DeepEqual(calls, [][]winInput{batch, up, up, up, up}) || m.Diagnostics().PendingKeyReleases != 0 {
		t.Fatalf("release recovery did not deliver only the unmatched KEYUP: %v", calls)
	}
}

func TestAbsoluteMousePicturePixel(t *testing.T) {
	// A 1024-pixel source at -1600 lies 320 pixels from the virtual origin.
	for _, sample := range []struct {
		position float64
		extent   int32
		pixel    int32
	}{
		{0, 1024, 0}, {.99 / 1024, 1024, 0}, {1 / 1024., 1024, 1}, {1.01 / 1024, 1024, 1},
		{511.99 / 1024, 1024, 511}, {1, 1024, 1023},
		// Actual picturePoint output for source pixel 2 on a 1920-wide image.
		{0.001041666666666663, 1920, 2},
	} {
		code := absoluteMouseCoordinate(sample.position, -1600, sample.extent, -1920, 4480)
		got := int32(int64(code)*4480/65536) - 320
		if got != sample.pixel {
			t.Fatalf("position %g reached %d, want %d", sample.position, got, sample.pixel)
		}
	}
}
