package nativehost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"time"

	"github.com/TNTcraftHIM/Screener/native/client/internal/mediaedge"
	"github.com/TNTcraftHIM/Screener/native/client/internal/nativecapture"
	"github.com/pion/webrtc/v4"
)

const startTimeout = 5 * time.Second

type CaptureState struct {
	State          string  `json:"state"`
	HardwareOnly   bool    `json:"hardwareOnly"`
	AdapterIndex   *uint32 `json:"adapterIndex,omitempty"`
	AdapterName    string  `json:"adapterName,omitempty"`
	AdapterLUID    string  `json:"adapterLuid,omitempty"`
	EncoderIndex   *uint32 `json:"mftIndex,omitempty"`
	EncoderName    string  `json:"mftName,omitempty"`
	EncoderCLSID   string  `json:"mftClsid,omitempty"`
	ProfileLevelID string  `json:"profileLevelId,omitempty"`
	Width          uint32  `json:"width,omitempty"`
	Height         uint32  `json:"height,omitempty"`
	FPS            uint32  `json:"fps,omitempty"`
}

type Event struct {
	Type         string
	ShareID      string
	ConnectionID string
	Candidate    *webrtc.ICECandidateInit
	State        string
	LocalType    string
	RemoteType   string
}

type Options struct {
	ShareID        string
	CaptureProcess string
	Video          nativecapture.VideoOptions
	EdgeCapacity   int
	BindAddress    string
	Events         chan<- Event
}

type Session struct {
	shareID string
	stream  *nativecapture.Stream
	engine  *mediaedge.Engine
	source  *mediaedge.Source
	events  chan<- Event

	ctx    context.Context
	cancel context.CancelFunc
	done   chan error
	ready  chan error

	mu     sync.Mutex
	edges  map[string]*mediaedge.Edge
	paused bool
	closed bool
}

func Start(parent context.Context, options Options) (*Session, error) {
	if parent == nil {
		parent = context.Background()
	}
	if options.ShareID == "" || len(options.ShareID) > 256 {
		return nil, errors.New("native share identity is invalid")
	}
	engine, err := mediaedge.NewEngine(mediaedge.EngineOptions{
		BindAddress: options.BindAddress,
	})
	if err != nil {
		return nil, err
	}
	stream, err := nativecapture.StartVideo(parent, options.CaptureProcess, options.Video)
	if err != nil {
		_ = engine.Close()
		return nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	session := &Session{
		shareID: options.ShareID,
		stream:  stream,
		engine:  engine,
		events:  options.Events,
		ctx:     ctx,
		cancel:  cancel,
		done:    make(chan error, 1),
		ready:   make(chan error, 1),
		edges:   make(map[string]*mediaedge.Edge),
	}
	source, err := engine.NewSource(options.EdgeCapacity, func() {
		_ = stream.RequestKeyFrame()
	})
	if err != nil {
		cancel()
		_ = stream.Close()
		_ = engine.Close()
		return nil, err
	}
	session.source = source
	go session.run()
	select {
	case err = <-session.ready:
		if err != nil {
			_ = session.Close()
			return nil, err
		}
		return session, nil
	case <-time.After(startTimeout):
		_ = session.Close()
		return nil, errors.New("native capture did not start in time")
	case <-parent.Done():
		_ = session.Close()
		return nil, parent.Err()
	}
}

func (session *Session) ShareID() string {
	return session.shareID
}

func (session *Session) PrepareEdge(
	connectionID string,
	iceServers []webrtc.ICEServer,
) (webrtc.SessionDescription, error) {
	session.mu.Lock()
	if session.closed || session.edges[connectionID] != nil {
		session.mu.Unlock()
		return webrtc.SessionDescription{}, errors.New("native media edge is unavailable")
	}
	session.mu.Unlock()
	created, err := session.engine.NewEdge(session.source, mediaedge.EdgeOptions{
		ConnectionID: connectionID,
		ICEServers:   iceServers,
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
						ConnectionID: connectionID,
						LocalType:    pair.Local.String(), RemoteType: pair.Remote.String(),
					})
				}
			},
		},
	})
	if err != nil {
		return webrtc.SessionDescription{}, err
	}
	edge := created
	session.mu.Lock()
	if session.closed || session.edges[connectionID] != nil {
		session.mu.Unlock()
		_ = edge.Close()
		return webrtc.SessionDescription{}, errors.New("native media edge is unavailable")
	}
	session.edges[connectionID] = edge
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
		return errors.New("native media edge does not exist")
	}
	return edge.SetAnswer(answer)
}

func (session *Session) AddCandidate(
	connectionID string,
	candidate *webrtc.ICECandidateInit,
) error {
	edge := session.edge(connectionID)
	if edge == nil {
		return errors.New("native media edge does not exist")
	}
	return edge.AddRemoteCandidate(candidate)
}

func (session *Session) SetPaused(paused bool) {
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return
	}
	session.paused = paused
	source := session.source
	session.mu.Unlock()
	if !paused {
		source.RequestRecoveryFrame()
	}
}

func (session *Session) CloseEdge(connectionID string) {
	session.mu.Lock()
	edge := session.edges[connectionID]
	delete(session.edges, connectionID)
	session.mu.Unlock()
	if edge != nil {
		_ = edge.Close()
	}
}

func (session *Session) Done() <-chan error {
	return session.done
}

func (session *Session) Close() error {
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		_, _ = <-session.done
		return nil
	}
	session.closed = true
	edges := make([]*mediaedge.Edge, 0, len(session.edges))
	for _, edge := range session.edges {
		edges = append(edges, edge)
	}
	session.edges = make(map[string]*mediaedge.Edge)
	session.mu.Unlock()
	session.cancel()
	for _, edge := range edges {
		_ = edge.Close()
	}
	_ = session.stream.Close()
	_ = session.source.Close()
	_ = session.engine.Close()
	_, _ = <-session.done
	return nil
}

func (session *Session) edge(connectionID string) *mediaedge.Edge {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed {
		return nil
	}
	return session.edges[connectionID]
}

func (session *Session) run() {
	var result error
	ready := false
	defer func() {
		if !ready {
			session.ready <- result
		}
		_ = session.source.Close()
		_ = session.engine.Close()
		_ = session.stream.Close()
		session.done <- result
		close(session.done)
	}()
	for {
		frame, err := session.stream.Read()
		if err != nil {
			if session.ctx.Err() == nil {
				result = errors.New("native capture process stopped unexpectedly")
			}
			return
		}
		switch frame.Kind {
		case nativecapture.FrameStatus:
			status, statusErr := decodeCaptureState(frame.Data)
			if statusErr != nil {
				result = statusErr
				return
			}
			session.emit(Event{Type: "capture-state", ShareID: session.shareID, State: status.State})
			if !ready {
				ready = true
				session.ready <- nil
			}
		case nativecapture.FrameH264:
			// Pion writes every binding before returning a per-binding error. Edge
			// state owns that failure; one retired edge must not stop healthy siblings.
			session.mu.Lock()
			paused := session.paused
			session.mu.Unlock()
			if !paused {
				_ = session.source.WriteH264(frame.Data, frame.Duration)
			}
		default:
			result = errors.New("native video process emitted a non-video frame")
			return
		}
	}
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

func decodeCaptureState(payload []byte) (CaptureState, error) {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var state CaptureState
	if err := decoder.Decode(&state); err != nil || decoder.Decode(&struct{}{}) != io.EOF ||
		(state.State != "starting" && state.State != "active") || !state.HardwareOnly {
		return CaptureState{}, errors.New("native capture state is invalid")
	}
	if state.State == "starting" &&
		(state.AdapterIndex == nil || state.EncoderIndex == nil ||
			state.AdapterName == "" || state.AdapterLUID == "" ||
			state.EncoderName == "" || state.EncoderCLSID == "") {
		return CaptureState{}, errors.New("native capture starting state is incomplete")
	}
	if state.State == "active" &&
		(state.ProfileLevelID != mediaedge.H264ProfileLevelID ||
			state.Width == 0 || state.Height == 0 || state.FPS == 0) {
		return CaptureState{}, errors.New("native capture active state is incomplete")
	}
	return state, nil
}
