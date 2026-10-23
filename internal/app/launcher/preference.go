package launcher

import (
	"errors"
	"os"
	"slices"
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

// Startup preference selects one approved origin; it never grants access.
func LoadStartupSite(configPath string, approvedSites ...string) (string, error) {
	payload, err := os.ReadFile(configPath + ".startup-site")
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	site := strings.TrimSpace(string(payload))
	if site == "" || slices.Contains(approvedSites, site) {
		return site, nil
	}
	// CLI/config changes also retire the old choice, rather than letting a
	// later approval of that same address resurrect it.
	return "", SaveStartupSite(configPath, "")
}

func SaveStartupSite(configPath, site string) error {
	return os.WriteFile(configPath+".startup-site", []byte(site+"\n"), 0o600)
}

func validMode(mode Mode) bool {
	return mode == ModeLocal || mode == ModeLink
}
