package mediaedge

import (
	"errors"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"sync"

	"github.com/TNTcraftHIM/Piik/internal/diagnostics"
	"github.com/TNTcraftHIM/Piik/internal/media/forwarding"
	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
)

const maxPendingCandidates = 64

type EdgeEvents struct {
	LocalCandidate  func(*webrtc.ICECandidateInit)
	ConnectionState func(webrtc.PeerConnectionState, *SelectedPair)
}

type EdgeOptions struct {
	ConnectionID string
	ICEServers   []webrtc.ICEServer
	Audio        *AudioSource
	Local        bool
	Events       EdgeEvents
}

type Edge struct {
	connectionID  string
	engine        *Engine
	source        *Source
	audioSource   *AudioSource
	connection    *webrtc.PeerConnection
	sender        *webrtc.RTPSender
	audioSender   *webrtc.RTPSender
	targetBitrate func() (int, bool)
	events        EdgeEvents
	transport     *forwarding.Transport
	local         bool

	mu                   sync.Mutex
	pendingCandidates    []webrtc.ICECandidateInit
	remoteDescriptionSet bool
	closed               bool
	qualityMu            sync.Mutex
	qualityBaseline      qualityBaseline
	answerMu             sync.Mutex
	localCandidates      *localCandidateGathering
}

func (engine *Engine) NewEdge(source *Source, options EdgeOptions) (*Edge, error) {
	if source == nil || source.engine != engine || options.ConnectionID == "" ||
		len(options.ConnectionID) > 256 {
		return nil, errors.New("native media edge input is invalid")
	}
	if options.Audio != nil && options.Audio.engine != engine {
		return nil, errors.New("native audio edge source belongs to another engine")
	}
	mappedPort := 0
	if engine.portMapping != nil && !options.Local && len(options.ICEServers) > 0 {
		mappedPort = engine.portMapping.Prepare()
	}
	if err := source.reserve(options.Local); err != nil {
		return nil, err
	}
	if options.Audio != nil {
		if err := options.Audio.reserve(options.Local); err != nil {
			source.releaseReservation(options.Local)
			return nil, err
		}
	}
	var audio webrtc.TrackLocal
	if options.Audio != nil {
		audio = options.Audio.track
	}
	transport, err := forwarding.NewTransport(forwarding.TransportOptions{
		Source: source.media.Source, Settings: engine.settings, ConnectionID: options.ConnectionID,
		InitialBitrate: engine.initialBitrate, Audio: audio,
	})
	if err != nil {
		source.releaseReservation(options.Local)
		if options.Audio != nil {
			options.Audio.releaseReservation(options.Local)
		}
		return nil, err
	}
	connection := transport.PC
	log := slog.Default().With("connectionId", diagnostics.ID(options.ConnectionID), "rtcPeerId", diagnostics.ID(connection.ID()))
	transport.SetAudioBitrate(options.Audio.configuredBitrate())
	edge := &Edge{
		connectionID:  options.ConnectionID,
		engine:        engine,
		source:        source,
		audioSource:   options.Audio,
		connection:    connection,
		transport:     transport,
		local:         options.Local,
		targetBitrate: transport.TargetBitrate,
		events:        options.Events,
		sender:        transport.VideoSender,
		audioSender:   transport.AudioSender,
	}
	if err = engine.register(edge); err != nil {
		source.releaseReservation(options.Local)
		if options.Audio != nil {
			options.Audio.releaseReservation(options.Local)
		}
		_ = transport.Close()
		return nil, err
	}
	if err = source.attach(edge, options.Local); err != nil {
		if options.Audio != nil {
			options.Audio.releaseReservation(options.Local)
		}
		engine.remove(edge)
		_ = transport.Close()
		return nil, err
	}
	if options.Audio != nil {
		if err = options.Audio.attach(edge, options.Local); err != nil {
			source.detach(edge)
			engine.remove(edge)
			_ = transport.Close()
			return nil, err
		}
	}
	edge.localCandidates = newLocalCandidateGathering(
		engine,
		options.ICEServers,
		mappedPort,
		options.Events.LocalCandidate,
	)
	connection.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		edge.localCandidates.addPion(candidate)
	})
	connection.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		log.Debug("piik-client", "event", "media-ice-state", "direction", "outbound", "local", options.Local, "state", state.String())
	})
	if dtls := edge.sender.Transport(); dtls != nil {
		dtls.OnStateChange(func(state webrtc.DTLSTransportState) {
			log.Debug("piik-client", "event", "media-dtls-state", "direction", "outbound", "local", options.Local, "state", state.String())
		})
	}
	connection.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		debug := slog.Default().Enabled(engine.ctx, slog.LevelDebug)
		if debug {
			log.Debug("piik-client", "event", "media-connection-state", "direction", "outbound", "local", options.Local, "state", state.String())
		}
		if state == webrtc.PeerConnectionStateConnected {
			if err := edge.transport.SetConnected(); err != nil {
				if debug {
					log.Debug("piik-client", "event", "media-activation-failed", diagnostics.Error(err))
				}
				_ = connection.Close()
				return
			}
			edge.source.RequestRecoveryFrame()
		}
		var selected *SelectedPair
		if state == webrtc.PeerConnectionStateConnected && (edge.events.ConnectionState != nil || debug) {
			if pair, pairErr := edge.SelectedPair(); pairErr == nil {
				selected = &pair
				if debug {
					log.Debug("piik-client", "event", "media-selected-path", "direction", "outbound", "local", options.Local,
						"localType", pair.Local.String(), "remoteType", pair.Remote.String(), "natTraversalPath", pair.NatTraversalPath)
				}
			}
		}
		if edge.events.ConnectionState != nil {
			edge.events.ConnectionState(state, selected)
		}
	})
	return edge, nil
}

func (edge *Edge) ConnectionID() string {
	return edge.connectionID
}

// SetTargetLayer is a media-component input, not a route change or UI setting.
func (edge *Edge) SetTargetLayer(layer int) error {
	source := edge.source
	changed := false
	source.writeMu.Lock()
	defer func() {
		source.writeMu.Unlock()
		if changed {
			source.RequestRecoveryFrame()
		}
	}()
	source.mu.Lock()
	_, attached := source.edges[edge]
	closed := source.closed
	source.mu.Unlock()
	if closed || !attached {
		return io.ErrClosedPipe
	}
	if layer < 0 || layer >= len(source.formats) {
		return errors.New("native output layer is invalid")
	}
	if len(source.outputBitrates) > 0 && source.outputBitrates[layer] == 0 {
		return errors.New("native output layer is unavailable")
	}
	changed = edge.transport.Output.MaxLayer().Spatial != int32(layer)
	edge.transport.Output.SetMaxSpatialLayer(int32(layer))
	return nil
}

func (edge *Edge) CreateOffer() (webrtc.SessionDescription, error) {
	offer, err := edge.connection.CreateOffer(nil)
	if err != nil {
		return webrtc.SessionDescription{}, err
	}
	if err = edge.connection.SetLocalDescription(offer); err != nil {
		return webrtc.SessionDescription{}, err
	}
	edge.localCandidates.start()
	return offer, nil
}

func (edge *Edge) SetAnswer(answer webrtc.SessionDescription) error {
	edge.answerMu.Lock()
	defer edge.answerMu.Unlock()
	if answer.Type != webrtc.SDPTypeAnswer {
		return errors.New("native media edge requires an SDP answer")
	}
	edge.mu.Lock()
	if edge.closed {
		edge.mu.Unlock()
		return errors.New("native media edge is closed")
	}
	if edge.remoteDescriptionSet {
		// The connection identity fences the answer to one edge. A repeated
		// answer is a retransmission; the first applied description remains
		// authoritative.
		edge.mu.Unlock()
		return nil
	}
	edge.mu.Unlock()
	if err := edge.connection.SetRemoteDescription(answer); err != nil {
		return err
	}
	edge.mu.Lock()
	edge.remoteDescriptionSet = true
	pending := edge.pendingCandidates
	edge.pendingCandidates = nil
	edge.mu.Unlock()
	for _, candidate := range pending {
		// Candidates are disposable edge input. The connection state callback
		// remains the authority for a real media failure.
		if err := edge.connection.AddICECandidate(candidate); err != nil {
			slog.Debug("media-candidate-rejected", "connectionId", diagnostics.ID(edge.connectionID), "stage", "drain", diagnostics.Error(err))
		}
	}
	return nil
}

func (edge *Edge) AddRemoteCandidate(candidate *webrtc.ICECandidateInit) error {
	if malformedRemoteCandidate(candidate) {
		slog.Debug("media-candidate-rejected", "connectionId", diagnostics.ID(edge.connectionID), "stage", "malformed")
		return nil
	}
	value := webrtc.ICECandidateInit{}
	if candidate != nil {
		value = *candidate
	}
	edge.mu.Lock()
	if edge.closed {
		edge.mu.Unlock()
		return nil
	}
	if !edge.remoteDescriptionSet {
		if len(edge.pendingCandidates) >= maxPendingCandidates {
			edge.mu.Unlock()
			slog.Debug("media-candidate-rejected", "connectionId", diagnostics.ID(edge.connectionID), "stage", "queue-full", "capacity", maxPendingCandidates)
			return nil
		}
		edge.pendingCandidates = append(edge.pendingCandidates, value)
		edge.mu.Unlock()
		return nil
	}
	edge.mu.Unlock()
	// A candidate may become stale between validation and delivery. Dropping
	// that one edge input keeps the shared control session alive; ICE state
	// events still report whether the edge itself can connect.
	if err := edge.connection.AddICECandidate(value); err != nil {
		slog.Debug("media-candidate-rejected", "connectionId", diagnostics.ID(edge.connectionID), "stage", "apply", diagnostics.Error(err))
	}
	return nil
}

func malformedRemoteCandidate(candidate *webrtc.ICECandidateInit) bool {
	if candidate == nil || candidate.Candidate == "" {
		return false
	}
	_, err := ice.UnmarshalCandidate(strings.TrimPrefix(candidate.Candidate, "candidate:"))
	return err != nil
}

type SelectedPair struct {
	Local            webrtc.ICECandidateType
	Remote           webrtc.ICECandidateType
	NatTraversalPath string
}

func (edge *Edge) SelectedPair() (SelectedPair, error) {
	transport := edge.sender.Transport()
	if transport == nil || transport.ICETransport() == nil {
		return SelectedPair{}, errors.New("native media ICE transport is unavailable")
	}
	pair, err := transport.ICETransport().GetSelectedCandidatePair()
	if err != nil || pair == nil {
		return SelectedPair{}, errors.New("native media ICE pair is unavailable")
	}
	return SelectedPair{
		Local: pair.Local.Typ, Remote: pair.Remote.Typ,
		NatTraversalPath: selectedNatTraversalPath(
			pair.Local.Foundation,
			pair.Remote.Foundation,
		),
	}, nil
}

func selectedNatTraversalPath(foundations ...string) string {
	for _, foundation := range foundations {
		if len(foundation) < 3 || foundation[0] != 's' ||
			(foundation[1] != 'p' && foundation[1] != 'm') {
			continue
		}
		if _, err := strconv.Atoi(foundation[2:]); err == nil {
			return "predicted"
		}
	}
	for _, foundation := range foundations {
		if foundation != "" {
			return "ordinary"
		}
	}
	return "unknown"
}

func (edge *Edge) State() webrtc.PeerConnectionState {
	return edge.connection.ConnectionState()
}

func (edge *Edge) Close() error {
	edge.mu.Lock()
	if edge.closed {
		edge.mu.Unlock()
		return nil
	}
	edge.closed = true
	if edge.localCandidates != nil {
		edge.localCandidates.close()
	}
	edge.pendingCandidates = nil
	edge.mu.Unlock()
	if edge.local && slog.Default().Enabled(edge.engine.ctx, slog.LevelDebug) {
		logLocalMediaCandidateCounts(edge.connection.GetStats())
	}
	err := edge.transport.Close()
	edge.source.detach(edge)
	if edge.audioSource != nil {
		edge.audioSource.detach(edge)
	}
	edge.engine.remove(edge)
	return err
}

func logLocalMediaCandidateCounts(report webrtc.StatsReport) {
	for _, direction := range []webrtc.StatsType{webrtc.StatsTypeLocalCandidate, webrtc.StatsTypeRemoteCandidate} {
		for _, kind := range []webrtc.ICECandidateType{webrtc.ICECandidateTypeHost, webrtc.ICECandidateTypeSrflx, webrtc.ICECandidateTypePrflx, webrtc.ICECandidateTypeRelay} {
			udp, tcp := 0, 0
			for _, entry := range report {
				candidate, ok := entry.(webrtc.ICECandidateStats)
				if !ok || candidate.Type != direction || candidate.CandidateType != kind || candidate.Deleted {
					continue
				}
				switch candidate.Protocol {
				case "udp":
					udp++
				case "tcp":
					tcp++
				}
			}
			slog.Debug("piik-client", "event", "media-candidate-counts", "local", true,
				"direction", string(direction), "type", kind.String(), "udp", udp, "tcp", tcp)
		}
	}
}

// Shutdown must release every transport before waiting on shared source writes.
func closeEdges(edges []*Edge) {
	for _, edge := range edges {
		_ = edge.connection.Close()
	}
	for _, edge := range edges {
		_ = edge.Close()
	}
}
