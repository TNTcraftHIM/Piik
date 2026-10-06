package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	serverconfig "github.com/TNTcraftHIM/Piik/internal/server/config"
)

const currentVersion = 1

type Config struct {
	Version             int    `json:"version"`
	LocalAccessPassword string `json:"localAccessPassword"`
	Site                string `json:"site,omitempty"`
}

func DefaultPath() (string, error) {
	directory, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("find user configuration directory: %w", err)
	}
	return filepath.Join(directory, "Piik", "client.json"), nil
}

func LoadOrCreate(path string) (Config, error) {
	config, err := load(path)
	if err == nil {
		return config, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return Config{}, err
	}

	config = Config{
		Version: currentVersion,
	}
	payload, err := encode(config)
	if err != nil {
		return Config{}, fmt.Errorf("encode App configuration: %w", err)
	}
	if err = os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return Config{}, fmt.Errorf("create App configuration directory: %w", err)
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return load(path)
	}
	if err != nil {
		return Config{}, fmt.Errorf("create App configuration: %w", err)
	}
	if _, writeErr := file.Write(payload); writeErr != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return Config{}, fmt.Errorf("write App configuration: %w", writeErr)
	}
	if err = file.Close(); err != nil {
		return Config{}, fmt.Errorf("close App configuration: %w", err)
	}
	return config, nil
}

func Save(path string, config Config) error {
	payload, err := encode(config)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create App configuration directory: %w", err)
	}
	// Keep the last readable configuration until the replacement is complete.
	// CreateTemp uses 0600 and the same directory keeps the rename on one volume.
	file, err := os.CreateTemp(filepath.Dir(path), ".piik-config-*")
	if err != nil {
		return fmt.Errorf("create App configuration replacement: %w", err)
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(payload); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return fmt.Errorf("write App configuration: %w", err)
	}
	if closeErr != nil {
		return fmt.Errorf("close App configuration replacement: %w", closeErr)
	}
	if err = os.Rename(file.Name(), path); err != nil {
		return fmt.Errorf("replace App configuration: %w", err)
	}
	return nil
}

func NormalizeSite(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	if !strings.Contains(value, "://") {
		value = "https://" + value
	}
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.Host == "" || parsed.User != nil ||
		(parsed.Path != "" && parsed.Path != "/") ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("Piik Site must be an HTTP or HTTPS origin")
	}
	origin := serverconfig.Origin(parsed)
	if origin == "" {
		return "", errors.New("Piik Site must have a valid host and port")
	}
	return origin, nil
}

func load(path string) (Config, error) {
	payload, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var config Config
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&config) != nil || decoder.Decode(&struct{}{}) != io.EOF ||
		config.Version != currentVersion {
		return Config{}, errors.New("App configuration is invalid")
	}
	if config.Site, err = NormalizeSite(config.Site); err != nil {
		return Config{}, errors.New("App configuration is invalid")
	}
	return config, nil
}

func encode(config Config) ([]byte, error) {
	if config.Version != currentVersion {
		return nil, errors.New("App configuration is invalid")
	}
	site, err := NormalizeSite(config.Site)
	if err != nil || site != config.Site {
		return nil, errors.New("App configuration is invalid")
	}
	payload, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("encode App configuration: %w", err)
	}
	return append(payload, '\n'), nil
}
