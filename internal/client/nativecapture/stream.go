package nativecapture

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	captureStopTimeout = time.Second
	maxPreviewBytes    = 192 * 1024
)

type audioCaptureState struct {
	State string `json:"state"`
	Audio bool   `json:"audio"`
}

type CaptureTarget struct {
	Kind         string `json:"kind"`
	SourceID     string `json:"sourceId"`
	PID          uint32 `json:"pid,omitempty"`
	CreationTime string `json:"creationTime,omitempty"`
	Title        string `json:"title"`
}

type VideoOptions struct {
	Target       CaptureTarget
	Codec        string
	AdapterIndex uint32
	EncoderIndex uint32
	Profile      VideoProfile
	RestoreToken string
}

type VideoProfile struct {
	Width      uint32
	Height     uint32
	Framerate  uint32
	Bitrate    uint32
	Preference string
}

func (profile VideoProfile) Valid() bool {
	validResolution :=
		(profile.Width == 854 && profile.Height == 480) ||
			(profile.Width == 1280 && profile.Height == 720) ||
			(profile.Width == 1920 && profile.Height == 1080) ||
			(profile.Width == 2560 && profile.Height == 1440)
	validPreference := profile.Preference == "maintain-resolution" ||
		profile.Preference == "balanced" ||
		profile.Preference == "maintain-framerate"
	return validResolution && profile.Framerate >= 15 && profile.Framerate <= 60 &&
		profile.Bitrate >= 2_000_000 && profile.Bitrate <= 12_000_000 &&
		validPreference
}

type Stream struct {
	cancel context.CancelFunc
	input  io.ReadCloser
	key    io.WriteCloser
	done   chan error

	closeOnce sync.Once
}

func ListSources(parent context.Context, executable string) ([]CaptureTarget, error) {
	ctx, cancel := context.WithTimeout(parent, probeTimeout)
	defer cancel()
	stdout := &boundedBuffer{limit: maxProbeOutputBytes}
	command := exec.CommandContext(ctx, executable, "--list")
	command.Stdout = stdout
	command.Stderr = &boundedBuffer{limit: maxProbeErrorBytes}
	hideWindow(command)
	if err := command.Run(); err != nil {
		return nil, errors.New("native capture source list is unavailable")
	}
	var targets []CaptureTarget
	if err := decodeStrictJSON(stdout.Bytes(), &targets); err != nil || len(targets) > 1024 {
		return nil, errors.New("native capture source list is invalid")
	}
	for _, target := range targets {
		if !validCaptureTarget(target) {
			return nil, errors.New("native capture target is invalid")
		}
	}
	return targets, nil
}

func PreviewSource(parent context.Context, executable string, target CaptureTarget) ([]byte, error) {
	if !validCaptureTarget(target) {
		return nil, errors.New("native preview target is invalid")
	}
	ctx, cancel := context.WithTimeout(parent, probeTimeout)
	defer cancel()
	stdout := &boundedBuffer{limit: maxPreviewBytes}
	command := exec.CommandContext(ctx, executable,
		"--preview",
		target.Kind,
		target.SourceID,
		strconv.FormatUint(uint64(target.PID), 10),
		zeroWhenEmpty(target.CreationTime),
	)
	command.Stdout = stdout
	command.Stderr = &boundedBuffer{limit: maxProbeErrorBytes}
	hideWindow(command)
	if err := command.Run(); err != nil {
		return nil, errors.New("native capture preview is unavailable")
	}
	preview := stdout.Bytes()
	if len(preview) < 54 || preview[0] != 'B' || preview[1] != 'M' {
		return nil, errors.New("native capture preview is invalid")
	}
	return append([]byte(nil), preview...), nil
}

func StartVideo(parent context.Context, executable string, options VideoOptions) (*Stream, error) {
	if !validCaptureTarget(options.Target) || !options.Profile.Valid() ||
		(options.Codec != "auto" && options.Codec != "h264" && options.Codec != "vp8") ||
		len(options.RestoreToken) > 4096 || !utf8.ValidString(options.RestoreToken) ||
		strings.ContainsRune(options.RestoreToken, 0) {
		return nil, errors.New("native video target is invalid")
	}
	environment := []string(nil)
	if options.RestoreToken != "" {
		environment = []string{"SCREENER_XDP_RESTORE_TOKEN=" + options.RestoreToken}
	}
	return startStreamWithEnvironment(parent, executable, []string{
		"--capture-video",
		options.Target.Kind,
		options.Target.SourceID,
		strconv.FormatUint(uint64(options.Target.PID), 10),
		zeroWhenEmpty(options.Target.CreationTime),
		"--adapter-index",
		strconv.FormatUint(uint64(options.AdapterIndex), 10),
		"--mft-index",
		strconv.FormatUint(uint64(options.EncoderIndex), 10),
		"--width",
		strconv.FormatUint(uint64(options.Profile.Width), 10),
		"--height",
		strconv.FormatUint(uint64(options.Profile.Height), 10),
		"--fps",
		strconv.FormatUint(uint64(options.Profile.Framerate), 10),
		"--bitrate",
		strconv.FormatUint(uint64(options.Profile.Bitrate), 10),
		"--preference",
		options.Profile.Preference,
		"--codec",
		options.Codec,
		"--protocol-v4",
	}, environment)
}

func StartAudio(parent context.Context, executable string, target CaptureTarget) (*Stream, error) {
	if !validCaptureTarget(target) {
		return nil, errors.New("native audio target is invalid")
	}
	return startAudioStream(parent, executable, []string{
		"--capture-audio",
		target.Kind,
		strconv.FormatUint(uint64(target.PID), 10),
		zeroWhenEmpty(target.CreationTime),
	})
}

func StartSystemAudio(parent context.Context, executable string) (*Stream, error) {
	return startAudioStream(parent, executable, []string{
		"--capture-audio", "display", "0", "0",
	})
}

func startAudioStream(parent context.Context, executable string, arguments []string) (*Stream, error) {
	if parent == nil {
		parent = context.Background()
	}
	stream, err := startStream(parent, executable, arguments)
	if err != nil {
		return nil, err
	}
	ready := make(chan error, 1)
	go func() {
		frame, readErr := stream.Read()
		if readErr != nil {
			ready <- errors.New("native audio capture did not become ready")
			return
		}
		ready <- validateAudioReadyFrame(frame)
	}()
	timer := time.NewTimer(probeTimeout)
	defer timer.Stop()
	select {
	case readyErr := <-ready:
		if readyErr == nil {
			return stream, nil
		}
		_ = stream.Close()
		return nil, readyErr
	case <-timer.C:
		_ = stream.Close()
		return nil, errors.New("native audio capture timed out during startup")
	case <-parent.Done():
		_ = stream.Close()
		return nil, parent.Err()
	}
}

func validCaptureTarget(target CaptureTarget) bool {
	if !positiveDecimal(target.SourceID) || len(target.Title) == 0 ||
		len(target.Title) > 4096 {
		return false
	}
	switch target.Kind {
	case "window":
		return target.PID > 0 && positiveDecimal(target.CreationTime)
	case "display":
		return target.PID == 0 && target.CreationTime == ""
	case "picker":
		return target.PID == 0 && target.CreationTime == ""
	default:
		return false
	}
}

func zeroWhenEmpty(value string) string {
	if value == "" {
		return "0"
	}
	return value
}

func validateAudioReadyFrame(frame Frame) error {
	var state audioCaptureState
	if frame.Kind != FrameStatus || decodeStrictJSON(frame.Data, &state) != nil ||
		state.State != "active" || !state.Audio {
		return errors.New("native audio capture returned an invalid ready state")
	}
	return nil
}

func positiveDecimal(value string) bool {
	if value == "" || len(value) > 20 || value[0] == '0' {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return false
		}
	}
	_, err := strconv.ParseUint(value, 10, 64)
	return err == nil
}

func startStream(parent context.Context, executable string, arguments []string) (*Stream, error) {
	return startStreamWithEnvironment(parent, executable, arguments, nil)
}

func startStreamWithEnvironment(
	parent context.Context,
	executable string,
	arguments []string,
	environment []string,
) (*Stream, error) {
	if parent == nil {
		parent = context.Background()
	}
	if executable == "" {
		return nil, errors.New("native capture process is unavailable")
	}
	ctx, cancel := context.WithCancel(parent)
	command := exec.CommandContext(ctx, executable, arguments...)
	if len(environment) > 0 {
		command.Env = append(os.Environ(), environment...)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stdin, err := command.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	command.Stderr = &boundedBuffer{limit: maxProbeErrorBytes}
	hideWindow(command)
	if err = command.Start(); err != nil {
		cancel()
		return nil, fmt.Errorf("start native capture process: %w", err)
	}
	stream := &Stream{
		cancel: cancel,
		input:  stdout,
		key:    stdin,
		done:   make(chan error, 1),
	}
	go func() {
		stream.done <- command.Wait()
		close(stream.done)
	}()
	return stream, nil
}

func (stream *Stream) Read() (Frame, error) {
	return readFrame(stream.input)
}

func (stream *Stream) RequestKeyFrame() error {
	_, err := stream.key.Write([]byte{'K'})
	return err
}

func (stream *Stream) Done() <-chan error {
	return stream.done
}

func (stream *Stream) Close() error {
	stream.closeOnce.Do(func() {
		_, _ = stream.key.Write([]byte{'Q'})
		_ = stream.key.Close()
	})
	select {
	case <-stream.done:
		stream.cancel()
		return nil
	case <-time.After(captureStopTimeout):
		stream.cancel()
		<-stream.done
		return nil
	}
}
