package nativecapture

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/diagnostics"
)

const (
	probeProtocol       = 7
	probeTimeout        = 3 * time.Second
	maxProbeOutputBytes = 64 * 1024
	maxProbeErrorBytes  = 4 * 1024
	maxAdapters         = 64
	maxEncoders         = 64
	maxIdentityBytes    = 512
)

type Encoder struct {
	Index    uint32 `json:"index"`
	Name     string `json:"name"`
	Identity string `json:"identity"`
}

type Adapter struct {
	Index        uint32    `json:"index"`
	Name         string    `json:"name"`
	Identity     string    `json:"identity"`
	HardwareH264 []Encoder `json:"hardwareH264"`
}

type Capabilities struct {
	Protocol      int       `json:"protocol"`
	Platform      string    `json:"platform"`
	PlatformBuild string    `json:"platformBuild"`
	VideoCapture  bool      `json:"videoCapture"`
	ProcessAudio  bool      `json:"processAudio"`
	SystemAudio   bool      `json:"systemAudio"`
	SoftwareVP8   bool      `json:"softwareVP8"`
	Adapters      []Adapter `json:"adapters"`
}

type Summary struct {
	Video        bool
	ProcessAudio bool
	SystemAudio  bool
	HardwareH264 bool
	SoftwareVP8  bool
}

func (capabilities Capabilities) Summary() Summary {
	summary := Summary{
		Video:        capabilities.VideoCapture,
		ProcessAudio: capabilities.ProcessAudio,
		SystemAudio:  capabilities.SystemAudio,
		SoftwareVP8:  capabilities.SoftwareVP8,
	}
	for _, adapter := range capabilities.Adapters {
		if len(adapter.HardwareH264) > 0 {
			summary.HardwareH264 = true
			break
		}
	}
	return summary
}

func (summary Summary) AudioFor(kind string) bool {
	if kind == "window" {
		return summary.ProcessAudio
	}
	return (kind == "display" || kind == "picker") && summary.SystemAudio
}

func Discover(parent context.Context, executable string) (Capabilities, error) {
	if strings.TrimSpace(executable) == "" {
		return Capabilities{}, nil
	}
	if _, err := os.Stat(executable); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Capabilities{}, nil
		}
		return Capabilities{}, fmt.Errorf("inspect native capture process: %w", err)
	}
	ctx, cancel := context.WithTimeout(parent, probeTimeout)
	defer cancel()
	stdout := &boundedBuffer{limit: maxProbeOutputBytes}
	stderr := diagnostics.Writer("native-capture-probe")
	defer stderr.Close()
	command := exec.CommandContext(ctx, executable, "--probe")
	command.Stdout = stdout
	command.Stderr = stderr
	hideWindow(command)
	if err := command.Run(); err != nil {
		slog.DebugContext(ctx, "piik-client", "event", "capture-probe-failed", diagnostics.Error(err), "canceled", ctx.Err() != nil)
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return Capabilities{}, errors.New("native capture probe timed out")
		}
		return Capabilities{}, fmt.Errorf("native capture probe failed: %w", err)
	}
	capabilities, err := decodeProbe(stdout.Bytes())
	if err != nil {
		return Capabilities{}, err
	}
	if capabilities.Platform != runtime.GOOS {
		return Capabilities{}, errors.New("native capture platform does not match the App")
	}
	return capabilities, nil
}

func PackagedExecutable() string {
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	name := ""
	switch runtime.GOOS {
	case "windows":
		name = "piik-capture.exe"
	case "darwin":
		name = "piik-capture"
	case "linux":
		name = "piik-capture"
	default:
		return ""
	}
	return filepath.Join(filepath.Dir(executable), "runtime", "native", name)
}

func decodeProbe(payload []byte) (Capabilities, error) {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var capabilities Capabilities
	if err := decoder.Decode(&capabilities); err != nil {
		return Capabilities{}, errors.New("native capture probe returned invalid JSON")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Capabilities{}, errors.New("native capture probe returned trailing data")
	}
	if capabilities.Protocol != probeProtocol ||
		(capabilities.Platform != "windows" && capabilities.Platform != "darwin" &&
			capabilities.Platform != "linux") ||
		len(capabilities.PlatformBuild) == 0 ||
		len(capabilities.PlatformBuild) > maxIdentityBytes ||
		len(capabilities.Adapters) > maxAdapters {
		return Capabilities{}, errors.New("native capture probe returned an invalid contract")
	}
	adapterIndexes := make(map[uint32]struct{}, len(capabilities.Adapters))
	for _, adapter := range capabilities.Adapters {
		if len(adapter.Name) == 0 || len(adapter.Name) > maxIdentityBytes ||
			len(adapter.Identity) == 0 || len(adapter.Identity) > maxIdentityBytes ||
			len(adapter.HardwareH264) > maxEncoders {
			return Capabilities{}, errors.New("native capture probe returned an invalid adapter")
		}
		if _, exists := adapterIndexes[adapter.Index]; exists {
			return Capabilities{}, errors.New("native capture probe returned duplicate adapters")
		}
		adapterIndexes[adapter.Index] = struct{}{}
		encoderIndexes := make(map[uint32]struct{}, len(adapter.HardwareH264))
		for _, encoder := range adapter.HardwareH264 {
			if len(encoder.Name) == 0 || len(encoder.Name) > maxIdentityBytes ||
				len(encoder.Identity) == 0 || len(encoder.Identity) > maxIdentityBytes {
				return Capabilities{}, errors.New("native capture probe returned an invalid encoder")
			}
			if _, exists := encoderIndexes[encoder.Index]; exists {
				return Capabilities{}, errors.New("native capture probe returned duplicate encoders")
			}
			encoderIndexes[encoder.Index] = struct{}{}
		}
	}
	return capabilities, nil
}

type boundedBuffer struct {
	buffer          bytes.Buffer
	limit           int
	discardOverflow bool
}

func (buffer *boundedBuffer) Write(payload []byte) (int, error) {
	remaining := buffer.limit - buffer.buffer.Len()
	if buffer.discardOverflow {
		// Keep terminal failure codes even after a long stream of encoder statistics.
		if len(payload) >= buffer.limit {
			buffer.buffer.Reset()
			payloadTail := payload[len(payload)-buffer.limit:]
			_, _ = buffer.buffer.Write(payloadTail)
		} else {
			if len(payload) > remaining {
				buffer.buffer.Next(len(payload) - remaining)
			}
			_, _ = buffer.buffer.Write(payload)
		}
		return len(payload), nil
	}
	if remaining <= 0 {
		return 0, errors.New("native capture probe output exceeded its bound")
	}
	if len(payload) > remaining {
		_, _ = buffer.buffer.Write(payload[:remaining])
		return remaining, errors.New("native capture probe output exceeded its bound")
	}
	return buffer.buffer.Write(payload)
}

func (buffer *boundedBuffer) Bytes() []byte {
	return buffer.buffer.Bytes()
}
