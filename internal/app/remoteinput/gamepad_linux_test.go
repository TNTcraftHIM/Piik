//go:build linux

package remoteinput

import (
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestUinputGamepadReport(t *testing.T) {
	packet := uinputGamepadReport(gamepadReport{
		Buttons:     (1 << 0) | (1 << 2) | (1 << 6) | (1 << 9) | (1 << 12) | (1 << 15) | (1 << 16),
		LeftTrigger: 128, RightTrigger: 255,
		LeftX: -32768, LeftY: 32767, RightX: -1234, RightY: 2345,
	})
	want := []struct {
		kind, code uint16
		value      int32
	}{
		{1, 0x130, 1}, {1, 0x131, 0}, {1, 0x134, 1}, {1, 0x133, 0},
		{1, 0x136, 0}, {1, 0x137, 0}, {1, 0x138, 1}, {1, 0x139, 0},
		{1, 0x13a, 0}, {1, 0x13b, 1}, {1, 0x13d, 0}, {1, 0x13e, 0}, {1, 0x13c, 1},
		{3, 0, -32768}, {3, 1, 32767}, {3, 3, -1234}, {3, 4, 2345},
		{3, 2, 128}, {3, 5, 255}, {3, 16, 1}, {3, 17, -1}, {0, 0, 0},
	}
	if len(packet) != len(want)*uinputEventSize {
		t.Fatalf("packet length = %d", len(packet))
	}
	for i, event := range want {
		data := packet[i*uinputEventSize:]
		for _, value := range data[:uinputEventOffset] {
			if value != 0 {
				t.Fatalf("event %d has nonzero ignored timestamp", i)
			}
		}
		data = data[uinputEventOffset:]
		kind, code := binary.NativeEndian.Uint16(data), binary.NativeEndian.Uint16(data[2:])
		value := int32(binary.NativeEndian.Uint32(data[4:]))
		if kind != event.kind || code != event.code || value != event.value {
			t.Errorf("event %d = (%d,%d,%d), want %+v", i, kind, code, value, event)
		}
	}
	// Opposite D-pad buttons cancel, and reset returns every control to zero.
	for _, report := range []gamepadReport{{}, {Buttons: 15 << 12}} {
		packet := uinputGamepadReport(report)
		for i := 0; i < uinputReportEvents; i++ {
			data := packet[i*uinputEventSize+uinputEventOffset:]
			if binary.NativeEndian.Uint32(data[4:]) != 0 {
				t.Fatalf("neutral report event %d is not zero", i)
			}
		}
	}
}

// Run explicitly on an isolated Linux desktop/runner with the stock uinput
// module and permission to open uinput and the resulting evdev nodes:
// SILIP_TEST_UINPUT=1 go test ./internal/app/remoteinput -run TestUinputKernel -v
func TestUinputKernel(t *testing.T) {
	if os.Getenv("SILIP_TEST_UINPUT") != "1" {
		t.Skip("set SILIP_TEST_UINPUT=1 on a Linux runner with uinput/evdev permissions")
	}
	backend, err := openGamepadBackend()
	if err != nil {
		t.Fatal(err)
	}
	b := backend.(*uinputGamepadBackend)
	t.Cleanup(func() {
		if err := b.Close(); err != nil {
			t.Error(err)
		}
	})
	// uinput has no XInput four-slot limit. Each grant must have an independent
	// device, and retiring one must preserve a healthy sibling's held inputs.
	var devices []*uinputGamepad
	var readers []int
	for range 5 {
		pad, err := b.Open()
		if err != nil {
			t.Fatal(err)
		}
		d := pad.(*uinputGamepad)
		devices = append(devices, d)
		readers = append(readers, openUinputEvdev(t, d.fd))
	}
	for i, d := range devices {
		if err := d.Update(gamepadReport{Buttons: 1, LeftX: int16(1000 + i), LeftTrigger: 127}); err != nil {
			t.Fatal(err)
		}
		assertUinputState(t, readers[i], 1000+int32(i), 127, true)
	}
	if err := devices[0].Update(gamepadReport{}); err != nil {
		t.Fatal(err)
	}
	assertUinputState(t, readers[0], 0, 0, false)
	if err := devices[0].Close(); err != nil {
		t.Fatal(err)
	}
	if err := devices[0].Close(); err != nil {
		t.Fatalf("repeated device Close: %v", err)
	}
	assertUinputState(t, readers[1], 1001, 127, true)
	if err := devices[1].Update(gamepadReport{RightY: -32768}); err != nil {
		t.Fatalf("healthy sibling stopped after another device closed: %v", err)
	}
	if err := b.Close(); err != nil {
		t.Fatal(err)
	}
	for _, d := range devices {
		if !errors.Is(d.Update(gamepadReport{}), os.ErrClosed) {
			t.Error("retired device accepted an update")
		}
	}
	if _, err := b.Open(); !errors.Is(err, os.ErrClosed) {
		t.Errorf("retired backend Open = %v", err)
	}
	for _, fd := range readers {
		var abs [24]byte
		if err := uinputIoctlBytes(fd, 0x80184540, abs[:]); !errors.Is(err, unix.ENODEV) {
			t.Errorf("destroyed evdev device remains active: %v", err)
		}
	}
}

func openUinputEvdev(t *testing.T, fd int) int {
	t.Helper()
	var name [128]byte
	// UI_GET_SYSNAME(sizeof(name)), followed by the kernel's evdev child.
	if err := uinputIoctlBytes(fd, 0x8080552c, name[:]); err != nil {
		t.Fatal(err)
	}
	end := 0
	for end < len(name) && name[end] != 0 {
		end++
	}
	pattern := filepath.Join("/sys/devices/virtual/input", string(name[:end]), "event*")
	deadline := time.Now().Add(2 * time.Second)
	for {
		paths, err := filepath.Glob(pattern)
		if err != nil {
			t.Fatal(err)
		}
		if len(paths) == 1 {
			eventFD, err := unix.Open(filepath.Join("/dev/input", filepath.Base(paths[0])), unix.O_RDONLY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
			if err == nil {
				t.Cleanup(func() { _ = unix.Close(eventFD) })
				return eventFD
			}
			if !errors.Is(err, unix.ENOENT) {
				t.Fatal(err)
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("uinput device did not expose an evdev node")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func assertUinputState(t *testing.T, fd int, wantX, wantTrigger int32, wantButton bool) {
	t.Helper()
	for _, axis := range []struct {
		code uint16
		want int32
	}{{padABSX, wantX}, {padABSZ, wantTrigger}} {
		var info [24]byte
		if err := uinputIoctlBytes(fd, 0x80184540+uintptr(axis.code), info[:]); err != nil {
			t.Fatal(err)
		}
		if got := int32(binary.NativeEndian.Uint32(info[:])); got != axis.want {
			t.Errorf("axis %d = %d, want %d", axis.code, got, axis.want)
		}
	}
	var keys [96]byte // KEY_CNT / 8
	if err := uinputIoctlBytes(fd, 0x80604518, keys[:]); err != nil {
		t.Fatal(err)
	}
	if pressed := keys[0x130/8]&(1<<(0x130%8)) != 0; pressed != wantButton {
		t.Errorf("south button = %v, want %v", pressed, wantButton)
	}
}
