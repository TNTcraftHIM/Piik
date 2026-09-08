//go:build unix

package main

import (
	"os"
	"os/signal"
	"syscall"

	"github.com/TNTcraftHIM/Screener/internal/diagnostics"
)

func watchDiagnosticExport(recorder *diagnostics.Recorder) func() {
	requests := make(chan os.Signal, 1)
	stop, done := make(chan struct{}), make(chan struct{})
	signal.Notify(requests, syscall.SIGUSR1)
	go func() {
		defer close(done)
		for {
			select {
			case <-stop:
				return
			case <-requests:
				_ = exportServerDiagnostics(recorder)
			}
		}
	}()
	return func() {
		signal.Stop(requests)
		close(stop)
		<-done
	}
}
