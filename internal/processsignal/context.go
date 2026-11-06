// Package processsignal owns ordered process termination for App and Server.
package processsignal

import (
	"context"
	"os"
	"os/signal"
	"syscall"
)

func NotifyContext(parent context.Context) (context.Context, context.CancelFunc) {
	signals := []os.Signal{os.Interrupt, syscall.SIGTERM}
	// nohup deliberately passes an ignored HUP; registering it would undo that intent.
	if !signal.Ignored(syscall.SIGHUP) {
		signals = append(signals, syscall.SIGHUP)
	}
	return signal.NotifyContext(parent, signals...)
}
