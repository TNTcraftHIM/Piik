package remoteinput

import (
	"encoding/binary"
	"testing"
)

func TestGamepadHIDReport(t *testing.T) {
	neutral := gamepadHIDReport(gamepadReport{})
	want := [gamepadHIDReportSize]byte{2: 8}
	if neutral != want {
		t.Fatalf("neutral HID report = %x, want %x", neutral, want)
	}
	report := gamepadReport{
		Buttons: 0x1ffff, LeftTrigger: 31, RightTrigger: 255,
		LeftX: -32768, LeftY: 32767, RightX: -1234, RightY: 5678,
	}
	data := gamepadHIDReport(report)
	if binary.LittleEndian.Uint16(data[:2]) != 0x1fff || data[2] != 8 {
		t.Fatalf("button and opposing D-pad encoding = %x", data[:3])
	}
	for i, want := range []int16{-32768, 32767, -1234, 5678} {
		if got := int16(binary.LittleEndian.Uint16(data[3+i*2:])); got != want {
			t.Fatalf("HID axis %d = %d, want %d", i, got, want)
		}
	}
	if data[11] != 31 || data[12] != 255 {
		t.Fatalf("trigger encoding = %x", data[11:])
	}
	for button := range 17 {
		data := gamepadHIDReport(gamepadReport{Buttons: 1 << button})
		buttons := binary.LittleEndian.Uint16(data[:2])
		if button < 12 && buttons != 1<<button || button == 16 && buttons != 1<<12 ||
			button >= 12 && button < 16 && buttons != 0 {
			t.Fatalf("W3C button %d encoded as HID buttons 0x%x", button, buttons)
		}
	}
}

func TestGamepadHIDDPad(t *testing.T) {
	// Bit order is W3C up, down, left, right. Every combination is defined,
	// including opposing directions received from independent physical buttons.
	want := [...]byte{8, 0, 4, 8, 6, 7, 5, 6, 2, 1, 3, 2, 8, 0, 4, 8}
	for directions, hat := range want {
		data := gamepadHIDReport(gamepadReport{Buttons: uint32(directions) << 12})
		if data[2] != hat {
			t.Fatalf("D-pad %04b = %d, want hat %d", directions, data[2], hat)
		}
	}
}

func TestGamepadHIDDescriptorReportSize(t *testing.T) {
	// Read HID short items as an independent consumer. The input payload must
	// fit exactly, with no report-ID prefix or advertised output/feature report.
	var size, count, bits int
	for i := 0; i < len(gamepadHIDDescriptor); {
		prefix := gamepadHIDDescriptor[i]
		i++
		n := int(prefix & 3)
		if n == 3 {
			n = 4
		}
		if prefix == 0xfe || i+n > len(gamepadHIDDescriptor) {
			t.Fatal("invalid or unsupported HID descriptor item")
		}
		value := 0
		for j := range n {
			value |= int(gamepadHIDDescriptor[i+j]) << (8 * j)
		}
		i += n
		switch prefix & 0xfc {
		case 0x74:
			size = value
		case 0x94:
			count = value
		case 0x80:
			bits += size * count
		case 0x84, 0x90, 0xb0:
			t.Fatal("unexpected report ID, output or feature report")
		}
	}
	if bits != gamepadHIDReportSize*8 {
		t.Fatalf("descriptor requires %d input bits; encoder supplies %d", bits, gamepadHIDReportSize*8)
	}
}
