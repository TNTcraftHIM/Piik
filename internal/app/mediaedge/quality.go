package mediaedge

import (
	"log/slog"
	"time"

	"github.com/P4-aaaul/Silip/internal/diagnostics"
	"github.com/P4-aaaul/Silip/internal/media/forwarding"
	"github.com/pion/webrtc/v4"
)

const defaultNativeSourceInitialBitrate = 3_000_000

type QualitySample struct {
	SampleTimestampMs     int64
	SampleWindowMs        int64
	RTPStatsID            string
	TrackIdentifier       string
	State                 string
	Reason                *string
	IntervalFramesSent    uint64
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
	framesNow, bytesNow, format := edge.videoCounters()
	audioBytes := edge.audioSource.snapshotBytes()
	edge.qualityMu.Lock()
	previous := edge.qualityBaseline
	edge.qualityBaseline = qualityBaseline{
		at: now, frames: framesNow, videoBytes: bytesNow, audioBytes: audioBytes,
	}
	edge.qualityMu.Unlock()
	if previous.at.IsZero() {
		return QualitySample{}, false
	}
	window := now.Sub(previous.at)
	if window < time.Second || window > 5*time.Second ||
		framesNow < previous.frames || bytesNow < previous.videoBytes ||
		audioBytes < previous.audioBytes {
		return QualitySample{}, false
	}
	frames := framesNow - previous.frames
	videoBytes := bytesNow - previous.videoBytes
	bytes := videoBytes + audioBytes - previous.audioBytes
	seconds := window.Seconds()
	bitrate := float64(bytes*8) / seconds
	sample := QualitySample{
		SampleTimestampMs:  now.UnixMilli(),
		SampleWindowMs:     window.Milliseconds(),
		RTPStatsID:         edge.connection.ID(),
		TrackIdentifier:    edge.transport.Output.ID(),
		State:              "unknown",
		IntervalFramesSent: frames,
		FramesPerSecond:    float64(frames) / seconds,
		BitrateKbps:        bitrate / 1000,
		Width:              uint32(format >> 32),
		Height:             uint32(format),
	}
	if slog.Default().Enabled(edge.engine.ctx, slog.LevelDebug) {
		defer func() {
			slog.Debug("media-sample", "connectionId", diagnostics.ID(edge.connectionID), "local", edge.local,
				"rtcPeerId", diagnostics.ID(edge.connection.ID()), "windowMs", sample.SampleWindowMs,
				"fps", sample.FramesPerSecond, "bitrateKbps", sample.BitrateKbps, "width", sample.Width, "height", sample.Height,
				"availableOutgoingKbps", sample.AvailableOutgoingKbps, "state", sample.State, "reason", sample.Reason,
				"egress", edge.transport.Egress(), "output", edge.transport.Output.State())
		}()
	}
	target, observed := edge.targetBitrate()
	if edge.State() != webrtc.PeerConnectionStateConnected || !observed ||
		frames == 0 || bytes == 0 {
		return sample, true
	}
	sample.AvailableOutgoingKbps = float64(target) / 1000
	reason := "none"
	sample.State = "healthy"
	// Allocation and ordinary congestion own the limitation. A source bitrate
	// spike or an unsuccessful recovery probe is not itself a new media limit.
	if edge.transport.BandwidthLimited() {
		reason = "bandwidth"
		sample.State = "degraded"
	}
	sample.Reason = &reason
	return sample, true
}

func (edge *Edge) videoCounters() (frames, bytes, format uint64) {
	stats := edge.transport.Output.GetState().RTPStats.ToProto()
	if stats != nil {
		frames, bytes = uint64(stats.Frames), stats.Bytes-stats.HeaderBytes
	}
	current := edge.transport.Output.State().Current
	width, height := sentVideoDimensions(edge.transport.CurrentSource(), int(current))
	format = uint64(width)<<32 | uint64(height)
	return
}

func sentVideoDimensions(source *forwarding.Source, layer int) (uint32, uint32) {
	if layer < 0 {
		return 0, 0
	}
	sizes := source.VideoSizes()
	if layer < len(sizes) {
		return sizes[layer].Width, sizes[layer].Height
	}
	// VideoSizes stops at an unproduced lower slot. The source owner also
	// publishes actual dimensions in metadata as encoded frames arrive.
	info := source.TrackInfo()
	if layer < len(info.Layers) {
		return info.Layers[layer].Width, info.Layers[layer].Height
	}
	return 0, 0
}
