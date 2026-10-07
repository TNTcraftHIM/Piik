package config

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"sync"

	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
)

const MaxQualityPreferenceBytes = 1024

// QualityPreference owns optional App-wide settings, not a live capture profile.
// A separate file leaves the strict configuration readable by published Apps.
type QualityPreference struct {
	mu    sync.Mutex
	path  string
	value *protocol.QualitySettings
}

// A missing or unreadable preference must not prevent the App from starting.
// Even on error the returned store can accept the user's next explicit choice.
func LoadQualityPreference(configPath string) (*QualityPreference, error) {
	p := &QualityPreference{path: configPath + ".quality"}
	file, err := os.Open(p.path)
	if errors.Is(err, os.ErrNotExist) {
		return p, nil
	}
	if err != nil {
		return p, err
	}
	defer file.Close()
	payload, err := io.ReadAll(io.LimitReader(file, MaxQualityPreferenceBytes+1))
	if err != nil {
		return p, err
	}
	var quality protocol.QualitySettings
	if len(payload) > MaxQualityPreferenceBytes || json.Unmarshal(payload, &quality) != nil {
		return p, errors.New("invalid saved sharing quality")
	}
	p.value = &quality
	return p, nil
}

func (p *QualityPreference) Read() *protocol.QualitySettings {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.value == nil {
		return nil
	}
	value := *p.value
	return &value
}

func (p *QualityPreference) Save(quality protocol.QualitySettings) error {
	payload, err := json.Marshal(quality)
	if err != nil {
		return err
	}
	// Reuse the wire validator instead of a second list of accepted settings.
	if err := json.Unmarshal(payload, &quality); err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.value != nil && *p.value == quality {
		return nil
	}
	if err := saveFile(p.path, append(payload, '\n')); err != nil {
		return err
	}
	p.value = &quality
	return nil
}
