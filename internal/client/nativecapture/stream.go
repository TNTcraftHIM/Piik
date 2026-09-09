package nativecapture

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/TNTcraftHIM/Screener/internal/diagnostics"
)

const (
	captureStopTimeout = time.Second
	maxPreviewBytes    = 192 * 1024
	maxOutputs         = 6
	minOutputBitrate   = 1_000 // Codec rate APIs use whole kbps.
	maxOutputBitrate   = 12_000_000
)

var (
	captureStageCode = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)
	captureHRESULT   = regexp.MustCompile(`^0x[0-9a-fA-F]{8}$`)
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
	OutputGroups int
}

type EncodedVideoOptions struct {
	Codec        string
	AdapterIndex uint32
	EncoderIndex uint32
	Preference   string
	Outputs      []OutputProfile
}

type VideoProfile struct {
	Width      uint32
	Height     uint32
	Framerate  uint32
	Bitrate    uint32
	Preference string
}

// OutputProfile describes one codec output, not a selectable product preset.
type OutputProfile struct {
	Width     uint32 `json:"width"`
	Height    uint32 `json:"height"`
	Framerate uint32 `json:"fps"`
	Bitrate   uint32 `json:"bitrate"`
}

func (profile OutputProfile) Valid() bool {
	return profile.Width >= 2 && profile.Width <= 2560 && profile.Width%2 == 0 &&
		profile.Height >= 2 && profile.Height <= 1440 && profile.Height%2 == 0 &&
		profile.Framerate >= 1 && profile.Framerate <= 60 &&
		profile.Bitrate >= minOutputBitrate && profile.Bitrate <= maxOutputBitrate
}

// ScreenShareOutputs follows LiveKit 2.22.1's screen-share simulcast construction,
// with even derived dimensions for NV12. The source profile has already passed Valid.
func ScreenShareOutputs(profile VideoProfile) []OutputProfile {
	return []OutputProfile{
		{
			Width: profile.Width / 4 * 2, Height: profile.Height / 4 * 2,
			Framerate: profile.Framerate, Bitrate: max(150_000, profile.Bitrate/4),
		},
		{
			Width: profile.Width, Height: profile.Height,
			Framerate: profile.Framerate, Bitrate: profile.Bitrate,
		},
	}
}

func (profile VideoProfile) Valid() bool {
	validResolution :=
		(profile.Width == 854 && profile.Height == 480) ||
			(profile.Width == 1280 && profile.Height == 720) ||
			(profile.Width == 1920 && profile.Height == 1080) ||
			(profile.Width == 2560 && profile.Height == 1440)
	return validResolution && profile.Framerate >= 15 && profile.Framerate <= 60 &&
		profile.Bitrate >= 2_000_000 && profile.Bitrate <= 12_000_000 &&
		validVideoPreference(profile.Preference)
}

func validVideoPreference(preference string) bool {
	return preference == "maintain-resolution" || preference == "balanced" || preference == "maintain-framerate"
}

type Stream struct {
	cancel context.CancelFunc
	input  io.ReadCloser
	key    io.WriteCloser
	done   chan error

	outputs   []OutputProfile
	active    [maxOutputs]bool
	bitrates  [maxOutputs]uint32
	controlMu sync.Mutex
	closed    bool
	closeOnce sync.Once
	readEnd   sync.Once
	logger    *slog.Logger
	ctx       context.Context
}

func ListSources(parent context.Context, executable string) ([]CaptureTarget, error) {
	ctx, cancel := context.WithTimeout(parent, probeTimeout)
	defer cancel()
	stdout := &boundedBuffer{limit: maxProbeOutputBytes}
	command := exec.CommandContext(ctx, executable, "--list")
	command.Stdout = stdout
	stderr := diagnostics.Writer("native-source-list")
	defer stderr.Close()
	command.Stderr = stderr
	hideWindow(command)
	if err := command.Run(); err != nil {
		slog.DebugContext(ctx, "screener-client", "event", "capture-source-list-failed", diagnostics.Error(err), "canceled", ctx.Err() != nil)
		return nil, errors.New("native capture source list is unavailable")
	}
	var targets []CaptureTarget
	if err := decodeStrictJSON(stdout.Bytes(), &targets); err != nil || len(targets) > 1024 {
		return nil, errors.New("native capture source list is invalid")
	}
	for _, target := range targets {
		if !target.Valid() {
			return nil, errors.New("native capture target is invalid")
		}
	}
	return targets, nil
}

func PreviewSource(parent context.Context, executable string, target CaptureTarget) ([]byte, error) {
	if !target.Valid() {
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
	stderr := diagnostics.Writer("native-source-preview")
	defer stderr.Close()
	command.Stderr = stderr
	hideWindow(command)
	if err := command.Run(); err != nil {
		slog.DebugContext(ctx, "screener-client", "event", "capture-source-preview-failed", diagnostics.Error(err), "canceled", ctx.Err() != nil)
		return nil, errors.New("native capture preview is unavailable")
	}
	preview := stdout.Bytes()
	if len(preview) < 54 || preview[0] != 'B' || preview[1] != 'M' {
		return nil, errors.New("native capture preview is invalid")
	}
	return append([]byte(nil), preview...), nil
}

func StartVideo(parent context.Context, executable string, options VideoOptions) (*Stream, error) {
	if !options.Target.Valid() || !options.Profile.Valid() ||
		(options.Codec != "auto" && options.Codec != "h264" && options.Codec != "vp8") ||
		options.OutputGroups < 0 || options.OutputGroups > maxOutputs-2 ||
		len(options.RestoreToken) > 4096 || !utf8.ValidString(options.RestoreToken) ||
		strings.ContainsRune(options.RestoreToken, 0) {
		return nil, errors.New("native video target is invalid")
	}
	environment := []string(nil)
	if options.RestoreToken != "" {
		environment = []string{"SCREENER_XDP_RESTORE_TOKEN=" + options.RestoreToken}
	}
	arguments := []string{
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
		"--protocol-v7",
	}
	outputs := ScreenShareOutputs(options.Profile)
	for range options.OutputGroups {
		outputs = append(outputs, outputs[0])
	}
	arguments, err := appendOutputArguments(arguments, outputs)
	if err != nil {
		return nil, err
	}
	stream, err := startStreamWithEnvironment(parent, executable, arguments, environment)
	if err != nil {
		return nil, err
	}
	stream.outputs = outputs
	stream.active[0], stream.active[1] = true, true
	return stream, nil
}

func StartEncodedVideo(parent context.Context, executable string, options EncodedVideoOptions) (*Stream, error) {
	if (options.Codec != "h264" && options.Codec != "vp8") || !validVideoPreference(options.Preference) {
		return nil, errors.New("native encoded video options are invalid")
	}
	arguments, err := appendOutputArguments([]string{
		"--encoded-video", "--codec", options.Codec,
		"--adapter-index", strconv.FormatUint(uint64(options.AdapterIndex), 10),
		"--mft-index", strconv.FormatUint(uint64(options.EncoderIndex), 10),
		"--preference", options.Preference, "--protocol-v7",
	}, options.Outputs)
	if err != nil {
		return nil, err
	}
	stream, err := startStream(parent, executable, arguments)
	if err != nil {
		return nil, err
	}
	stream.outputs = append([]OutputProfile(nil), options.Outputs...)
	return stream, nil
}

func appendOutputArguments(arguments []string, outputs []OutputProfile) ([]string, error) {
	if len(outputs) < 1 || len(outputs) > maxOutputs {
		return nil, errors.New("native output count is invalid")
	}
	for _, output := range outputs {
		if !output.Valid() {
			return nil, errors.New("native output profile is invalid")
		}
		arguments = append(arguments, "--output", strconv.FormatUint(uint64(output.Width), 10),
			strconv.FormatUint(uint64(output.Height), 10), strconv.FormatUint(uint64(output.Framerate), 10), strconv.FormatUint(uint64(output.Bitrate), 10))
	}
	return arguments, nil
}

func StartAudio(parent context.Context, executable string, target CaptureTarget) (*Stream, error) {
	if !target.Valid() {
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

func (target CaptureTarget) Valid() bool {
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
	started := time.Now()
	// A diagnostic-only process label correlates stderr while old/new captures overlap.
	captureID := strconv.FormatInt(started.UnixNano(), 36)
	logger := slog.Default().With("capture", captureID)
	command := exec.CommandContext(ctx, executable, arguments...)
	if logger.Enabled(ctx, slog.LevelDebug) {
		environment = append(environment, "SCREENER_CAPTURE_DEBUG=1")
	}
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
	stderr := &boundedBuffer{limit: maxProbeErrorBytes, discardOverflow: true}
	trace := diagnostics.Writer("native-capture/" + captureID)
	command.Stderr = io.MultiWriter(stderr, trace)
	hideWindow(command)
	if err = command.Start(); err != nil {
		_ = trace.Close()
		cancel()
		logger.DebugContext(ctx, "screener-client", "event", "capture-process-start-failed", diagnostics.Error(err))
		return nil, fmt.Errorf("start native capture process: %w", err)
	}
	logger = logger.With("pid", command.Process.Pid)
	mode := "capture"
	if len(arguments) > 0 {
		switch arguments[0] {
		case "--capture-video", "--capture-audio", "--encoded-video":
			mode = strings.TrimPrefix(arguments[0], "--")
		}
	}
	logger.DebugContext(ctx, "screener-client", "event", "capture-process-started", "mode", mode)
	stream := &Stream{
		cancel: cancel,
		input:  stdout,
		key:    stdin,
		done:   make(chan error, 1),
		logger: logger,
		ctx:    ctx,
	}
	go func() {
		waitErr := command.Wait()
		_ = trace.Close()
		logCaptureFailure(ctx, waitErr, command.ProcessState.ExitCode(), stderr.Bytes())
		logger.DebugContext(ctx, "screener-client", "event", "capture-process-ended", "mode", mode,
			"durationMs", time.Since(started).Milliseconds(), "exitCode", command.ProcessState.ExitCode(),
			"canceled", ctx.Err() != nil, "cancelReason", diagnostics.SafeText(fmt.Sprint(context.Cause(ctx))), diagnostics.Error(waitErr))
		stream.done <- waitErr
		close(stream.done)
	}()
	return stream, nil
}

func logCaptureFailure(ctx context.Context, err error, exitCode int, stderr []byte) {
	if err == nil || !slog.Default().Enabled(ctx, slog.LevelDebug) {
		return
	}
	stage, hresult := "", ""
	for _, line := range strings.Split(string(stderr), "\n") {
		key, value, _ := strings.Cut(strings.TrimSuffix(line, "\r"), "=")
		switch {
		case key == "stage" && stage == "" && captureStageCode.MatchString(value):
			stage = value
		case key == "hresult" && hresult == "" && captureHRESULT.MatchString(value):
			hresult = strings.ToLower(value)
		}
	}
	canceled := ctx.Err() != nil
	// A real child failure may race owner cancellation. Keep its fixed codes,
	// while ordinary cancellation without a reported failure stays silent.
	if canceled && stage == "" && hresult == "" {
		return
	}
	slog.DebugContext(ctx, "screener-client", "event", "capture-process-failed",
		"exitCode", exitCode, "stage", stage, "hresult", hresult, "canceled", canceled)
}

func (stream *Stream) Read() (Frame, error) {
	frame, err := readFrame(stream.input)
	if err != nil && stream.logger != nil {
		stream.readEnd.Do(func() {
			stream.logger.DebugContext(stream.ctx, "screener-client", "event", "capture-stream-ended",
				"eof", errors.Is(err, io.EOF), "canceled", stream.ctx.Err() != nil, diagnostics.Error(err))
		})
	}
	return frame, err
}

// WriteFrame shares the existing stdin lock with control. Only encoded video
// crosses this input boundary; capture status and PCM remain producer outputs.
func (stream *Stream) WriteFrame(frame Frame) error {
	if frame.Kind != FrameH264 && frame.Kind != FrameVP8 {
		return errors.New("native encoded input is not video")
	}
	stream.controlMu.Lock()
	defer stream.controlMu.Unlock()
	if stream.closed {
		return io.ErrClosedPipe
	}
	return writeFrame(stream.key, frame)
}

func (stream *Stream) Outputs() []OutputProfile {
	return append([]OutputProfile(nil), stream.outputs...)
}

func (stream *Stream) RequestKeyFrame(layer int) error {
	if layer < -1 || layer >= len(stream.outputs) || len(stream.outputs) == 0 {
		return errors.New("native recovery output is invalid")
	}
	return stream.writeControl("K " + strconv.Itoa(layer))
}

func (stream *Stream) SetOutputActive(layer int, active bool) error {
	if layer < 0 || layer >= len(stream.outputs) {
		return errors.New("native active output is invalid")
	}
	stream.controlMu.Lock()
	defer stream.controlMu.Unlock()
	if stream.closed {
		return io.ErrClosedPipe
	}
	if stream.active[layer] == active {
		return nil
	}
	value := "0"
	if active {
		value = "1"
	}
	if err := stream.writeControlLocked("A " + strconv.Itoa(layer) + " " + value); err != nil {
		return err
	}
	stream.active[layer] = active
	return nil
}

func (stream *Stream) SetOutputBitrate(layer int, bitrate uint32) error {
	if layer < 0 || layer >= len(stream.outputs) || bitrate < minOutputBitrate || bitrate > stream.outputs[layer].Bitrate {
		return errors.New("native output bitrate is invalid")
	}
	stream.controlMu.Lock()
	defer stream.controlMu.Unlock()
	if stream.closed {
		return io.ErrClosedPipe
	}
	if stream.bitrates[layer] == bitrate {
		return nil
	}
	if err := stream.writeControlLocked("B " + strconv.Itoa(layer) + " " + strconv.FormatUint(uint64(bitrate), 10)); err != nil {
		return err
	}
	stream.bitrates[layer] = bitrate
	return nil
}

func (stream *Stream) writeControl(command string) error {
	stream.controlMu.Lock()
	defer stream.controlMu.Unlock()
	return stream.writeControlLocked(command)
}

func (stream *Stream) writeControlLocked(command string) error {
	if stream.closed {
		return io.ErrClosedPipe
	}
	return writeFrame(stream.key, Frame{Kind: FrameControl, Data: []byte(command)})
}

func (stream *Stream) Done() <-chan error {
	return stream.done
}

func (stream *Stream) Close() error {
	// Start the existing stop budget before waiting for a possibly blocked control write.
	timer := time.AfterFunc(captureStopTimeout, stream.cancel)
	defer timer.Stop()
	stream.closeOnce.Do(func() {
		stream.controlMu.Lock()
		defer stream.controlMu.Unlock()
		stream.closed = true
		_ = writeFrame(stream.key, Frame{Kind: FrameControl, Data: []byte("Q")})
		_ = stream.key.Close()
	})
	<-stream.done
	stream.cancel()
	return nil
}
