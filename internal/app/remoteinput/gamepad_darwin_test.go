//go:build darwin && !ios && cgo

package remoteinput

import (
	"os"
	"testing"
)

// Requires a Mac build authorized for com.apple.developer.hid.virtual.device.
// This exercises native ownership; game/framework recognition needs a separate
// consumer on the Mac and cannot be established by a successful input write.
func TestMacGamepadNativeLifecycle(t *testing.T) {
	if os.Getenv("PIIK_GAMEPAD_GATE") != "1" {
		t.Skip("set PIIK_GAMEPAD_GATE=1 in an Apple-authorized Mac build")
	}
	b, err := openGamepadBackend()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := b.Close(); err != nil {
			t.Error(err)
		}
	})
	a, err := b.Open()
	if err != nil {
		t.Fatal(err)
	}
	other, err := b.Open()
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Update(gamepadReport{Buttons: 1 | 1<<16, LeftX: -32768, RightTrigger: 255}); err != nil {
		t.Fatal(err)
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	if err := a.Update(gamepadReport{}); err == nil {
		t.Fatal("closed gamepad accepted an update")
	}
	if err := other.Update(gamepadReport{Buttons: 1 << 3, LeftY: 32767}); err != nil {
		t.Fatalf("closing one gamepad disrupted another: %v", err)
	}
	if err := b.Close(); err != nil {
		t.Fatal(err)
	}
	if err := other.Update(gamepadReport{}); err == nil {
		t.Fatal("closed backend retained a writable device")
	}
	if _, err := b.Open(); err == nil {
		t.Fatal("closed backend created a device")
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
}
