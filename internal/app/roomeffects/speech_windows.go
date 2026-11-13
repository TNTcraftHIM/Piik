package roomeffects

import (
	"context"
	"fmt"
	"runtime"
	"syscall"
	"time"
	"unsafe"

	"github.com/TNTcraftHIM/Piik/internal/server/signal"
	"golang.org/x/sys/windows"
)

var ole32 = windows.NewLazySystemDLL("ole32.dll")

// ISpVoice inherits ISpEventSource. The indices are those of ISpVoiceVtbl
// in the Windows SDK sapi.h, including the inherited methods.
const (
	voiceRelease       = 2
	voiceSpeak         = 20
	voiceWaitUntilDone = 32
	speakAsync         = 1
	speakPurge         = 2
	speakPlainText     = 16
)

func runSpeech(ctx context.Context, queue <-chan signal.RoomEffect) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	result, _, _ := ole32.NewProc("CoInitializeEx").Call(0, 0)
	if err := speechError("initialize Windows speech", result); err != nil {
		return err
	}
	defer ole32.NewProc("CoUninitialize").Call()

	class, _ := windows.GUIDFromString("{96749377-3391-11D2-9EE3-00C04F797396}")
	iid, _ := windows.GUIDFromString("{6C44DF74-72B9-4992-A1EC-EF996E0422D4}")
	var voice *[1]*[38]uintptr
	result, _, _ = ole32.NewProc("CoCreateInstance").Call(uintptr(unsafe.Pointer(&class)), 0, 1,
		uintptr(unsafe.Pointer(&iid)), uintptr(unsafe.Pointer(&voice)))
	if err := speechError("open Windows speech voice", result); err != nil {
		return err
	}
	instance := uintptr(unsafe.Pointer(voice))
	methods := voice[0]
	defer syscall.SyscallN(methods[voiceRelease], instance)
	for {
		select {
		case <-ctx.Done():
			return nil
		case event := <-queue:
			if expired(event) || ctx.Err() != nil {
				continue
			}
			name := event.Text
			if name == "" {
				name = "有观众"
			}
			text, err := windows.UTF16FromString(name + "进入了房间")
			if err != nil {
				continue
			}
			result, _, _ := syscall.SyscallN(methods[voiceSpeak], instance, uintptr(unsafe.Pointer(&text[0])), speakAsync|speakPlainText, 0)
			runtime.KeepAlive(text)
			if err := speechError("speak Viewer arrival", result); err != nil {
				return err
			}
			deadline := time.Now().Add(10 * time.Second)
			for {
				if expired(event) || ctx.Err() != nil || time.Now().After(deadline) {
					syscall.SyscallN(methods[voiceSpeak], instance, 0, speakAsync|speakPurge, 0)
					break
				}
				result, _, _ = syscall.SyscallN(methods[voiceWaitUntilDone], instance, 80)
				if err := speechError("wait for Viewer announcement", result); err != nil {
					return err
				}
				if result == 0 {
					break
				}
			}
		}
	}
}

func speechError(operation string, result uintptr) error {
	if int32(result) < 0 {
		return fmt.Errorf("%s (HRESULT 0x%08X)", operation, uint32(result))
	}
	return nil
}
