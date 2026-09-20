package nativeviewer

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/app/mediaedge"
	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/pion/webrtc/v4"
)

type Event struct {
	Current          func() bool
	Type             string
	ShareID          string
	ConnectionID     string
	Candidate        *webrtc.ICECandidateInit
	State            string
	LocalType        string
	RemoteType       string
	NatTraversalPath string
	Quality          *mediaedge.QualitySample
}

type Options struct {
	ShareID      string
	EdgeCapacity int
	PortMapping  bool
	Events       chan<- Event
	Relay        *mediaedge.RelayOptions
}

type sessionEdge struct {
	edge               *mediaedge.Edge
	sourceConnectionID string
}

// Session owns the native media implementation for one Browser Viewer. Room,
// participant, route, and recovery authority remain in the Browser/server.
type Session struct {
	shareID      string
	edgeCapacity int
	engine       *mediaedge.Engine
	events       chan<- Event
	ctx          context.Context
	cancel       context.CancelFunc
	relay        *mediaedge.RelayOptions

	mu        sync.Mutex
	receivers map[string]*mediaedge.Receiver
	edges     map[string]sessionEdge
	profile   *nativecapture.VideoProfile
	closed    bool
}

func Start(parent context.Context, options Options) (*Session, error) {
	if parent == nil {
		parent = context.Background()
	}
	if options.ShareID == "" || len(options.ShareID) > 256 ||
		options.EdgeCapacity < 1 || options.EdgeCapacity > 3 {
		return nil, errors.New("native Viewer session input is invalid")
	}
	engine, err := mediaedge.NewEngine(mediaedge.EngineOptions{
		IncludeLoopback: true,
		PortMapping:     options.PortMapping,
	})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	session := &Session{
		shareID: options.ShareID, edgeCapacity: options.EdgeCapacity,
		engine: engine, events: options.Events, ctx: ctx, cancel: cancel, relay: options.Relay,
		receivers: make(map[string]*mediaedge.Receiver),
		edges:     make(map[string]sessionEdge),
	}
	go session.runQuality()
	return session, nil
}

func (session *Session) ShareID() string { return session.shareID }

// UpdateProfile records the Host ceiling; receiving alone never starts derivation.
func (session *Session) UpdateProfile(profile nativecapture.VideoProfile) error {
	if !profile.Valid() {
		return errors.New("native Viewer profile is invalid")
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed {
		return errors.New("native Viewer session is closed")
	}
	if session.profile != nil && *session.profile == profile {
		return nil
	}
	for _, receiver := range session.receivers {
		if err := receiver.Source().SetRelayProfile(profile); err != nil {
			return err
		}
	}
	session.profile = &profile
	return nil
}

type OfferResult struct {
	Answer webrtc.SessionDescription
	Audio  bool
	Codec  string
	Reused bool
}

func (session *Session) AcceptOffer(
	connectionID string,
	offer webrtc.SessionDescription,
	iceServers []webrtc.ICEServer,
	reuse bool,
) (OfferResult, error) {
	if connectionID == "" || len(connectionID) > 256 {
		return OfferResult{}, errors.New("native Viewer receiver identity is invalid")
	}
	session.mu.Lock()
	closed := session.closed
	session.mu.Unlock()
	if closed {
		return OfferResult{}, errors.New("native Viewer session is closed")
	}
	if receiver := session.receiver(connectionID); reuse && receiver != nil {
		answer, reused, err := receiver.Renegotiate(offer, iceServers)
		if err != nil {
			return OfferResult{}, err
		}
		if reused {
			return OfferResult{Answer: answer, Audio: receiver.HasAudio(), Codec: receiver.Codec(), Reused: true}, nil
		}
	}
	session.CloseReceiver(connectionID)
	receiver, answer, err := session.engine.NewReceiver(mediaedge.ReceiverOptions{
		Offer:        offer,
		ICEServers:   iceServers,
		EdgeCapacity: session.edgeCapacity,
		Relay:        session.relay,
		Events: mediaedge.ReceiverEvents{
			LocalCandidate: func(candidate *webrtc.ICECandidateInit, current func() bool) {
				session.emit(Event{
					Current: current,
					Type:    "edge-candidate", ShareID: session.shareID,
					ConnectionID: connectionID, Candidate: candidate,
				})
			},
			ConnectionState: func(state webrtc.PeerConnectionState, pair *mediaedge.SelectedPair, current func() bool) {
				session.emit(Event{
					Current: current,
					Type:    "edge-state", ShareID: session.shareID,
					ConnectionID: connectionID, State: state.String(),
				})
				if pair != nil {
					session.emit(Event{
						Current: current,
						Type:    "edge-path", ShareID: session.shareID,
						ConnectionID:     connectionID,
						LocalType:        pair.Local.String(),
						RemoteType:       pair.Remote.String(),
						NatTraversalPath: pair.NatTraversalPath,
					})
				}
			},
		},
	})
	if err != nil {
		return OfferResult{}, err
	}
	session.mu.Lock()
	if session.closed || session.receivers[connectionID] != nil {
		session.mu.Unlock()
		_ = receiver.Close()
		return OfferResult{}, errors.New("native Viewer receiver is unavailable")
	}
	if session.profile != nil {
		if err = receiver.Source().SetRelayProfile(*session.profile); err != nil {
			session.mu.Unlock()
			_ = receiver.Close()
			return OfferResult{}, err
		}
	}
	session.receivers[connectionID] = receiver
	session.mu.Unlock()
	return OfferResult{Answer: answer, Audio: receiver.HasAudio(), Codec: receiver.Codec()}, nil
}

func (session *Session) AddReceiverCandidate(
	connectionID string,
	candidate *webrtc.ICECandidateInit,
) error {
	receiver := session.receiver(connectionID)
	if receiver == nil {
		return nil
	}
	return receiver.AddRemoteCandidate(candidate)
}

func (session *Session) PrepareLocalEdge(
	sourceConnectionID string,
	connectionID string,
) (webrtc.SessionDescription, error) {
	return session.prepareEdge(sourceConnectionID, connectionID, nil, true)
}

func (session *Session) PrepareEdge(
	sourceConnectionID string,
	connectionID string,
	iceServers []webrtc.ICEServer,
) (webrtc.SessionDescription, error) {
	return session.prepareEdge(sourceConnectionID, connectionID, iceServers, false)
}

func (session *Session) prepareEdge(
	sourceConnectionID string,
	connectionID string,
	iceServers []webrtc.ICEServer,
	local bool,
) (webrtc.SessionDescription, error) {
	receiver := session.receiver(sourceConnectionID)
	if receiver == nil {
		return webrtc.SessionDescription{}, errors.New("native Viewer source does not exist")
	}
	session.mu.Lock()
	if session.closed || session.edges[connectionID].edge != nil {
		session.mu.Unlock()
		return webrtc.SessionDescription{}, errors.New("native Viewer edge is unavailable")
	}
	if !local && session.profile == nil {
		session.mu.Unlock()
		return webrtc.SessionDescription{}, errors.New("native relay requires the Host profile")
	}
	session.mu.Unlock()
	edge, err := session.engine.NewEdge(receiver.Source(), mediaedge.EdgeOptions{
		ConnectionID: connectionID,
		ICEServers:   iceServers,
		Audio:        receiver.AudioSource(),
		Local:        local,
		Events: mediaedge.EdgeEvents{
			LocalCandidate: func(candidate *webrtc.ICECandidateInit) {
				session.emit(Event{
					Type: "edge-candidate", ShareID: session.shareID,
					ConnectionID: connectionID, Candidate: candidate,
				})
			},
			ConnectionState: func(state webrtc.PeerConnectionState, pair *mediaedge.SelectedPair) {
				session.emit(Event{
					Type: "edge-state", ShareID: session.shareID,
					ConnectionID: connectionID, State: state.String(),
				})
				if pair != nil {
					session.emit(Event{
						Type: "edge-path", ShareID: session.shareID,
						ConnectionID:     connectionID,
						LocalType:        pair.Local.String(),
						RemoteType:       pair.Remote.String(),
						NatTraversalPath: pair.NatTraversalPath,
					})
				}
			},
		},
	})
	if err != nil {
		return webrtc.SessionDescription{}, err
	}
	session.mu.Lock()
	if session.closed || session.edges[connectionID].edge != nil ||
		session.receivers[sourceConnectionID] != receiver {
		session.mu.Unlock()
		_ = edge.Close()
		return webrtc.SessionDescription{}, errors.New("native Viewer edge is unavailable")
	}
	session.edges[connectionID] = sessionEdge{
		edge: edge, sourceConnectionID: sourceConnectionID,
	}
	session.mu.Unlock()
	offer, err := edge.CreateOffer()
	if err != nil {
		session.CloseEdge(connectionID)
		return webrtc.SessionDescription{}, err
	}
	return offer, nil
}

func (session *Session) SetAnswer(connectionID string, answer webrtc.SessionDescription) error {
	edge := session.edge(connectionID)
	if edge == nil {
		return errors.New("native Viewer edge does not exist")
	}
	return edge.SetAnswer(answer)
}

func (session *Session) AddCandidate(connectionID string, candidate *webrtc.ICECandidateInit) error {
	edge := session.edge(connectionID)
	if edge == nil {
		return nil
	}
	return edge.AddRemoteCandidate(candidate)
}

func (session *Session) CloseReceiver(connectionID string) {
	session.mu.Lock()
	receiver := session.receivers[connectionID]
	delete(session.receivers, connectionID)
	edges := make([]*mediaedge.Edge, 0)
	for edgeID, owned := range session.edges {
		if owned.sourceConnectionID == connectionID {
			edges = append(edges, owned.edge)
			delete(session.edges, edgeID)
		}
	}
	session.mu.Unlock()
	for _, edge := range edges {
		_ = edge.Close()
	}
	if receiver != nil {
		_ = receiver.Close()
	}
}

func (session *Session) CloseEdge(connectionID string) {
	session.mu.Lock()
	edge := session.edges[connectionID].edge
	delete(session.edges, connectionID)
	session.mu.Unlock()
	if edge != nil {
		_ = edge.Close()
	}
}

func (session *Session) Close() error {
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return nil
	}
	session.closed = true
	receivers := make([]*mediaedge.Receiver, 0, len(session.receivers))
	for _, receiver := range session.receivers {
		receivers = append(receivers, receiver)
	}
	edges := make([]*mediaedge.Edge, 0, len(session.edges))
	for _, owned := range session.edges {
		edges = append(edges, owned.edge)
	}
	session.receivers = make(map[string]*mediaedge.Receiver)
	session.edges = make(map[string]sessionEdge)
	session.mu.Unlock()
	session.cancel()
	for _, edge := range edges {
		_ = edge.Close()
	}
	for _, receiver := range receivers {
		_ = receiver.Close()
	}
	return session.engine.Close()
}

func (session *Session) receiver(connectionID string) *mediaedge.Receiver {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed {
		return nil
	}
	return session.receivers[connectionID]
}

func (session *Session) edge(connectionID string) *mediaedge.Edge {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed {
		return nil
	}
	return session.edges[connectionID].edge
}

func (session *Session) emit(event Event) {
	if session.events == nil {
		return
	}
	select {
	case session.events <- event:
	case <-session.ctx.Done():
	}
}

func (session *Session) runQuality() {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case now := <-ticker.C:
			session.mu.Lock()
			edges := make([]*mediaedge.Edge, 0, len(session.edges))
			for _, owned := range session.edges {
				edges = append(edges, owned.edge)
			}
			session.mu.Unlock()
			for _, edge := range edges {
				if sample, ok := edge.QualitySample(now); ok {
					session.emit(Event{
						Type: "edge-quality", ShareID: session.shareID,
						ConnectionID: edge.ConnectionID(), Quality: &sample,
					})
				}
			}
		case <-session.ctx.Done():
			return
		}
	}
}
