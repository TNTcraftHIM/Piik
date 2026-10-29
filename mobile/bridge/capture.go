// Package bridge binds mobile capture to Silip's existing native session.
package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"github.com/P4-aaaul/Silip/internal/app/nativeaudio"
	"github.com/P4-aaaul/Silip/internal/app/nativecapture"
	"github.com/P4-aaaul/Silip/internal/app/nativehost"
	"github.com/P4-aaaul/Silip/internal/media/encoded"
)

// Platform runs Platform-owned permission and codec work on its appropriate threads.
// Byte buffers are copied before returning from a platform callback.
type Platform interface {
	StartVideo(id int64, configuration string)
	PreparationDone(id int64)
	StartAudio(id int64)
	StartMicrophone(id int64, deviceID string)
	Microphones() (string, error)
	Control(id int64, command string, layer int64, value int64)
	Stop(id int64)
	SiteAccessChanged()
	RuntimeStopped(reason string)
}

type capture struct {
	platform    Platform
	multiOutput bool
	encoders    []encoderCapability
	mu          sync.Mutex
	next        int64
	streams     map[int64]*captureStream
}

type captureStream struct {
	owner         *capture
	id            int64
	ctx           context.Context
	cancel        context.CancelCauseFunc
	frames        chan nativecapture.Frame
	outputs       []nativecapture.OutputProfile
	once          sync.Once
	format        atomic.Uint64
	ready         chan struct{}
	readyOnce     sync.Once
	codec         atomic.Uint32
	requested     string
	videoMu       sync.Mutex
	inputPTS      time.Duration
	hasInput      bool
	firstInputPTS time.Duration
	inputReady    bool
}

func (c *capture) stream(ctx context.Context, outputs []nativecapture.OutputProfile) *captureStream {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.next++
	ctx, cancel := context.WithCancelCause(ctx)
	s := &captureStream{owner: c, id: c.next, ctx: ctx, cancel: cancel, frames: make(chan nativecapture.Frame, 8), outputs: outputs, ready: make(chan struct{})}
	c.streams[s.id] = s
	go func() { <-ctx.Done(); _ = s.Close() }()
	return s
}

func (c *capture) Video(ctx context.Context, options nativecapture.VideoOptions) (nativehost.CaptureStream, error) {
	available := false
	for _, encoder := range c.encoders {
		if options.Codec == "auto" || options.Codec == encoder.Codec {
			available = true
			break
		}
	}
	if !available {
		return nil, errors.New("requested mobile encoder is unavailable")
	}
	output := nativecapture.OutputProfile{Width: options.Profile.Width, Height: options.Profile.Height, Framerate: options.Profile.Framerate, Bitrate: options.Profile.Bitrate}
	outputs := []nativecapture.OutputProfile{output}
	if c.multiOutput {
		outputs = nativecapture.ScreenShareOutputs(options.Profile)
		for range options.OutputGroups {
			outputs = append(outputs, outputs[0])
		}
	}
	s := c.stream(ctx, outputs)
	s.requested = options.Codec
	configuration, _ := json.Marshal(struct {
		nativecapture.OutputProfile
		Codec   string                        `json:"codec"`
		Outputs []nativecapture.OutputProfile `json:"outputs,omitempty"`
	}{output, options.Codec, outputs})
	c.platform.StartVideo(s.id, string(configuration))
	return s, nil
}

func (c *capture) Audio(ctx context.Context, _ nativecapture.CaptureTarget, excluded *nativecapture.CaptureTarget) (nativehost.CaptureStream, error) {
	if excluded != nil {
		return nil, errors.New("mobile source exclusion is unavailable")
	}
	s := c.stream(ctx, nil)
	c.platform.StartAudio(s.id)
	select {
	case <-s.ctx.Done():
		return nil, errors.New("mobile playback audio is unavailable")
	case <-s.ready:
		return s, nil
	}
}
func (c *capture) Microphone(ctx context.Context, device string) (nativehost.CaptureStream, error) {
	s := c.stream(ctx, nil)
	c.platform.StartMicrophone(s.id, device)
	select {
	case <-s.ctx.Done():
		return nil, errors.New("mobile commentary microphone is unavailable")
	case <-s.ready:
		return s, nil
	}
}
func (c *capture) ListSources(context.Context) ([]nativecapture.CaptureTarget, error) {
	return []nativecapture.CaptureTarget{{Kind: "picker", SourceID: "1", Title: "Screen"}}, nil
}
func (c *capture) PreviewSource(context.Context, nativecapture.CaptureTarget) ([]byte, error) {
	return nil, errors.New("mobile screen preview is unavailable before system consent")
}
func (c *capture) ListMicrophones(context.Context) ([]nativecapture.Microphone, error) {
	payload, err := c.platform.Microphones()
	if err != nil {
		return nil, err
	}
	var devices []nativecapture.Microphone
	if json.Unmarshal([]byte(payload), &devices) != nil || devices == nil || len(devices) > 64 {
		return nil, errors.New("mobile microphone list is invalid")
	}
	for _, device := range devices {
		if device.ID == "" || !nativecapture.ValidDeviceID(device.ID) || device.Label == "" || len(device.Label) > 512 {
			return nil, errors.New("mobile microphone identity is invalid")
		}
	}
	return devices, nil
}

func (s *captureStream) Read() (nativecapture.Frame, error) {
	select {
	case <-s.ctx.Done():
		if errors.Is(context.Cause(s.ctx), nativecapture.ErrSourceCanceled) {
			return nativecapture.Frame{}, nativecapture.ErrSourceCanceled
		}
		return nativecapture.Frame{}, io.EOF
	case frame := <-s.frames:
		return frame, nil
	}
}
func (s *captureStream) Outputs() []nativecapture.OutputProfile {
	return append([]nativecapture.OutputProfile(nil), s.outputs...)
}
func (s *captureStream) PreparationDone() {
	s.owner.platform.PreparationDone(s.id)
}

func (s *captureStream) Close() error {
	s.once.Do(func() {
		s.cancel(nil)
		s.owner.mu.Lock()
		delete(s.owner.streams, s.id)
		s.owner.mu.Unlock()
		s.owner.platform.Stop(s.id)
	})
	return nil
}
func (s *captureStream) RequestKeyFrame(layer int) error {
	s.owner.platform.Control(s.id, "keyframe", int64(layer), 0)
	return nil
}
func (s *captureStream) SetOutputActive(layer int, active bool) error {
	value := int64(0)
	if active {
		value = 1
	}
	s.owner.platform.Control(s.id, "active", int64(layer), value)
	return nil
}
func (s *captureStream) SetOutputBitrate(layer int, bitrate uint32) error {
	s.owner.platform.Control(s.id, "bitrate", int64(layer), int64(bitrate))
	return nil
}

func (c *capture) get(id int64) *captureStream {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.streams[id]
}

func (r *Runtime) CaptureCurrent(id int64) bool { return r.capture.get(id) != nil }
func (s *captureStream) push(frame nativecapture.Frame) bool {
	select {
	case <-s.ctx.Done():
		return false
	case s.frames <- frame:
		return true
	}
}

// VideoReady publishes actual encoder dimensions and profile, not requested capability.
func (r *Runtime) VideoReady(id int64, codec string, width, height int64, profile string) bool {
	s := r.capture.get(id)
	if s == nil || len(s.outputs) == 0 {
		return false
	}
	if (codec != "h264" && codec != "vp8") || (s.requested != "auto" && s.requested != codec) {
		s.Close()
		return false
	}
	kind := uint32(1)
	if codec == "vp8" {
		kind = 2
	}
	if previous := s.codec.Load(); previous != 0 && previous != kind {
		s.Close()
		return false
	}
	// An incompatible prepared encoder has not committed any state. The platform
	// can try another candidate or restore the existing source on this stream.
	if width < 2 || height < 2 || width > int64(s.outputs[min(1, len(s.outputs)-1)].Width) || height > int64(s.outputs[min(1, len(s.outputs)-1)].Height) || !nativecapture.ValidVideoSize(uint32(width), uint32(height)) || (codec == "h264" && !nativecapture.SupportedH264ProfileLevelID(profile)) || (codec == "vp8" && profile != "") {
		return false
	}
	s.codec.Store(kind)
	s.format.Store(uint64(width)<<32 | uint64(height))
	state := nativehost.CaptureState{State: "active", HardwareOnly: codec == "h264", Codec: codec, Width: uint32(width), Height: uint32(height), FPS: s.outputs[min(1, len(s.outputs)-1)].Framerate, ProfileLevelID: profile, Outputs: s.outputs}
	data, _ := json.Marshal(state)
	s.videoMu.Lock()
	defer s.videoMu.Unlock()
	if !s.push(nativecapture.Frame{Kind: nativecapture.FrameStatus, Data: data}) {
		return false
	}
	if !s.inputReady {
		s.inputReady = true
		if s.hasInput {
			if !s.push(nativecapture.Frame{Kind: nativecapture.FrameBegin, Timestamp: s.firstInputPTS}) {
				return false
			}
			if s.inputPTS > s.firstInputPTS {
				return s.push(nativecapture.Frame{Kind: nativecapture.FrameBegin, Timestamp: s.inputPTS})
			}
		}
	}
	return true
}

// Video accepts a complete codec access unit; AVC recovery includes SPS/PPS.
func (r *Runtime) Video(id int64, data []byte, ptsMicros, durationMicros int64, key bool) {
	s := r.capture.get(id)
	if s == nil {
		return
	}
	format := s.format.Load()
	if format == 0 || len(data) == 0 || len(data) > encoded.MaxAccessUnitBytes || ptsMicros < 0 || durationMicros <= 0 {
		s.Close()
		return
	}
	r.VideoInput(id, ptsMicros)
	r.VideoLayer(id, int64(min(1, len(s.outputs)-1)), data, ptsMicros, durationMicros, int64(format>>32), int64(uint32(format)), key)
}

// VideoLayerReady admits optional encoders without replacing capture authority.
func (r *Runtime) VideoLayerReady(id, layer int64, codec string, width, height int64, profile string) bool {
	s := r.capture.get(id)
	if s == nil || layer < 0 || layer >= int64(len(s.outputs)) || s.format.Load() == 0 {
		return false
	}
	if (s.codec.Load() == 1 && codec != "h264") || (s.codec.Load() == 2 && codec != "vp8") {
		return false
	}
	output := s.outputs[layer]
	return width >= 2 && height >= 2 && width <= int64(output.Width) && height <= int64(output.Height) && nativecapture.ValidVideoSize(uint32(width), uint32(height)) && ((codec == "h264" && nativecapture.SupportedH264ProfileLevelID(profile)) || (codec == "vp8" && profile == ""))
}

// VideoInput advances the single capture-image clock before encoder submission.
func (r *Runtime) VideoInput(id, ptsMicros int64) {
	s := r.capture.get(id)
	if s == nil || ptsMicros < 0 {
		return
	}
	s.videoMu.Lock()
	defer s.videoMu.Unlock()
	pts := time.Duration(ptsMicros) * time.Microsecond
	if s.hasInput && pts <= s.inputPTS {
		return
	}
	if !s.hasInput {
		s.firstInputPTS = pts
	}
	s.hasInput, s.inputPTS = true, pts
	if s.inputReady {
		s.push(nativecapture.Frame{Kind: nativecapture.FrameBegin, Timestamp: pts})
	}
}

// VideoLayer preserves one capture timeline across independently completing encoders.
func (r *Runtime) VideoLayer(id, layer int64, data []byte, ptsMicros, durationMicros, width, height int64, key bool) {
	s := r.capture.get(id)
	if s == nil {
		return
	}
	if layer < 0 || layer >= int64(len(s.outputs)) || s.format.Load() == 0 || len(data) == 0 || len(data) > encoded.MaxAccessUnitBytes || ptsMicros < 0 || durationMicros <= 0 || width < 2 || height < 2 || width > int64(s.outputs[layer].Width) || height > int64(s.outputs[layer].Height) || !nativecapture.ValidVideoSize(uint32(width), uint32(height)) {
		s.Close()
		return
	}
	s.videoMu.Lock()
	defer s.videoMu.Unlock()
	pts := time.Duration(ptsMicros) * time.Microsecond
	kind := nativecapture.FrameH264
	if s.codec.Load() == 2 {
		kind = nativecapture.FrameVP8
	}
	s.push(nativecapture.Frame{Kind: kind, Layer: int(layer), Width: uint32(width), Height: uint32(height), Data: append([]byte(nil), data...), Timestamp: pts, Duration: time.Duration(durationMicros) * time.Microsecond, KeyFrame: key})
}

// VideoLayerUnavailable retires optional output demand through the shared planner.
func (r *Runtime) VideoLayerUnavailable(id, layer int64) {
	s := r.capture.get(id)
	if s == nil || layer < 0 || layer >= int64(len(s.outputs)) {
		return
	}
	if layer == int64(min(1, len(s.outputs)-1)) {
		s.Close()
		return
	}
	s.push(nativecapture.Frame{Kind: nativecapture.FrameLayerUnavailable, Layer: int(layer)})
}

func (r *Runtime) Audio(id int64, data []byte) {
	s := r.capture.get(id)
	if s != nil {
		if len(data) != nativeaudio.FrameBytes {
			s.Close()
			return
		}
		s.push(nativecapture.Frame{Kind: nativecapture.FramePCM, Data: append([]byte(nil), data...), Duration: 20 * time.Millisecond})
	}
}
func (r *Runtime) AudioReady(id int64) {
	if s := r.capture.get(id); s != nil {
		s.readyOnce.Do(func() { close(s.ready) })
	}
}

// CaptureCanceled is only for an explicit dismissal of system source selection.
func (r *Runtime) CaptureCanceled(id int64) {
	if s := r.capture.get(id); s != nil {
		s.cancel(nativecapture.ErrSourceCanceled)
		_ = s.Close()
	}
}

func (r *Runtime) CaptureEnded(id int64) {
	if s := r.capture.get(id); s != nil {
		_ = s.Close()
	}
}
