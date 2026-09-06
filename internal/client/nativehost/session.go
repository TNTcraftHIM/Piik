package nativehost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/TNTcraftHIM/Screener/internal/client/mediaedge"
	"github.com/TNTcraftHIM/Screener/internal/client/nativecapture"
	"github.com/pion/webrtc/v4"
)

const startTimeout = 5 * time.Second
const qualitySamplePeriod = 2 * time.Second

type CaptureState struct {
	State           string  `json:"state"`
	HardwareOnly    bool    `json:"hardwareOnly"`
	Codec           string  `json:"codec"`
	AdapterIndex    *uint32 `json:"adapterIndex,omitempty"`
	AdapterName     string  `json:"adapterName,omitempty"`
	AdapterIdentity string  `json:"adapterIdentity,omitempty"`
	EncoderIndex    *uint32 `json:"encoderIndex,omitempty"`
	EncoderName     string  `json:"encoderName,omitempty"`
	EncoderIdentity string  `json:"encoderIdentity,omitempty"`
	ProfileLevelID  string  `json:"profileLevelId,omitempty"`
	Width           uint32  `json:"width,omitempty"`
	Height          uint32  `json:"height,omitempty"`
	FPS             uint32  `json:"fps,omitempty"`
	RestoreToken    string  `json:"restoreToken,omitempty"`
}

type Event struct {
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
	ShareID        string
	CaptureProcess string
	Video          nativecapture.VideoOptions
	Profile        QualityProfile
	AudioEnabled   bool
	EdgeCapacity   int
	BindAddress    string
	PortMapping    bool
	Events         chan<- Event
}

type Session struct {
	shareID        string
	captureProcess string
	videoOptions   nativecapture.VideoOptions
	profile        QualityProfile
	edgeCapacity   int
	stream         *nativecapture.Stream
	audioStream    *nativecapture.Stream
	engine         *mediaedge.Engine
	source         *mediaedge.Source
	audioSource    *mediaedge.AudioSource
	events         chan<- Event

	ctx    context.Context
	cancel context.CancelFunc
	done   chan error
	ready  chan error

	mu       sync.Mutex
	updateMu sync.Mutex
	edges    map[string]*mediaedge.Edge
	paused   bool
	closed   bool
}

func Start(parent context.Context, options Options) (*Session, error) {
	if parent == nil {
		parent = context.Background()
	}
	if options.ShareID == "" || len(options.ShareID) > 256 {
		return nil, errors.New("native share identity is invalid")
	}
	if !options.Profile.Valid() || options.Video.Profile != options.Profile.Video {
		return nil, errors.New("native share profile is invalid")
	}
	engine, err := mediaedge.NewEngine(mediaedge.EngineOptions{
		BindAddress:     options.BindAddress,
		IncludeLoopback: true,
		PortMapping:     options.PortMapping,
		InitialBitrate:  int(options.Profile.Video.Bitrate),
	})
	if err != nil {
		return nil, err
	}
	stream, err := nativecapture.StartVideo(parent, options.CaptureProcess, options.Video)
	if err != nil {
		_ = engine.Close()
		return nil, err
	}
	var audioStream *nativecapture.Stream
	if options.AudioEnabled {
		audioStream, _ = startAudioCapture(
			parent,
			options.CaptureProcess,
			options.Video.Target,
		)
	}
	ctx, cancel := context.WithCancel(parent)
	session := &Session{
		shareID:        options.ShareID,
		captureProcess: options.CaptureProcess,
		videoOptions:   options.Video,
		profile:        options.Profile,
		edgeCapacity:   options.EdgeCapacity,
		stream:         stream,
		audioStream:    audioStream,
		engine:         engine,
		events:         options.Events,
		ctx:            ctx,
		cancel:         cancel,
		done:           make(chan error, 1),
		ready:          make(chan error, 1),
		edges:          make(map[string]*mediaedge.Edge),
	}
	if audioStream != nil {
		audioSource, audioErr := engine.NewAudioSource(
			options.EdgeCapacity, options.Profile.AudioBitrate,
		)
		if audioErr != nil {
			_ = audioStream.Close()
			audioStream = nil
			session.audioStream = nil
		} else {
			session.audioSource = audioSource
		}
	}
	go session.run()
	var timeout <-chan time.Time
	var timer *time.Timer
	if options.Video.Target.Kind != "picker" {
		timer = time.NewTimer(startTimeout)
		timeout = timer.C
		defer timer.Stop()
	}
	select {
	case err = <-session.ready:
		if err != nil {
			_ = session.Close()
			return nil, err
		}
		return session, nil
	case <-timeout:
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

func (session *Session) Codec() string {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.source == nil {
		return ""
	}
	return session.source.Codec()
}

func (session *Session) HasAudio() bool {
	session.mu.Lock()
	defer session.mu.Unlock()
	return !session.closed && session.audioSource != nil
}

func (session *Session) PrepareEdge(
	connectionID string,
	iceServers []webrtc.ICEServer,
) (webrtc.SessionDescription, error) {
	return session.prepareEdge(connectionID, iceServers, false)
}

func (session *Session) PrepareLocalEdge(
	connectionID string,
) (webrtc.SessionDescription, error) {
	return session.prepareEdge(connectionID, nil, true)
}

func (session *Session) prepareEdge(
	connectionID string,
	iceServers []webrtc.ICEServer,
	local bool,
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
		Audio:        session.audioSource,
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
		// Candidates can arrive after an edge has been retired. They are
		// disposable input, not a reason to tear down the share session.
		return nil
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

func (session *Session) UpdateProfile(profile QualityProfile) error {
	if !profile.Valid() {
		return errors.New("native share profile is invalid")
	}
	session.updateMu.Lock()
	defer session.updateMu.Unlock()

	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return errors.New("native share is unavailable")
	}
	if session.profile == profile {
		session.mu.Unlock()
		return nil
	}
	previousProfile := session.profile
	options := session.videoOptions
	options.Profile = profile.Video
	session.mu.Unlock()
	if profile.Video == previousProfile.Video {
		if session.audioSource != nil && profile.AudioBitrate != previousProfile.AudioBitrate {
			if err := session.audioSource.SetBitrate(profile.AudioBitrate); err != nil {
				return err
			}
		}
		session.mu.Lock()
		if session.closed {
			session.mu.Unlock()
			return errors.New("native share is unavailable")
		}
		session.profile = profile
		session.mu.Unlock()
		return nil
	}

	replacement, state, err := session.prepareVideo(session.ctx, options)
	if err != nil {
		return err
	}
	if session.audioSource != nil && profile.AudioBitrate != previousProfile.AudioBitrate {
		if err = session.audioSource.SetBitrate(profile.AudioBitrate); err != nil {
			_ = replacement.Close()
			return err
		}
	}

	return session.commitCapture(
		options,
		profile,
		replacement,
		state,
		nil,
		false,
	)
}

func (session *Session) ReplaceSource(
	ctx context.Context,
	options nativecapture.VideoOptions,
	audioEnabled bool,
) error {
	session.updateMu.Lock()
	defer session.updateMu.Unlock()

	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return errors.New("native share is unavailable")
	}
	profile := session.profile
	options.Codec = session.videoOptions.Codec
	hasAudio := session.audioSource != nil && session.audioStream != nil
	session.mu.Unlock()
	if audioEnabled != hasAudio {
		return errors.New("native source audio availability cannot change while sharing")
	}
	options.Profile = profile.Video
	options.RestoreToken = ""
	replacement, state, err := session.prepareVideo(ctx, options)
	if err != nil {
		return err
	}
	var replacementAudio *nativecapture.Stream
	if hasAudio {
		replacementAudio, err = startAudioCapture(
			ctx,
			session.captureProcess,
			options.Target,
		)
		if err != nil {
			_ = replacement.Close()
			return errors.New("native source audio could not start")
		}
	}
	return session.commitCapture(
		options,
		profile,
		replacement,
		state,
		replacementAudio,
		hasAudio,
	)
}

func startAudioCapture(
	ctx context.Context,
	captureProcess string,
	target nativecapture.CaptureTarget,
) (*nativecapture.Stream, error) {
	if target.Kind == "display" || target.Kind == "picker" {
		return nativecapture.StartSystemAudio(ctx, captureProcess)
	}
	return nativecapture.StartAudio(ctx, captureProcess, target)
}

func (session *Session) prepareVideo(
	ctx context.Context,
	options nativecapture.VideoOptions,
) (*nativecapture.Stream, CaptureState, error) {
	replacement, err := nativecapture.StartVideo(
		ctx,
		session.captureProcess,
		options,
	)
	if err != nil {
		return nil, CaptureState{}, errors.New("native capture could not start")
	}
	state, err := waitForCaptureProfile(
		ctx,
		replacement,
		options.Profile,
		options.Codec,
		options.Target.Kind == "picker",
	)
	if err != nil {
		_ = replacement.Close()
		return nil, CaptureState{}, err
	}
	return replacement, state, nil
}

func (session *Session) commitCapture(
	options nativecapture.VideoOptions,
	profile QualityProfile,
	replacement *nativecapture.Stream,
	state CaptureState,
	replacementAudio *nativecapture.Stream,
	replaceAudio bool,
) error {
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		_ = replacement.Close()
		if replacementAudio != nil {
			_ = replacementAudio.Close()
		}
		return errors.New("native share is unavailable")
	}
	previous := session.stream
	previousAudio := session.audioStream
	if state.RestoreToken != "" {
		options.RestoreToken = state.RestoreToken
	}
	session.stream = replacement
	if replaceAudio {
		session.audioStream = replacementAudio
	}
	session.videoOptions = options
	session.profile = profile
	session.source.SetFormat(state.Width, state.Height)
	session.mu.Unlock()

	session.emit(Event{
		Type: "capture-state", ShareID: session.shareID, State: "active",
	})
	_ = replacement.RequestKeyFrame()
	_ = previous.Close()
	if replaceAudio && previousAudio != nil {
		_ = previousAudio.Close()
	}
	return nil
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
	session.updateMu.Lock()
	defer session.updateMu.Unlock()
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
	stream := session.stream
	audioStream := session.audioStream
	session.edges = make(map[string]*mediaedge.Edge)
	session.mu.Unlock()
	session.cancel()
	for _, edge := range edges {
		_ = edge.Close()
	}
	_ = stream.Close()
	if audioStream != nil {
		_ = audioStream.Close()
	}
	if session.source != nil {
		_ = session.source.Close()
	}
	if session.audioSource != nil {
		_ = session.audioSource.Close()
	}
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
	videoDone := make(chan error, 1)
	go func() {
		videoDone <- session.runVideo()
	}()
	audioDone := make(chan struct{})
	qualityDone := make(chan struct{})
	go func() {
		session.runQuality()
		close(qualityDone)
	}()
	if session.audioStream == nil {
		close(audioDone)
	} else {
		go func() {
			session.runAudio()
			close(audioDone)
		}()
	}
	result := <-videoDone
	session.mu.Lock()
	closed := session.closed
	session.mu.Unlock()
	if closed {
		// An explicit Close is a clean end, even if closing the capture process
		// made the video reader return an error.
		result = nil
	}
	session.cancel()
	session.mu.Lock()
	audioStream := session.audioStream
	session.mu.Unlock()
	if audioStream != nil {
		_ = audioStream.Close()
	}
	<-audioDone
	<-qualityDone
	defer func() {
		if session.source != nil {
			_ = session.source.Close()
		}
		if session.audioSource != nil {
			_ = session.audioSource.Close()
		}
		_ = session.engine.Close()
		session.mu.Lock()
		stream := session.stream
		audioStream := session.audioStream
		session.mu.Unlock()
		_ = stream.Close()
		if audioStream != nil {
			_ = audioStream.Close()
		}
		session.done <- result
		close(session.done)
	}()
	return
}

func (session *Session) runVideo() error {
	ready := false
	fail := func(err error) error {
		if !ready {
			session.ready <- err
		}
		return err
	}
	current := session.currentStream()
	for current != nil {
		frame, err := current.Read()
		if err != nil {
			next := session.currentStream()
			if next != nil && next != current {
				session.source.BeginGeneration()
				current = next
				continue
			}
			return fail(errors.New("native capture process stopped unexpectedly"))
		}
		if next := session.currentStream(); next != current {
			if next != nil {
				session.source.BeginGeneration()
				current = next
			}
			continue
		}
		switch frame.Kind {
		case nativecapture.FrameStatus:
			status, statusErr := decodeCaptureState(frame.Data)
			if statusErr != nil {
				return fail(statusErr)
			}
			session.mu.Lock()
			if session.closed {
				session.mu.Unlock()
				return fail(errors.New("native share stopped"))
			}
			if session.source == nil {
				if session.videoOptions.Codec != "auto" && session.videoOptions.Codec != status.Codec {
					session.mu.Unlock()
					return fail(errors.New("native capture codec was not applied"))
				}
				source, sourceErr := session.engine.NewSource(status.Codec, session.edgeCapacity, func() {
					if stream := session.currentStream(); stream != nil {
						_ = stream.RequestKeyFrame()
					}
				})
				if sourceErr != nil {
					session.mu.Unlock()
					return fail(sourceErr)
				}
				session.source = source
				session.videoOptions.Codec = status.Codec
			} else if session.source.Codec() != status.Codec {
				session.mu.Unlock()
				return fail(errors.New("native capture codec changed within a share"))
			}
			session.mu.Unlock()
			session.emit(Event{Type: "capture-state", ShareID: session.shareID, State: status.State})
			if status.State == "active" {
				session.mu.Lock()
				profile := session.videoOptions.Profile
				if status.RestoreToken != "" {
					session.videoOptions.RestoreToken = status.RestoreToken
				}
				session.mu.Unlock()
				if status.Width != profile.Width || status.Height != profile.Height ||
					status.FPS != profile.Framerate {
					return fail(errors.New("native capture profile was not applied"))
				}
				session.source.SetFormat(status.Width, status.Height)
			}
			if !ready {
				ready = true
				session.ready <- nil
			}
		case nativecapture.FrameH264, nativecapture.FrameVP8:
			if session.source == nil ||
				(frame.Kind == nativecapture.FrameH264) != (session.source.Codec() == "h264") {
				return fail(errors.New("native video frame does not match its source codec"))
			}
			// Pion writes every binding before returning a per-binding error. Edge
			// state owns that failure; one retired edge must not stop healthy siblings.
			session.mu.Lock()
			paused := session.paused
			session.mu.Unlock()
			if !paused {
				writeErr := session.source.WriteVideo(
					frame.Data,
					frame.Timestamp,
					frame.Duration,
				)
				if errors.Is(writeErr, mediaedge.ErrInvalidVideoTimestamp) {
					return fail(writeErr)
				}
			}
		case nativecapture.FramePCM:
			return fail(errors.New("native video process emitted audio"))
		default:
			return fail(errors.New("native video process emitted an unknown frame"))
		}
	}
	return fail(errors.New("native capture process stopped unexpectedly"))
}

func (session *Session) currentStream() *nativecapture.Stream {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed {
		return nil
	}
	return session.stream
}

func waitForCaptureProfile(
	ctx context.Context,
	stream *nativecapture.Stream,
	profile nativecapture.VideoProfile,
	codec string,
	interactive bool,
) (CaptureState, error) {
	type result struct {
		state CaptureState
		err   error
	}
	ready := make(chan result, 1)
	go func() {
		for {
			frame, err := stream.Read()
			if err != nil {
				ready <- result{err: errors.New("native capture profile did not become ready")}
				return
			}
			if frame.Kind != nativecapture.FrameStatus {
				continue
			}
			state, err := decodeCaptureState(frame.Data)
			if err != nil {
				ready <- result{err: err}
				return
			}
			if state.State == "active" {
				if state.Codec != codec || state.Width != profile.Width || state.Height != profile.Height ||
					state.FPS != profile.Framerate {
					ready <- result{err: errors.New("native capture profile was not applied")}
					return
				}
				ready <- result{state: state}
				return
			}
		}
	}()
	var timeout <-chan time.Time
	var timer *time.Timer
	if !interactive {
		timer = time.NewTimer(startTimeout)
		timeout = timer.C
		defer timer.Stop()
	}
	select {
	case value := <-ready:
		return value.state, value.err
	case <-timeout:
		return CaptureState{}, errors.New("native capture profile timed out")
	case <-ctx.Done():
		return CaptureState{}, errors.New("native share stopped")
	}
}

func (session *Session) runQuality() {
	ticker := time.NewTicker(qualitySamplePeriod)
	defer ticker.Stop()
	for {
		select {
		case now := <-ticker.C:
			session.mu.Lock()
			edges := make([]*mediaedge.Edge, 0, len(session.edges))
			for _, edge := range session.edges {
				edges = append(edges, edge)
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

func (session *Session) runAudio() {
	current := session.currentAudioStream()
	for current != nil {
		frame, err := current.Read()
		if err != nil {
			next := session.currentAudioStream()
			if next != nil && next != current {
				current = next
				continue
			}
			return
		}
		if next := session.currentAudioStream(); next != current {
			current = next
			continue
		}
		if frame.Kind != nativecapture.FramePCM {
			return
		}
		session.mu.Lock()
		paused := session.paused
		session.mu.Unlock()
		if paused {
			continue
		}
		if err = session.audioSource.WritePCM(frame.Data, frame.Duration); err != nil {
			return
		}
	}
}

func (session *Session) currentAudioStream() *nativecapture.Stream {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed {
		return nil
	}
	return session.audioStream
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
		(state.State != "starting" && state.State != "active") ||
		(state.Codec != "h264" && state.Codec != "vp8") ||
		state.HardwareOnly != (state.Codec == "h264") {
		return CaptureState{}, errors.New("native capture state is invalid")
	}
	if state.State == "starting" &&
		(state.AdapterIndex == nil || (state.Codec == "h264" && state.EncoderIndex == nil) ||
			state.AdapterName == "" || state.AdapterIdentity == "" ||
			state.EncoderName == "" || state.EncoderIdentity == "") {
		return CaptureState{}, errors.New("native capture starting state is incomplete")
	}
	if state.State == "active" &&
		((state.Codec == "h264" && !validH264ProfileLevelID(state.ProfileLevelID)) ||
			(state.Codec == "vp8" && state.ProfileLevelID != "") ||
			state.Width == 0 || state.Height == 0 || state.FPS == 0 ||
			len(state.RestoreToken) > 4096 || !utf8.ValidString(state.RestoreToken) ||
			strings.ContainsRune(state.RestoreToken, 0)) {
		return CaptureState{}, errors.New("native capture active state is incomplete")
	}
	return state, nil
}

func validH264ProfileLevelID(value string) bool {
	switch value {
	case "42c01e", "42c01f", "42c020", "42c028", "42c029", "42c02a", "42c032", "42c033":
		return true
	default:
		return false
	}
}
