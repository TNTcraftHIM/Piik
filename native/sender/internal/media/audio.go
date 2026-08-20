package media

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sync"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
)

const (
	audioClockRate  = 48_000
	audioQueueDepth = 16
	OpusSDPFmtpLine = "minptime=10;useinbandfec=1"
)

type AudioMetrics struct {
	PacketsWritten           uint64 `json:"packetsWritten"`
	SourceRTPPacketsWritten  uint64 `json:"sourceRtpPacketsWritten"`
	SourceRTPBytesWritten    uint64 `json:"sourceRtpBytesWritten"`
	LastSourceTimestamp100ns uint64 `json:"lastSourceTimestamp100ns"`
}

type AudioFanout struct {
	track     *webrtc.TrackLocalStaticRTP
	writer    rtpWriter
	queue     chan Packet
	ctx       context.Context
	cancel    context.CancelFunc
	done      chan struct{}
	closeOnce sync.Once
	fatalOnce sync.Once
	onFatal   func(error)
	metricsMu sync.Mutex
	metrics   AudioMetrics
}

func NewAudioFanout(onFatal func(error)) (*AudioFanout, error) {
	capability := webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeOpus, ClockRate: audioClockRate, Channels: 2, SDPFmtpLine: OpusSDPFmtpLine,
	}
	track, err := webrtc.NewTrackLocalStaticRTP(capability, "audio", "screener")
	if err != nil {
		return nil, fmt.Errorf("create shared Opus track: %w", err)
	}
	return newAudioFanout(track, track, onFatal), nil
}

func newAudioFanout(track *webrtc.TrackLocalStaticRTP, writer rtpWriter, onFatal func(error)) *AudioFanout {
	ctx, cancel := context.WithCancel(context.Background())
	fanout := &AudioFanout{
		track: track, writer: writer, queue: make(chan Packet, audioQueueDepth),
		ctx: ctx, cancel: cancel, done: make(chan struct{}), onFatal: onFatal,
	}
	go fanout.writeLoop()
	return fanout
}

func (fanout *AudioFanout) Track() *webrtc.TrackLocalStaticRTP { return fanout.track }

func (fanout *AudioFanout) Push(packet Packet) error {
	if packet.Kind != KindOpus {
		return errors.New("shared audio fanout requires Opus")
	}
	if err := validatePacket(packet); err != nil {
		return err
	}
	select {
	case <-fanout.ctx.Done():
		return errors.New("shared audio fanout is closed")
	case fanout.queue <- packet:
		return nil
	default:
		return errors.New("shared audio queue exceeded its bound")
	}
}

func (fanout *AudioFanout) Snapshot() AudioMetrics {
	fanout.metricsMu.Lock()
	defer fanout.metricsMu.Unlock()
	return fanout.metrics
}

func (fanout *AudioFanout) Close() {
	fanout.stop()
	<-fanout.done
}

func (fanout *AudioFanout) writeLoop() {
	defer close(fanout.done)
	timeline := newAudioTimeline()
	for {
		select {
		case <-fanout.ctx.Done():
			return
		case packet := <-fanout.queue:
			packets, err := timeline.Packetize(packet)
			if err != nil {
				fanout.fail(err)
				return
			}
			var sourceBytes uint64
			for _, rtpPacket := range packets {
				if err = fanout.writer.WriteRTP(rtpPacket); err != nil {
					fanout.fail(errors.New("write shared Opus RTP packet failed"))
					return
				}
				sourceBytes += uint64(rtpPacket.MarshalSize())
			}
			fanout.metricsMu.Lock()
			fanout.metrics.PacketsWritten++
			fanout.metrics.SourceRTPPacketsWritten += uint64(len(packets))
			fanout.metrics.SourceRTPBytesWritten += sourceBytes
			fanout.metrics.LastSourceTimestamp100ns = packet.Timestamp100ns
			fanout.metricsMu.Unlock()
		}
	}
}

func (fanout *AudioFanout) fail(err error) {
	fanout.fatalOnce.Do(func() {
		fanout.stop()
		if fanout.onFatal != nil {
			go func() { <-fanout.done; fanout.onFatal(err) }()
		}
	})
}

func (fanout *AudioFanout) stop() { fanout.closeOnce.Do(fanout.cancel) }

type audioTimeline struct {
	packetizer        rtp.Packetizer
	hasPrevious       bool
	previousTimestamp uint64
}

func newAudioTimeline() *audioTimeline {
	return &audioTimeline{packetizer: rtp.NewPacketizer(
		1200, 111, 0, &codecs.OpusPayloader{}, rtp.NewRandomSequencer(), audioClockRate,
	)}
}

func (timeline *audioTimeline) Packetize(packet Packet) ([]*rtp.Packet, error) {
	if timeline.hasPrevious {
		if packet.Timestamp100ns <= timeline.previousTimestamp {
			return nil, errors.New("encoded audio timestamp did not increase")
		}
		delta, err := audioSamples(packet.Timestamp100ns - timeline.previousTimestamp)
		if err != nil {
			return nil, err
		}
		if delta == 0 {
			delta = 1
		}
		timeline.packetizer.SkipSamples(delta)
	}
	packets := timeline.packetizer.Packetize(packet.Data, 0)
	if len(packets) == 0 {
		return nil, errors.New("Opus access unit exceeded the RTP payload bound")
	}
	timeline.hasPrevious = true
	timeline.previousTimestamp = packet.Timestamp100ns
	return packets, nil
}

func audioSamples(value100ns uint64) (uint32, error) {
	seconds := value100ns / 10_000_000
	remainder := value100ns % 10_000_000
	samples := seconds*audioClockRate + (remainder*audioClockRate+5_000_000)/10_000_000
	if samples > math.MaxUint32 {
		return 0, errors.New("encoded audio timestamp gap is too large")
	}
	return uint32(samples), nil
}
