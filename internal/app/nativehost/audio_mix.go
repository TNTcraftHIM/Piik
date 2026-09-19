package nativehost

import (
	"context"
	"encoding/binary"
	"errors"
	"log/slog"
	"math"
	"sync"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/app/mediaedge"
	"github.com/TNTcraftHIM/Piik/internal/app/nativeaudio"
	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/TNTcraftHIM/Piik/internal/diagnostics"
)

const audioPeriod = 20 * time.Millisecond

// Each device is resampled by the platform to PCM48 stereo. This bounded FIFO
// absorbs scheduling jitter; it never replays samples or builds a latency tail.
// It does not claim to eliminate long-term drift between hardware clocks.
type audioInput struct {
	stream *nativecapture.Stream
	frames [][]byte
}

func (input *audioInput) push(frame []byte) {
	if len(input.frames) == 4 {
		input.frames = input.frames[1:]
	}
	input.frames = append(input.frames, frame)
}

func (input *audioInput) pop() []byte {
	if input == nil || len(input.frames) == 0 {
		return nil
	}
	frame := input.frames[0]
	input.frames[0] = nil
	input.frames = input.frames[1:]
	return frame
}

// One share owns one output/encoder. Replacing an input never replaces that
// output. The session owns source capture; this owner owns microphone capture.
type audioMix struct {
	ctx     context.Context
	output  *mediaedge.AudioSource
	emit    func(Event)
	shareID string
	mu      sync.Mutex
	// State delivery is ordered, but backpressure never holds the audio lock.
	eventMu            sync.Mutex
	readers            sync.WaitGroup
	source, microphone *audioInput
	paused             bool
	gain, appliedGain  float64
	microphoneDevice   string
}

func (mix *audioMix) stateLocked(failed bool) Event {
	return Event{Type: "audio-state", ShareID: mix.shareID,
		SourceAudio: mix.source != nil, Microphone: mix.microphone != nil, Failed: failed}
}

func (mix *audioMix) setSource(stream *nativecapture.Stream) {
	mix.eventMu.Lock()
	defer mix.eventMu.Unlock()
	mix.mu.Lock()
	if mix.ctx.Err() != nil {
		mix.mu.Unlock()
		return
	}
	mix.source = nil
	if stream != nil {
		mix.source = &audioInput{stream: stream}
		mix.readers.Add(1)
		go mix.read(mix.source, false)
	}
	state := mix.stateLocked(false)
	mix.mu.Unlock()
	mix.emit(state)
}

func (mix *audioMix) read(input *audioInput, microphone bool) {
	defer mix.readers.Done()
	for {
		frame, err := input.stream.Read()
		mix.mu.Lock()
		current := mix.source
		if microphone {
			current = mix.microphone
		}
		if current != input || mix.ctx.Err() != nil {
			mix.mu.Unlock()
			return
		}
		if err != nil || frame.Kind != nativecapture.FramePCM || len(frame.Data) != nativeaudio.FrameBytes || frame.Duration != audioPeriod {
			mix.mu.Unlock()
			mix.inputEnded(input, microphone)
			slog.DebugContext(mix.ctx, "piik-client", "event", "audio-input-ended", "microphone", microphone, diagnostics.Error(err))
			_ = input.stream.Close()
			return
		}
		if !mix.paused {
			input.push(frame.Data)
		}
		mix.mu.Unlock()
	}
}

func (mix *audioMix) setPaused(paused bool) {
	mix.mu.Lock()
	defer mix.mu.Unlock()
	mix.paused = paused
	for _, input := range []*audioInput{mix.source, mix.microphone} {
		if input != nil {
			input.frames = nil
		}
	}
	// Never carry a pre-pause ramp into the resumed share.
	mix.appliedGain = 0
}

func (mix *audioMix) inputEnded(input *audioInput, microphone bool) {
	mix.eventMu.Lock()
	defer mix.eventMu.Unlock()
	mix.mu.Lock()
	current := mix.source
	if microphone {
		current = mix.microphone
	}
	if current != input || mix.ctx.Err() != nil {
		mix.mu.Unlock()
		return
	}
	if microphone {
		mix.microphone = nil
	} else {
		mix.source = nil
	}
	state := mix.stateLocked(microphone)
	mix.mu.Unlock()
	mix.emit(state)
}

func (mix *audioMix) setMicrophone(executable string, enabled *bool, gain *float64, deviceID *string) error {
	if deviceID != nil && !nativecapture.ValidDeviceID(*deviceID) {
		return errors.New("microphone device is invalid")
	}
	if gain != nil && (math.IsNaN(*gain) || math.IsInf(*gain, 0) || *gain < 0 || *gain > 2) {
		return errors.New("microphone volume is invalid")
	}
	mix.mu.Lock()
	if gain != nil {
		mix.gain = *gain
	}
	wanted := mix.microphone != nil
	if enabled != nil {
		wanted = *enabled
	}
	device := mix.microphoneDevice
	if deviceID != nil {
		device = *deviceID
	}
	unchanged := wanted == (mix.microphone != nil) && device == mix.microphoneDevice
	mix.mu.Unlock()
	if unchanged {
		return nil
	}
	var stream *nativecapture.Stream
	if wanted {
		var err error
		stream, err = nativecapture.StartMicrophone(mix.ctx, executable, device)
		if err != nil {
			return err
		}
	}
	mix.eventMu.Lock()
	defer mix.eventMu.Unlock()
	mix.mu.Lock()
	if mix.ctx.Err() != nil {
		mix.mu.Unlock()
		if stream != nil {
			_ = stream.Close()
		}
		return mix.ctx.Err()
	}
	previous := mix.microphone
	mix.microphoneDevice = device
	mix.microphone = nil
	if stream != nil {
		mix.microphone = &audioInput{stream: stream}
		mix.readers.Add(1)
		go mix.read(mix.microphone, true)
	}
	state := mix.stateLocked(false)
	mix.mu.Unlock()
	if previous != nil {
		_ = previous.stream.Close()
	}
	mix.emit(state)
	return nil
}

func (mix *audioMix) run() {
	ticker := time.NewTicker(audioPeriod)
	defer ticker.Stop()
	var output [nativeaudio.FrameBytes]byte
	previous := time.Now()
	for {
		select {
		case now := <-ticker.C:
			// Pion advances RTP time across missed ticks; do not burst old speech.
			dropped := uint16(min(max(int(now.Sub(previous)/audioPeriod)-1, 0), 65535))
			previous = now
			mix.mu.Lock()
			source, microphone := mix.source.pop(), mix.microphone.pop()
			gain := mix.gain
			if microphone == nil {
				gain = 0
			}
			mixPCM(output[:], source, microphone, mix.appliedGain, gain)
			mix.appliedGain = gain
			if mix.paused {
				clear(output[:])
			}
			// A retired edge cannot end healthy sibling media.
			_ = mix.output.WritePCMWithDropped(output[:], audioPeriod, dropped)
			mix.mu.Unlock()
		case <-mix.ctx.Done():
			mix.mu.Lock()
			microphone := mix.microphone
			mix.microphone = nil
			mix.mu.Unlock()
			if microphone != nil {
				_ = microphone.stream.Close()
			}
			mix.readers.Wait() // Session cancellation/retirement also closes source.
			return
		}
	}
}

// Mix once in a wider type, then saturate. Never attenuate source sound just
// because the microphone was enabled. Gain changes span a frame, not a sample.
func mixPCM(output, source, microphone []byte, from, to float64) {
	for sample := range nativeaudio.FrameSamples {
		gain := from + (to-from)*float64(sample+1)/nativeaudio.FrameSamples
		for channel := range nativeaudio.Channels {
			offset := (sample*nativeaudio.Channels + channel) * 2
			value := 0.0
			if source != nil {
				value = float64(int16(binary.LittleEndian.Uint16(source[offset:])))
			}
			if microphone != nil {
				value += gain * float64(int16(binary.LittleEndian.Uint16(microphone[offset:])))
			}
			binary.LittleEndian.PutUint16(output[offset:], uint16(int16(max(-32768, min(32767, value)))))
		}
	}
}
