//go:build !windows

package publictunnel

import "os/exec"

func hideWindow(_ *exec.Cmd) {}
