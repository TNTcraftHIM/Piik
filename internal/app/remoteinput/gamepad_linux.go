//go:build linux

package remoteinput

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"unsafe"

	"golang.org/x/sys/unix"
)

// Linux uinput's userspace ABI (include/uapi/linux/{uinput,input}.h).
// No kernel driver or force-feedback support is supplied by Piik.
const (
	uiDevCreate  = 0x5501
	uiDevDestroy = 0x5502
	uiDevSetup   = 0x405c5503
	uiAbsSetup   = 0x401c5504
	uiSetEvbit   = 0x40045564
	uiSetKeybit  = 0x40045565

	padEVKey = 1
	padEVAbs = 3

	padABSX     = 0
	padABSY     = 1
	padABSZ     = 2
	padABSRX    = 3
	padABSRY    = 4
	padABSRZ    = 5
	padABSHat0X = 16
	padABSHat0Y = 17
)

// W3C standard button indices, excluding the D-pad represented by HAT0.
var uinputButtons = [...]struct {
	index uint
	code  uint16
}{
	{0, 0x130}, {1, 0x131}, {2, 0x134}, {3, 0x133}, // south, east, west, north
	{4, 0x136}, {5, 0x137}, {6, 0x138}, {7, 0x139}, // shoulders, triggers
	{8, 0x13a}, {9, 0x13b}, {10, 0x13d}, {11, 0x13e}, // select, start, stick clicks
	{16, 0x13c}, // guide
}

type uinputGamepadBackend struct {
	mu      sync.Mutex
	closed  bool
	devices map[*uinputGamepad]struct{}
}

type uinputGamepad struct {
	backend *uinputGamepadBackend
	fd      int
}

func openGamepadBackend() (gamepadBackend, error) {
	b := &uinputGamepadBackend{devices: make(map[*uinputGamepad]struct{})}
	// Opening a node alone does not prove device creation is permitted. Probe
	// the same setup used by grants, and leave no device behind at discovery.
	d, err := b.Open()
	if err == nil {
		err = d.Close()
	}
	if err != nil {
		return nil, errors.Join(fmt.Errorf("%w: Linux uinput: %w", errGamepadUnavailable, err), b.Close())
	}
	return b, nil
}

func openUinputNode() (int, error) {
	fd, err := unix.Open("/dev/uinput", unix.O_WRONLY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if errors.Is(err, unix.ENOENT) {
		fd, err = unix.Open("/dev/input/uinput", unix.O_WRONLY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	}
	if err != nil {
		return -1, fmt.Errorf("open uinput (requires device write permission): %w", err)
	}
	return fd, nil
}

func (b *uinputGamepadBackend) Open() (gamepadDevice, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return nil, os.ErrClosed
	}
	fd, err := openUinputNode()
	if err != nil {
		return nil, err
	}
	if err := setupUinputGamepad(fd); err != nil {
		return nil, errors.Join(err, unix.Close(fd))
	}
	d := &uinputGamepad{backend: b, fd: fd}
	b.devices[d] = struct{}{}
	if err := d.updateLocked(gamepadReport{}); err != nil {
		return nil, errors.Join(err, d.closeLocked())
	}
	return d, nil
}

func setupUinputGamepad(fd int) error {
	for _, kind := range []int{padEVKey, padEVAbs} {
		if err := unix.IoctlSetInt(fd, uiSetEvbit, kind); err != nil {
			return fmt.Errorf("configure uinput events: %w", err)
		}
	}
	for _, button := range uinputButtons {
		if err := unix.IoctlSetInt(fd, uiSetKeybit, int(button.code)); err != nil {
			return fmt.Errorf("configure uinput buttons: %w", err)
		}
	}
	for _, axis := range []struct {
		code         uint16
		minimum, max int32
	}{
		{padABSX, -32768, 32767}, {padABSY, -32768, 32767},
		{padABSRX, -32768, 32767}, {padABSRY, -32768, 32767},
		// ABS_Z/RZ are the established xpad/SDL analog-trigger convention.
		{padABSZ, 0, 255}, {padABSRZ, 0, 255},
		{padABSHat0X, -1, 1}, {padABSHat0Y, -1, 1},
	} {
		// uinput_abs_setup: code, 2 padding bytes, input_absinfo (6 s32).
		var setup [28]byte
		binary.NativeEndian.PutUint16(setup[0:], axis.code)
		binary.NativeEndian.PutUint32(setup[8:], uint32(axis.minimum))
		binary.NativeEndian.PutUint32(setup[12:], uint32(axis.max))
		if err := uinputIoctlBytes(fd, uiAbsSetup, setup[:]); err != nil {
			return fmt.Errorf("configure uinput axis %d: %w", axis.code, err)
		}
	}
	// uinput_setup: input_id (4 u16), name[80], ff_effects_max (u32).
	// BUS_VIRTUAL and unassigned vendor/product identify a generic controller;
	// do not impersonate an Xbox or another manufacturer's hardware.
	var setup [92]byte
	binary.NativeEndian.PutUint16(setup[0:], 0x06)
	binary.NativeEndian.PutUint16(setup[6:], 1)
	copy(setup[8:88], "Piik Remote Gamepad")
	if err := uinputIoctlBytes(fd, uiDevSetup, setup[:]); err != nil {
		return fmt.Errorf("set uinput device identity: %w", err)
	}
	if err := unix.IoctlSetInt(fd, uiDevCreate, 0); err != nil {
		return fmt.Errorf("create uinput gamepad: %w", err)
	}
	return nil
}

func uinputIoctlBytes(fd int, request uintptr, data []byte) error {
	_, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), request, uintptr(unsafe.Pointer(&data[0])))
	if errno != 0 {
		return errno
	}
	return nil
}

// input_event uses two native longs for the ignored timestamp, then u16 type,
// u16 code and s32 value. Encode fields explicitly rather than casting reports.
const uinputEventOffset = int(unsafe.Sizeof(uintptr(0))) * 2
const uinputEventSize = uinputEventOffset + 8
const uinputReportEvents = len(uinputButtons) + 8 + 1

func uinputGamepadReport(report gamepadReport) [uinputReportEvents * uinputEventSize]byte {
	var packet [uinputReportEvents * uinputEventSize]byte
	offset := 0
	emit := func(kind, code uint16, value int32) {
		data := packet[offset+uinputEventOffset:]
		binary.NativeEndian.PutUint16(data[0:], kind)
		binary.NativeEndian.PutUint16(data[2:], code)
		binary.NativeEndian.PutUint32(data[4:], uint32(value))
		offset += uinputEventSize
	}
	pressed := func(index uint) int32 {
		return int32((report.Buttons >> index) & 1)
	}
	for _, button := range uinputButtons {
		emit(padEVKey, button.code, pressed(button.index))
	}
	emit(padEVAbs, padABSX, int32(report.LeftX))
	emit(padEVAbs, padABSY, int32(report.LeftY))
	emit(padEVAbs, padABSRX, int32(report.RightX))
	emit(padEVAbs, padABSRY, int32(report.RightY))
	emit(padEVAbs, padABSZ, int32(report.LeftTrigger))
	emit(padEVAbs, padABSRZ, int32(report.RightTrigger))
	emit(padEVAbs, padABSHat0X, pressed(15)-pressed(14))
	emit(padEVAbs, padABSHat0Y, pressed(13)-pressed(12))
	emit(0, 0, 0) // EV_SYN / SYN_REPORT commits one complete state.
	return packet
}

func (d *uinputGamepad) updateLocked(report gamepadReport) error {
	packet := uinputGamepadReport(report)
	for {
		n, err := unix.Write(d.fd, packet[:])
		if err == unix.EINTR {
			continue
		}
		if err != nil {
			return fmt.Errorf("write uinput report: %w", err)
		}
		if n != len(packet) {
			return io.ErrShortWrite
		}
		return nil
	}
}

func (d *uinputGamepad) Update(report gamepadReport) error {
	b := d.backend
	b.mu.Lock()
	defer b.mu.Unlock()
	if d.fd < 0 {
		return os.ErrClosed
	}
	return d.updateLocked(report)
}

func (d *uinputGamepad) closeLocked() error {
	if d.fd < 0 {
		return nil
	}
	// Closing the fd also destroys the device if explicit destruction fails.
	result := errors.Join(d.updateLocked(gamepadReport{}), unix.IoctlSetInt(d.fd, uiDevDestroy, 0), unix.Close(d.fd))
	d.fd = -1
	delete(d.backend.devices, d)
	return result
}

func (d *uinputGamepad) Close() error {
	b := d.backend
	b.mu.Lock()
	defer b.mu.Unlock()
	return d.closeLocked()
}

func (b *uinputGamepadBackend) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	var result error
	for d := range b.devices {
		result = errors.Join(result, d.closeLocked())
	}
	return result
}
