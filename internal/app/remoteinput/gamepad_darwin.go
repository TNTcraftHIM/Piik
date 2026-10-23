//go:build darwin && cgo

package remoteinput

/*
#cgo CFLAGS: -fblocks
#cgo LDFLAGS: -framework IOKit -framework Foundation -framework Security
#include "gamepad_darwin.h"
*/
import "C"

import (
	"errors"
	"fmt"
	"sync"
	"unsafe"
)

type macGamepadBackend struct {
	mu      sync.Mutex
	devices map[*macGamepad]struct{}
	closed  bool
}

type macGamepad struct {
	backend *macGamepadBackend
	device  *C.PiikGamepad
}

func openGamepadBackend() (gamepadBackend, error) {
	b := &macGamepadBackend{devices: make(map[*macGamepad]struct{})}
	// API presence alone does not establish permission or working injection.
	// Probe a real device and a neutral report before advertising availability.
	device, err := b.Open()
	if err != nil {
		return nil, fmt.Errorf("%w: %w", errGamepadUnavailable, err)
	}
	if err := device.Close(); err != nil {
		return nil, fmt.Errorf("%w: %w", errGamepadUnavailable, err)
	}
	return b, nil
}

func macGamepadResult(action string, result C.uint32_t) error {
	if result == 0 {
		return nil
	}
	if uint32(result) == 0xe00002e2 { // kIOReturnNotPermitted
		return fmt.Errorf("%s: macOS denied virtual HID access; the App requires the Apple-authorized com.apple.developer.hid.virtual.device entitlement", action)
	}
	return fmt.Errorf("%s failed (IOKit 0x%08x)", action, uint32(result))
}

func (b *macGamepadBackend) Open() (gamepadDevice, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return nil, errors.New("virtual gamepad backend is closed")
	}
	neutral := gamepadHIDReport(gamepadReport{})
	var result C.uint32_t
	device := C.piik_gamepad_open((*C.uint8_t)(unsafe.Pointer(&gamepadHIDDescriptor[0])), C.size_t(len(gamepadHIDDescriptor)),
		(*C.uint8_t)(unsafe.Pointer(&neutral[0])), C.size_t(len(neutral)), &result)
	if device == nil {
		return nil, macGamepadResult("create virtual HID gamepad", result)
	}
	d := &macGamepad{backend: b, device: device}
	b.devices[d] = struct{}{}
	return d, nil
}

func (d *macGamepad) Update(report gamepadReport) error {
	b := d.backend
	b.mu.Lock()
	defer b.mu.Unlock()
	if d.device == nil {
		return errors.New("virtual gamepad device is closed")
	}
	data := gamepadHIDReport(report)
	return macGamepadResult("write virtual HID gamepad", C.piik_gamepad_update(d.device, (*C.uint8_t)(unsafe.Pointer(&data[0]))))
}

func (d *macGamepad) closeLocked() error {
	if d.device == nil {
		return nil
	}
	neutral := gamepadHIDReport(gamepadReport{})
	result := C.piik_gamepad_close(d.device, (*C.uint8_t)(unsafe.Pointer(&neutral[0])))
	d.device = nil
	delete(d.backend.devices, d)
	return macGamepadResult("retire virtual HID gamepad", result)
}

func (d *macGamepad) Close() error {
	d.backend.mu.Lock()
	defer d.backend.mu.Unlock()
	return d.closeLocked()
}

func (b *macGamepadBackend) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	var result error
	for d := range b.devices {
		result = errors.Join(result, d.closeLocked())
	}
	return result
}
