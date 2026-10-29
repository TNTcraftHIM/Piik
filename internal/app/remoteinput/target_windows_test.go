//go:build windows

package remoteinput

import (
	"runtime"
	"strconv"
	"testing"
	"unsafe"

	"github.com/P4-aaaul/Silip/internal/app/nativecapture"
	"golang.org/x/sys/windows"
)

func TestWindowTargetObservations(t *testing.T) {
	// A hidden zero-style fixture never activates or injects desktop input.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	class, _ := windows.UTF16PtrFromString("STATIC")
	window, _, err := user32.NewProc("CreateWindowExW").Call(0, uintptr(unsafe.Pointer(class)), 0, 0x80000000, 0, 0, 320, 200, 0, 0, 0, 0)
	if window == 0 {
		t.Fatalf("create hidden fixture: %v", err)
	}
	defer func() {
		if window != 0 {
			user32.NewProc("DestroyWindow").Call(window)
		}
	}()
	var pid uint32
	user32.NewProc("GetWindowThreadProcessId").Call(window, uintptr(unsafe.Pointer(&pid)))
	var created, exited, kernel, user windows.Filetime
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(process)
	if err := windows.GetProcessTimes(process, &created, &exited, &kernel, &user); err != nil {
		t.Fatal(err)
	}
	target := nativecapture.CaptureTarget{Kind: "window", SourceID: strconv.FormatUint(uint64(window), 10), PID: pid, CreationTime: strconv.FormatUint(uint64(created.HighDateTime)<<32|uint64(created.LowDateTime), 10)}
	sink := &windowsSink{}
	if b, _, err := sink.Target(target, nil); err != nil || b.width <= 0 || b.height <= 0 {
		t.Fatalf("valid geometry: %+v %v", b, err)
	}
	user32.NewProc("SetWindowPos").Call(window, 0, 0, 0, 0, 0, 0x0014) // NOZORDER | NOACTIVATE
	if b, focused, err := sink.Target(target, nil); err != nil || focused || b != (bounds{}) {
		t.Fatalf("empty geometry must suspend: %+v %v %v", b, focused, err)
	}
	user32.NewProc("SetWindowPos").Call(window, 0, 0, 0, 320, 200, 0x0014)
	if b, _, err := sink.Target(target, nil); err != nil || b.width <= 0 {
		t.Fatalf("geometry did not recover: %+v %v", b, err)
	}
	target.CreationTime = "1"
	if _, _, err := sink.Target(target, nil); err == nil {
		t.Fatal("replaced process identity accepted")
	}
	target.PID++
	if _, _, err := sink.Target(target, nil); err == nil {
		t.Fatal("different window owner accepted")
	}
	user32.NewProc("DestroyWindow").Call(window)
	window = 0
	if _, _, err := sink.Target(target, nil); err == nil {
		t.Fatal("destroyed window accepted")
	}
}

type monitorObservationSink struct {
	*recordedInput
	unavailable bool
}

func (s *monitorObservationSink) Target(target nativecapture.CaptureTarget, stream *nativecapture.Stream) (bounds, bool, error) {
	if s.unavailable {
		target.SourceID = "1"
	}
	return (&windowsSink{}).Target(target, stream)
}

func TestMonitorObservationSuspendsSameGrant(t *testing.T) {
	monitor, _, _ := user32.NewProc("MonitorFromPoint").Call(0, 1)
	if monitor == 0 {
		t.Skip("no interactive display")
	}
	sink := &monitorObservationSink{recordedInput: &recordedInput{events: make(chan inputEvent, 16), resets: make(chan struct{}, 16), focused: true}}
	m := &Manager{sink: sink, connections: map[endpointKey]*connection{}}
	s, peers := coPlaySession(t, m, true)
	s.target = nativecapture.CaptureTarget{Kind: "display", SourceID: strconv.FormatUint(uint64(monitor), 10)}
	c := peers[0]
	sendTestInput(m, c, inputEvent{Type: "request"})
	grant := c.grant
	sendTestInput(m, c, inputEvent{Type: "key", Code: "KeyA", Down: true})
	<-sink.events
	sink.unavailable = true
	m.refreshActive()
	sendTestInput(m, c, inputEvent{Type: "move", X: .8, Y: .4})
	if grant == "" || c.grant != grant || !c.suspended || len(c.keys) != 0 || len(sink.events) != 0 {
		t.Fatal("unavailable monitor did not safely suspend same grant")
	}
	sink.unavailable = false
	m.refreshActive()
	if c.suspended || c.grant != grant || len(sink.events) != 0 {
		t.Fatal("monitor recovery changed grant or replayed input")
	}
	sendTestInput(m, c, inputEvent{Type: "move", X: .4, Y: .2})
	if len(sink.events) != 1 {
		t.Fatal("new input did not resume after monitor observation")
	}
}
