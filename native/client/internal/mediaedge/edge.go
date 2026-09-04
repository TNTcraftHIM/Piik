package mediaedge

import (
	"context"
	"errors"
	"io"
	"strconv"
	"strings"
	"sync"

	"github.com/pion/ice/v4"
	"github.com/pion/rtcp"
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
	connectionID string
	engine       *Engine
	source       *Source
	audioSource  *AudioSource
	connection   *webrtc.PeerConnection
	sender       *webrtc.RTPSender
	audioSender  *webrtc.RTPSender
	bandwidth    *bandwidthObserver
	events       EdgeEvents

	mu                    sync.Mutex
	pendingCandidates     []webrtc.ICECandidateInit
	remoteDescriptionSet  bool
	closed                bool
	qualityMu             sync.Mutex
	qualityBaseline       qualityBaseline
	answerMu              sync.Mutex
	surveyServers         []webrtc.ICEServer
	surveyOnce            sync.Once
	pionGatheringDone     bool
	surveyDone            bool
	localCandidateEndSent bool
	surveyContext         context.Context
	cancelSurvey          context.CancelFunc
}

func (engine *Engine) NewEdge(source *Source, options EdgeOptions) (*Edge, error) {
	if source == nil || source.engine != engine || options.ConnectionID == "" ||
		len(options.ConnectionID) > 256 {
		return nil, errors.New("native media edge input is invalid")
	}
	if options.Audio != nil && options.Audio.engine != engine {
		return nil, errors.New("native audio edge source belongs to another engine")
	}
	if engine.portMapping != nil && !options.Local && len(options.ICEServers) > 0 {
		engine.portMapping.Prepare()
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
	surveyServers := stunServers(options.ICEServers)
	connection, err := engine.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		source.releaseReservation(options.Local)
		if options.Audio != nil {
			options.Audio.releaseReservation(options.Local)
		}
		return nil, err
	}
	bandwidth := engine.bandwidth.take(connection.ID())
	if bandwidth == nil {
		source.releaseReservation(options.Local)
		if options.Audio != nil {
			options.Audio.releaseReservation(options.Local)
		}
		_ = connection.Close()
		return nil, errors.New("native media bandwidth observer is unavailable")
	}
	edge := &Edge{
		connectionID:  options.ConnectionID,
		engine:        engine,
		source:        source,
		audioSource:   options.Audio,
		connection:    connection,
		bandwidth:     bandwidth,
		events:        options.Events,
		surveyServers: surveyServers,
		surveyDone:    len(surveyServers) == 0,
	}
	if err = engine.register(edge); err != nil {
		source.releaseReservation(options.Local)
		if options.Audio != nil {
			options.Audio.releaseReservation(options.Local)
		}
		_ = connection.Close()
		return nil, err
	}
	if err = source.attach(edge, options.Local); err != nil {
		if options.Audio != nil {
			options.Audio.releaseReservation(options.Local)
		}
		engine.remove(edge)
		_ = connection.Close()
		return nil, err
	}
	if options.Audio != nil {
		if err = options.Audio.attach(edge, options.Local); err != nil {
			source.detach(edge)
			engine.remove(edge)
			_ = connection.Close()
			return nil, err
		}
	}
	sender, err := connection.AddTrack(source.track)
	if err != nil {
		_ = edge.Close()
		return nil, err
	}
	edge.sender = sender
	if options.Audio != nil {
		audioSender, audioErr := connection.AddTrack(options.Audio.track)
		if audioErr != nil {
			_ = edge.Close()
			return nil, audioErr
		}
		edge.audioSender = audioSender
	}
	connection.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate == nil {
			edge.completePionGathering()
			return
		}
		value := candidate.ToJSON()
		edge.emitLocalCandidate(&value)
	})
	connection.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateConnected {
			edge.source.RequestRecoveryFrame()
		}
		if edge.events.ConnectionState != nil {
			var selected *SelectedPair
			if state == webrtc.PeerConnectionStateConnected {
				if pair, pairErr := edge.SelectedPair(); pairErr == nil {
					selected = &pair
				}
			}
			edge.events.ConnectionState(state, selected)
		}
	})
	go edge.readRTCP(edge.sender, edge.source)
	if edge.audioSender != nil {
		go edge.readRTCP(edge.audioSender, nil)
	}
	edge.surveyContext, edge.cancelSurvey = context.WithCancel(engine.ctx)
	return edge, nil
}

func (edge *Edge) ConnectionID() string {
	return edge.connectionID
}

func (edge *Edge) CreateOffer() (webrtc.SessionDescription, error) {
	offer, err := edge.connection.CreateOffer(nil)
	if err != nil {
		return webrtc.SessionDescription{}, err
	}
	if err = edge.connection.SetLocalDescription(offer); err != nil {
		return webrtc.SessionDescription{}, err
	}
	edge.surveyOnce.Do(func() {
		go edge.surveyMappedAddresses()
	})
	return offer, nil
}

func (edge *Edge) surveyMappedAddresses() {
	index := 0
	edge.engine.surveySTUN(edge.surveyContext, edge.surveyServers, func(mapped mappedAddress) {
		index++
		mid := "0"
		line := uint16(0)
		candidate := webrtc.ICECandidateInit{
			Candidate: "candidate:ns" + strconv.Itoa(index) +
				" 1 udp 1694498815 " + mapped.address + " " +
				strconv.Itoa(mapped.port) + " typ srflx raddr 0.0.0.0 rport " +
				strconv.Itoa(edge.engine.localPort),
			SDPMid:        &mid,
			SDPMLineIndex: &line,
		}
		edge.emitLocalCandidate(&candidate)
	})
	edge.completeSTUNSurvey()
}

func (edge *Edge) emitLocalCandidate(candidate *webrtc.ICECandidateInit) {
	edge.mu.Lock()
	closed := edge.closed
	edge.mu.Unlock()
	if !closed && edge.events.LocalCandidate != nil {
		edge.events.LocalCandidate(candidate)
	}
}

func (edge *Edge) completePionGathering() {
	edge.mu.Lock()
	edge.pionGatheringDone = true
	sendEnd := edge.finishLocalCandidatesLocked()
	edge.mu.Unlock()
	if sendEnd {
		edge.events.LocalCandidate(nil)
	}
}

func (edge *Edge) completeSTUNSurvey() {
	edge.mu.Lock()
	edge.surveyDone = true
	sendEnd := edge.finishLocalCandidatesLocked()
	edge.mu.Unlock()
	if sendEnd {
		edge.events.LocalCandidate(nil)
	}
}

func (edge *Edge) finishLocalCandidatesLocked() bool {
	if edge.closed || edge.localCandidateEndSent ||
		!edge.pionGatheringDone || !edge.surveyDone ||
		edge.events.LocalCandidate == nil {
		return false
	}
	edge.localCandidateEndSent = true
	return true
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
		_ = edge.connection.AddICECandidate(candidate)
	}
	return nil
}

func (edge *Edge) AddRemoteCandidate(candidate *webrtc.ICECandidateInit) error {
	if malformedRemoteCandidate(candidate) {
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
	_ = edge.connection.AddICECandidate(value)
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
	Local  webrtc.ICECandidateType
	Remote webrtc.ICECandidateType
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
	return SelectedPair{Local: pair.Local.Typ, Remote: pair.Remote.Typ}, nil
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
	if edge.cancelSurvey != nil {
		edge.cancelSurvey()
	}
	edge.pendingCandidates = nil
	edge.mu.Unlock()
	edge.source.detach(edge)
	if edge.audioSource != nil {
		edge.audioSource.detach(edge)
	}
	edge.engine.remove(edge)
	return edge.connection.Close()
}

func (edge *Edge) readRTCP(sender *webrtc.RTPSender, videoSource *Source) {
	for {
		packets, _, err := sender.ReadRTCP()
		if err != nil {
			if !errors.Is(err, io.EOF) {
				return
			}
			return
		}
		for _, packet := range packets {
			switch packet.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
				if videoSource != nil {
					videoSource.RequestRecoveryFrame()
				}
			}
		}
	}
}
