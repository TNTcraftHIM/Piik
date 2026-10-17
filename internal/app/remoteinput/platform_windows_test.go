//go:build windows && remotecontrol

package remoteinput

import (
	"testing"
	"unsafe"
)

func TestCommittedTextPackets(t *testing.T) {
	inputs, err := textInputs("A中😀")
	units := []uint16{0x41, 0x4e2d, 0xd83d, 0xde00}
	if err != nil || len(inputs) != 2*len(units) {
		t.Fatalf("text packets: %d, %v", len(inputs), err)
	}
	for i, input := range inputs {
		key := (*keyboardInput)(unsafe.Pointer(&input.Mouse))
		if input.Kind != 1 || key.VK != 0 || key.Scan != units[i/2] || key.Flags != uint32(4+2*(i%2)) {
			t.Fatalf("packet %d: %+v", i, key)
		}
	}
	for _, text := range []string{"", "a\nb", "a\x00b", string([]byte{0xff})} {
		if _, err := textInputs(text); err == nil {
			t.Fatal("invalid text accepted")
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
