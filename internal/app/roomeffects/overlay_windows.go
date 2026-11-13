package roomeffects

import (
	"context"
	"fmt"
	"math/rand/v2"
	"runtime"
	"strings"
	"time"
	"unsafe"

	"github.com/TNTcraftHIM/Piik/internal/server/signal"
	"golang.org/x/sys/windows"
)

var user32 = windows.NewLazySystemDLL("user32.dll")
var gdi32 = windows.NewLazySystemDLL("gdi32.dll")

type point struct{ x, y int32 }
type rect struct{ left, top, right, bottom int32 }
type message struct {
	window         uintptr
	id             uint32
	wparam, lparam uintptr
	time           uint32
	cursor         point
	private        uint32
}
type bitmapInfo struct {
	size                       uint32
	width, height              int32
	planes, bits               uint16
	compression, imageSize     uint32
	xResolution, yResolution   int32
	colors, important, palette uint32
}

type flight struct {
	event   signal.RoomEffect
	text    []uint16
	started time.Time
	lane    int
	width   int32
}

type overlay struct {
	ink                                          rect
	visible                                      bool
	window, dc, bitmap, font, oldBitmap, oldFont uintptr
	pixels                                       []uint32
	width, height, top, lineHeight, dpi          int32
	flights                                      []flight
}

func runOverlay(ctx context.Context, options Options, queue <-chan signal.RoomEffect) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	// The monitor dimensions and pixel buffer must use the same DPI space.
	previous, _, _ := user32.NewProc("SetThreadDpiAwarenessContext").Call(^uintptr(3))
	if previous != 0 {
		defer user32.NewProc("SetThreadDpiAwarenessContext").Call(previous)
	}
	top, bottom, err := parseArea(options.Area)
	if err != nil {
		return err
	}
	view := &overlay{}
	defer view.close()
	ticker := time.NewTicker(time.Second / 60)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case event := <-queue:
			if expired(event) || options.Opacity == 0 {
				continue
			}
			if err := view.prepare(top, bottom, options.Size); err != nil {
				return err
			}
			view.add(event, time.Now(), options.Speed)
		case <-ticker.C:
			if view.window == 0 {
				continue
			}
			pumpWindow()
			if err := view.prepare(top, bottom, options.Size); err != nil {
				return err
			}
			if err := view.frame(time.Now(), options.Speed, options.Opacity); err != nil {
				return err
			}
		}
	}
}

func (o *overlay) prepare(top, bottom int, scale float64) error {
	metrics := user32.NewProc("GetSystemMetrics")
	w, _, _ := metrics.Call(0)
	h, _, _ := metrics.Call(1)
	dpi, _, _ := user32.NewProc("GetDpiForSystem").Call()
	y := int32(h * uintptr(top) / 100)
	height := int32(h*uintptr(bottom)/100) - y
	if o.window != 0 && o.width == int32(w) && o.height == height && o.top == y && o.dpi == int32(dpi) {
		return nil
	}
	o.close()
	if w == 0 || height <= 0 || dpi == 0 {
		return fmt.Errorf("primary display dimensions are unavailable")
	}
	o.width, o.height, o.top, o.dpi = int32(w), height, y, int32(dpi)
	fontSize := int32(24 * scale * float64(dpi) / 96)
	o.lineHeight = fontSize + fontSize/3 + 3
	if o.lineHeight > height {
		return fmt.Errorf("danmaku area is shorter than one line at the selected size")
	}
	class := windows.StringToUTF16Ptr("STATIC")
	// A layered, topmost tool window passes mouse input through and never activates.
	const extendedStyle = 0x00080000 | 0x00000008 | 0x00000080 | 0x08000000 | 0x00000020
	window, _, err := user32.NewProc("CreateWindowExW").Call(extendedStyle, uintptr(unsafe.Pointer(class)), 0,
		0x80000000, 0, uintptr(y), w, uintptr(height), 0, 0, 0, 0)
	if window == 0 {
		return fmt.Errorf("create danmaku window: %w", err)
	}
	o.window = window
	const excludeFromCapture = 0x11
	if ok, _, err := user32.NewProc("SetWindowDisplayAffinity").Call(window, excludeFromCapture); ok == 0 {
		return fmt.Errorf("exclude danmaku window from capture: %w", err)
	}
	o.dc, _, err = gdi32.NewProc("CreateCompatibleDC").Call(0)
	if o.dc == 0 {
		return fmt.Errorf("create danmaku drawing context: %w", err)
	}
	info := bitmapInfo{size: 40, width: o.width, height: -height, planes: 1, bits: 32}
	var bits unsafe.Pointer
	o.bitmap, _, err = gdi32.NewProc("CreateDIBSection").Call(o.dc, uintptr(unsafe.Pointer(&info)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if o.bitmap == 0 || bits == nil {
		return fmt.Errorf("create danmaku bitmap: %w", err)
	}
	o.pixels = unsafe.Slice((*uint32)(bits), int(o.width)*int(height))
	o.oldBitmap, _, _ = gdi32.NewProc("SelectObject").Call(o.dc, o.bitmap)
	face := windows.StringToUTF16Ptr("Microsoft YaHei UI")
	o.font, _, err = gdi32.NewProc("CreateFontW").Call(uintptr(-fontSize), 0, 0, 0, 600, 0, 0, 0, 1, 0, 0, 4, 0, uintptr(unsafe.Pointer(face)))
	if o.font == 0 {
		return fmt.Errorf("create danmaku font: %w", err)
	}
	o.oldFont, _, _ = gdi32.NewProc("SelectObject").Call(o.dc, o.font)
	gdi32.NewProc("SetBkMode").Call(o.dc, 1)
	return nil
}

func (o *overlay) add(event signal.RoomEffect, now time.Time, speed float64) {
	text, err := windows.UTF16FromString(strings.Join(strings.Fields(event.Text), " "))
	if err != nil || len(text) <= 1 {
		return
	}
	text = text[:len(text)-1]
	var size point
	ok, _, _ := gdi32.NewProc("GetTextExtentPoint32W").Call(o.dc, uintptr(unsafe.Pointer(&text[0])), uintptr(len(text)), uintptr(unsafe.Pointer(&size)))
	if ok == 0 {
		return
	}
	var lanes []int
	for lane := 0; lane < int(o.height/o.lineHeight); lane++ {
		free := true
		for _, moving := range o.flights {
			if moving.lane == lane && !expired(moving.event) && o.x(moving, now, speed)+moving.width+16 > o.width {
				free = false
				break
			}
		}
		if free {
			lanes = append(lanes, lane)
		}
	}
	if len(lanes) != 0 && len(o.flights) < 24 {
		o.flights = append(o.flights, flight{event: event, text: text, started: now, lane: lanes[rand.IntN(len(lanes))], width: size.x})
	}
}

func (o *overlay) x(f flight, now time.Time, speed float64) int32 {
	pixelsPerSecond := min(float64(o.width)*.10, 280*float64(o.dpi)/96)
	return o.width - int32(now.Sub(f.started).Seconds()*pixelsPerSecond*speed)
}

func (o *overlay) frame(now time.Time, speed, opacity float64) error {
	show := user32.NewProc("ShowWindow")
	o.flights = keepFlights(o.flights, func(f flight) bool { return !expired(f.event) && o.x(f, now, speed)+f.width+2 > 0 })
	o.eachInkRow(o.ink, func(row []uint32) { clear(row) })
	o.ink = rect{left: o.width, top: o.height}
	for _, flight := range o.flights {
		x, y := o.x(flight, now, speed), int32(flight.lane)*o.lineHeight
		if x >= o.width || x+flight.width+6 <= 0 {
			continue
		}
		o.ink.left = min(o.ink.left, max(0, x-3))
		o.ink.top = min(o.ink.top, y)
		o.ink.right = max(o.ink.right, min(o.width, x+flight.width+6))
		o.ink.bottom = max(o.ink.bottom, y+o.lineHeight)
	}
	if o.ink.right <= o.ink.left {
		if o.visible {
			show.Call(o.window, 0)
			o.visible = false
		}
		return nil
	}
	color := gdi32.NewProc("SetTextColor")
	draw := gdi32.NewProc("TextOutW")
	for _, flight := range o.flights {
		x, y := o.x(flight, now, speed), int32(flight.lane)*o.lineHeight
		// Red marks the shadow mask. White contributes both alpha and luminance.
		color.Call(o.dc, 0xff)
		draw.Call(o.dc, uintptr(x+2), uintptr(y+2), uintptr(unsafe.Pointer(&flight.text[0])), uintptr(len(flight.text)))
		color.Call(o.dc, 0xffffff)
		draw.Call(o.dc, uintptr(x), uintptr(y), uintptr(unsafe.Pointer(&flight.text[0])), uintptr(len(flight.text)))
	}
	gdi32.NewProc("GdiFlush").Call()
	o.eachInkRow(o.ink, func(row []uint32) {
		for i, pixel := range row {
			luma := pixel & 0xff
			alpha := max(luma, (pixel>>16)&0xff)
			row[i] = alpha<<24 | luma*0x010101
		}
	})
	dst := point{x: o.ink.left, y: o.top + o.ink.top}
	src := point{x: o.ink.left, y: o.ink.top}
	size := point{x: o.ink.right - o.ink.left, y: o.ink.bottom - o.ink.top}
	blend := uint32(1<<24) | uint32(opacity*255+.5)<<16
	ok, _, err := user32.NewProc("UpdateLayeredWindow").Call(o.window, 0, uintptr(unsafe.Pointer(&dst)),
		uintptr(unsafe.Pointer(&size)), o.dc, uintptr(unsafe.Pointer(&src)), 0, uintptr(unsafe.Pointer(&blend)), 2)
	if ok == 0 {
		return fmt.Errorf("draw danmaku window: %w", err)
	}
	if !o.visible {
		show.Call(o.window, 4)
		o.visible = true
	}
	return nil
}

func (o *overlay) eachInkRow(area rect, visit func([]uint32)) {
	for y := area.top; y < area.bottom; y++ {
		row := y * o.width
		visit(o.pixels[row+area.left : row+area.right])
	}
}

func keepFlights(flights []flight, keep func(flight) bool) []flight {
	active := flights[:0]
	for _, flight := range flights {
		if keep(flight) {
			active = append(active, flight)
		}
	}
	clear(flights[len(active):])
	return active
}

func (o *overlay) close() {
	selectObject := gdi32.NewProc("SelectObject")
	if o.oldFont != 0 {
		selectObject.Call(o.dc, o.oldFont)
	}
	if o.oldBitmap != 0 {
		selectObject.Call(o.dc, o.oldBitmap)
	}
	deleteObject := gdi32.NewProc("DeleteObject")
	if o.font != 0 {
		deleteObject.Call(o.font)
	}
	if o.bitmap != 0 {
		deleteObject.Call(o.bitmap)
	}
	if o.dc != 0 {
		gdi32.NewProc("DeleteDC").Call(o.dc)
	}
	if o.window != 0 {
		user32.NewProc("DestroyWindow").Call(o.window)
	}
	*o = overlay{}
}

func pumpWindow() {
	var msg message
	peek, dispatch := user32.NewProc("PeekMessageW"), user32.NewProc("DispatchMessageW")
	for {
		found, _, _ := peek.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0, 1)
		if found == 0 {
			return
		}
		dispatch.Call(uintptr(unsafe.Pointer(&msg)))
	}
}
