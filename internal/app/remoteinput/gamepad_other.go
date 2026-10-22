//go:build !windows || !amd64

package remoteinput

import "fmt"

func openGamepadBackend() (gamepadBackend, error) {
	return nil, fmt.Errorf("%w: requires Windows x64 and ViGEmBus", errGamepadUnavailable)
}
