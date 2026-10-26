//go:build windows

package remoteinput

import (
	"errors"
	"strconv"
	"unsafe"

	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"golang.org/x/sys/windows"
)

var extendedFrameBounds = windows.NewLazySystemDLL("dwmapi.dll").NewProc("DwmGetWindowAttribute")

type rect struct{ left, top, right, bottom int32 }

func (s *windowsSink) Target(target nativecapture.CaptureTarget, _ *nativecapture.Stream) (bounds, bool, error) {
	id, err := strconv.ParseUint(target.SourceID, 10, 64)
	if err != nil || id == 0 {
		return bounds{}, false, errors.New("shared source is unavailable")
	}
	var area rect
	focused := true
	switch target.Kind {
	case "display":
		info := struct {
			size          uint32
			monitor, work rect
			flags         uint32
		}{}
		info.size = uint32(unsafe.Sizeof(info))
		ok, _, _ := user32.NewProc("GetMonitorInfoW").Call(uintptr(id), uintptr(unsafe.Pointer(&info)))
		if ok == 0 {
			// A failed monitor observation does not prove the capture was retired.
			return bounds{}, false, nil
		}
		area = info.monitor
	case "window":
		var pid uint32
		user32.NewProc("GetWindowThreadProcessId").Call(uintptr(id), uintptr(unsafe.Pointer(&pid)))
		if pid == 0 || pid != target.PID {
			return bounds{}, false, errors.New("shared window is unavailable")
		}
		creation, parseErr := strconv.ParseUint(target.CreationTime, 10, 64)
		if parseErr != nil || creation == 0 {
			return bounds{}, false, errors.New("shared window identity is invalid")
		}
		// Match the capture target's process incarnation, not a recycled HWND/PID.
		process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
		if err != nil {
			return bounds{}, false, nil
		}
		var created, exited, kernel, user windows.Filetime
		err = windows.GetProcessTimes(process, &created, &exited, &kernel, &user)
		windows.CloseHandle(process)
		if err != nil {
			return bounds{}, false, nil
		}
		if creation != uint64(created.HighDateTime)<<32|uint64(created.LowDateTime) {
			return bounds{}, false, errors.New("shared window was replaced")
		}
		if hr, _, _ := extendedFrameBounds.Call(uintptr(id), 9, uintptr(unsafe.Pointer(&area)), unsafe.Sizeof(area)); int32(hr) < 0 {
			ok, _, _ := user32.NewProc("GetWindowRect").Call(uintptr(id), uintptr(unsafe.Pointer(&area)))
			if ok == 0 {
				return bounds{}, false, nil
			}
		}
		foreground, _, _ := user32.NewProc("GetForegroundWindow").Call()
		root, _, _ := user32.NewProc("GetAncestor").Call(foreground, 2) // GA_ROOT
		minimized, _, _ := user32.NewProc("IsIconic").Call(uintptr(id))
		focused = root == uintptr(id) && minimized == 0
	default:
		return bounds{}, false, errors.New("source cannot accept input")
	}
	if area.right <= area.left || area.bottom <= area.top {
		return bounds{}, false, nil
	}
	return bounds{area.left, area.top, area.right - area.left, area.bottom - area.top}, focused, nil
}
