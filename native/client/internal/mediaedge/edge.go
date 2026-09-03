package mediaedge

import (
	"errors"
	"io"
	"sync"

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

	mu                   sync.Mutex
	pendingCandidates    []webrtc.ICECandidateInit
	remoteDescriptionSet bool
	closed               bool
	qualityMu            sync.Mutex
	qualityBaseline      qualityBaseline
}

func (engine *Engine) NewEdge(source *Source, options EdgeOptions) (*Edge, error) {
	if source == nil || source.engine != engine || options.ConnectionID == "" ||
		len(options.ConnectionID) > 256 {
		return nil, errors.New("native media edge input is invalid")
	}
	if options.Audio != nil && options.Audio.engine != engine {
		return nil, errors.New("native audio edge source belongs to another engine")
	}
	if engine.portMapping != nil && !options.Local {
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
	connection, err := engine.api.NewPeerConnection(webrtc.Configuration{
		ICEServers: options.ICEServers,
	})
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
		connectionID: options.ConnectionID,
		engine:       engine,
		source:       source,
		audioSource:  options.Audio,
		connection:   connection,
		bandwidth:    bandwidth,
		events:       options.Events,
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
		if edge.events.LocalCandidate != nil {
			if candidate == nil {
				edge.events.LocalCandidate(nil)
				return
			}
			value := candidate.ToJSON()
			edge.events.LocalCandidate(&value)
		}
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
	return offer, nil
}

func (edge *Edge) SetAnswer(answer webrtc.SessionDescription) error {
	if answer.Type != webrtc.SDPTypeAnswer {
		return errors.New("native media edge requires an SDP answer")
	}
	if err := edge.connection.SetRemoteDescription(answer); err != nil {
		return err
	}
	edge.mu.Lock()
	edge.remoteDescriptionSet = true
	pending := edge.pendingCandidates
	edge.pendingCandidates = nil
	edge.mu.Unlock()
	for _, candidate := range pending {
		if err := edge.connection.AddICECandidate(candidate); err != nil {
			return err
		}
	}
	return nil
}

func (edge *Edge) AddRemoteCandidate(candidate *webrtc.ICECandidateInit) error {
	value := webrtc.ICECandidateInit{}
	if candidate != nil {
		value = *candidate
	}
	edge.mu.Lock()
	if edge.closed {
		edge.mu.Unlock()
		return errors.New("native media edge is closed")
	}
	if !edge.remoteDescriptionSet {
		if len(edge.pendingCandidates) >= maxPendingCandidates {
			edge.mu.Unlock()
			return errors.New("native media ICE candidate queue is full")
		}
		edge.pendingCandidates = append(edge.pendingCandidates, value)
		edge.mu.Unlock()
		return nil
	}
	edge.mu.Unlock()
	return edge.connection.AddICECandidate(value)
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
