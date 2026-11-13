package roomeffects

import (
	"runtime"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/server/signal"
)

func TestDanmakuDrawsAcrossPrimaryDisplay(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	previous, _, _ := user32.NewProc("SetThreadDpiAwarenessContext").Call(^uintptr(3))
	if previous != 0 {
		defer user32.NewProc("SetThreadDpiAwarenessContext").Call(previous)
	}
	view := &overlay{}
	defer view.close()
	if err := view.prepare(5, 30, 1.3); err != nil {
		t.Skipf("interactive Windows desktop unavailable: %v", err)
	}
	start := time.Now()
	retired := make(chan struct{})
	view.add(signal.RoomEffect{Text: "Piik 你好", Done: retired}, start, 1)
	if len(view.flights) != 1 {
		t.Fatal("chat did not enter a lane")
	}
	crossing := time.Duration(float64(time.Second) * float64(view.width) / min(float64(view.width)*.10, 280*float64(view.dpi)/96))
	if crossing < 10*time.Second {
		t.Fatalf("default crossing is too fast: %v", crossing)
	}
	for _, phase := range []struct {
		elapsed     time.Duration
		left, right float64
	}{
		{crossing / 8, .85, .99},
		{crossing / 2, .45, .66},
		{crossing * 19 / 20, .02, .20},
	} {
		if err := view.frame(start.Add(phase.elapsed), 1, .8); err != nil {
			t.Fatal(err)
		}
		left, right := view.width, int32(-1)
		for index, pixel := range view.pixels {
			if pixel>>24 != 0 {
				x := int32(index % int(view.width))
				left, right = min(left, x), max(right, x)
			}
		}
		if left > right || float64(left)/float64(view.width) < phase.left || float64(right)/float64(view.width) > phase.right {
			t.Fatalf("at %v got horizontal ink %d–%d of %d", phase.elapsed, left, right, view.width)
		}
	}
	if err := view.frame(start.Add(crossing*2), 1, .8); err != nil {
		t.Fatal(err)
	}
	if len(view.flights) != 0 {
		t.Fatal("chat did not leave the left edge")
	}
	view.add(signal.RoomEffect{Text: "retire on stop", Done: retired}, start, 1)
	close(retired)
	if err := view.frame(start.Add(time.Second), 1, .8); err != nil || len(view.flights) != 0 {
		t.Fatalf("stopping the share did not clear the overlay: %v", err)
	}
}
