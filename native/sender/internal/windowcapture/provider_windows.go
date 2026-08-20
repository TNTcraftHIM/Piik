//go:build windows

package windowcapture

import (
	"bytes"
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
	maxListBytes        = 64 << 10
	maxTargets          = 100
	helperHeaderSize    = 28
	maxStatusBytes      = 4 << 10
	maxMediaBytes       = 1 << 20
	maxPCMBytes         = 48_000 * 2 * 2 / 10
	helperKindPCM       = 1
	helperKindH264      = 2
	helperKindStatus    = 3
	helperProtocolMagic = "SMED"
)

type windowsProvider struct {
	helper       string
	adapterIndex uint
	mftIndex     uint
}

type helperTarget struct {
	WindowHandle uint64 `json:"windowHandle"`
	PID          uint32 `json:"pid"`
	CreationTime uint64 `json:"creationTime"`
	Title        string `json:"title"`
}

func NewProvider() Provider {
	helper := strings.TrimSpace(os.Getenv("SCREENER_WINDOW_CAPTURE_HELPER"))
	if helper == "" {
		if executable, err := os.Executable(); err == nil {
			helper = filepath.Join(filepath.Dir(executable), "screener-window-capture.exe")
		}
	}
	return &windowsProvider{
		helper:       helper,
		adapterIndex: parseOptionalIndex("SCREENER_WINDOW_CAPTURE_ADAPTER_INDEX"),
		mftIndex:     parseOptionalIndex("SCREENER_WINDOW_CAPTURE_MFT_INDEX"),
	}
}

func parseOptionalIndex(name string) uint {
	value, err := strconv.ParseUint(strings.TrimSpace(os.Getenv(name)), 10, 32)
	if err != nil {
		return 0
	}
	return uint(value)
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
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&listed) != nil || decoder.Decode(&struct{}{}) != io.EOF || len(listed) > maxTargets {
		return nil, ErrUnavailable
	}
	targets := make([]Target, 0, len(listed))
	for _, candidate := range listed {
		title := strings.TrimSpace(candidate.Title)
		if candidate.WindowHandle == 0 || candidate.PID == 0 || candidate.CreationTime == 0 ||
			title == "" || len(title) > 512 {
			continue
		}
		targets = append(targets, Target{
			WindowHandle: candidate.WindowHandle,
			PID:          candidate.PID,
			CreationTime: candidate.CreationTime,
			Title:        title,
		})
	}
	return targets, nil
}

func (provider *windowsProvider) CaptureAudio(
	ctx context.Context,
	target Target,
	onPCM func(PCMChunk) error,
) error {
	return provider.capture(ctx, target,
		[]string{"--capture-audio", targetPID(target), targetCreationTime(target)},
		nil, onPCM, nil, nil)
}

func (provider *windowsProvider) CaptureWindow(
	ctx context.Context,
	target Target,
	keyFrames <-chan struct{},
	onPCM func(PCMChunk) error,
	onH264 func(H264AccessUnit) error,
	onStatus func(Status) error,
) error {
	if keyFrames == nil || onPCM == nil || onH264 == nil || onStatus == nil {
		return ErrUnavailable
	}
	arguments := []string{
		"--capture-window", targetPID(target), targetCreationTime(target),
		strconv.FormatUint(target.WindowHandle, 10),
		"--adapter-index", strconv.FormatUint(uint64(provider.adapterIndex), 10),
		"--mft-index", strconv.FormatUint(uint64(provider.mftIndex), 10),
		"--protocol-v1",
	}
	return provider.capture(ctx, target, arguments, keyFrames, onPCM, onH264, onStatus)
}

func targetPID(target Target) string { return strconv.FormatUint(uint64(target.PID), 10) }

func targetCreationTime(target Target) string { return strconv.FormatUint(target.CreationTime, 10) }

func (provider *windowsProvider) capture(
	ctx context.Context,
	target Target,
	arguments []string,
	keyFrames <-chan struct{},
	onPCM func(PCMChunk) error,
	onH264 func(H264AccessUnit) error,
	onStatus func(Status) error,
) error {
	windowMode := onH264 != nil && onStatus != nil
	if !provider.available() || target.PID == 0 || target.CreationTime == 0 || onPCM == nil ||
		(windowMode && target.WindowHandle == 0) {
		return ErrUnavailable
	}
	command := exec.CommandContext(ctx, provider.helper, arguments...)
	stdout, err := command.StdoutPipe()
	if err != nil {
		return ErrUnavailable
	}
	var stdin io.WriteCloser
	if windowMode {
		stdin, err = command.StdinPipe()
		if err != nil {
			return ErrUnavailable
		}
	}
	command.Stderr = io.Discard
	if err = command.Start(); err != nil {
		return ErrUnavailable
	}
	keyFrameDone := make(chan struct{})
	keyFrameStop := make(chan struct{})
	if windowMode {
		go func() {
			defer close(keyFrameDone)
			defer stdin.Close()
			for {
				select {
				case <-ctx.Done():
					return
				case <-keyFrameStop:
					return
				case _, ok := <-keyFrames:
					if !ok {
						return
					}
					if _, writeErr := stdin.Write([]byte{'K'}); writeErr != nil {
						return
					}
				}
			}
		}()
	} else {
		close(keyFrameDone)
	}

	startedPCM := false
	startedH264 := false
	for {
		header := make([]byte, helperHeaderSize)
		if _, err = io.ReadFull(stdout, header); err != nil {
			break
		}
		kind := header[5]
		flags := header[6]
		timestamp := binary.BigEndian.Uint64(header[8:16])
		duration := binary.BigEndian.Uint64(header[16:24])
		length := binary.BigEndian.Uint32(header[24:28])
		if string(header[:4]) != helperProtocolMagic || header[4] != 1 || header[7] != 0 ||
			length == 0 || !validHelperHeader(kind, flags, timestamp, duration, length, windowMode) {
			err = errors.New("window capture helper returned an invalid media header")
			break
		}
		data := make([]byte, length)
		if _, err = io.ReadFull(stdout, data); err != nil {
			break
		}
		switch kind {
		case helperKindPCM:
			startedPCM = true
			err = onPCM(PCMChunk{Timestamp100ns: timestamp, Duration100ns: duration, Data: data})
		case helperKindH264:
			startedH264 = true
			err = onH264(H264AccessUnit{
				KeyFrame: flags == 1, Timestamp100ns: timestamp, Duration100ns: duration, Data: data,
			})
		case helperKindStatus:
			var status Status
			err = decodeStatus(data, &status)
			if err == nil {
				err = onStatus(status)
			}
		}
		if err != nil {
			break
		}
	}
	if err != nil && ctx.Err() == nil {
		_ = command.Process.Kill()
	}
	_ = command.Wait()
	if windowMode {
		close(keyFrameStop)
		_ = stdin.Close()
	}
	<-keyFrameDone
	if ctx.Err() != nil {
		return nil
	}
	if err != nil || (windowMode && !startedH264) || (!windowMode && !startedPCM) {
		return errors.New("selected window capture stopped")
	}
	return errors.New("selected target process exited")
}

func validHelperHeader(kind, flags byte, timestamp, duration uint64, length uint32, windowMode bool) bool {
	switch kind {
	case helperKindPCM:
		return flags == 0 && duration > 0 && duration <= 10_000_000 &&
			length <= maxPCMBytes && length%4 == 0
	case helperKindH264:
		return windowMode && flags <= 1 && timestamp > 0 && duration >= 10 &&
			duration <= 10_000_000 && duration%10 == 0 && length <= maxMediaBytes
	case helperKindStatus:
		return windowMode && flags == 0 && timestamp == 0 && duration == 0 && length <= maxStatusBytes
	default:
		return false
	}
}

func decodeStatus(payload []byte, status *Status) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(status) != nil || decoder.Decode(&struct{}{}) != io.EOF || !status.HardwareOnly {
		return errors.New("window capture helper returned invalid status")
	}
	switch status.State {
	case "starting":
		if status.AdapterIndex == nil || status.MFTIndex == nil || status.AdapterName == "" ||
			status.AdapterLUID == "" || status.MFTName == "" || status.MFTCLSID == "" {
			return errors.New("window capture helper returned incomplete hardware status")
		}
	case "active":
		if status.ProfileLevelID != "42c01f" || status.Width != 1280 || status.Height != 720 || status.FPS != 30 {
			return errors.New("window capture helper returned unexpected video status")
		}
	default:
		return errors.New("window capture helper returned unknown status")
	}
	return nil
}
