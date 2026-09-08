package main

import "github.com/TNTcraftHIM/Screener/internal/diagnostics"

// Windows exports at orderly shutdown; it has no SIGUSR1 equivalent.
func watchDiagnosticExport(*diagnostics.Recorder) func() { return func() {} }
