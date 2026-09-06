package mediaedge

import (
	"sync"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/cc"
	"github.com/pion/interceptor/pkg/gcc"
	"github.com/pion/webrtc/v4"
)

const defaultNativeSourceInitialBitrate = 3_000_000

type targetBitrateEstimator interface {
	GetTargetBitrate() int
	OnTargetBitrateChange(func(int))
}

type bandwidthObserver struct {
	estimator targetBitrateEstimator

	mu       sync.RWMutex
	observed bool
}

func newBandwidthObserver(estimator targetBitrateEstimator) *bandwidthObserver {
	observer := &bandwidthObserver{estimator: estimator}
	estimator.OnTargetBitrateChange(func(int) {
		observer.mu.Lock()
		observer.observed = true
		observer.mu.Unlock()
	})
	return observer
}

type QualitySample struct {
	SampleTimestampMs     int64
	SampleWindowMs        int64
	RTPStatsID            string
	TrackIdentifier       string
	State                 string
	Reason                *string
	IntervalFramesEncoded uint64
	FramesPerSecond       float64
	BitrateKbps           float64
	AvailableOutgoingKbps float64
	Width                 uint32
	Height                uint32
}

type qualityBaseline struct {
	at         time.Time
	frames     uint64
	videoBytes uint64
	audioBytes uint64
}

func (edge *Edge) QualitySample(now time.Time) (QualitySample, bool) {
	video := edge.source.snapshot()
	audioBytes := edge.audioSource.snapshotBytes()
	edge.qualityMu.Lock()
	previous := edge.qualityBaseline
	edge.qualityBaseline = qualityBaseline{
		at: now, frames: video.frames, videoBytes: video.bytes, audioBytes: audioBytes,
	}
	edge.qualityMu.Unlock()
	if previous.at.IsZero() {
		return QualitySample{}, false
	}
	window := now.Sub(previous.at)
	if window < time.Second || window > 5*time.Second ||
		video.frames < previous.frames || video.bytes < previous.videoBytes ||
		audioBytes < previous.audioBytes {
		return QualitySample{}, false
	}
	frames := video.frames - previous.frames
	bytes := video.bytes - previous.videoBytes + audioBytes - previous.audioBytes
	seconds := window.Seconds()
	bitrate := float64(bytes*8) / seconds
	sample := QualitySample{
		SampleTimestampMs:     now.UnixMilli(),
		SampleWindowMs:        window.Milliseconds(),
		RTPStatsID:            edge.connection.ID(),
		TrackIdentifier:       edge.source.track.ID(),
		State:                 "unknown",
		IntervalFramesEncoded: frames,
		FramesPerSecond:       float64(frames) / seconds,
		BitrateKbps:           bitrate / 1000,
		Width:                 video.width,
		Height:                video.height,
	}
	target, observed := edge.bandwidth.targetBitrate()
	if edge.State() != webrtc.PeerConnectionStateConnected || !observed ||
		frames == 0 || bytes == 0 {
		return sample, true
	}
	sample.AvailableOutgoingKbps = float64(target) / 1000
	reason := "none"
	sample.State = "healthy"
	if float64(target) < bitrate {
		reason = "bandwidth"
		sample.State = "degraded"
	}
	sample.Reason = &reason
	return sample, true
}

func (observer *bandwidthObserver) targetBitrate() (int, bool) {
	observer.mu.RLock()
	observed := observer.observed
	observer.mu.RUnlock()
	if !observed {
		return 0, false
	}
	return observer.estimator.GetTargetBitrate(), true
}

type bandwidthObservers struct {
	mu      sync.Mutex
	pending map[string]*bandwidthObserver
}

func configureBandwidthObservers(
	media *webrtc.MediaEngine,
	registry *interceptor.Registry,
	initialBitrate int,
) (*bandwidthObservers, error) {
	if initialBitrate <= 0 {
		initialBitrate = defaultNativeSourceInitialBitrate
	}
	observers := &bandwidthObservers{pending: make(map[string]*bandwidthObserver)}
	factory, err := cc.NewInterceptor(func() (cc.BandwidthEstimator, error) {
		return gcc.NewSendSideBWE(
			gcc.SendSideBWEInitialBitrate(initialBitrate),
			gcc.SendSideBWEPacer(gcc.NewNoOpPacer()),
		)
	})
	if err != nil {
		return nil, err
	}
	factory.OnNewPeerConnection(func(id string, estimator cc.BandwidthEstimator) {
		observers.mu.Lock()
		observers.pending[id] = newBandwidthObserver(estimator)
		observers.mu.Unlock()
	})
	registry.Add(factory)
	if err = webrtc.ConfigureTWCCHeaderExtensionSender(media, registry); err != nil {
		return nil, err
	}
	return observers, nil
}

func (observers *bandwidthObservers) take(id string) *bandwidthObserver {
	observers.mu.Lock()
	defer observers.mu.Unlock()
	observer := observers.pending[id]
	delete(observers.pending, id)
	return observer
}
