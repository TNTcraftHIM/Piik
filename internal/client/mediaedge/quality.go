package mediaedge

import (
	"time"

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
	bytes := bytesNow - previous.videoBytes + audioBytes - previous.audioBytes
	seconds := window.Seconds()
	if edge.audioSource != nil && edge.audioSource.encoder == nil {
		edge.transport.SetAudioBitrate(uint32(float64((audioBytes-previous.audioBytes)*8) / seconds))
	}
	bitrate := float64(bytes*8) / seconds
	sample := QualitySample{
		SampleTimestampMs:     now.UnixMilli(),
		SampleWindowMs:        window.Milliseconds(),
		RTPStatsID:            edge.connection.ID(),
		TrackIdentifier:       edge.transport.Output.ID(),
		State:                 "unknown",
		IntervalFramesEncoded: frames,
		FramesPerSecond:       float64(frames) / seconds,
		BitrateKbps:           bitrate / 1000,
		Width:                 uint32(format >> 32),
		Height:                uint32(format),
	}
	target, observed := edge.targetBitrate()
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

func (edge *Edge) videoCounters() (frames, bytes, format uint64) {
	stats := edge.transport.Output.GetState().RTPStats.ToProto()
	if stats != nil {
		frames, bytes = uint64(stats.Frames), stats.Bytes-stats.HeaderBytes
	}
	current := edge.transport.Output.State().Current
	sizes := edge.source.media.VideoSizes()
	if current >= 0 && int(current) < len(sizes) {
		format = uint64(sizes[current].Width)<<32 | uint64(sizes[current].Height)
	} else if edge.source.relay != nil && current == int32(len(edge.source.formats)-1) {
		// ReceiverBase.VideoSizes stops at an unproduced lower slot. The raw
		// input's codec header still provides its actual delivered dimensions.
		format = edge.source.formats[current].Load()
	}
	return
}
