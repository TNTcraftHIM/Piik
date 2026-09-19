package nativecapture

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"unicode/utf8"
)

// Device identities remain local to the authenticated App control connection.
type Microphone struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

func ValidDeviceID(id string) bool {
	return len(id) <= 512 && utf8.ValidString(id) && !strings.ContainsRune(id, 0)
}

func ListMicrophones(parent context.Context, executable string) ([]Microphone, error) {
	ctx, cancel := context.WithTimeout(parent, probeTimeout)
	defer cancel()
	stdout := &boundedBuffer{limit: maxProbeOutputBytes}
	command := exec.CommandContext(ctx, executable, "--list-microphones")
	command.Stdout = stdout
	hideWindow(command)
	if err := command.Run(); err != nil {
		return nil, errors.New("native microphone list is unavailable")
	}
	var devices []Microphone
	if err := decodeStrictJSON(stdout.Bytes(), &devices); err != nil || devices == nil || len(devices) > 64 {
		return nil, errors.New("native microphone list is invalid")
	}
	seen := make(map[string]bool, len(devices))
	for _, device := range devices {
		if device.ID == "" || !ValidDeviceID(device.ID) || seen[device.ID] ||
			device.Label == "" || len(device.Label) > 512 || !utf8.ValidString(device.Label) || strings.ContainsRune(device.Label, 0) {
			return nil, errors.New("native microphone identity is invalid")
		}
		seen[device.ID] = true
	}
	return devices, nil
}
