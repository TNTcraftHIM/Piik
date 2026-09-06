//go:build !windows

package nativecapture

import "os/exec"

func hideWindow(_ *exec.Cmd) {}
