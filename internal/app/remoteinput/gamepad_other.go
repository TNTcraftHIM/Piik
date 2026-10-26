//go:build !linux && (!windows || !amd64) && (!darwin || ios || !cgo)

package remoteinput

import "fmt"

func openGamepadBackend() (gamepadBackend, error) {
	return nil, fmt.Errorf("%w: this platform has no native gamepad backend", errGamepadUnavailable)
}
