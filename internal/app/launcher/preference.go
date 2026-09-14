package launcher

import (
	"errors"
	"os"
	"strings"
)

// Keep UI preference outside client.json: published App versions reject
// unknown configuration fields. Missing preference preserves their default.
func LoadMode(configPath string) (Mode, error) {
	payload, err := os.ReadFile(configPath + ".mode")
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	mode := Mode(strings.TrimSpace(string(payload)))
	if !validMode(mode) {
		return "", errors.New("invalid saved launcher mode")
	}
	return mode, nil
}

func SaveMode(configPath string, mode Mode) error {
	if !validMode(mode) {
		return errors.New("invalid launcher mode")
	}
	return os.WriteFile(configPath+".mode", []byte(string(mode)+"\n"), 0o600)
}

func validMode(mode Mode) bool {
	return mode == ModeLocal || mode == ModeLink || mode == ModeSite
}
