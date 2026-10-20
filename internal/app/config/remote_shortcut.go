package config

import (
	"encoding/json"
	"errors"
	"os"
)

const DefaultRemoteStopKey = 10

// F12 is reserved by Windows debuggers even when no debugger is running.
func ValidRemoteStopKey(key int) bool { return key >= 1 && key <= 11 }

// Keep the optional input preference separate from the published strict config.
func LoadRemoteStopKey(configPath string) (int, error) {
	payload, err := os.ReadFile(configPath + ".remote-shortcut")
	if errors.Is(err, os.ErrNotExist) {
		return DefaultRemoteStopKey, nil
	}
	if err != nil {
		return DefaultRemoteStopKey, err
	}
	var key int
	if json.Unmarshal(payload, &key) != nil || !ValidRemoteStopKey(key) {
		return DefaultRemoteStopKey, errors.New("invalid saved remote-control shortcut")
	}
	return key, nil
}

func SaveRemoteStopKey(configPath string, key int) error {
	if !ValidRemoteStopKey(key) {
		return errors.New("invalid remote-control shortcut")
	}
	payload, err := json.Marshal(key)
	if err != nil {
		return err
	}
	return saveFile(configPath+".remote-shortcut", append(payload, '\n'))
}
