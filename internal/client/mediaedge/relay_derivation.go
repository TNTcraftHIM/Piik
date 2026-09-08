package mediaedge

import (
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"github.com/TNTcraftHIM/Screener/internal/client/nativecapture"
	"github.com/TNTcraftHIM/Screener/internal/media/encoded"
	"github.com/TNTcraftHIM/Screener/internal/media/forwarding"
	"github.com/livekit/mediatransportutil/pkg/utils"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

const relayPacketLimit = 500 // Same retained-packet bound as the native forwarding source.

type RelayOptions struct {
	CaptureProcess string
	Capabilities   nativecapture.Capabilities
}

func relayBackend(codec string, options *RelayOptions) (nativecapture.EncodedVideoOptions, bool) {
	backend := nativecapture.EncodedVideoOptions{Codec: codec}
	if options == nil || options.CaptureProcess == "" {
		return backend, false
	}
	for _, adapter := range options.Capabilities.Adapters {
		if codec == "vp8" && options.Capabilities.SoftwareVP8 {
			backend.AdapterIndex = adapter.Index
			return backend, true
		}
		if codec == "h264" && len(adapter.HardwareH264) > 0 {
			backend.AdapterIndex, backend.EncoderIndex = adapter.Index, adapter.HardwareH264[0].Index
			return backend, true
		}
	}
	return backend, false
}

// relayDerivation owns only the optional missing lower representation. Raw RTP
// never waits for it. A retired process must exit before another one can start.
type relayDerivation struct {
	source   *Source
	options  RelayOptions
	recovery atomic.Bool
	mu       sync.Mutex
	run      *relayRun
}

type relayPlan struct {
	profile *nativecapture.VideoProfile
	output  nativecapture.OutputProfile
	format  uint64
	bitrate uint32
	wanted  bool
}

type relayRun struct {
	owner      *relayDerivation
	plan       relayPlan
	ctx        context.Context
	cancel     context.CancelCauseFunc
	done       chan struct{}
	packets    chan *rtp.Packet
	anchorRTP  uint32
	anchorTime time.Time
}

// Called with writeMu held. Declared ceilings are not measured input quality.
func (source *Source) configureRelayFormats(reset bool) error {
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.closed {
		return io.ErrClosedPipe
	}
	if source.relayProfile == nil {
		return nil
	}
	base := len(source.formats) - 1
	format := source.formats[base].Load()
	width, height := uint32(format>>32), uint32(format)
	outputs := nativecapture.ScreenShareOutputs(*source.relayProfile)
	lower := outputs[0]
	if width > 0 && height > 0 {
		lower.Width, lower.Height = min(width/4*2, lower.Width), min(height/4*2, lower.Height)
	}
	if !reset && len(source.outputBitrates) > 0 && source.outputBitrates[0] == 0 {
		lower.Bitrate = 0
	}
	source.outputBitrates = []uint32{lower.Bitrate, source.relayProfile.Bitrate}
	return source.media.UpdateFormats([]forwarding.LayerFormat{
		{Width: lower.Width, Height: lower.Height, Bitrate: lower.Bitrate},
		{Width: width, Height: height, Bitrate: source.relayProfile.Bitrate},
	})
}

func (source *Source) relayPlan() relayPlan {
	source.writeMu.Lock()
	defer source.writeMu.Unlock()
	source.mu.Lock()
	defer source.mu.Unlock()
	plan := relayPlan{}
	if source.closed || source.relayProfile == nil || len(source.outputBitrates) == 0 || source.outputBitrates[0] == 0 {
		return plan
	}
	base := len(source.formats) - 1
	plan.profile, plan.format = source.relayProfile, source.formats[base].Load()
	width, height := uint32(plan.format>>32), uint32(plan.format)
	plan.output = nativecapture.ScreenShareOutputs(*plan.profile)[0]
	plan.output.Width = min(width/4*2, plan.output.Width)
	plan.output.Height = min(height/4*2, plan.output.Height)
	if !plan.output.Valid() || width > 2560 || height > 1440 {
		return plan
	}
	plan.bitrate = plan.output.Bitrate
	for edge, local := range source.edges {
		if local || edge.State() != webrtc.PeerConnectionStateConnected {
			continue
		}
		if _, fresh := edge.transport.TargetBitrate(); !fresh {
			continue
		}
		state := edge.transport.Output.State()
		needsLower := state.Paused || state.Target >= 0 && state.Target < int32(base) ||
			state.Current >= 0 && state.Current < int32(base)
		if state.VideoBudget > 0 && needsLower {
			plan.wanted = true
			budget := source.media.CodecBudget(0, state.VideoBudget)
			plan.bitrate = min(plan.bitrate, uint32(min(budget, int64(plan.output.Bitrate))))
		}
	}
	plan.bitrate = max(1000, plan.bitrate)
	return plan
}

func (relay *relayDerivation) push(packet *rtp.Packet) {
	relay.mu.Lock()
	defer relay.mu.Unlock()
	if relay.run != nil {
		select {
		case <-relay.run.done:
			relay.run = nil
		default:
		}
	}
	if packet.Marker {
		plan := relay.source.relayPlan()
		if relay.run != nil && (!plan.wanted || plan.profile != relay.run.plan.profile || plan.format != relay.run.plan.format) {
			relay.run.cancel(nil)
			return
		}
		if relay.run == nil && plan.wanted {
			at, available := relay.source.media.ReferenceTime(len(relay.source.formats)-1, packet.Timestamp)
			if !available {
				return
			}
			ctx, cancel := context.WithCancelCause(relay.source.engine.ctx)
			relay.run = &relayRun{
				owner: relay, plan: plan, ctx: ctx, cancel: cancel,
				done: make(chan struct{}), packets: make(chan *rtp.Packet, relayPacketLimit),
				anchorRTP: packet.Timestamp, anchorTime: at,
			}
			relay.recovery.Store(true)
			go relay.run.serve()
			// Earlier packets of this frame used the raw path only. Begin assembly
			// with the next complete frame, not this frame's trailing fragment.
			return
		}
	}
	if relay.run == nil {
		return
	}
	select {
	case relay.run.packets <- packet.Clone():
	case <-relay.run.ctx.Done():
	default:
		// Discarding a compressed reference frame silently poisons the decoder.
		// Retire this derived output; the existing edge owner handles its failure.
		relay.run.cancel(errors.New("native relay decoder input is full"))
	}
}

func (relay *relayDerivation) cancel() {
	relay.mu.Lock()
	if relay.run != nil {
		relay.run.cancel(nil)
	}
	relay.mu.Unlock()
}

func (relay *relayDerivation) close() {
	relay.mu.Lock()
	run := relay.run
	if run != nil {
		run.cancel(nil)
	}
	relay.mu.Unlock()
	if run != nil {
		<-run.done
	}
}

func (run *relayRun) serve() {
	defer close(run.done)
	defer func() {
		if cause := context.Cause(run.ctx); cause != nil && !errors.Is(cause, context.Canceled) {
			retire, _ := run.owner.source.markLayerUnavailable(0, run)
			if retire != nil {
				retire()
			}
		}
	}()
	backend, _ := relayBackend(run.owner.source.codec, &run.owner.options)
	backend.Preference, backend.Outputs = run.plan.profile.Preference, []nativecapture.OutputProfile{run.plan.output}
	stream, err := nativecapture.StartEncodedVideo(run.ctx, run.owner.options.CaptureProcess, backend)
	if err != nil {
		run.cancel(err)
		return
	}
	run.owner.source.SetLowestLayerRateControlled(true)
	defer run.owner.source.SetLowestLayerRateControlled(false)
	run.owner.source.BeginGeneration()
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		run.read(stream)
	}()
	run.owner.source.media.SendPLI(int32(len(run.owner.source.formats)-1), false)
	if err = run.write(stream); err != nil {
		run.cancel(err)
	}
	_ = stream.Close()
	<-readDone
}

func (run *relayRun) write(stream *nativecapture.Stream) error {
	waitingRecovery := true
	input := relayVideoInput{codec: run.owner.source.codec, onPacketDropped: func() {
		waitingRecovery = true
		run.owner.source.media.SendPLI(int32(len(run.owner.source.formats)-1), false)
	}}
	clock := utils.NewWrapAround[uint32, uint64](utils.WrapAroundParams{})
	clock.Update(run.anchorRTP)
	for {
		select {
		case <-run.ctx.Done():
			return context.Cause(run.ctx)
		case packet := <-run.packets:
			if err := input.push(packet); err != nil {
				return err
			}
			for {
				sample, timestamp := input.pop()
				if sample == nil {
					break
				}
				frame, err := input.frame(sample.Data)
				if err != nil {
					return err
				}
				if waitingRecovery && !frame.KeyFrame {
					continue
				}
				if frame.Width == 0 || frame.Height == 0 {
					continue
				}
				waitingRecovery = false
				stamp := clock.Update(timestamp)
				if stamp.IsUnhandled || stamp.ExtendedVal < clock.GetExtendedStart() {
					continue
				}
				ticks := stamp.ExtendedVal - clock.GetExtendedStart()
				frame.Timestamp = time.Duration(ticks/videoClockRate)*time.Second + time.Duration(ticks%videoClockRate)*time.Second/videoClockRate
				frame.Duration = sample.Duration
				if frame.Duration <= 0 {
					frame.Duration = time.Second / time.Duration(run.plan.profile.Framerate)
				}
				plan := run.owner.source.relayPlan()
				if !plan.wanted || plan.profile != run.plan.profile || plan.format != run.plan.format {
					return context.Canceled
				}
				if err = stream.SetOutputBitrate(0, plan.bitrate); err != nil {
					return err
				}
				if run.owner.recovery.Swap(false) {
					if err = stream.RequestKeyFrame(0); err != nil {
						return err
					}
				}
				if err = stream.WriteFrame(frame); err != nil {
					return err
				}
			}
		}
	}
}

func (run *relayRun) read(stream *nativecapture.Stream) {
	for {
		frame, err := stream.Read()
		if err != nil {
			run.cancel(err)
			return
		}
		if run.ctx.Err() != nil {
			return
		}
		source := run.owner.source
		switch frame.Kind {
		case nativecapture.FrameStatus:
			continue
		case nativecapture.FrameBegin:
			source.writeMu.Lock()
			err = source.media.BeginFrame(frame.Timestamp, run.anchorTime.Add(frame.Timestamp))
			source.writeMu.Unlock()
		case nativecapture.FrameH264, nativecapture.FrameVP8:
			if frame.Layer != 0 || (frame.Kind == nativecapture.FrameH264) != (source.codec == "h264") {
				err = errors.New("native relay output does not match its source")
				break
			}
			if err = source.SetFormat(0, frame.Width, frame.Height); err != nil {
				break
			}
			err = source.WriteVideo(0, encoded.Frame{
				Data: frame.Data, PTS: frame.Timestamp, Duration: frame.Duration, Recovery: frame.KeyFrame,
			})
		default:
			err = errors.New("native relay output failed")
		}
		if err != nil {
			run.cancel(err)
			return
		}
	}
}
