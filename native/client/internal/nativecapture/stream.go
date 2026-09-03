package nativecapture

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"sync"
	"time"
)

const captureStopTimeout = time.Second

type WindowTarget struct {
	WindowHandle string `json:"windowHandle"`
	PID          uint32 `json:"pid"`
	CreationTime string `json:"creationTime"`
	Title        string `json:"title"`
}

type VideoOptions struct {
	Target       WindowTarget
	AdapterIndex uint32
	EncoderIndex uint32
}

type Stream struct {
	cancel context.CancelFunc
	input  io.ReadCloser
	key    io.WriteCloser
	done   chan error

	closeOnce sync.Once
}

func ListWindows(parent context.Context, executable string) ([]WindowTarget, error) {
	ctx, cancel := context.WithTimeout(parent, probeTimeout)
	defer cancel()
	stdout := &boundedBuffer{limit: maxProbeOutputBytes}
	command := exec.CommandContext(ctx, executable, "--list")
	command.Stdout = stdout
	command.Stderr = &boundedBuffer{limit: maxProbeErrorBytes}
	hideWindow(command)
	if err := command.Run(); err != nil {
		return nil, errors.New("native window list is unavailable")
	}
	var targets []WindowTarget
	if err := decodeStrictJSON(stdout.Bytes(), &targets); err != nil || len(targets) > 1024 {
		return nil, errors.New("native window list is invalid")
	}
	for _, target := range targets {
		if !positiveDecimal(target.WindowHandle) || target.PID == 0 ||
			!positiveDecimal(target.CreationTime) ||
			len(target.Title) == 0 || len(target.Title) > 4096 {
			return nil, errors.New("native window target is invalid")
		}
	}
	return targets, nil
}

func StartVideo(parent context.Context, executable string, options VideoOptions) (*Stream, error) {
	if !positiveDecimal(options.Target.WindowHandle) || options.Target.PID == 0 ||
		!positiveDecimal(options.Target.CreationTime) {
		return nil, errors.New("native video target is invalid")
	}
	return startStream(parent, executable, []string{
		"--capture-video",
		strconv.FormatUint(uint64(options.Target.PID), 10),
		options.Target.CreationTime,
		options.Target.WindowHandle,
		"--adapter-index",
		strconv.FormatUint(uint64(options.AdapterIndex), 10),
		"--mft-index",
		strconv.FormatUint(uint64(options.EncoderIndex), 10),
		"--protocol-v2",
	})
}

func StartAudio(parent context.Context, executable string, target WindowTarget) (*Stream, error) {
	if target.PID == 0 || !positiveDecimal(target.CreationTime) {
		return nil, errors.New("native audio target is invalid")
	}
	return startStream(parent, executable, []string{
		"--capture-audio",
		strconv.FormatUint(uint64(target.PID), 10),
		target.CreationTime,
	})
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
	if parent == nil {
		parent = context.Background()
	}
	if executable == "" {
		return nil, errors.New("native capture process is unavailable")
	}
	ctx, cancel := context.WithCancel(parent)
	command := exec.CommandContext(ctx, executable, arguments...)
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
