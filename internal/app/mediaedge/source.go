package mediaedge

import (
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/TNTcraftHIM/Piik/internal/media/encoded"
	"github.com/TNTcraftHIM/Piik/internal/media/forwarding"
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
	Active         []bool
	RecoveryLayers []int
	Bitrates       []uint32
}

type Source struct {
	engine           *Engine
	codec            string
	media            *forwarding.EncodedSource
	formats          []atomic.Uint64
	outputBitrates   []uint32
	capacity         int
	requestKeyFrame  func()
	relayProfile     *nativecapture.VideoProfile
	relay            *relayDerivation
	groups           map[int]*outputGroup
	memberships      map[groupConsumer]*outputGroup
	groupRecovery    atomic.Uint32
	recoveryRequests chan struct{}
	recoveryStopped  chan struct{}
	inputPTS         time.Duration
	inputAt          time.Time
	hasInput         bool

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
	source.writeMu.Lock()
	defer source.writeMu.Unlock()
	source.media.SetLowestLayerRateControlled(controlled)
	for slot, group := range source.groups {
		if slot != 0 {
			group.media.SetLowestLayerRateControlled(controlled)
		}
	}
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
	return source.beginFrame(timestamp, time.Now())
}

func (source *Source) beginFrame(timestamp time.Duration, at time.Time) (OutputPlan, error) {
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
	if err := source.beginGroupFrame(timestamp, at); err != nil {
		return OutputPlan{}, err
	}
	for _, edge := range edges {
		if edge.State() != webrtc.PeerConnectionStateConnected {
			continue
		}
		if err := edge.transport.SetConnected(); err != nil {
			// Retirement can race the connected snapshot. An attachment failure
			// belongs to this consumer, not the shared capture and its siblings.
			unavailable = append(unavailable, edge)
			continue
		}
		if source.unavailableDemand(edge) {
			unavailable = append(unavailable, edge)
			continue
		}
		edge.transport.Output.BeginFrame()
	}
	if len(source.formats) == 2 && len(source.outputBitrates) >= 2 {
		plan, err := source.planGroups(source.collectDemands(edges, publications))
		for mask, slot := source.groupRecovery.Swap(0), 0; mask != 0; mask, slot = mask>>1, slot+1 {
			if mask&1 != 0 && slot < len(plan.Active) && plan.Active[slot] {
				plan.RecoveryLayers = append(plan.RecoveryLayers, slot)
			}
		}
		return plan, err
	}
	plan := OutputPlan{Active: make([]bool, len(source.outputBitrates)), Bitrates: append([]uint32(nil), source.outputBitrates...)}
	count := 0
	for _, edge := range edges {
		if edge.State() == webrtc.PeerConnectionStateConnected {
			count = max(count, edge.transport.RequiredActiveCount())
		}
	}
	for _, publication := range publications {
		count = max(count, publication.RequiredActiveCount())
	}
	for slot := 0; slot < min(count, len(plan.Active)); slot++ {
		plan.Active[slot] = true
	}
	return plan, nil
}

// ConfigureOutputs installs one validated capture generation's bitrate bounds.
// A zero slot subsequently means that producer has failed, not a new preset.
func (source *Source) ConfigureOutputs(ceilings []uint32) error {
	if len(ceilings) < len(source.formats) || len(ceilings) > len(source.formats)+source.capacity ||
		len(source.formats) != 2 && len(ceilings) != len(source.formats) {
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
	formats := make([]forwarding.LayerFormat, len(source.formats))
	for layer := range formats {
		format := source.formats[layer].Load()
		formats[layer] = forwarding.LayerFormat{Width: uint32(format >> 32), Height: uint32(format), Bitrate: ceilings[layer]}
	}
	if err := source.media.UpdateFormats(formats); err != nil {
		return err
	}
	for slot, group := range source.groups {
		group.budget = ceilings[slot]
		if slot != 0 {
			formats[0].Bitrate = ceilings[slot]
			if err := group.media.UpdateFormats(formats); err != nil {
				return err
			}
		}
	}
	return nil
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
	group := source.groups[layer]
	for publication := range source.publications {
		if layer == 1 || group == nil && layer < len(source.formats) || group != nil &&
			(publication.transport.CurrentSource() == group.media.Source || source.memberships[publication.transport] == group) {
			publications = append(publications, publication)
		}
	}
	var affected []*Edge
	for edge := range source.edges {
		state := edge.transport.Output.State()
		_, observed := edge.transport.TargetBitrate()
		selectedLayer := int32(layer)
		if group != nil {
			if source.memberships[edge.transport] == group {
				affected = append(affected, edge)
				continue
			}
			if edge.transport.CurrentSource() != group.media.Source {
				continue
			}
			selectedLayer = 0
		}
		if state.Target == selectedLayer || state.Current == selectedLayer ||
			(observed && state.Paused && state.Prepare == selectedLayer) ||
			(state.Target < 0 && state.Current < 0 && edge.transport.Output.MaxLayer().Spatial == selectedLayer) {
			affected = append(affected, edge)
		}
	}
	source.mu.Unlock()
	media, logical := source.media, layer
	if group != nil {
		media, logical = group.media, 0
		group.active = false
		media.SetLowestLayerRateControlled(false)
	}
	if logical < len(source.formats) {
		if tracker := media.StreamTrackerManager().GetTracker(int32(logical)); tracker != nil {
			tracker.SetPaused(true)
		}
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
	return source.writeVideo(layer, frame)
}

// Caller serializes capture/source generation with this output.
func (source *Source) writeVideo(layer int, frame encoded.Frame) error {
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
	if len(frame.Data) == 0 || frame.Duration <= 0 || !source.hasInput || frame.PTS < 0 || frame.PTS > source.inputPTS {
		return errors.New("encoded output has no matching source input")
	}
	if len(source.formats) != 2 {
		return source.media.WriteFrame(layer, frame)
	}
	if layer == 1 {
		if err := source.media.WriteFrame(1, frame); err != nil {
			return err
		}
		for slot, group := range source.groups {
			if slot != 0 && group.active && frame.PTS >= group.start {
				if err := group.media.WriteFrame(1, frame); err != nil {
					return err
				}
			}
		}
		if frame.Recovery {
			source.installGroup(nil, true)
		}
		return nil
	}
	group := source.groups[layer]
	if group == nil {
		if layer == 0 {
			return source.media.WriteFrame(0, frame)
		}
		return nil
	}
	if !group.active || frame.PTS < group.start {
		return nil
	}
	if err := group.media.WriteFrame(0, frame); err != nil {
		return err
	}
	if frame.Recovery {
		source.installGroup(group, false)
	}
	return nil
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
	recovery := false
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
			recovery = true
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
	for slot, group := range source.groups {
		if slot != 0 && group.active {
			if groupErr := group.media.Source.WriteRTP(layer, &forwarded); err == nil {
				err = groupErr
			}
		}
	}
	if recovery && err == nil {
		source.installGroup(nil, true)
	}
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
	physical := selected
	if selected == 0 {
		if group := source.groupForMedia(edge.transport.CurrentSource()); group != nil {
			physical = int32(group.slot)
		}
	}
	if selected >= 0 && !source.failedOutput(physical) {
		return false
	}
	fallback := int32(edge.transport.RequiredActiveCount() - 1)
	if fallback == 0 {
		if group := source.groupForMedia(edge.transport.CurrentSource()); group != nil {
			fallback = int32(group.slot)
		}
	}
	return source.failedOutput(fallback)
}

func (source *Source) failedOutput(layer int32) bool {
	return layer >= 0 && int(layer) < len(source.outputBitrates) && source.outputBitrates[layer] == 0
}

func (source *Source) SenderReport(report *rtcp.SenderReport) error {
	source.writeMu.Lock()
	defer source.writeMu.Unlock()
	correlated := *report
	layer := len(source.formats) - 1
	correlated.SSRC = uint32(layer + 1)
	err := source.media.SenderReport(layer, &correlated)
	for slot, group := range source.groups {
		if slot != 0 && group.active {
			if groupErr := group.media.SenderReport(layer, &correlated); err == nil {
				err = groupErr
			}
		}
	}
	return err
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
	source.hasInput = false
	for slot, group := range source.groups {
		group.start = 0
		if slot != 0 {
			group.media.BeginGeneration()
		}
	}
}

func (source *Source) SetFormat(layer int, width, height uint32) error {
	source.writeMu.Lock()
	defer source.writeMu.Unlock()
	return source.setFormat(layer, width, height)
}

func (source *Source) setFormat(layer int, width, height uint32) error {
	if layer < 0 || layer >= max(len(source.formats), len(source.outputBitrates)) || width == 0 || height == 0 {
		return errors.New("native output format is invalid")
	}
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.closed {
		return io.ErrClosedPipe
	}
	format := uint64(width)<<32 | uint64(height)
	if layer >= len(source.formats) {
		if group := source.groups[layer]; group != nil {
			return group.media.UpdateDimensions(0, width, height)
		}
		return nil
	}
	if err := source.media.UpdateDimensions(layer, width, height); err != nil {
		return err
	}
	source.formats[layer].Store(format)
	if layer == 1 {
		for slot, group := range source.groups {
			if slot != 0 {
				if err := group.media.UpdateDimensions(1, width, height); err != nil {
					return err
				}
			}
		}
	}
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
		highest := len(source.formats) - 1
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
	source.RequestRecoveryFrame()
}

func (source *Source) requestLayerKeyFrame(layer int) {
	source.groupRecovery.Or(uint32(1) << layer)
	source.RequestRecoveryFrame()
}

func (source *Source) RequestRecoveryFrame() {
	if source.requestKeyFrame != nil {
		select {
		case source.recoveryRequests <- struct{}{}:
		default:
		}
	}
}

// One coalescing notification owner per source, never per encoder or frame.
// Producer I/O cannot reenter a source lock from a forwarding callback.
func (source *Source) runRecovery() {
	var engineDone <-chan struct{}
	if source.engine.ctx != nil {
		engineDone = source.engine.ctx.Done()
	}
	for {
		select {
		case <-engineDone:
			return
		case <-source.recoveryStopped:
			return
		case <-source.recoveryRequests:
			source.mu.Lock()
			closed := source.closed
			source.mu.Unlock()
			if !closed {
				source.requestKeyFrame()
			}
		}
	}
}

func (source *Source) Close() error {
	source.mu.Lock()
	if source.closed {
		source.mu.Unlock()
		return nil
	}
	source.closed = true
	if source.recoveryStopped != nil {
		close(source.recoveryStopped)
	}
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
	for slot, group := range source.groups {
		if slot != 0 {
			group.media.Close()
		}
	}
	source.media.Close()
	source.writeMu.Unlock()
	return nil
}
