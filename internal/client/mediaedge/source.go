package mediaedge

import (
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"github.com/TNTcraftHIM/Screener/internal/client/nativecapture"
	"github.com/TNTcraftHIM/Screener/internal/media/encoded"
	"github.com/TNTcraftHIM/Screener/internal/media/forwarding"
	mediacodec "github.com/livekit/mediatransportutil/pkg/codec"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

const videoClockRate = 90_000
const videoPacketMTU = 1200
const h264PayloadType = 102
const vp8PayloadType = 96

var ErrSourceCapacity = errors.New("native media source capacity is exhausted")

// OutputPlan belongs to the capture input that produced it. The caller applies
// it to that exact stream after BeginFrame releases the source locks.
type OutputPlan struct {
	ActiveLayers   int
	RecoveryLayers []int
	Bitrates       []uint32
}

type Source struct {
	engine          *Engine
	codec           string
	media           *forwarding.EncodedSource
	formats         []atomic.Uint64
	outputBitrates  []uint32
	capacity        int
	requestKeyFrame func()
	relayProfile    *nativecapture.VideoProfile
	relay           *relayDerivation

	mu               sync.Mutex
	writeMu          sync.Mutex
	edges            map[*Edge]bool
	publications     map[*Publication]struct{}
	reservations     int
	localReservation bool
	closed           bool
}

func (source *Source) Codec() string { return source.codec }

func (source *Source) SetLowestLayerRateControlled(controlled bool) {
	source.media.SetLowestLayerRateControlled(controlled)
}

// The room supplies a relay ceiling, never a replacement capture authority.
// Recording it does not create an encoder or invoke the capture process.
func (source *Source) SetRelayProfile(profile nativecapture.VideoProfile) error {
	if !profile.Valid() {
		return errors.New("native relay profile is invalid")
	}
	source.mu.Lock()
	if source.closed {
		source.mu.Unlock()
		return io.ErrClosedPipe
	}
	if source.relayProfile != nil && *source.relayProfile == profile {
		source.mu.Unlock()
		return nil
	}
	source.relayProfile = &profile
	source.mu.Unlock()
	if source.relay != nil {
		source.relay.cancel()
		source.writeMu.Lock()
		defer source.writeMu.Unlock()
		return source.configureRelayFormats(true)
	}
	return nil
}

// BeginFrame runs once before outputs for an actual source input. Unconnected
// edges retain their capacity reservation but do not demand encoded output yet.
func (source *Source) BeginFrame(timestamp time.Duration) (OutputPlan, error) {
	source.writeMu.Lock()
	var unavailable []*Edge
	defer func() {
		source.writeMu.Unlock()
		closeEdges(unavailable)
	}()
	source.mu.Lock()
	if source.closed {
		source.mu.Unlock()
		return OutputPlan{}, io.ErrClosedPipe
	}
	edges := make([]*Edge, 0, len(source.edges))
	for edge := range source.edges {
		edges = append(edges, edge)
	}
	publications := make([]*Publication, 0, len(source.publications))
	for publication := range source.publications {
		publications = append(publications, publication)
	}
	source.mu.Unlock()
	if err := source.media.BeginFrame(timestamp, time.Now()); err != nil {
		return OutputPlan{}, err
	}
	plan := OutputPlan{
		Bitrates: append([]uint32(nil), source.outputBitrates...),
	}
	for _, publication := range publications {
		active := publication.RequiredActiveCount()
		plan.ActiveLayers = max(plan.ActiveLayers, active)
		if budget := publication.LowestLayerBudget(); active > 0 && len(plan.Bitrates) > 0 && budget > 0 {
			budget = source.media.CodecBudget(0, budget)
			plan.Bitrates[0] = min(plan.Bitrates[0], uint32(max(1000, min(budget, int64(plan.Bitrates[0])))))
		}
	}
	for _, edge := range edges {
		if edge.State() != webrtc.PeerConnectionStateConnected {
			continue
		}
		if err := edge.transport.SetConnected(); err != nil {
			return OutputPlan{}, err
		}
		if source.unavailableDemand(edge) {
			unavailable = append(unavailable, edge)
			continue
		}
		state := edge.transport.Output.State()
		highest := state.Target
		if !state.Paused {
			highest = max(highest, state.Current)
		}
		if _, observed := edge.transport.TargetBitrate(); observed {
			if !source.failedOutput(state.Prepare) {
				highest = max(highest, state.Prepare)
			}
			// Only consumers of the lowest representation constrain that encoder.
			// A limited child never changes a healthy sibling's higher output.
			if len(plan.Bitrates) > 0 && state.VideoBudget > 0 &&
				(state.Target == 0 || state.Current == 0 || state.Paused && state.Prepare == 0) {
				budget := source.media.CodecBudget(0, state.VideoBudget)
				plan.Bitrates[0] = min(plan.Bitrates[0], uint32(max(1000, min(budget, int64(plan.Bitrates[0])))))
			}
		}
		if highest < 0 && !state.Paused {
			highest = int32(len(source.formats) - 1)
		}
		plan.ActiveLayers = max(plan.ActiveLayers, int(highest)+1)
		edge.transport.Output.BeginFrame()
	}
	return plan, nil
}

// ConfigureOutputs installs one validated capture generation's bitrate bounds.
// A zero slot subsequently means that producer has failed, not a new preset.
func (source *Source) ConfigureOutputs(ceilings []uint32) error {
	if len(ceilings) != len(source.formats) {
		return errors.New("native output count does not match the source")
	}
	for _, bitrate := range ceilings {
		if bitrate < 1000 {
			return errors.New("native output bitrate is invalid")
		}
	}
	source.writeMu.Lock()
	defer source.writeMu.Unlock()
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.closed {
		return io.ErrClosedPipe
	}
	source.outputBitrates = append([]uint32(nil), ceilings...)
	formats := make([]forwarding.LayerFormat, len(ceilings))
	for layer, bitrate := range ceilings {
		format := source.formats[layer].Load()
		formats[layer] = forwarding.LayerFormat{Width: uint32(format >> 32), Height: uint32(format), Bitrate: bitrate}
	}
	return source.media.UpdateFormats(formats)
}

func (source *Source) DisableLayer(layer int) error {
	retire, err := source.markLayerUnavailable(layer, nil)
	if retire != nil {
		retire()
	}
	return err
}

func (source *Source) markLayerUnavailable(layer int, run *relayRun) (func(), error) {
	if run != nil {
		run.owner.mu.Lock()
		defer run.owner.mu.Unlock()
	}
	source.writeMu.Lock()
	defer source.writeMu.Unlock()
	source.mu.Lock()
	if run != nil && (run.owner.run != run || source.relayProfile != run.plan.profile ||
		source.formats[len(source.formats)-1].Load() != run.plan.format) {
		source.mu.Unlock()
		return nil, nil
	}
	if source.closed || layer < 0 || layer >= len(source.outputBitrates) {
		source.mu.Unlock()
		return nil, errors.New("native output layer is unavailable")
	}
	source.outputBitrates[layer] = 0
	if layer == 0 {
		source.media.SetLowestLayerRateControlled(false)
	}
	publications := make([]*Publication, 0, len(source.publications))
	for publication := range source.publications {
		publications = append(publications, publication)
	}
	var affected []*Edge
	for edge := range source.edges {
		state := edge.transport.Output.State()
		_, observed := edge.transport.TargetBitrate()
		if state.Target == int32(layer) || state.Current == int32(layer) ||
			(observed && state.Paused && state.Prepare == int32(layer)) ||
			(state.Target < 0 && state.Current < 0 && edge.transport.Output.MaxLayer().Spatial == int32(layer)) {
			affected = append(affected, edge)
		}
	}
	source.mu.Unlock()
	if tracker := source.media.StreamTrackerManager().GetTracker(int32(layer)); tracker != nil {
		tracker.SetPaused(true)
	}
	// An unavailable encoder retires its consumers through the existing edge
	// lifecycle. Healthy sibling outputs are neither stopped nor restarted.
	return func() {
		closeEdges(affected)
		// Publication metadata declares every slot, including paused or preparing
		// uploads. None may publish a descriptor containing a failed encoding.
		for _, publication := range publications {
			_ = publication.Close()
		}
	}, nil
}

func (source *Source) WriteVideo(layer int, frame encoded.Frame) error {
	source.writeMu.Lock()
	defer source.writeMu.Unlock()
	source.mu.Lock()
	closed := source.closed
	source.mu.Unlock()
	if closed {
		return io.ErrClosedPipe
	}
	if len(source.outputBitrates) > 0 &&
		(layer < 0 || layer >= len(source.outputBitrates) || source.outputBitrates[layer] == 0) {
		return errors.New("native output layer is unavailable")
	}
	return source.media.WriteFrame(layer, frame)
}

// WriteRTP preserves the received representation. Optional lower derivation is
// fed without waiting for its decoder, encoder, or process pipe.
func (source *Source) WriteRTP(packet *rtp.Packet) error {
	if packet == nil {
		return errors.New("native video RTP packet is invalid")
	}
	source.writeMu.Lock()
	source.mu.Lock()
	if source.closed {
		source.mu.Unlock()
		source.writeMu.Unlock()
		return io.ErrClosedPipe
	}
	source.mu.Unlock()
	layer := len(source.formats) - 1
	if source.relay != nil {
		var size mediacodec.VideoSize
		if source.codec == "h264" {
			size = mediacodec.ExtractH264VideoSize(packet.Payload)
		} else {
			var header mediacodec.VP8
			if header.Unmarshal(packet.Payload) == nil {
				size = mediacodec.ExtractVP8VideoSize(&header, packet.Payload)
			}
		}
		if size.Width > 0 && size.Height > 0 {
			format := uint64(size.Width)<<32 | uint64(size.Height)
			if source.formats[layer].Swap(format) != format {
				_ = source.configureRelayFormats(false)
			}
		}
	}
	forwarded := connectionNeutralRTP(packet)
	forwarded.SSRC = uint32(layer + 1)
	forwarded.PayloadType = uint8(videoCodecs[source.codec].PayloadType)
	err := source.media.Source.WriteRTP(layer, &forwarded)
	var unavailable []*Edge
	if packet.Marker {
		source.mu.Lock()
		for edge := range source.edges {
			if edge.State() == webrtc.PeerConnectionStateConnected && source.unavailableDemand(edge) {
				unavailable = append(unavailable, edge)
			}
		}
		source.mu.Unlock()
	}
	source.writeMu.Unlock()
	closeEdges(unavailable)
	if source.relay != nil {
		source.relay.push(packet)
	}
	return err
}

// Called with writeMu held. Preparation is advisory; the source owns whether
// that requested codec output still exists after a producer failure.
func (source *Source) unavailableDemand(edge *Edge) bool {
	state := edge.transport.Output.State()
	selected := state.Target
	if !state.Paused {
		selected = max(selected, state.Current)
	}
	if selected >= 0 && !source.failedOutput(selected) {
		return false
	}
	return source.failedOutput(int32(edge.transport.RequiredActiveCount() - 1))
}

func (source *Source) failedOutput(layer int32) bool {
	return layer >= 0 && int(layer) < len(source.outputBitrates) && source.outputBitrates[layer] == 0
}

func (source *Source) SenderReport(report *rtcp.SenderReport) error {
	correlated := *report
	layer := len(source.formats) - 1
	correlated.SSRC = uint32(layer + 1)
	return source.media.SenderReport(layer, &correlated)
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
	defer source.writeMu.Unlock()
	source.media.BeginGeneration()
}

func (source *Source) SetFormat(layer int, width, height uint32) error {
	if layer < 0 || layer >= len(source.formats) || width == 0 || height == 0 {
		return errors.New("native output format is invalid")
	}
	source.writeMu.Lock()
	defer source.writeMu.Unlock()
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.closed {
		return io.ErrClosedPipe
	}
	format := uint64(width)<<32 | uint64(height)
	if err := source.media.UpdateDimensions(layer, width, height); err != nil {
		return err
	}
	source.formats[layer].Store(format)
	return nil
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
	source.writeMu.Lock()
	defer source.writeMu.Unlock()
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
	if len(source.outputBitrates) > 0 {
		highest := len(source.outputBitrates) - 1
		for highest >= 0 && source.outputBitrates[highest] == 0 {
			highest--
		}
		if highest < 0 {
			return errors.New("native media source has no available output")
		}
		edge.transport.Output.SetMaxSpatialLayer(int32(highest))
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
	source.writeMu.Lock()
	source.mu.Lock()
	delete(source.edges, edge)
	source.mu.Unlock()
	source.writeMu.Unlock()
	if source.relay != nil && !source.relayPlan().wanted {
		source.relay.cancel()
	}
}

func (source *Source) requestLayerKeyFrame(layer int) {
	if source.relay != nil && layer < len(source.formats)-1 {
		source.relay.recovery.Store(true)
	}
	source.RequestRecoveryFrame()
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
	publications := make([]*Publication, 0, len(source.publications))
	for publication := range source.publications {
		publications = append(publications, publication)
	}
	edges := make([]*Edge, 0, len(source.edges))
	for edge := range source.edges {
		edges = append(edges, edge)
	}
	source.mu.Unlock()
	// Close transports before waiting on their possible writes into this group.
	closeEdges(edges)
	for _, publication := range publications {
		_ = publication.Close()
	}
	if source.relay != nil {
		source.relay.close()
	}
	source.writeMu.Lock()
	source.media.Close()
	source.writeMu.Unlock()
	return nil
}
