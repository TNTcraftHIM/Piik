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
	track, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: videoClockRate},
		"screen",
		"screener",
	)
	if err != nil {
		return nil, fmt.Errorf("create shared VP8 track: %w", err)
	}
	return newFanout(track, track, requestKeyFrame, onFatal), nil
}

func newFanout(track *webrtc.TrackLocalStaticRTP, writer rtpWriter, requestKeyFrame func(), onFatal func(error)) *Fanout {
	ctx, cancel := context.WithCancel(context.Background())
	fanout := &Fanout{
		track:           track,
		writer:          writer,
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
		return errors.New("encoded VP8 frame violates the bounded media contract")
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
	timeline := newFrameTimeline()
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
	return &frameTimeline{packetizer: rtp.NewPacketizer(
		1200,
		96,
		0,
		&codecs.VP8Payloader{},
		rtp.NewRandomSequencer(),
		videoClockRate,
	)}
}

func (timeline *frameTimeline) Packetize(frame Frame) ([]*rtp.Packet, uint64, error) {
	var gapMicros uint64
	if timeline.hasPrevious {
		if frame.TimestampMicros <= timeline.previousTimestampMicros {
			return nil, 0, errors.New("encoded frame timestamp did not increase")
		}
		if timeline.previousTimestampMicros > math.MaxUint64-timeline.previousDurationMicros {
			return nil, 0, errors.New("encoded frame timestamp overflowed")
		}
		expected := timeline.previousTimestampMicros + timeline.previousDurationMicros
		if frame.TimestampMicros < expected {
			return nil, 0, errors.New("encoded frame timestamps overlap")
		}
		gapMicros = frame.TimestampMicros - expected
		gapSamples, err := microsToSamples(gapMicros)
		if err != nil {
			return nil, 0, err
		}
		timeline.packetizer.SkipSamples(gapSamples)
	}
	durationSamples, err := microsToSamples(frame.DurationMicros)
	if err != nil {
		return nil, 0, err
	}
	if durationSamples == 0 {
		durationSamples = uint32(videoClockRate / 30)
	}
	packets := timeline.packetizer.Packetize(frame.Data, durationSamples)
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
