//go:build windows && amd64

package remoteinput

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// ViGEmClient is not thread-safe. This lock also keeps device calls inside the
// owning client's lifetime, including DLL unload.
type vigemGamepadBackend struct {
	mu           sync.Mutex
	dll          *windows.DLL
	client       uintptr
	devices      map[*vigemGamepad]struct{}
	alloc        *windows.Proc
	free         *windows.Proc
	connect      *windows.Proc
	disconnect   *windows.Proc
	targetAlloc  *windows.Proc
	targetFree   *windows.Proc
	addTarget    *windows.Proc
	removeTarget *windows.Proc
	updateTarget *windows.Proc
}

type vigemGamepad struct {
	backend *vigemGamepadBackend
	target  uintptr
	closed  bool
}

func openGamepadBackend() (gamepadBackend, error) {
	executable, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("%w: locate App executable: %w", errGamepadUnavailable, err)
	}
	path := filepath.Join(filepath.Dir(executable), "ViGEmClient.dll")
	// Only the fixed App directory and System32 supply this DLL's dependencies.
	handle, err := windows.LoadLibraryEx(path, 0, windows.LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|windows.LOAD_LIBRARY_SEARCH_SYSTEM32)
	if err != nil {
		return nil, fmt.Errorf("%w: load ViGEmClient.dll: %w", errGamepadUnavailable, err)
	}
	b := &vigemGamepadBackend{dll: &windows.DLL{Name: path, Handle: handle}, devices: make(map[*vigemGamepad]struct{})}
	for _, export := range []struct {
		name string
		proc **windows.Proc
	}{
		{"vigem_alloc", &b.alloc}, {"vigem_free", &b.free},
		{"vigem_connect", &b.connect}, {"vigem_disconnect", &b.disconnect},
		{"vigem_target_x360_alloc", &b.targetAlloc}, {"vigem_target_free", &b.targetFree},
		{"vigem_target_add", &b.addTarget}, {"vigem_target_remove", &b.removeTarget},
		{"vigem_target_x360_update", &b.updateTarget},
	} {
		*export.proc, err = b.dll.FindProc(export.name)
		if err != nil {
			return nil, errors.Join(fmt.Errorf("%w: ViGEmClient export %s: %w", errGamepadUnavailable, export.name, err), b.Close())
		}
	}
	b.client, _, _ = b.alloc.Call()
	if b.client == 0 {
		return nil, errors.Join(fmt.Errorf("%w: ViGEmClient allocation failed", errGamepadUnavailable), b.Close())
	}
	result, _, _ := b.connect.Call(b.client)
	if err := vigemResult("connect to ViGEmBus", result); err != nil {
		return nil, errors.Join(fmt.Errorf("%w: %w", errGamepadUnavailable, err), b.Close())
	}
	return b, nil
}

func vigemResult(action string, result uintptr) error {
	if uint32(result) == 0x20000000 { // VIGEM_ERROR_NONE
		return nil
	}
	detail := ""
	switch uint32(result) {
	case 0xe0000001:
		detail = ": ViGEmBus driver not available"
	case 0xe0000002:
		detail = ": no free controller slot"
	case 0xe0000008:
		detail = ": incompatible ViGEmBus driver"
	case 0xe0000009:
		detail = ": ViGEmBus access failed"
	}
	return fmt.Errorf("%s failed (ViGEm 0x%08x)%s", action, uint32(result), detail)
}

func (b *vigemGamepadBackend) Open() (gamepadDevice, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.dll == nil {
		return nil, errors.New("virtual gamepad backend is closed")
	}
	target, _, _ := b.targetAlloc.Call()
	if target == 0 {
		return nil, errors.New("virtual Xbox 360 allocation failed")
	}
	result, _, _ := b.addTarget.Call(b.client, target)
	if err := vigemResult("add virtual Xbox 360", result); err != nil {
		b.targetFree.Call(target)
		return nil, err
	}
	d := &vigemGamepad{backend: b, target: target}
	b.devices[d] = struct{}{}
	if err := b.updateLocked(target, gamepadReport{}); err != nil {
		d.closed = true
		return nil, errors.Join(err, b.removeLocked(d))
	}
	return d, nil
}

func (b *vigemGamepadBackend) updateLocked(target uintptr, report gamepadReport) error {
	// Windows x64 passes the 12-byte XUSB_REPORT value by a 16-byte-aligned
	// reference. SDK: nefarius/ViGEmClient b66d02d57e32cc8595369c53418b843e958649b4.
	var storage [32]byte
	offset := (-uintptr(unsafe.Pointer(&storage[0]))) & 15
	data := (*gamepadReport)(unsafe.Pointer(&storage[offset]))
	*data = report
	result, _, _ := b.updateTarget.Call(b.client, target, uintptr(unsafe.Pointer(data)))
	runtime.KeepAlive(&storage)
	return vigemResult("write virtual Xbox 360 report", result)
}

func (d *vigemGamepad) Update(report gamepadReport) error {
	b := d.backend
	b.mu.Lock()
	defer b.mu.Unlock()
	if d.closed || b.dll == nil {
		return errors.New("virtual gamepad device is closed")
	}
	return b.updateLocked(d.target, report)
}

func (b *vigemGamepadBackend) removeLocked(d *vigemGamepad) error {
	result, _, _ := b.removeTarget.Call(b.client, d.target)
	if err := vigemResult("remove virtual Xbox 360", result); err != nil {
		return err // Retain the handle until this client's disconnect removes it.
	}
	b.targetFree.Call(d.target)
	d.target = 0
	delete(b.devices, d)
	return nil
}

func (d *vigemGamepad) closeLocked() error {
	if d.target == 0 {
		return nil
	}
	d.closed = true
	return errors.Join(d.backend.updateLocked(d.target, gamepadReport{}), d.backend.removeLocked(d))
}

func (d *vigemGamepad) Close() error {
	b := d.backend
	b.mu.Lock()
	defer b.mu.Unlock()
	return d.closeLocked()
}

func (b *vigemGamepadBackend) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.dll == nil {
		return nil
	}
	var result error
	if b.client != 0 {
		for d := range b.devices {
			result = errors.Join(result, d.closeLocked())
		}
		// Disconnect removes only this SDK client's remaining driver targets.
		b.disconnect.Call(b.client)
		for d := range b.devices {
			b.targetFree.Call(d.target)
			d.target = 0
		}
		clear(b.devices)
		b.free.Call(b.client)
		b.client = 0
	}
	result = errors.Join(result, b.dll.Release())
	b.dll = nil
	return result
}
