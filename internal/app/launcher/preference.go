package launcher

import (
	"encoding/json"
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

// StartupIntent selects an external origin or this App's launch, never access.
type StartupIntent struct {
	Site  string         `json:"site,omitempty"`
	Owned *StartupLaunch `json:"owned,omitempty"`
}

type StartupLaunch struct {
	Mode       Mode    `json:"mode"`
	LANAddress *string `json:"lanAddress,omitempty"`
}

func LoadStartupSite(configPath string, approvedSites ...string) (StartupIntent, error) {
	payload, err := os.ReadFile(configPath + ".startup-site")
	if errors.Is(err, os.ErrNotExist) {
		return StartupIntent{}, nil
	}
	if err != nil {
		return StartupIntent{}, err
	}
	site := strings.TrimSpace(string(payload))
	if strings.HasPrefix(site, "{") {
		var intent StartupIntent
		if err := json.Unmarshal(payload, &intent); err != nil {
			return StartupIntent{}, err
		}
		if intent.Owned == nil || intent.Site != "" || !validMode(intent.Owned.Mode) {
			return StartupIntent{}, errors.New("invalid saved startup intent")
		}
		return intent, nil
	}
	if site == "" || slices.Contains(approvedSites, site) {
		return StartupIntent{Site: site}, nil
	}
	// CLI/config changes also retire the old choice, rather than letting a
	// later approval of that same address resurrect it.
	return StartupIntent{}, SaveStartupSite(configPath, StartupIntent{})
}

func SaveStartupSite(configPath string, intent StartupIntent) error {
	payload := []byte(intent.Site)
	if intent.Owned != nil {
		if intent.Site != "" || !validMode(intent.Owned.Mode) {
			return errors.New("invalid startup intent")
		}
		var err error
		payload, err = json.Marshal(intent)
		if err != nil {
			return err
		}
	}
	return os.WriteFile(configPath+".startup-site", append(payload, '\n'), 0o600)
}

func validMode(mode Mode) bool {
	return mode == ModeLocal || mode == ModeLink
}
