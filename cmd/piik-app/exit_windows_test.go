package main

import (
	"context"
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

func TestStandaloneConsoleErrorPause(t *testing.T) {
	const helper = "PIIK_TEST_STANDALONE_CONSOLE"
	if os.Getenv(helper) == "" {
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestStandaloneConsoleErrorPause$")
		command.WaitDelay = time.Second
		command.Env = append(os.Environ(), helper+"=true")
		command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x10, HideWindow: true} // CREATE_NEW_CONSOLE
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("standalone console: %v\n%s", err, output)
		}
		return
	}
	// exec captures the test result; the real console handles model double-click
	// launch without touching the parent terminal or a user's App configuration.
	input, err := os.OpenFile("CONIN$", os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	output, err := os.OpenFile("CONOUT$", os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer output.Close()
	stdin, stdout, stderr := os.Stdin, os.Stdout, os.Stderr
	os.Stdin, os.Stdout, os.Stderr = input, output, output
	defer func() { os.Stdin, os.Stdout, os.Stderr = stdin, stdout, stderr }()
	t.Setenv("PIIK_CLIENT_GATE_NO_BROWSER", "false")
	if os.Getenv(helper) == "shared" {
		pauseOnError()
		return
	}
	done := make(chan struct{})
	go func() { pauseOnError(); close(done) }()
	select {
	case <-done:
		t.Fatal("the standalone error window closed before confirmation")
	case <-time.After(150 * time.Millisecond):
	}
	// INPUT_RECORD containing a key-down Enter event.
	event := struct {
		kind, padding uint16
		down          int32
		repeat, key   uint16
		scan, char    uint16
		control       uint32
	}{kind: 1, down: 1, repeat: 1, key: 13, char: 13}
	var written uint32
	ok, _, callErr := syscall.NewLazyDLL("kernel32.dll").NewProc("WriteConsoleInputW").Call(
		input.Fd(), uintptr(unsafe.Pointer(&event)), 1, uintptr(unsafe.Pointer(&written)),
	)
	if ok == 0 || written != 1 {
		t.Fatalf("confirm close: %v", callErr)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Enter did not release the error window")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	shared := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestStandaloneConsoleErrorPause$")
	shared.Env = append(os.Environ(), helper+"=shared")
	shared.WaitDelay = time.Second
	if result, err := shared.CombinedOutput(); err != nil {
		t.Fatalf("an existing terminal must exit directly: %v\n%s", err, result)
	}
	t.Setenv("PIIK_CLIENT_GATE_NO_BROWSER", "true")
	pauseOnError() // Automation must not wait even when it owns a console.
	os.Stdin, os.Stdout, os.Stderr = stdin, stdout, stderr
	t.Setenv("PIIK_CLIENT_GATE_NO_BROWSER", "false")
	pauseOnError() // Redirected output must not wait.
}
