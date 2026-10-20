//go:build windows

package remoteinput

import (
	"context"
	"testing"
	"unsafe"
)

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
	m, err := New(t.Context(), false, key, nil)
	if err != nil || m == nil {
		t.Fatalf("hotkey collision disabled the input backend: %v", err)
	}
	t.Cleanup(m.Close)
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
