//go:build windows && remotecontrol

package remoteinput

import "testing"

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
