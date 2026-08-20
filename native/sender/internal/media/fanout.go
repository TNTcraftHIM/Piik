package media

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"sync"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
)

const (
	FrameHeaderBytes = 17
	MaxFrameBytes    = 1 << 20
	queueCapacity    = 8
	videoClockRate   = 90_000
)

// Codec selects the encoded representation carried by the native bridge.
// VP8 remains the default; H.264 is an explicit Windows/WebCodecs opt-in.
type Codec string

const (
	CodecVP8  Codec = "vp8"
	CodecH264 Codec = "h264"

	H264ProfileLevelID = "42c01f"
	H264SDPFmtpLine    = "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=" + H264ProfileLevelID
)

func ParseCodec(value string) (Codec, bool) {
	switch Codec(value) {
	case CodecVP8:
		return CodecVP8, true
	case CodecH264:
		return CodecH264, true
	default:
		return CodecVP8, false
	}
}

type Frame struct {
	KeyFrame        bool
	TimestampMicros uint64
	DurationMicros  uint64
	Data            []byte
}

type Metrics struct {
	Queue                     QueueMetrics `json:"queue"`
	FramesWritten             uint64       `json:"framesWritten"`
	SourceRTPPacketsWritten   uint64       `json:"sourceRtpPacketsWritten"`
	SourceRTPBytesWritten     uint64       `json:"sourceRtpBytesWritten"`
	SourceTimestampGapMicros  uint64       `json:"sourceTimestampGapMicros"`
	LastSourceTimestampMicros uint64       `json:"lastSourceTimestampMicros"`
}

type rtpWriter interface {
	WriteRTP(*rtp.Packet) error
}

type Fanout struct {
	track           *webrtc.TrackLocalStaticRTP
	writer          rtpWriter
	codec           Codec
	queue           *frameQueue
	ctx             context.Context
	cancel          context.CancelFunc
	done            chan struct{}
	closeOnce       sync.Once
	fatalOnce       sync.Once
	requestKeyFrame func()
	onFatal         func(error)
	metricsMu       sync.Mutex
	metrics         Metrics
}

func NewFanout(requestKeyFrame func(), onFatal func(error)) (*Fanout, error) {
	return NewFanoutWithCodec(CodecVP8, requestKeyFrame, onFatal)
}

func NewFanoutWithCodec(codec Codec, requestKeyFrame func(), onFatal func(error)) (*Fanout, error) {
	capability, err := trackCapability(codec)
	if err != nil {
		return nil, err
	}
	track, err := webrtc.NewTrackLocalStaticRTP(capability, "screen", "screener")
	if err != nil {
		return nil, fmt.Errorf("create shared %s track: %w", codec, err)
	}
	return newFanoutWithCodec(track, track, codec, requestKeyFrame, onFatal), nil
}

func trackCapability(codec Codec) (webrtc.RTPCodecCapability, error) {
	switch codec {
	case CodecVP8:
		return webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: videoClockRate}, nil
	case CodecH264:
		return webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeH264, ClockRate: videoClockRate, SDPFmtpLine: H264SDPFmtpLine,
		}, nil
	default:
		return webrtc.RTPCodecCapability{}, fmt.Errorf("unsupported native codec %q", codec)
	}
}

func newFanout(track *webrtc.TrackLocalStaticRTP, writer rtpWriter, requestKeyFrame func(), onFatal func(error)) *Fanout {
	return newFanoutWithCodec(track, writer, CodecVP8, requestKeyFrame, onFatal)
}

func newFanoutWithCodec(track *webrtc.TrackLocalStaticRTP, writer rtpWriter, codec Codec, requestKeyFrame func(), onFatal func(error)) *Fanout {
	ctx, cancel := context.WithCancel(context.Background())
	fanout := &Fanout{
		track:           track,
		writer:          writer,
		codec:           codec,
		queue:           newFrameQueue(queueCapacity),
		ctx:             ctx,
		cancel:          cancel,
		done:            make(chan struct{}),
		requestKeyFrame: requestKeyFrame,
		onFatal:         onFatal,
	}
	go fanout.writeLoop()
	return fanout
}

func (fanout *Fanout) Track() *webrtc.TrackLocalStaticRTP {
	return fanout.track
}

func (fanout *Fanout) Push(frame Frame) error {
	if len(frame.Data) == 0 || len(frame.Data) > MaxFrameBytes || frame.DurationMicros == 0 {
		return errors.New("encoded frame violates the bounded media contract")
	}
	result, err := fanout.queue.Push(frame)
	if err != nil {
		return err
	}
	if result.requestKeyFrame && fanout.requestKeyFrame != nil {
		fanout.requestKeyFrame()
	}
	return nil
}

func (fanout *Fanout) Snapshot() Metrics {
	fanout.metricsMu.Lock()
	metrics := fanout.metrics
	fanout.metricsMu.Unlock()
	metrics.Queue = fanout.queue.Snapshot()
	return metrics
}

func (fanout *Fanout) Close() {
	fanout.stop()
	<-fanout.done
}

func (fanout *Fanout) writeLoop() {
	defer close(fanout.done)
	timeline := newFrameTimelineForCodec(fanout.codec)
	for {
		frame, ok, err := fanout.queue.Pop(fanout.ctx)
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				fanout.fail(fmt.Errorf("read encoded media queue: %w", err))
			}
			return
		}
		if !ok {
			return
		}
		packets, gapMicros, err := timeline.Packetize(frame)
		if err != nil {
			fanout.fail(err)
			return
		}
		var sourceBytes uint64
		for _, packet := range packets {
			if err = fanout.writer.WriteRTP(packet); err != nil {
				fanout.fail(errors.New("write shared RTP packet failed"))
				return
			}
			sourceBytes += uint64(packet.MarshalSize())
		}
		fanout.queue.MarkRecoveryWritten(frame.KeyFrame)
		fanout.metricsMu.Lock()
		fanout.metrics.FramesWritten++
		fanout.metrics.SourceRTPPacketsWritten += uint64(len(packets))
		fanout.metrics.SourceRTPBytesWritten += sourceBytes
		fanout.metrics.SourceTimestampGapMicros += gapMicros
		fanout.metrics.LastSourceTimestampMicros = frame.TimestampMicros
		fanout.metricsMu.Unlock()
	}
}

func (fanout *Fanout) fail(err error) {
	fanout.fatalOnce.Do(func() {
		fanout.stop()
		if fanout.onFatal != nil {
			go func() {
				<-fanout.done
				fanout.onFatal(err)
			}()
		}
	})
}

func (fanout *Fanout) stop() {
	fanout.closeOnce.Do(func() {
		fanout.cancel()
		fanout.queue.Close()
	})
}

type frameTimeline struct {
	packetizer              rtp.Packetizer
	hasPrevious             bool
	previousTimestampMicros uint64
	previousDurationMicros  uint64
}

func newFrameTimeline() *frameTimeline {
	return newFrameTimelineForCodec(CodecVP8)
}

func newFrameTimelineForCodec(codec Codec) *frameTimeline {
	var payloader rtp.Payloader
	if codec == CodecH264 {
		payloader = &codecs.H264Payloader{}
	} else {
		payloader = &codecs.VP8Payloader{}
	}
	return &frameTimeline{packetizer: rtp.NewPacketizer(
		1200,
		96,
		0,
		payloader,
		rtp.NewRandomSequencer(),
		videoClockRate,
	)}
}

func (timeline *frameTimeline) Packetize(frame Frame) ([]*rtp.Packet, uint64, error) {
	var gapMicros uint64
	// Source timestamps own RTP cadence. WebCodecs duration is nullable and can
	// extend past the next live-capture timestamp, so it is diagnostic only.
	if timeline.hasPrevious {
		if frame.TimestampMicros <= timeline.previousTimestampMicros {
			return nil, 0, errors.New("encoded frame timestamp did not increase")
		}
		deltaMicros := frame.TimestampMicros - timeline.previousTimestampMicros
		if deltaMicros > timeline.previousDurationMicros {
			gapMicros = deltaMicros - timeline.previousDurationMicros
		}
		deltaSamples, err := microsToSamples(deltaMicros)
		if err != nil {
			return nil, 0, err
		}
		if deltaSamples == 0 {
			deltaSamples = 1
		}
		timeline.packetizer.SkipSamples(deltaSamples)
	}
	packets := timeline.packetizer.Packetize(frame.Data, 0)
	timeline.hasPrevious = true
	timeline.previousTimestampMicros = frame.TimestampMicros
	timeline.previousDurationMicros = frame.DurationMicros
	return packets, gapMicros, nil
}

func microsToSamples(micros uint64) (uint32, error) {
	seconds := micros / 1_000_000
	remainder := micros % 1_000_000
	samples := seconds*videoClockRate + (remainder*videoClockRate+500_000)/1_000_000
	if samples > math.MaxUint32 {
		return 0, errors.New("encoded frame timestamp gap is too large")
	}
	return uint32(samples), nil
}

func DecodeFrame(payload []byte) (Frame, error) {
	if len(payload) <= FrameHeaderBytes || len(payload)-FrameHeaderBytes > MaxFrameBytes {
		return Frame{}, errors.New("encoded frame is empty, truncated, or too large")
	}
	frame := Frame{
		TimestampMicros: binary.BigEndian.Uint64(payload[1:9]),
		DurationMicros:  binary.BigEndian.Uint64(payload[9:17]),
		Data:            append([]byte(nil), payload[FrameHeaderBytes:]...),
	}
	switch payload[0] {
	case 1:
		frame.KeyFrame = true
	case 2:
	default:
		return Frame{}, errors.New("encoded frame type is invalid")
	}
	if frame.DurationMicros == 0 || frame.DurationMicros > uint64(time.Second/time.Microsecond) {
		return Frame{}, errors.New("encoded frame duration is invalid")
	}
	return frame, nil
}
