package mediaedge

import (
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/client/nativeaudio"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

const opusSDPFmtpLine = "minptime=10;useinbandfec=1"

var opusCapability = webrtc.RTPCodecCapability{
	MimeType:    webrtc.MimeTypeOpus,
	ClockRate:   nativeaudio.SampleRate,
	Channels:    nativeaudio.Channels,
	SDPFmtpLine: opusSDPFmtpLine,
	RTCPFeedback: []webrtc.RTCPFeedback{
		{Type: webrtc.TypeRTCPFBTransportCC},
	},
}

// AudioSource owns one encoded Opus source and the same bounded edge capacity
// as the corresponding video source.
type AudioSource struct {
	engine   *Engine
	track    webrtc.TrackLocal
	samples  *webrtc.TrackLocalStaticSample
	packets  *webrtc.TrackLocalStaticRTP
	encoder  *nativeaudio.Encoder
	capacity int

	mu               sync.Mutex
	encodeMu         sync.Mutex
	edges            map[*Edge]bool
	reservations     int
	localReservation bool
	closed           bool
	bytes            atomic.Uint64
}

func (engine *Engine) NewAudioSource(capacity, bitrate int) (*AudioSource, error) {
	if capacity < 1 || capacity > 4 {
		return nil, errors.New("native audio source capacity is outside the route bound")
	}
	encoder, err := nativeaudio.NewEncoder(bitrate)
	if err != nil {
		return nil, err
	}
	engine.mu.Lock()
	defer engine.mu.Unlock()
	if engine.closed {
		return nil, errors.New("native media engine is closed")
	}
	track, err := webrtc.NewTrackLocalStaticSample(
		opusCapability,
		"audio",
		"piik-native",
	)
	if err != nil {
		return nil, err
	}
	return &AudioSource{
		engine: engine, track: track, samples: track, encoder: encoder,
		capacity: capacity, edges: make(map[*Edge]bool),
	}, nil
}

func (engine *Engine) NewRelayedAudioSource(capacity int) (*AudioSource, error) {
	if capacity < 1 || capacity > 4 {
		return nil, errors.New("native audio source capacity is outside the route bound")
	}
	engine.mu.Lock()
	defer engine.mu.Unlock()
	if engine.closed {
		return nil, errors.New("native media engine is closed")
	}
	track, err := webrtc.NewTrackLocalStaticRTP(
		opusCapability,
		"audio",
		"piik-native",
	)
	if err != nil {
		return nil, err
	}
	return &AudioSource{
		engine: engine, track: track, packets: track,
		capacity: capacity, edges: make(map[*Edge]bool),
	}, nil
}

func (source *AudioSource) WritePCM(pcm []byte, duration time.Duration) error {
	if source == nil || source.encoder == nil || duration <= 0 {
		return errors.New("native PCM sample is invalid")
	}
	source.encodeMu.Lock()
	defer source.encodeMu.Unlock()
	source.mu.Lock()
	closed := source.closed
	source.mu.Unlock()
	if closed {
		return errors.New("native audio source is closed")
	}
	packet, err := source.encoder.Encode(pcm)
	if err != nil {
		return err
	}
	source.bytes.Add(uint64(len(packet)))
	return source.samples.WriteSample(media.Sample{Data: packet, Duration: duration})
}

func (source *AudioSource) WriteRTP(packet *rtp.Packet) error {
	if source == nil || source.packets == nil || packet == nil {
		return errors.New("native Opus RTP packet is invalid")
	}
	source.mu.Lock()
	closed := source.closed
	source.mu.Unlock()
	if closed {
		return errors.New("native audio source is closed")
	}
	source.bytes.Add(uint64(len(packet.Payload)))
	forwarded := connectionNeutralRTP(packet)
	return source.packets.WriteRTP(&forwarded)
}

func (source *AudioSource) SetBitrate(bitrate int) error {
	if source == nil || source.encoder == nil {
		return errors.New("native audio source is unavailable")
	}
	source.encodeMu.Lock()
	defer source.encodeMu.Unlock()
	source.mu.Lock()
	closed := source.closed
	source.mu.Unlock()
	if closed {
		return errors.New("native audio source is closed")
	}
	if err := source.encoder.SetBitrate(bitrate); err != nil {
		return err
	}
	source.mu.Lock()
	edges := make([]*Edge, 0, len(source.edges))
	for edge := range source.edges {
		edges = append(edges, edge)
	}
	source.mu.Unlock()
	for _, edge := range edges {
		edge.transport.SetAudioBitrate(uint32(bitrate))
	}
	return nil
}

func (source *AudioSource) configuredBitrate() uint32 {
	if source == nil || source.encoder == nil {
		return 0
	}
	source.encodeMu.Lock()
	defer source.encodeMu.Unlock()
	return uint32(source.encoder.Bitrate())
}

func (source *AudioSource) snapshotBytes() uint64 {
	if source == nil {
		return 0
	}
	return source.bytes.Load()
}

func (source *AudioSource) reserve(local bool) error {
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.closed {
		return errors.New("native audio source is closed")
	}
	if local {
		if source.localReservation {
			return ErrSourceCapacity
		}
		for _, existingLocal := range source.edges {
			if existingLocal {
				return ErrSourceCapacity
			}
		}
		source.localReservation = true
		return nil
	}
	routeEdges := 0
	for _, existingLocal := range source.edges {
		if !existingLocal {
			routeEdges++
		}
	}
	if routeEdges+source.reservations >= source.capacity {
		return ErrSourceCapacity
	}
	source.reservations++
	return nil
}

func (source *AudioSource) attach(edge *Edge, local bool) error {
	source.mu.Lock()
	defer source.mu.Unlock()
	if local {
		source.localReservation = false
	} else if source.reservations > 0 {
		source.reservations--
	}
	if source.closed {
		return errors.New("native audio source is closed")
	}
	source.edges[edge] = local
	return nil
}

func (source *AudioSource) releaseReservation(local bool) {
	source.mu.Lock()
	if local {
		source.localReservation = false
	} else if source.reservations > 0 {
		source.reservations--
	}
	source.mu.Unlock()
}

func (source *AudioSource) detach(edge *Edge) {
	source.mu.Lock()
	delete(source.edges, edge)
	source.mu.Unlock()
}

func (source *AudioSource) Close() error {
	source.mu.Lock()
	if source.closed {
		source.mu.Unlock()
		return nil
	}
	source.closed = true
	edges := make([]*Edge, 0, len(source.edges))
	for edge := range source.edges {
		edges = append(edges, edge)
	}
	source.mu.Unlock()
	for _, edge := range edges {
		_ = edge.Close()
	}
	return nil
}
