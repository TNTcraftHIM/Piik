package mediaedge

import (
	"errors"
	"slices"
	"sync"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/media/forwarding"
	"github.com/pion/webrtc/v4"
)

type PublicationMedia struct {
	Codec        string             `json:"codec"`
	Layers       []PublicationLayer `json:"layers"`
	Audio        bool               `json:"audio"`
	AudioBitrate uint32             `json:"audioBitrate"`
}

type PublicationLayer struct {
	RID     string `json:"rid"`
	Width   uint32 `json:"width"`
	Height  uint32 `json:"height"`
	Bitrate uint32 `json:"bitrate"`
}

type Publication struct {
	source    *Source
	audio     *AudioSource
	transport *forwarding.Publication
	// Reuse the existing bounded SDP/candidate owner without registering a P2P edge.
	signaling       Edge
	closeOnce       sync.Once
	closeErr        error
	qualityMu       sync.Mutex
	qualityAt       time.Time
	qualityCounters forwarding.PublicationCounters
}

func (engine *Engine) NewPublication(source *Source, options EdgeOptions) (*Publication, error) {
	if source == nil || source.engine != engine || options.Local || options.ConnectionID == "" ||
		len(options.ConnectionID) > 256 || options.Audio != nil && options.Audio.engine != engine {
		return nil, errors.New("native publication input is invalid")
	}
	// A new publication starts on the base source. Independent lower-output
	// groups are not part of its descriptor and own their failures separately.
	outputsUnavailable := func() bool {
		return slices.Contains(source.outputBitrates[:min(len(source.outputBitrates), len(source.formats))], uint32(0))
	}
	source.mu.Lock()
	unavailable := outputsUnavailable()
	source.mu.Unlock()
	if unavailable {
		return nil, errors.New("native publication output is unavailable")
	}
	if err := source.reserve(false); err != nil {
		return nil, err
	}
	if options.Audio != nil {
		if err := options.Audio.reserve(false); err != nil {
			source.releaseReservation(false)
			return nil, err
		}
	}
	publication := &Publication{source: source, audio: options.Audio}
	var audio webrtc.TrackLocal
	if options.Audio != nil {
		audio = options.Audio.track
	}
	transport, err := forwarding.NewPublication(forwarding.TransportOptions{
		Source: source.media.Source, Settings: engine.settings, ConnectionID: options.ConnectionID,
		InitialBitrate: engine.initialBitrate, Audio: audio,
	})
	if err != nil {
		_ = publication.Close()
		return nil, err
	}
	publication.transport = transport
	transport.SetAudioBitrate(options.Audio.configuredBitrate())
	publication.signaling.connection = transport.PC
	publication.signaling.localCandidates = newLocalCandidateGathering(engine, options.ICEServers, nil, options.Events.LocalCandidate)
	transport.PC.OnICECandidate(publication.signaling.localCandidates.addPion)
	transport.PC.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateConnected {
			if connectErr := transport.SetConnected(); connectErr != nil {
				_ = transport.PC.Close()
				return
			}
			source.RequestRecoveryFrame()
		}
		if options.Events.ConnectionState != nil {
			options.Events.ConnectionState(state, nil)
		}
	})
	engine.mu.Lock()
	source.mu.Lock()
	if engine.closed || source.closed || len(source.publications) >= 2 || outputsUnavailable() {
		source.mu.Unlock()
		engine.mu.Unlock()
		_ = publication.Close()
		return nil, errors.New("native publication is unavailable")
	}
	source.publications[publication] = struct{}{}
	engine.publications[publication] = struct{}{}
	source.mu.Unlock()
	engine.mu.Unlock()
	return publication, nil
}

func (publication *Publication) CreateOffer() (webrtc.SessionDescription, error) {
	return publication.signaling.CreateOffer()
}
func (publication *Publication) SetAnswer(answer webrtc.SessionDescription) error {
	return publication.signaling.SetAnswer(answer)
}
func (publication *Publication) AddRemoteCandidate(candidate *webrtc.ICECandidateInit) error {
	return publication.signaling.AddRemoteCandidate(candidate)
}
func (publication *Publication) SetActiveCount(count int) error {
	if err := publication.transport.SetActiveCount(count); err != nil {
		return err
	}
	publication.source.RequestRecoveryFrame()
	return nil
}
func (publication *Publication) RequiredActiveCount() int {
	return publication.transport.RequiredActiveCount()
}
func (publication *Publication) LowestLayerBudget() int64 {
	return publication.transport.LowestLayerBudget()
}

type PublicationQualitySample struct {
	SampleTimestampMs        int64    `json:"sampleTimestampMs"`
	SampleWindowMs           int64    `json:"sampleWindowMs"`
	RTPStatsID               string   `json:"rtpStatsId"`
	TrackIdentifier          string   `json:"trackIdentifier"`
	Codec                    string   `json:"codec"`
	VideoEncodingCount       int      `json:"videoEncodingCount"`
	ActiveVideoEncodingCount int      `json:"activeVideoEncodingCount"`
	RID                      string   `json:"rid"`
	IntervalFramesSent       uint64   `json:"intervalFramesSent"`
	FramesPerSecond          float64  `json:"framesPerSecond"`
	Width                    uint32   `json:"width"`
	Height                   uint32   `json:"height"`
	BitrateKbps              float64  `json:"bitrateKbps"`
	AudioBitrateKbps         float64  `json:"audioBitrateKbps"`
	AvailableOutgoingKbps    *float64 `json:"availableOutgoingKbps"`
	State                    string   `json:"state"`
	Reason                   *string  `json:"reason"`
}

func (publication *Publication) QualitySample(now time.Time) (PublicationQualitySample, bool) {
	current := publication.transport.Counters()
	publication.qualityMu.Lock()
	previous, at := publication.qualityCounters, publication.qualityAt
	publication.qualityCounters, publication.qualityAt = current, now
	publication.qualityMu.Unlock()
	window := now.Sub(at)
	if at.IsZero() || window < time.Second || window > 5*time.Second ||
		current.VideoBytes < previous.VideoBytes || current.AudioBytes < previous.AudioBytes {
		return PublicationQualitySample{}, false
	}
	seconds := window.Seconds()
	source := publication.transport.CurrentSource()
	sample := PublicationQualitySample{SampleTimestampMs: now.UnixMilli(), SampleWindowMs: window.Milliseconds(),
		RTPStatsID: publication.signaling.connection.ID(), TrackIdentifier: string(source.TrackID()),
		Codec: publication.source.codec, VideoEncodingCount: len(current.Frames), State: "unknown",
		BitrateKbps:      float64((current.VideoBytes-previous.VideoBytes+current.AudioBytes-previous.AudioBytes)*8) / seconds / 1000,
		AudioBitrateKbps: float64((current.AudioBytes-previous.AudioBytes)*8) / seconds / 1000}
	for index, frames := range current.Frames {
		if index >= len(previous.Frames) || frames <= previous.Frames[index] {
			continue
		}
		sample.ActiveVideoEncodingCount++
		sample.IntervalFramesSent = frames - previous.Frames[index]
		sample.RID = forwarding.PublicationRID(index, len(current.Frames))
		sample.Width, sample.Height = sentVideoDimensions(source, index)
	}
	sample.FramesPerSecond = float64(sample.IntervalFramesSent) / seconds
	if current.Observed {
		capacity := float64(current.TargetBitrate) / 1000
		sample.AvailableOutgoingKbps = &capacity
		if publication.signaling.State() == webrtc.PeerConnectionStateConnected && sample.IntervalFramesSent > 0 {
			reason := "none"
			sample.State = "healthy"
			if current.Limited {
				reason, sample.State = "bandwidth", "degraded"
			}
			sample.Reason = &reason
		}
	}
	return sample, true
}

func (publication *Publication) Media() PublicationMedia {
	info := publication.transport.CurrentSource().TrackInfo()
	media := PublicationMedia{Codec: publication.source.codec, Audio: publication.audio != nil,
		AudioBitrate: publication.audio.configuredBitrate(), Layers: make([]PublicationLayer, len(info.Layers))}
	for index, layer := range info.Layers {
		media.Layers[index] = PublicationLayer{RID: forwarding.PublicationRID(index, len(info.Layers)),
			Width: layer.Width, Height: layer.Height, Bitrate: layer.Bitrate}
	}
	publication.transport.SetAudioBitrate(media.AudioBitrate)
	return media
}

func (publication *Publication) Close() error {
	publication.closeOnce.Do(func() {
		publication.signaling.mu.Lock()
		publication.signaling.closed = true
		if publication.signaling.localCandidates != nil {
			publication.signaling.localCandidates.close()
		}
		publication.signaling.mu.Unlock()
		if publication.transport != nil {
			publication.closeErr = publication.transport.Close()
		}
		publication.source.mu.Lock()
		delete(publication.source.publications, publication)
		publication.source.mu.Unlock()
		publication.source.releaseReservation(false)
		if publication.audio != nil {
			publication.audio.releaseReservation(false)
		}
		engine := publication.source.engine
		engine.mu.Lock()
		delete(engine.publications, publication)
		engine.mu.Unlock()
		publication.source.RequestRecoveryFrame()
	})
	return publication.closeErr
}
