//go:build windows

package windowaudio

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/windows"
)

const (
	maxListBytes     = 64 << 10
	maxTargets       = 100
	helperHeaderSize = 28
)

type windowsProvider struct{ helper string }

type helperTarget struct {
	PID          uint32 `json:"pid"`
	CreationTime uint64 `json:"creationTime"`
	Title        string `json:"title"`
}

func NewProvider() Provider {
	helper := strings.TrimSpace(os.Getenv("SCREENER_PROCESS_AUDIO_HELPER"))
	if helper == "" {
		if executable, err := os.Executable(); err == nil {
			helper = filepath.Join(filepath.Dir(executable), "screener-process-audio.exe")
		}
	}
	return &windowsProvider{helper: helper}
}

func (provider *windowsProvider) available() bool {
	version := windows.RtlGetVersion()
	if version.MajorVersion < 10 || version.BuildNumber < 22_000 || provider.helper == "" {
		return false
	}
	info, err := os.Stat(provider.helper)
	return err == nil && !info.IsDir()
}

func (provider *windowsProvider) List(ctx context.Context) ([]Target, error) {
	if !provider.available() {
		return nil, ErrUnavailable
	}
	command := exec.CommandContext(ctx, provider.helper, "--list")
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, ErrUnavailable
	}
	command.Stderr = io.Discard
	if err = command.Start(); err != nil {
		return nil, ErrUnavailable
	}
	payload, readErr := io.ReadAll(io.LimitReader(stdout, maxListBytes+1))
	if (readErr != nil || len(payload) > maxListBytes) && ctx.Err() == nil {
		_ = command.Process.Kill()
	}
	waitErr := command.Wait()
	if readErr != nil || waitErr != nil || len(payload) > maxListBytes {
		return nil, ErrUnavailable
	}
	var listed []helperTarget
	if json.Unmarshal(payload, &listed) != nil || len(listed) > maxTargets {
		return nil, ErrUnavailable
	}
	targets := make([]Target, 0, len(listed))
	for _, candidate := range listed {
		title := strings.TrimSpace(candidate.Title)
		if candidate.PID == 0 || candidate.CreationTime == 0 || title == "" || len(title) > 512 {
			continue
		}
		targets = append(targets, Target{
			PID: candidate.PID, CreationTime: candidate.CreationTime, Title: title,
		})
	}
	return targets, nil
}

func (provider *windowsProvider) Capture(ctx context.Context, target Target, onChunk func(PCMChunk) error) error {
	if !provider.available() || target.PID == 0 || target.CreationTime == 0 || onChunk == nil {
		return ErrUnavailable
	}
	command := exec.CommandContext(ctx, provider.helper, "--capture",
		strconv.FormatUint(uint64(target.PID), 10), strconv.FormatUint(target.CreationTime, 10))
	stdout, err := command.StdoutPipe()
	if err != nil {
		return ErrUnavailable
	}
	command.Stderr = io.Discard
	if err = command.Start(); err != nil {
		return ErrUnavailable
	}
	started := false
	for {
		header := make([]byte, helperHeaderSize)
		_, readErr := io.ReadFull(stdout, header)
		if readErr != nil {
			err = readErr
			break
		}
		length := binary.BigEndian.Uint32(header[24:28])
		if string(header[:4]) != "SPCM" || header[4] != 1 || header[5] != 0 ||
			header[6] != 0 || header[7] != 0 || length == 0 || length > 48_000*2*2/10 || length%4 != 0 {
			err = errors.New("process audio helper returned an invalid PCM header")
			break
		}
		data := make([]byte, length)
		if _, readErr = io.ReadFull(stdout, data); readErr != nil {
			err = readErr
			break
		}
		started = true
		if err = onChunk(PCMChunk{
			Timestamp100ns: binary.BigEndian.Uint64(header[8:16]),
			Duration100ns:  binary.BigEndian.Uint64(header[16:24]),
			Data:           data,
		}); err != nil {
			_ = command.Process.Kill()
			break
		}
	}
	if err != nil && ctx.Err() == nil {
		_ = command.Process.Kill()
	}
	_ = command.Wait()
	if ctx.Err() != nil {
		return nil
	}
	if err != nil || !started {
		return errors.New("target-process audio capture stopped")
	}
	return errors.New("target process exited")
}
