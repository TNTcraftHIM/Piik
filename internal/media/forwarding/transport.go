package forwarding

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/TNTcraftHIM/Screener/internal/diagnostics"
	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/livekit/livekit-server/pkg/sfu/buffer"
	"github.com/livekit/livekit-server/pkg/sfu/bwe"
	"github.com/livekit/livekit-server/pkg/sfu/bwe/sendsidebwe"
	"github.com/livekit/livekit-server/pkg/sfu/ccutils"
	"github.com/livekit/livekit-server/pkg/sfu/pacer"
	"github.com/livekit/livekit-server/pkg/sfu/streamallocator"
	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/logger"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/transport/v4/packetio"
	"github.com/pion/webrtc/v4"
)

type TransportOptions struct {
	Source         *Source
	Settings       webrtc.SettingEngine
	ConnectionID   string
	InitialBitrate int
	Audio          webrtc.TrackLocal
	// OnDemandChanged must only signal its owner without blocking or reentering
	// Transport. Callers can coalesce signals in their existing bounded owner.
	OnDemandChanged func()
}

// Transport is outgoing-only. Its caller owns signaling, ICE events and the
// shared UDP mux. Video RTCP is callback-driven; never read VideoSender's RTCP.
type Transport struct {
	PC           *webrtc.PeerConnection
	Output       *Output
	VideoSender  *webrtc.RTPSender
	AudioSender  *webrtc.RTPSender
	source       *Source
	estimator    *sendsidebwe.SendSideBWE
	prober       *ccutils.Prober
	probe        ccutils.ProbeClusterInfo
	target       atomic.Int64
	pacer        *boundedPacer
	observed     atomic.Bool
	mu           sync.Mutex
	attached     bool
	closed       bool
	audioBitrate uint32
	paddingReady bool
	closeOnce    sync.Once
	closeErr     error
	readers      sync.WaitGroup
}

func NewTransport(options TransportOptions) (_ *Transport, err error) {
	if options.Source == nil || options.ConnectionID == "" || options.InitialBitrate <= 0 {
		return nil, errors.New("forwarding transport options are invalid")
	}
	transport := &Transport{source: options.Source}
	transport.target.Store(int64(options.InitialBitrate))
	defer func() {
		if err != nil {
			_ = transport.Close()
		}
	}()
	codec := options.Source.Codec()
	media := &webrtc.MediaEngine{}
	if err = media.RegisterCodec(codec, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, err
	}
	if options.Audio != nil {
		audio, ok := options.Audio.(interface {
			Codec() webrtc.RTPCodecCapability
		})
		if !ok {
			return nil, errors.New("forwarding audio codec is unavailable")
		}
		if err = media.RegisterCodec(webrtc.RTPCodecParameters{
			RTPCodecCapability: audio.Codec(), PayloadType: 111,
		}, webrtc.RTPCodecTypeAudio); err != nil {
			return nil, err
		}
	}
	factory := buffer.NewFactoryOfBufferFactory(options.Source.maxPackets, buffer.InitPacketBufferSizeAudio).CreateBufferFactory()
	settings := options.Settings
	if slog.Default().Enabled(context.Background(), slog.LevelDebug) {
		settings.LoggerFactory = diagnostics.PionLoggerFactory("connectionId", diagnostics.ID(options.ConnectionID))
	}
	settings.BufferFactory = func(kind packetio.BufferPacketType, ssrc uint32) io.ReadWriteCloser {
		if kind == packetio.RTCPBufferPacket {
			if reader := factory.GetRTCPReader(ssrc); reader != nil {
				return reader
			}
		}
		// Preserve stock Pion SRTP/SRTCP bounds for unclaimed streams, including audio.
		input := packetio.NewBuffer()
		limit := 1_000_000
		if kind == packetio.RTCPBufferPacket {
			limit = 100_000
		}
		input.SetLimitSize(limit)
		return input
	}
	registry := &interceptor.Registry{}
	// LiveKit records actual paced sends and owns this extension's sequence space.
	if err = media.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{
		URI: "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
	}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, err
	}
	// DownTrack owns video retransmission; registering default NACK interceptors
	// here would create a second responder. Pion still owns normal RTCP reports.
	if err = webrtc.ConfigureRTCPReports(registry); err != nil {
		return nil, err
	}
	transport.PC, err = webrtc.NewAPI(webrtc.WithMediaEngine(media),
		webrtc.WithInterceptorRegistry(registry), webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, err
	}
	log := diagnostics.MediaLogger("transport").WithValues("connectionId", diagnostics.ID(options.ConnectionID))
	log.Debugw("transport-created", "rtcPeerId", diagnostics.ID(transport.PC.ID()), "codec", codec.MimeType,
		"initialBitrate", options.InitialBitrate, "packetCapacity", options.Source.maxPackets)
	transport.estimator = sendsidebwe.NewSendSideBWE(sendsidebwe.SendSideBWEParams{
		Config: sendsidebwe.DefaultSendSideBWEConfig, Logger: log,
	})
	transport.estimator.SetBWEListener(transport)
	transport.prober = ccutils.NewProber(ccutils.ProberParams{Listener: transport, Logger: log})
	// Use the pinned Pion pacer's 5 ms service cadence, with LiveKit packet
	// ownership and a cap matching this connection's retransmission cache.
	transport.pacer = newBoundedPacer(pacer.NewLeakyBucket(log, nil, 5*time.Millisecond, options.InitialBitrate),
		log, options.Source.maxPackets)
	transport.pacer.SetBitrate(options.InitialBitrate)
	transport.pacer.sender = pacer.NewBase(log, transport.estimator)
	transport.pacer.SetPacerProbeObserverListener(transport)
	track, err := sfu.NewDownTrack(sfu.DownTrackParams{
		Codecs: []webrtc.RTPCodecParameters{codec}, Source: livekit.TrackSource_SCREEN_SHARE,
		Receiver: &outputReceiver{Source: options.Source}, BufferFactory: factory, SubID: livekit.ParticipantID(options.ConnectionID),
		StreamID: options.Source.StreamID(), MaxTrack: options.Source.maxPackets,
		Pacer: transport.pacer, Logger: log, Listener: transport,
		RTCPWriter: transport.PC.WriteRTCP, DisableSenderReportPassThrough: true,
		EnableStartAtDesiredQuality: true,
	})
	if err != nil {
		return nil, err
	}
	transport.Output = NewOutput(track, int64(options.InitialBitrate))
	track.Receiver().(*outputReceiver).output = transport.Output
	transport.Output.onActivity = transport.mediaActivity
	transport.Output.onDemandChanged = options.OnDemandChanged
	track.SetStreamAllocatorListener(transport)
	track.AddReceiverReportListener(func(*sfu.DownTrack, *rtcp.ReceiverReport) {
		transport.mu.Lock()
		defer transport.mu.Unlock()
		if !transport.closed {
			transport.paddingReady = true
			transport.driveProbeLocked()
		}
	})
	// Spatial selection arms acquisition; its temporal bound must already be valid.
	transport.Output.SetMaxTemporalLayer(0)
	transport.Output.SetMaxSpatialLayer(int32(len(options.Source.TrackInfo().Layers) - 1))
	transceiver, err := transport.PC.AddTransceiverFromTrack(track,
		webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	if err != nil {
		return nil, err
	}
	track.SetTransceiver(transceiver)
	transport.VideoSender = transceiver.Sender()
	if options.Audio != nil {
		transport.AudioSender, err = transport.PC.AddTrack(options.Audio)
		if err != nil {
			return nil, err
		}
		transport.readers.Add(1)
		go func() {
			defer transport.readers.Done()
			for {
				if _, _, readErr := transport.AudioSender.ReadRTCP(); readErr != nil {
					return
				}
			}
		}()
	}
	return transport, nil
}

func (transport *Transport) SetConnected() error {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if transport.closed {
		return io.ErrClosedPipe
	}
	if transport.attached {
		return nil
	}
	receiver := transport.Output.Receiver().(*outputReceiver)
	receiver.attached = true
	if err := receiver.AddDownTrack(transport.Output); err != nil {
		receiver.attached = false
		return err
	}
	transport.attached = true
	transport.Output.SetConnected()
	transport.Output.Reconcile()
	return nil
}

func (transport *Transport) CurrentSource() *Source {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	return transport.source
}

// ReplaceSource retains the connection and its congestion state. The caller
// prepares recovery in next and serializes group lifetime with this handoff.
func (transport *Transport) ReplaceSource(next *Source) error {
	recovery := false
	// Register first so feedback runs after every lock below has been released.
	defer func() {
		if recovery {
			for layer := range next.TrackInfo().Layers {
				next.SendPLI(int32(layer), true)
			}
		}
	}()
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if transport.closed || transport.Output.IsClosed() {
		return io.ErrClosedPipe
	}
	if next == nil {
		return errors.New("replacement video source is absent")
	}
	next.mu.Lock()
	defer next.mu.Unlock()
	if err := validateReplacement(transport.source, next); err != nil {
		return err
	}
	if next == transport.source {
		return nil
	}
	receiver := &outputReceiver{Source: next, output: transport.Output, attached: transport.attached}
	if err := transport.Output.replaceReceiver(receiver); err != nil {
		return err
	}
	transport.source = next
	recovery = transport.attached
	return nil
}

// next.mu prevents source closure between validation and receiver attachment.
func validateReplacement(current, next *Source) error {
	if next.closed || next.IsClosed() {
		return io.ErrClosedPipe
	}
	before, after := current.Codec(), next.Codec()
	if before.PayloadType != after.PayloadType || before.MimeType != after.MimeType ||
		before.ClockRate != after.ClockRate || before.Channels != after.Channels ||
		before.SDPFmtpLine != after.SDPFmtpLine || !slices.Equal(before.RTCPFeedback, after.RTCPFeedback) ||
		current.TrackID() != next.TrackID() || current.StreamID() != next.StreamID() ||
		current.VideoLayerMode() != next.VideoLayerMode() || current.maxPackets != next.maxPackets ||
		len(current.TrackInfo().Layers) != len(next.TrackInfo().Layers) ||
		!slices.Equal(current.HeaderExtensions(), next.HeaderExtensions()) {
		return errors.New("replacement video source changed its transport contract")
	}
	return nil
}

func (transport *Transport) TargetBitrate() (int, bool) {
	return int(transport.target.Load()), transport.observed.Load()
}

func (transport *Transport) RequiredActiveCount() int {
	state := transport.Output.State()
	highest := state.Target
	if !state.Paused {
		highest = max(highest, state.Current)
	}
	if transport.observed.Load() {
		highest = max(highest, state.Prepare)
	}
	if highest < 0 && !state.Paused {
		highest = transport.Output.MaxLayer().Spatial
	}
	return int(highest + 1)
}

// Egress counts successful RTP writes, including headers but excluding SRTP/UDP
// overhead. It is local delivery to Pion, not proof of remote receipt or decode.
func (transport *Transport) Egress() EgressStats {
	return transport.pacer.stats()
}

// SetAudioBitrate reserves the current audio owner's contribution to this PC's
// shared estimate. Zero means no audio demand; the transport invents no profile.
func (transport *Transport) SetAudioBitrate(bitrate uint32) {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if !transport.closed {
		transport.audioBitrate = bitrate
		transport.refreshBudgetLocked()
	}
}

func (transport *Transport) refreshBudgetLocked() {
	bitrate := int(transport.target.Load())
	remaining := int64(bitrate) - int64(transport.audioBitrate)
	if transport.probe.Id == ccutils.ProbeClusterIdInvalid || transport.probe.Result.EndTime != 0 {
		transport.pacer.SetBitrate(bitrate)
	}
	transport.Output.SetBudget(max(remaining, 0))
}

func (transport *Transport) Close() error {
	transport.closeOnce.Do(func() {
		transport.mu.Lock()
		transport.closed = true
		attached := transport.attached
		transport.stopProbeLocked()
		transport.mu.Unlock()
		if transport.PC != nil {
			transport.closeErr = transport.PC.Close()
		}
		if transport.Output != nil {
			if attached {
				transport.source.DeleteDownTrack(transport.Output.SubscriberID())
			}
			transport.Output.Close()
		}
		if transport.pacer != nil {
			transport.pacer.Stop()
		}
		transport.readers.Wait()
	})
	return transport.closeErr
}

// LiveKit delivers feedback without a ReadRTCP loop on its callback reader.
func (transport *Transport) OnTransportCCFeedback(_ *sfu.DownTrack, packet *rtcp.TransportLayerCC) {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if !transport.closed {
		transport.estimator.HandleTWCCFeedback(packet)
		transport.observed.Store(true)
		transport.refreshBudgetLocked()
		transport.driveProbeLocked()
	}
}

// HandleTWCCFeedback invokes this synchronously under the transport's event
// lock. Store the framework result without reentering that lock.
func (transport *Transport) OnCongestionStateChange(_, _ bwe.CongestionState, capacity int64) {
	if capacity > 0 {
		transport.target.Store(capacity)
	}
}

func (*Transport) OnREMB(*sfu.DownTrack, *rtcp.ReceiverEstimatedMaximumBitrate) {}
func (*Transport) OnAvailableLayersChanged(*sfu.DownTrack)                      {}
func (*Transport) OnBitrateAvailabilityChanged(*sfu.DownTrack)                  {}
func (*Transport) OnMaxPublishedSpatialChanged(*sfu.DownTrack)                  {}
func (*Transport) OnMaxPublishedTemporalChanged(*sfu.DownTrack)                 {}
func (*Transport) OnSubscribedLayerChanged(*sfu.DownTrack, buffer.VideoLayer)   {}
func (*Transport) OnResume(*sfu.DownTrack)                                      {}
func (*Transport) IsBWEEnabled(*sfu.DownTrack) bool                             { return true }
func (*Transport) BWEType() bwe.BWEType                                         { return bwe.BWETypeSendSide }
func (*Transport) IsSubscribeMutable(*sfu.DownTrack) bool                       { return true }
func (transport *Transport) OnSubscriptionChanged(*sfu.DownTrack)               { transport.Output.Reconcile() }
func (*Transport) OnBindAndConnected()                                          {}
func (transport *Transport) OnStatsUpdate(stats *livekit.AnalyticsStat) {
	if slog.Default().Enabled(context.Background(), slog.LevelDebug) {
		slog.Debug("media-stats", "scope", "forwarding", "rtcPeerId", diagnostics.ID(transport.PC.ID()),
			"rtp", stats, "egress", transport.Egress(), "targetBitrate", transport.target.Load(),
			"pendingPackets", transport.pacer.pendingCount(), "packetCapacity", transport.pacer.limit)
	}
}
func (*Transport) OnMaxSubscribedLayerChanged(int32) {}
func (transport *Transport) OnRttUpdate(rtt uint32) {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if !transport.closed {
		transport.estimator.UpdateRTT(float64(rtt) / 1000)
	}
}
func (*Transport) OnCodecNegotiated(webrtc.RTPCodecCapability) {}
func (*Transport) OnDownTrackClose(bool)                       {}
func (*Transport) OnStreamStarted(time.Duration)               {}

// Probe orchestration below adapts the single-track flow from LiveKit v1.13.6:
// https://github.com/livekit/livekit/blob/v1.13.6/pkg/sfu/streamallocator/streamallocator.go
// Copyright 2023 LiveKit, Inc.
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software distributed
// under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
// CONDITIONS OF ANY KIND, either express or implied. See the License for the
// specific language governing permissions and limitations under the License.

func (transport *Transport) mediaActivity() {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	transport.driveProbeLocked()
}

func (transport *Transport) driveProbeLocked() {
	if transport.closed || !transport.attached || transport.PC.ConnectionState() != webrtc.PeerConnectionStateConnected {
		transport.paddingReady = false
		transport.stopProbeLocked()
		return
	}
	if transport.probe.Id != ccutils.ProbeClusterIdInvalid {
		if transport.probe.Result.EndTime == 0 && (!transport.paddingReady ||
			transport.estimator.CongestionState() != bwe.CongestionStateNone || transport.estimator.ProbeClusterIsGoalReached() ||
			time.Since(transport.probe.CreatedAt) >= transport.probe.Goal.Duration) {
			transport.stopProbeLocked()
		}
		if transport.probe.Result.EndTime != 0 {
			if signal, capacity, finalized := transport.estimator.ProbeClusterFinalize(); finalized {
				valid := sendsidebwe.DefaultSendSideBWEConfig.CongestionDetector.ProbeSignal.IsValid(transport.probe)
				if valid && signal == ccutils.ProbeSignalNotCongesting && capacity > transport.target.Load() {
					transport.target.Store(capacity)
				}
				transport.probe = ccutils.ProbeClusterInfoInvalid
				transport.refreshBudgetLocked()
			}
		}
	}
	config := streamallocator.DefaultStreamAllocatorConfig
	if transport.Output.State().Paused && transport.estimator.CongestionState() != bwe.CongestionStateNone &&
		transport.pacer.TimeSinceLastSentPacket() > config.PausedMinWait {
		transport.stopProbeLocked()
		transport.estimator.Reset()
		transport.probe = ccutils.ProbeClusterInfoInvalid
	}
	if transport.probe.Id != ccutils.ProbeClusterIdInvalid || !transport.paddingReady ||
		!transport.observed.Load() || !transport.estimator.CanProbe() {
		return
	}
	delta, usage := transport.Output.probeDemand()
	if delta <= 0 {
		return
	}
	usage += int64(transport.audioBitrate)
	goal := ccutils.ProbeClusterGoal{AvailableBandwidthBps: int(transport.target.Load()),
		ExpectedUsageBps: int(usage), DesiredBps: int(usage + max(delta*config.ProbeOveragePct/100, config.ProbeMinBps)),
		Duration: transport.estimator.ProbeDuration()}
	transport.probe = transport.prober.AddCluster(ccutils.ProbeClusterModeUniform, goal)
	transport.estimator.ProbeClusterStarting(transport.probe)
	transport.pacer.StartProbeCluster(transport.probe)
	transport.pacer.SetBitrate(goal.DesiredBps)
	transport.Output.SetProbeClusterId(transport.probe.Id)
}

func (transport *Transport) stopProbeLocked() {
	if transport.probe.Id == ccutils.ProbeClusterIdInvalid || transport.probe.Result.EndTime != 0 {
		return
	}
	transport.probe = transport.pacer.EndProbeCluster(transport.probe.Id)
	transport.Output.SwapProbeClusterId(transport.probe.Id, ccutils.ProbeClusterIdInvalid)
	transport.estimator.ProbeClusterDone(transport.probe)
	transport.prober.Reset(transport.probe)
	transport.pacer.cancelProbes(transport.probe.Id)
	transport.pacer.SetBitrate(int(transport.target.Load()))
}

// AddCluster returns the exact cluster synchronously. Initializing it there
// avoids reentering the Prober while its own cluster-start mutex is held.
func (*Transport) OnProbeClusterSwitch(ccutils.ProbeClusterInfo) {}

func (transport *Transport) OnSendProbe(bytesToSend int) {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	transport.driveProbeLocked()
	if transport.probe.Id == ccutils.ProbeClusterIdInvalid || transport.probe.Result.EndTime != 0 {
		return
	}
	written := transport.Output.WriteProbePackets(bytesToSend, true)
	transport.prober.ProbesSent(written)
	// Zero can be a temporary non-frame-boundary. The library-supplied cluster
	// duration bounds retries; only connection/RR authority controls readiness.
}

func (transport *Transport) OnPacerProbeObserverClusterComplete(id ccutils.ProbeClusterId) {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if transport.probe.Id == id {
		transport.stopProbeLocked()
	}
}

type EgressStats struct {
	// Drops include canceled probe padding and queued packets retired at close.
	Packets, RTPBytes, DroppedPackets uint64
}

// LiveKit's queue has no capacity limit. Only these bounded tickets enter it;
// the original packet remains ours until a ticket sends or Stop retires it.
type boundedPacer struct {
	pacer.Pacer
	sender  *pacer.Base
	recycle *pacer.Base
	mu      sync.Mutex
	pending map[*pacedPacket]struct{}
	limit   int
	closed  bool
	packets atomic.Uint64
	bytes   atomic.Uint64
	dropped atomic.Uint64
	last    atomic.Int64
}

func newBoundedPacer(packetPacer pacer.Pacer, log logger.Logger, limit int) *boundedPacer {
	return &boundedPacer{Pacer: packetPacer, sender: pacer.NewBase(log, nil), recycle: pacer.NewBase(log, nil),
		pending: make(map[*pacedPacket]struct{}), limit: limit}
}

func (queue *boundedPacer) SetBitrate(bitrate int) {
	// Pion interceptor v0.1.47 gcc.LeakyBucketPacer.SetTargetBitrate uses 1.5
	// pacing headroom. Codec/allocation budgets retain the unscaled BWE result.
	queue.Pacer.SetBitrate(int(1.5 * float64(bitrate)))
}

func (queue *boundedPacer) Enqueue(packet *pacer.Packet) {
	queue.mu.Lock()
	if queue.closed || len(queue.pending) >= queue.limit {
		queue.mu.Unlock()
		queue.dropped.Add(1)
		queue.discard(packet)
		return
	}
	ticket := &pacedPacket{owner: queue, packet: packet}
	queue.pending[ticket] = struct{}{}
	proxy := pacer.PacketFactory.Get().(*pacer.Packet)
	// The library uses the byte count to pace; it never owns a reference to the
	// pooled payload/header that Stop can release before this ticket is visited.
	*proxy = pacer.Packet{HeaderSize: packet.HeaderSize + len(packet.Payload), WriteStream: ticket}
	queue.mu.Unlock()
	queue.Pacer.Enqueue(proxy)
}

func (queue *boundedPacer) discard(packet *pacer.Packet) {
	packet.WriteStream = closedPacketWriter{}
	// Base owns all header/payload/packet pool returns, including failed writes.
	_, _ = queue.recycle.SendPacket(packet)
}

func (queue *boundedPacer) cancelProbes(id ccutils.ProbeClusterId) {
	queue.mu.Lock()
	var packets []*pacer.Packet
	for ticket := range queue.pending {
		if ticket.packet != nil && ticket.packet.IsProbe && ticket.packet.ProbeClusterId == id {
			packets = append(packets, ticket.packet)
			ticket.packet = nil
			// The header-free proxy still occupies the library queue. Keep its
			// admission slot charged until that proxy is actually dequeued.
		}
	}
	queue.mu.Unlock()
	for _, packet := range packets {
		queue.dropped.Add(1)
		queue.discard(packet)
	}
}

func (queue *boundedPacer) SetPacerProbeObserverListener(listener pacer.PacerProbeObserverListener) {
	queue.sender.SetPacerProbeObserverListener(listener)
}

func (queue *boundedPacer) StartProbeCluster(info ccutils.ProbeClusterInfo) {
	queue.sender.StartProbeCluster(info)
}

func (queue *boundedPacer) EndProbeCluster(id ccutils.ProbeClusterId) ccutils.ProbeClusterInfo {
	return queue.sender.EndProbeCluster(id)
}

func (queue *boundedPacer) Stop() {
	queue.mu.Lock()
	if queue.closed {
		queue.mu.Unlock()
		return
	}
	queue.closed = true
	packets := make([]*pacer.Packet, 0, len(queue.pending))
	for ticket := range queue.pending {
		if ticket.packet != nil {
			packets = append(packets, ticket.packet)
		}
		ticket.packet = nil
	}
	clear(queue.pending)
	queue.Pacer.Stop()
	queue.mu.Unlock()
	for _, packet := range packets {
		queue.dropped.Add(1)
		queue.discard(packet)
	}
}

func (queue *boundedPacer) TimeSinceLastSentPacket() time.Duration {
	return time.Since(time.Unix(0, queue.last.Load()))
}

func (queue *boundedPacer) stats() EgressStats {
	return EgressStats{Packets: queue.packets.Load(), RTPBytes: queue.bytes.Load(), DroppedPackets: queue.dropped.Load()}
}

func (queue *boundedPacer) pendingCount() int {
	queue.mu.Lock()
	defer queue.mu.Unlock()
	return len(queue.pending)
}

type pacedPacket struct {
	owner  *boundedPacer
	packet *pacer.Packet
}

func (ticket *pacedPacket) WriteRTP(*rtp.Header, []byte) (int, error) {
	queue := ticket.owner
	queue.mu.Lock()
	packet := ticket.packet
	ticket.packet = nil
	delete(queue.pending, ticket)
	queue.mu.Unlock()
	if packet == nil {
		return 0, io.ErrClosedPipe
	}
	written, err := queue.sender.SendPacket(packet)
	if err == nil && written > 0 {
		queue.packets.Add(1)
		queue.bytes.Add(uint64(written))
		queue.last.Store(time.Now().UnixNano())
	}
	return written, err
}

func (*pacedPacket) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

type closedPacketWriter struct{}

func (closedPacketWriter) WriteRTP(*rtp.Header, []byte) (int, error) { return 0, io.ErrClosedPipe }
func (closedPacketWriter) Write([]byte) (int, error)                 { return 0, io.ErrClosedPipe }
