//go:build unix

package processsignal

import (
	"context"
	"os"
	"os/signal"
	"syscall"
	"testing"
	"time"
)

func TestTerminalHangupRespectsInheritedIgnore(t *testing.T) {
	ignored := signal.Ignored(syscall.SIGHUP)
	defer func() {
		if ignored {
			signal.Ignore(syscall.SIGHUP)
		} else {
			signal.Reset(syscall.SIGHUP)
		}
	}()

	signal.Ignore(syscall.SIGHUP)
	ignoredContext, stop := NotifyContext(context.Background())
	defer stop()
	if !signal.Ignored(syscall.SIGHUP) {
		t.Fatal("shutdown registration changed the inherited HUP disposition")
	}
	if err := syscall.Kill(os.Getpid(), syscall.SIGHUP); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ignoredContext.Done():
		t.Fatal("ignored terminal hangup stopped the process")
	default:
	}
	stop()

	signal.Reset(syscall.SIGHUP)
	ctx, stop := NotifyContext(context.Background())
	defer stop()
	if err := syscall.Kill(os.Getpid(), syscall.SIGHUP); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ctx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("terminal hangup did not enter ordered shutdown")
	}
}
