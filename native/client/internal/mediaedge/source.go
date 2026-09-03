package mediaedge

import (
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

const maxAccessUnitBytes = 4 * 1024 * 1024

var ErrSourceCapacity = errors.New("native media source capacity is exhausted")

type Source struct {
	engine          *Engine
	track           *webrtc.TrackLocalStaticSample
	capacity        int
	requestKeyFrame func()

	mu           sync.Mutex
	edges        map[*Edge]struct{}
	reservations int
	closed       bool
	frames       atomic.Uint64
	bytes        atomic.Uint64
	format       atomic.Uint64
}

func (source *Source) WriteH264(accessUnit []byte, duration time.Duration) error {
	if len(accessUnit) == 0 || len(accessUnit) > maxAccessUnitBytes || duration <= 0 {
		return errors.New("native H264 access unit is invalid")
	}
	source.mu.Lock()
	closed := source.closed
	source.mu.Unlock()
	if closed {
		return errors.New("native media source is closed")
	}
	source.frames.Add(1)
	source.bytes.Add(uint64(len(accessUnit)))
	return source.track.WriteSample(media.Sample{Data: accessUnit, Duration: duration})
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

func (source *Source) reserve() error {
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.closed {
		return errors.New("native media source is closed")
	}
	if len(source.edges)+source.reservations >= source.capacity {
		return ErrSourceCapacity
	}
	source.reservations++
	return nil
}

func (source *Source) attach(edge *Edge) error {
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.reservations > 0 {
		source.reservations--
	}
	if source.closed {
		return errors.New("native media source is closed")
	}
	source.edges[edge] = struct{}{}
	return nil
}

func (source *Source) releaseReservation() {
	source.mu.Lock()
	if source.reservations > 0 {
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
