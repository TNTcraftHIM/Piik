package mediaedge

import (
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

const maxAccessUnitBytes = 4 * 1024 * 1024
const videoClockRate = 90_000
const videoPacketMTU = 1200
const h264PayloadType = 102
const vp8PayloadType = 96

var ErrSourceCapacity = errors.New("native media source capacity is exhausted")
var ErrInvalidVideoTimestamp = errors.New("native video timestamp is not monotonic")

type Source struct {
	engine          *Engine
	track           *webrtc.TrackLocalStaticRTP
	codec           string
	packetizer      rtp.Packetizer
	capacity        int
	requestKeyFrame func()

	mu                 sync.Mutex
	writeMu            sync.Mutex
	edges              map[*Edge]bool
	reservations       int
	localReservation   bool
	closed             bool
	hasTimestamp       bool
	lastTimestamp      time.Duration
	timestampRemainder float64
	rebasePending      bool
	rebaseInput        time.Duration
	rebaseOutput       time.Duration
	frames             atomic.Uint64
	bytes              atomic.Uint64
	format             atomic.Uint64
}

func (source *Source) Codec() string { return source.codec }

func (source *Source) WriteVideo(
	accessUnit []byte,
	timestamp time.Duration,
	duration time.Duration,
) error {
	if len(accessUnit) == 0 || len(accessUnit) > maxAccessUnitBytes ||
		timestamp < 0 || duration <= 0 {
		return errors.New("native video access unit is invalid")
	}
	source.writeMu.Lock()
	defer source.writeMu.Unlock()
	source.mu.Lock()
	closed := source.closed
	source.mu.Unlock()
	if closed {
		return errors.New("native media source is closed")
	}
	if source.rebasePending {
		source.rebasePending = false
		source.rebaseInput = timestamp
		source.rebaseOutput = source.lastTimestamp + duration
		timestamp = source.rebaseOutput
	} else if source.rebaseOutput > 0 {
		if timestamp < source.rebaseInput {
			return ErrInvalidVideoTimestamp
		}
		timestamp = source.rebaseOutput + timestamp - source.rebaseInput
	}
	if source.hasTimestamp {
		if timestamp <= source.lastTimestamp {
			return ErrInvalidVideoTimestamp
		}
		ticksFloat := (timestamp-source.lastTimestamp).Seconds()*videoClockRate +
			source.timestampRemainder
		ticks := uint64(ticksFloat)
		source.timestampRemainder = ticksFloat - float64(ticks)
		source.packetizer.SkipSamples(uint32(ticks))
	} else {
		source.hasTimestamp = true
	}
	source.lastTimestamp = timestamp
	packets := source.packetizer.Packetize(accessUnit, 0)
	if len(packets) == 0 {
		return errors.New("native video access unit produced no RTP packets")
	}
	source.frames.Add(1)
	source.bytes.Add(uint64(len(accessUnit)))
	var result error
	for _, packet := range packets {
		result = errors.Join(result, source.track.WriteRTP(packet))
	}
	return result
}

// WriteRTP forwards one already encoded video packet without decoding or
// re-encoding it. TrackLocalStaticRTP rewrites the negotiated SSRC and payload
// type independently for every bound edge.
func (source *Source) WriteRTP(packet *rtp.Packet) error {
	if packet == nil {
		return errors.New("native video RTP packet is invalid")
	}
	source.writeMu.Lock()
	defer source.writeMu.Unlock()
	source.mu.Lock()
	closed := source.closed
	source.mu.Unlock()
	if closed {
		return errors.New("native media source is closed")
	}
	// Forward RTP padding to preserve sequence continuity without counting it as video.
	if packet.Marker && len(packet.Payload) > 0 {
		source.frames.Add(1)
	}
	source.bytes.Add(uint64(len(packet.Payload)))
	forwarded := connectionNeutralRTP(packet)
	return source.track.WriteRTP(&forwarded)
}

func connectionNeutralRTP(packet *rtp.Packet) rtp.Packet {
	forwarded := *packet
	forwarded.Header = packet.Header
	// Header extensions are negotiated per PeerConnection. The outbound Pion
	// interceptors add fresh TWCC using that edge's negotiated ID.
	forwarded.Extension = false
	forwarded.ExtensionProfile = 0
	forwarded.Extensions = nil
	return forwarded
}

func (source *Source) BeginGeneration() {
	source.writeMu.Lock()
	source.rebasePending = true
	source.rebaseInput = 0
	source.rebaseOutput = 0
	source.writeMu.Unlock()
}

func (source *Source) SetFormat(width, height uint32) {
	source.format.Store(uint64(width)<<32 | uint64(height))
}

type sourceSnapshot struct {
	frames uint64
	bytes  uint64
	width  uint32
	height uint32
}

func (source *Source) snapshot() sourceSnapshot {
	format := source.format.Load()
	return sourceSnapshot{
		frames: source.frames.Load(),
		bytes:  source.bytes.Load(),
		width:  uint32(format >> 32),
		height: uint32(format),
	}
}

func (source *Source) reserve(local bool) error {
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.closed {
		return errors.New("native media source is closed")
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

func (source *Source) attach(edge *Edge, local bool) error {
	source.mu.Lock()
	defer source.mu.Unlock()
	if local {
		source.localReservation = false
	} else if source.reservations > 0 {
		source.reservations--
	}
	if source.closed {
		return errors.New("native media source is closed")
	}
	source.edges[edge] = local
	return nil
}

func (source *Source) releaseReservation(local bool) {
	source.mu.Lock()
	if local {
		source.localReservation = false
	} else if source.reservations > 0 {
		source.reservations--
	}
	source.mu.Unlock()
}

func (source *Source) detach(edge *Edge) {
	source.mu.Lock()
	delete(source.edges, edge)
	source.mu.Unlock()
}

func (source *Source) RequestRecoveryFrame() {
	if source.requestKeyFrame != nil {
		source.requestKeyFrame()
	}
}

func (source *Source) Close() error {
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
