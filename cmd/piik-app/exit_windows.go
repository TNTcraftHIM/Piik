package main

import (
	"bufio"
	"fmt"
	"os"
	"syscall"
	"unsafe"

	"github.com/charmbracelet/x/term"
)

func pauseOnError() {
	if os.Getenv("PIIK_CLIENT_GATE_NO_BROWSER") == "true" ||
		!term.IsTerminal(os.Stdin.Fd()) || !term.IsTerminal(os.Stdout.Fd()) || !term.IsTerminal(os.Stderr.Fd()) {
		return
	}
	// A shell sharing this console already preserves its output. Only keep a
	// standalone window alive, after App resources and terminal mode are restored.
	// https://learn.microsoft.com/en-us/windows/console/getconsoleprocesslist
	var processID uint32
	count, _, _ := syscall.NewLazyDLL("kernel32.dll").NewProc("GetConsoleProcessList").Call(
		uintptr(unsafe.Pointer(&processID)), 1,
	)
	if count != 1 {
		return
	}
	fmt.Fprintln(os.Stderr, "\nPress Enter to close this window. / 按回车关闭此窗口。")
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
}
