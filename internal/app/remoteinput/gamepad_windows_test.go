//go:build windows && amd64

package remoteinput

import (
	"os"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestGamepadReportABI(t *testing.T) {
	var report xusbReport
	if unsafe.Sizeof(report) != 12 || unsafe.Offsetof(report.LeftTrigger) != 2 ||
		unsafe.Offsetof(report.RightTrigger) != 3 || unsafe.Offsetof(report.LeftX) != 4 ||
		unsafe.Offsetof(report.LeftY) != 6 || unsafe.Offsetof(report.RightX) != 8 || unsafe.Offsetof(report.RightY) != 10 {
		t.Fatal("gamepad report no longer matches the ViGEm XUSB_REPORT layout")
	}
}

func TestGamepadXUSBMapping(t *testing.T) {
	// SDK Common.h XUSB_BUTTON values. Browser trigger buttons are analog in
	// XUSB_REPORT; Guide is independent of the ordinary face/shoulder buttons.
	wantButtons := []uint16{0x1000, 0x2000, 0x4000, 0x8000, 0x100, 0x200, 0, 0, 0x20, 0x10, 0x40, 0x80, 1, 2, 4, 8, 0x400}
	for index, want := range wantButtons {
		if got := toXUSBReport(gamepadReport{Buttons: 1 << index}).Buttons; got != want {
			t.Errorf("W3C button %d: got 0x%04x, want 0x%04x", index, got, want)
		}
	}
	if got := toXUSBReport(gamepadReport{}); got != (xusbReport{}) {
		t.Fatalf("neutral report must release every control: %+v", got)
	}
	got := toXUSBReport(gamepadReport{Buttons: 1 | 1<<4 | 1<<12 | 1<<16, LeftTrigger: 37, RightTrigger: 255, LeftX: -32768, LeftY: -32768, RightX: 32767, RightY: 32767})
	want := xusbReport{Buttons: 0x1501, LeftTrigger: 37, RightTrigger: 255, LeftX: -32768, LeftY: 32767, RightX: 32767, RightY: -32767}
	if got != want {
		t.Fatalf("buttons/triggers/stick axes changed: got %+v, want %+v", got, want)
	}
}

func TestGamepadWindowsCapacity(t *testing.T) {
	backend := &vigemGamepadBackend{dll: &windows.DLL{}, devices: make(map[*vigemGamepad]struct{})}
	for range 4 {
		backend.devices[&vigemGamepad{}] = struct{}{}
	}
	if _, err := backend.Open(); err == nil {
		t.Fatal("fifth Windows gamepad must be rejected before native allocation")
	}
}

// This opt-in check creates only its own temporary targets. XInput is read-only
// observation here; production allocation and ownership use SDK handles alone.
func TestGamepadNativeLifecycle(t *testing.T) {
	if os.Getenv("PIIK_GAMEPAD_GATE") != "1" {
		t.Skip("set PIIK_GAMEPAD_GATE=1 with ViGEmClient.dll beside this test executable and ViGEmBus installed")
	}
	newBackend := func() gamepadBackend {
		t.Helper()
		backend, err := openGamepadBackend()
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if err := backend.Close(); err != nil {
				t.Error(err)
			}
		})
		return backend
	}
	first, second := newBackend(), newBackend()
	newDevice := func(backend gamepadBackend) gamepadDevice {
		t.Helper()
		device, err := backend.Open()
		if err != nil {
			t.Fatal(err)
		}
		return device
	}
	a, b := newDevice(first), newDevice(second)
	xinput := windows.NewLazySystemDLL("xinput1_4.dll").NewProc("XInputGetState")
	if err := xinput.Find(); err != nil {
		t.Fatal(err)
	}
	read := func(index int) (xusbReport, bool) {
		var state struct {
			packet uint32
			report xusbReport
		}
		result, _, _ := xinput.Call(uintptr(index), uintptr(unsafe.Pointer(&state)))
		return state.report, result == 0
	}
	find := func(want xusbReport) int {
		for index := range 4 {
			if report, ok := read(index); ok && report == want {
				return index
			}
		}
		return -1
	}
	wait := func(check func() bool) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for !check() {
			if time.Now().After(deadline) {
				t.Fatal("temporary gamepad state did not converge in XInput")
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	update := func(device gamepadDevice, report gamepadReport) {
		t.Helper()
		if err := device.Update(report); err != nil {
			t.Fatal(err)
		}
	}
	reportA := gamepadReport{Buttons: 1 << 0, LeftTrigger: 61, RightTrigger: 17, LeftX: -17000, LeftY: 7100, RightX: -3900, RightY: 12400}
	reportB := gamepadReport{Buttons: 1 << 1, LeftTrigger: 23, RightTrigger: 183, LeftX: 8300, LeftY: 20000, RightX: -9100, RightY: -13100}
	update(a, reportA)
	update(b, reportB)
	// PnP enumeration finishes asynchronously. Repeat current full-state reports
	// as the input stream does, instead of treating the first write as readiness.
	wait(func() bool {
		update(a, reportA)
		update(b, reportB)
		return find(toXUSBReport(reportA)) >= 0 && find(toXUSBReport(reportB)) >= 0
	})
	indexA, indexB := find(toXUSBReport(reportA)), find(toXUSBReport(reportB))
	update(a, gamepadReport{})
	wait(func() bool {
		a, okA := read(indexA)
		b, okB := read(indexB)
		return okA && a == (xusbReport{}) && okB && b == toXUSBReport(reportB)
	})
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	wait(func() bool {
		_, okA := read(indexA)
		b, okB := read(indexB)
		return !okA && okB && b == toXUSBReport(reportB)
	})
	if err := a.Update(reportA); err == nil {
		t.Fatal("closed device accepted an update")
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	a = newDevice(first)
	wait(func() bool {
		update(a, reportA)
		return find(toXUSBReport(reportA)) >= 0
	})
	indexA = find(toXUSBReport(reportA))
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	wait(func() bool {
		_, okA := read(indexA)
		b, okB := read(indexB)
		return !okA && okB && b == toXUSBReport(reportB)
	})
	if _, err := first.Open(); err == nil {
		t.Fatal("closed backend created a device")
	}
	if err := a.Update(reportA); err == nil {
		t.Fatal("backend retirement left its device writable")
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	update(b, gamepadReport{})
	wait(func() bool {
		report, ok := read(indexB)
		return ok && report == (xusbReport{})
	})
	if err := b.Close(); err != nil {
		t.Fatal(err)
	}
	wait(func() bool { _, ok := read(indexB); return !ok })
	t.Log("independent reports, device close and backend retirement passed against the installed driver")
}
