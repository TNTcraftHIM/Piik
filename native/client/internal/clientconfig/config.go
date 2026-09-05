package clientconfig

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	currentVersion         = 1
	minAccessPasswordBytes = 8
	maxAccessPasswordBytes = 128
)

var passwordPattern = regexp.MustCompile(`^[\x21-\x7e]{8,128}$`)

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
	return filepath.Join(directory, "Screener", "client.json"), nil
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
		return Config{}, fmt.Errorf("encode Client configuration: %w", err)
	}
	if err = os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return Config{}, fmt.Errorf("create Client configuration directory: %w", err)
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return load(path)
	}
	if err != nil {
		return Config{}, fmt.Errorf("create Client configuration: %w", err)
	}
	if _, writeErr := file.Write(payload); writeErr != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return Config{}, fmt.Errorf("write Client configuration: %w", writeErr)
	}
	if err = file.Close(); err != nil {
		return Config{}, fmt.Errorf("close Client configuration: %w", err)
	}
	return config, nil
}

func Save(path string, config Config) error {
	payload, err := encode(config)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create Client configuration directory: %w", err)
	}
	if err = os.WriteFile(path, payload, 0o600); err != nil {
		return fmt.Errorf("write Client configuration: %w", err)
	}
	if err = os.Chmod(path, 0o600); err != nil {
		return fmt.Errorf("protect Client configuration: %w", err)
	}
	return nil
}

func NormalizeSite(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.Host == "" || parsed.User != nil ||
		(parsed.Path != "" && parsed.Path != "/") ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("Screener Site must be an HTTP or HTTPS origin")
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

// NormalizeLocalAccessPassword keeps the local authority open by default while
// retaining a bounded, user-chosen password when one is supplied.
func NormalizeLocalAccessPassword(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	if len(value) < minAccessPasswordBytes || len(value) > maxAccessPasswordBytes ||
		!passwordPattern.MatchString(value) {
		return "", errors.New("Local access password must contain 8 to 128 visible ASCII bytes")
	}
	return value, nil
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
		return Config{}, errors.New("Client configuration is invalid")
	}
	normalizedPassword, passwordErr := NormalizeLocalAccessPassword(config.LocalAccessPassword)
	if passwordErr != nil || normalizedPassword != config.LocalAccessPassword {
		return Config{}, errors.New("Client configuration is invalid")
	}
	if config.Site, err = NormalizeSite(config.Site); err != nil {
		return Config{}, errors.New("Client configuration is invalid")
	}
	return config, nil
}

func encode(config Config) ([]byte, error) {
	if config.Version != currentVersion {
		return nil, errors.New("Client configuration is invalid")
	}
	password, passwordErr := NormalizeLocalAccessPassword(config.LocalAccessPassword)
	if passwordErr != nil || password != config.LocalAccessPassword {
		return nil, errors.New("Client configuration is invalid")
	}
	site, err := NormalizeSite(config.Site)
	if err != nil || site != config.Site {
		return nil, errors.New("Client configuration is invalid")
	}
	payload, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("encode Client configuration: %w", err)
	}
	return append(payload, '\n'), nil
}
