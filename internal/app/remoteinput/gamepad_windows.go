//go:build windows && amd64

package remoteinput

import (
	"errors"
	"fmt"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Public bus protocol: nefarius/ViGEmClient b66d02d57e32cc8595369c53418b843e958649b4
// include/ViGEm/km/BusShared.h. Calls the installed driver without a client DLL.
// Session ownership/readiness: nefarius/ViGEmBus d986e1d93708ec9b11049542fa6027272cce716c,
// sys/Driver.cpp, busenum.cpp and EmulationTargetPDO.cpp.
const (
	vigemPlugIn       = 0x002aa004
	vigemUnplug       = 0x002aa008
	vigemCheckVersion = 0x002aa00c
	vigemWaitReady    = 0x002aa010
	vigemSubmitXUSB   = 0x002aa808
)

var vigemBusInterface = windows.GUID{Data1: 0x96e42b22, Data2: 0xf5e9, Data3: 0x42f8, Data4: [8]byte{0xb0, 0x43, 0xed, 0x0f, 0x93, 0x2f, 0x01, 0x4f}}

type vigemGamepadBackend struct {
	mu      sync.Mutex
	handle  windows.Handle
	path    string
	opening int
	devices map[*vigemGamepad]struct{}
}

type vigemGamepad struct {
	mu      sync.Mutex
	handle  windows.Handle
	backend *vigemGamepadBackend
	serial  uint32
	closed  bool
}

// The protocol uses Win32 ULONG/enum (32-bit) and USHORT (16-bit).
type vigemRequest struct{ size, value uint32 }
type vigemPlugin struct {
	size, serial, targetType uint32
	vendor, product          uint16
}
type vigemXUSBSubmission struct {
	size, serial uint32
	report       xusbReport
}

// Native XUSB_REPORT layout, separate from the platform-neutral wire report.
type xusbReport struct {
	Buttons      uint16
	LeftTrigger  uint8
	RightTrigger uint8
	LeftX        int16
	LeftY        int16
	RightX       int16
	RightY       int16
}

func toXUSBReport(report gamepadReport) xusbReport {
	var buttons uint16
	// W3C standard buttons -> ViGEm XUSB_BUTTON. Triggers use their analog
	// fields; Guide is supported by the SDK's published 0x0400 constant.
	for index, mask := range [...]uint16{0x1000, 0x2000, 0x4000, 0x8000, 0x0100, 0x0200, 0, 0, 0x0020, 0x0010, 0x0040, 0x0080, 0x0001, 0x0002, 0x0004, 0x0008, 0x0400} {
		if report.Buttons&(1<<index) != 0 {
			buttons |= mask
		}
	}
	invertY := func(value int16) int16 {
		if value == -32768 {
			return 32767
		}
		return -value
	}
	return xusbReport{
		Buttons: buttons, LeftTrigger: report.LeftTrigger, RightTrigger: report.RightTrigger,
		LeftX: report.LeftX, LeftY: invertY(report.LeftY), RightX: report.RightX, RightY: invertY(report.RightY),
	}
}

func openGamepadBackend() (gamepadBackend, error) {
	paths, err := windows.CM_Get_Device_Interface_List("", &vigemBusInterface, windows.CM_GET_DEVICE_INTERFACE_LIST_PRESENT)
	if err != nil {
		return nil, fmt.Errorf("%w: enumerate ViGEmBus: %w", errGamepadUnavailable, err)
	}
	var failure error
	for _, path := range paths {
		name, err := windows.UTF16PtrFromString(path)
		if err != nil {
			return nil, err
		}
		// A fresh file object owns a separate driver session. Closing it also
		// removes that session's targets after a crash or failed explicit unplug.
		handle, err := windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_WRITE,
			windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
		if err != nil {
			failure = errors.Join(failure, err)
			continue
		}
		request := vigemRequest{size: 8, value: 1} // VIGEM_COMMON_VERSION.
		if err = vigemControl(handle, vigemCheckVersion, unsafe.Pointer(&request), uint32(unsafe.Sizeof(request))); err != nil {
			failure = errors.Join(failure, fmt.Errorf("ViGEmBus protocol version 1: %w", err), windows.CloseHandle(handle))
			continue
		}
		return &vigemGamepadBackend{handle: handle, path: path, devices: make(map[*vigemGamepad]struct{})}, nil
	}
	return nil, errors.Join(errGamepadUnavailable, errors.New("install the official ViGEmBus driver"), failure)
}

func vigemControl(handle windows.Handle, code uint32, input unsafe.Pointer, size uint32) error {
	var transferred uint32
	return windows.DeviceIoControl(handle, code, (*byte)(input), size, nil, 0, &transferred, nil)
}

func (b *vigemGamepadBackend) Open() (gamepadDevice, error) {
	b.mu.Lock()
	if b.handle == windows.InvalidHandle {
		b.mu.Unlock()
		return nil, errors.New("virtual gamepad backend is closed")
	}
	if len(b.devices)+b.opening >= 4 {
		b.mu.Unlock()
		return nil, errors.New("all four Windows remote gamepad slots are occupied")
	}
	b.opening++
	path := b.path
	b.mu.Unlock()
	defer func() { b.mu.Lock(); b.opening--; b.mu.Unlock() }()
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	// Each target owns a file session. Enumerating a new target cannot serialize
	// reports or retirement for another target behind the bus readiness request.
	handle, err := windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, err
	}
	d := &vigemGamepad{backend: b, handle: handle}
	for serial := uint32(1); serial <= 65535; serial++ {
		request := vigemPlugin{size: 16, serial: serial, targetType: 0, vendor: 0x045e, product: 0x028e}
		err = vigemControl(handle, vigemPlugIn, unsafe.Pointer(&request), uint32(unsafe.Sizeof(request)))
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			continue
		}
		if err != nil {
			return nil, errors.Join(fmt.Errorf("create virtual Xbox 360: %w", err), d.closeLocked())
		}
		d.serial = serial
		ready := vigemRequest{size: 8, value: serial}
		if err = vigemControl(handle, vigemWaitReady, unsafe.Pointer(&ready), uint32(unsafe.Sizeof(ready))); err != nil {
			return nil, errors.Join(fmt.Errorf("initialize virtual Xbox 360: %w", err), d.closeLocked())
		}
		if err = d.updateLocked(gamepadReport{}); err != nil {
			return nil, errors.Join(err, d.closeLocked())
		}
		b.mu.Lock()
		closed := b.handle == windows.InvalidHandle
		if !closed {
			b.devices[d] = struct{}{}
		}
		b.mu.Unlock()
		if closed {
			return nil, errors.Join(errors.New("virtual gamepad backend is closed"), d.closeLocked())
		}
		return d, nil
	}
	return nil, errors.Join(errors.New("ViGEmBus has no free controller serial"), d.closeLocked())
}

func (d *vigemGamepad) updateLocked(report gamepadReport) error {
	request := vigemXUSBSubmission{size: 20, serial: d.serial, report: toXUSBReport(report)}
	if err := vigemControl(d.handle, vigemSubmitXUSB, unsafe.Pointer(&request), uint32(unsafe.Sizeof(request))); err != nil {
		return fmt.Errorf("write virtual Xbox 360 report: %w", err)
	}
	return nil
}

func (d *vigemGamepad) Update(report gamepadReport) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed || d.handle == windows.InvalidHandle {
		return errors.New("virtual gamepad device is closed")
	}
	deadline := time.Now().Add(time.Second / 60)
	for {
		err := d.updateLocked(report)
		if !errors.Is(err, windows.ERROR_NO_MORE_ITEMS) {
			return err
		}
		// XusbPdo drops changed reports when no USB input request is queued.
		// Ordinary full states repeat at 60 Hz; never delay them behind a retry.
		if report != (gamepadReport{}) {
			return nil
		}
		// A one-off focus reset has no following report. Give its neutral state
		// one frame to be consumed, then retire this pad if it cannot be reset.
		if !time.Now().Before(deadline) {
			return err
		}
		time.Sleep(time.Millisecond)
	}
}

func (d *vigemGamepad) closeLocked() error {
	if d.closed {
		return nil
	}
	d.closed = true
	var result error
	if d.serial != 0 {
		result = d.updateLocked(gamepadReport{})
		if errors.Is(result, windows.ERROR_NO_MORE_ITEMS) {
			result = nil
		}
		request := vigemRequest{size: 8, value: d.serial}
		if err := vigemControl(d.handle, vigemUnplug, unsafe.Pointer(&request), uint32(unsafe.Sizeof(request))); err != nil {
			result = errors.Join(result, fmt.Errorf("remove virtual Xbox 360: %w", err))
		}
	}
	// File close is also the driver's final cleanup for this target alone.
	result = errors.Join(result, windows.CloseHandle(d.handle))
	d.handle = windows.InvalidHandle
	d.serial = 0
	return result
}

func (d *vigemGamepad) Close() error {
	d.mu.Lock()
	err := d.closeLocked()
	d.mu.Unlock()
	d.backend.mu.Lock()
	delete(d.backend.devices, d)
	d.backend.mu.Unlock()
	return err
}

func (b *vigemGamepadBackend) Close() error {
	b.mu.Lock()
	handle := b.handle
	if handle == windows.InvalidHandle {
		b.mu.Unlock()
		return nil
	}
	b.handle = windows.InvalidHandle
	devices := b.devices
	b.devices = make(map[*vigemGamepad]struct{})
	b.mu.Unlock()
	var result error
	for d := range devices {
		result = errors.Join(result, d.Close())
	}
	return errors.Join(result, windows.CloseHandle(handle))
}
