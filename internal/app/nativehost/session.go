package nativehost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/TNTcraftHIM/Piik/internal/app/mediaedge"
	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/TNTcraftHIM/Piik/internal/diagnostics"
	"github.com/TNTcraftHIM/Piik/internal/media/encoded"
	"github.com/pion/webrtc/v4"
)

const startTimeout = 5 * time.Second
const qualitySamplePeriod = 2 * time.Second

type CaptureState struct {
	State           string                        `json:"state"`
	HardwareOnly    bool                          `json:"hardwareOnly"`
	Codec           string                        `json:"codec"`
	AdapterIndex    *uint32                       `json:"adapterIndex,omitempty"`
	AdapterName     string                        `json:"adapterName,omitempty"`
	AdapterIdentity string                        `json:"adapterIdentity,omitempty"`
	EncoderIndex    *uint32                       `json:"encoderIndex,omitempty"`
	EncoderName     string                        `json:"encoderName,omitempty"`
	EncoderIdentity string                        `json:"encoderIdentity,omitempty"`
	ProfileLevelID  string                        `json:"profileLevelId,omitempty"`
	Width           uint32                        `json:"width,omitempty"`
	Height          uint32                        `json:"height,omitempty"`
	FPS             uint32                        `json:"fps,omitempty"`
	RestoreToken    string                        `json:"restoreToken,omitempty"`
	Outputs         []nativecapture.OutputProfile `json:"outputs"`
}

type Event struct {
	Current               func() bool
	Type                  string
	ShareID               string
	ConnectionID          string
	PublicationGeneration string
	Candidate             *webrtc.ICECandidateInit
	State                 string
	LocalType             string
	RemoteType            string
	NatTraversalPath      string
	Quality               *mediaedge.QualitySample
	PublicationQuality    *mediaedge.PublicationQualitySample
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

	mu             sync.Mutex
	updateMu       sync.Mutex
	edges          map[string]*mediaedge.Edge
	publications   map[publicationKey]*mediaedge.Publication
	captureApplied chan struct{}
	audioChanged   chan struct{}
	paused         bool
	closed         bool
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
	options.Video.OutputGroups = options.EdgeCapacity
	stream, err := nativecapture.StartVideo(parent, options.CaptureProcess, options.Video)
	if err != nil {
		_ = engine.Close()
		return nil, err
	}
	var audioStream *nativecapture.Stream
	if options.AudioEnabled {
		var audioErr error
		audioStream, audioErr = startAudioCapture(
			parent,
			options.CaptureProcess,
			options.Video.Target,
		)
		if audioErr != nil {
			slog.DebugContext(parent, "piik-client", "event", "capture-audio-unavailable", "share", diagnostics.ID(options.ShareID), diagnostics.Error(audioErr))
		}
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
		audioChanged:   make(chan struct{}, 1),
	}
	if audioStream != nil {
		audioSource, audioErr := engine.NewAudioSource(
			options.EdgeCapacity, options.Profile.AudioBitrate,
		)
		if audioErr != nil {
			slog.DebugContext(ctx, "piik-client", "event", "capture-audio-source-failed", "share", diagnostics.ID(options.ShareID), diagnostics.Error(audioErr))
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
	if session.closed || session.ctx.Err() != nil {
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
		if session.closed || session.ctx.Err() != nil {
			session.mu.Unlock()
			return errors.New("native share is unavailable")
		}
		session.profile = profile
		session.mu.Unlock()
		return nil
	}

	// Updating an existing source never waits for an interactive picker.
	replacement, state, err := session.prepareVideo(session.ctx, options, false, true)
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
	options.OutputGroups = session.edgeCapacity
	hasAudio := session.audioSource != nil && session.audioStream != nil
	session.mu.Unlock()
	if audioEnabled != hasAudio {
		return errors.New("native source audio availability cannot change while sharing")
	}
	options.Profile = profile.Video
	options.RestoreToken = ""
	replacement, state, err := session.prepareVideo(ctx, options, options.Target.Kind == "picker", false)
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
	interactive bool,
	allowQuiet bool,
) (*nativecapture.Stream, CaptureState, error) {
	options.OutputGroups = session.edgeCapacity
	replacement, err := nativecapture.StartVideo(
		ctx,
		session.captureProcess,
		options,
	)
	if err != nil {
		return nil, CaptureState{}, captureProfileFailure(ctx, options.Profile, "process-start",
			errors.New("native capture could not start"))
	}
	state, err := waitForCaptureProfile(
		ctx,
		replacement,
		options.Profile,
		options.Codec,
		interactive,
		allowQuiet,
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
	if session.closed || session.ctx.Err() != nil {
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
	applied := make(chan struct{})
	session.captureApplied = applied
	if replaceAudio {
		session.audioStream = replacementAudio
		select {
		case session.audioChanged <- struct{}{}:
		default:
		}
	}
	session.videoOptions = options
	session.profile = profile
	session.mu.Unlock()

	_ = replacement.RequestKeyFrame(-1)
	_ = previous.Close()
	if replaceAudio && previousAudio != nil {
		_ = previousAudio.Close()
	}
	select {
	case <-applied:
	case <-session.ctx.Done():
		return session.ctx.Err()
	}
	if err := session.ctx.Err(); err != nil {
		return err
	}
	session.emit(Event{
		Type: "capture-state", ShareID: session.shareID, State: "active",
	})
	return nil
}

// Only the video reader installs source metadata, after leaving the old input.
// The update response waits for this exact stream's installation, not its process.
func (session *Session) installCapture(next *nativecapture.Stream) error {
	session.source.BeginGeneration()
	if err := configureCaptureOutputs(session.source, next.Outputs()); err != nil {
		return err
	}
	session.mu.Lock()
	if session.stream == next && session.captureApplied != nil {
		close(session.captureApplied)
		session.captureApplied = nil
	}
	session.mu.Unlock()
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
	session.cancel()
	session.updateMu.Lock()
	defer session.updateMu.Unlock()
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		_, _ = <-session.done
		return nil
	}
	session.closed = true
	session.edges = make(map[string]*mediaedge.Edge)
	session.mu.Unlock()
	session.retire()
	_, _ = <-session.done
	return nil
}

// Both explicit Close and source termination retire these idempotent owners.
// Do not wait for run here: Close uses this to unblock run's readers.
func (session *Session) retire() {
	session.mu.Lock()
	source, stream := session.source, session.stream
	audioSource, audioStream := session.audioSource, session.audioStream
	session.mu.Unlock()
	if source != nil {
		_ = source.Close()
	}
	_ = stream.Close()
	if audioStream != nil {
		_ = audioStream.Close()
	}
	if audioSource != nil {
		_ = audioSource.Close()
	}
	_ = session.engine.Close()
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
	if closed || session.ctx.Err() != nil {
		// Closing this owner or its parent is a clean end, even if stopping the
		// capture process made the video reader return an error.
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
	session.retire()
	if slog.Default().Enabled(session.ctx, slog.LevelDebug) {
		slog.Debug("piik-client", "event", "share-ended", "share", diagnostics.ID(session.shareID), "failed", result != nil, diagnostics.Error(result))
	}
	session.done <- result
	close(session.done)
}

func (session *Session) runVideo() error {
	ready := false
	activeSeen := false
	fail := func(err error) error {
		if !ready {
			session.ready <- err
		}
		return err
	}
	current := session.currentStream()
	changeStream := func(next *nativecapture.Stream) error {
		if err := session.installCapture(next); err != nil {
			return err
		}
		current = next
		// prepareVideo consumed and verified this replacement's active status.
		activeSeen = true
		return nil
	}
	for current != nil {
		frame, err := current.Read()
		if err != nil {
			next := session.currentStream()
			if next != nil && next != current {
				if err = changeStream(next); err != nil {
					return fail(err)
				}
				continue
			}
			slog.DebugContext(session.ctx, "piik-client", "event", "capture-video-read-ended",
				"share", diagnostics.ID(session.shareID), "canceled", session.ctx.Err() != nil, "eof", errors.Is(err, io.EOF), diagnostics.Error(err))
			return fail(errors.New("native capture process stopped unexpectedly"))
		}
		if next := session.currentStream(); next != current {
			if next != nil {
				if err = changeStream(next); err != nil {
					return fail(err)
				}
			}
			continue
		}
		switch frame.Kind {
		case nativecapture.FrameStatus:
			status, statusErr := decodeCaptureState(frame.Data)
			if statusErr != nil {
				return fail(statusErr)
			}
			if !slices.Equal(status.Outputs, current.Outputs()) {
				return fail(errors.New("native capture outputs were not applied"))
			}
			session.mu.Lock()
			if session.closed {
				session.mu.Unlock()
				return fail(errors.New("native share stopped"))
			}
			if session.stream != current {
				session.mu.Unlock()
				continue
			}
			if session.source == nil {
				if session.videoOptions.Codec != "auto" && session.videoOptions.Codec != status.Codec {
					session.mu.Unlock()
					return fail(errors.New("native capture codec was not applied"))
				}
				source, sourceErr := session.engine.NewSource(status.Codec, session.edgeCapacity, min(2, len(status.Outputs)), func() {
					if stream := session.currentStream(); stream != nil {
						_ = stream.RequestKeyFrame(-1)
					}
				})
				if sourceErr != nil {
					session.mu.Unlock()
					return fail(sourceErr)
				}
				if sourceErr = configureCaptureOutputs(source, status.Outputs); sourceErr != nil {
					session.mu.Unlock()
					_ = source.Close()
					return fail(sourceErr)
				}
				session.source = source
				session.videoOptions.Codec = status.Codec
			} else if session.source.Codec() != status.Codec {
				session.mu.Unlock()
				return fail(errors.New("native capture codec changed within a share"))
			}
			if status.State == "active" {
				activeSeen = true
				if status.RestoreToken != "" {
					session.videoOptions.RestoreToken = status.RestoreToken
				}
			}
			session.mu.Unlock()
			slog.Debug("piik-client", "event", "capture-state", "state", status.State, "codec", status.Codec,
				"share", diagnostics.ID(session.shareID), "width", status.Width, "height", status.Height, "fps", status.FPS,
				"hardware", status.HardwareOnly, "adapterIndex", status.AdapterIndex, "encoderIndex", status.EncoderIndex,
				"adapterName", diagnostics.SafeText(status.AdapterName), "encoderName", diagnostics.SafeText(status.EncoderName),
				"profileLevelId", status.ProfileLevelID, "outputs", status.Outputs)
			session.emit(Event{Type: "capture-state", ShareID: session.shareID, State: status.State})
			if !ready {
				ready = true
				session.ready <- nil
			}
		case nativecapture.FrameBegin:
			if session.source == nil {
				return fail(errors.New("native capture input arrived before its state"))
			}
			plan, beginErr := session.source.BeginFrame(frame.Timestamp)
			if beginErr != nil {
				return fail(beginErr)
			}
			session.mu.Lock()
			paused := session.paused
			session.mu.Unlock()
			if paused {
				clear(plan.Active)
			}
			controlErr := applyOutputPlan(current, plan, activeSeen)
			if controlErr != nil && session.currentStream() == current {
				return fail(controlErr)
			}
		case nativecapture.FrameH264, nativecapture.FrameVP8:
			if session.source == nil ||
				(frame.Kind == nativecapture.FrameH264) != (session.source.Codec() == "h264") {
				return fail(errors.New("native video frame does not match its source codec"))
			}
			if formatErr := session.source.SetFormat(frame.Layer, frame.Width, frame.Height); formatErr != nil {
				return fail(formatErr)
			}
			// Edge state owns write failures; one retired edge cannot stop siblings.
			session.mu.Lock()
			paused := session.paused
			session.mu.Unlock()
			if !paused {
				writeErr := session.source.WriteVideo(frame.Layer, encoded.Frame{
					Data: frame.Data, PTS: frame.Timestamp, Duration: frame.Duration, Recovery: frame.KeyFrame,
				})
				if errors.Is(writeErr, encoded.ErrInvalidTimestamp) {
					return fail(writeErr)
				}
			}
		case nativecapture.FrameLayerUnavailable:
			slog.DebugContext(session.ctx, "piik-client", "event", "capture-output-unavailable",
				"share", diagnostics.ID(session.shareID), "layer", frame.Layer, "detail", diagnostics.SafeText(string(frame.Data)))
			if session.source == nil {
				return fail(errors.New("native output ended before its source state"))
			}
			if err = session.source.DisableLayer(frame.Layer); err != nil {
				return fail(err)
			}
		case nativecapture.FramePCM:
			return fail(errors.New("native video process emitted audio"))
		default:
			return fail(errors.New("native video process emitted an unknown frame"))
		}
	}
	return fail(errors.New("native capture process stopped unexpectedly"))
}

func configureCaptureOutputs(source *mediaedge.Source, outputs []nativecapture.OutputProfile) error {
	ceilings := make([]uint32, len(outputs))
	for layer, output := range outputs {
		if layer < 2 {
			if err := source.SetFormat(layer, output.Width, output.Height); err != nil {
				return err
			}
		}
		ceilings[layer] = output.Bitrate
	}
	if err := source.ConfigureOutputs(ceilings); err != nil {
		return err
	}
	for layer := 2; layer < len(outputs); layer++ {
		if err := source.SetFormat(layer, outputs[layer].Width, outputs[layer].Height); err != nil {
			return err
		}
	}
	source.SetLowestLayerRateControlled(true)
	return nil
}

func applyOutputPlan(stream *nativecapture.Stream, plan mediaedge.OutputPlan, activeSeen bool) error {
	for layer, bitrate := range plan.Bitrates {
		if bitrate > 0 {
			if err := stream.SetOutputBitrate(layer, bitrate); err != nil {
				return err
			}
		}
	}
	for _, layer := range plan.RecoveryLayers {
		if err := stream.RequestKeyFrame(layer); err != nil {
			return err
		}
	}
	// A new group must receive its budget before activation admits a frame.
	// Startup retains the original until its first active status has arrived.
	if activeSeen {
		for layer, active := range plan.Active {
			if err := stream.SetOutputActive(layer, active); err != nil {
				return err
			}
		}
	}
	return nil
}

func (session *Session) currentStream() *nativecapture.Stream {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed {
		return nil
	}
	return session.stream
}

func captureProfileFailure(ctx context.Context, profile nativecapture.VideoProfile, stage string, err error) error {
	slog.DebugContext(ctx, "piik-client", "event", "capture-profile-rejected", "stage", stage,
		"width", profile.Width, "height", profile.Height, "fps", profile.Framerate, "bitrate", profile.Bitrate, diagnostics.Error(err))
	return err
}

func waitForCaptureProfile(
	ctx context.Context,
	stream *nativecapture.Stream,
	profile nativecapture.VideoProfile,
	codec string,
	interactive bool,
	allowQuiet bool,
) (CaptureState, error) {
	type result struct {
		state CaptureState
		err   error
		stage string
		input bool
	}
	ready := make(chan result, 1)
	stopped := make(chan struct{})
	defer close(stopped)
	go func() {
		send := func(value result) bool {
			select {
			case ready <- value:
				return true
			case <-stopped:
				return false
			}
		}
		inputSeen := false
		for {
			frame, err := stream.Read()
			if err != nil {
				send(result{stage: "process-ended", err: errors.New("native capture profile did not become ready")})
				return
			}
			if frame.Kind == nativecapture.FrameLayerUnavailable {
				send(result{stage: "output-unavailable", err: errors.New("native capture profile has an unavailable output")})
				return
			}
			if frame.Kind == nativecapture.FrameBegin && !inputSeen {
				inputSeen = true
				if !send(result{input: true}) {
					return
				}
			}
			if frame.Kind != nativecapture.FrameStatus {
				continue
			}
			state, err := decodeCaptureState(frame.Data)
			if err != nil {
				send(result{stage: "status-invalid", err: err})
				return
			}
			slog.DebugContext(ctx, "piik-client", "event", "capture-profile-observed", "state", state.State,
				"expectedCodec", codec, "actualCodec", state.Codec, "expectedProfile", profile,
				"actualWidth", state.Width, "actualHeight", state.Height, "actualFPS", state.FPS,
				"expectedOutputs", stream.Outputs(), "actualOutputs", state.Outputs)
			if !slices.Equal(state.Outputs, stream.Outputs()) {
				send(result{stage: "outputs-mismatch", err: errors.New("native capture outputs were not applied")})
				return
			}
			if state.Codec != codec {
				send(result{stage: "profile-mismatch", err: errors.New("native capture codec was not applied")})
				return
			}
			if state.State == "active" {
				if state.Width != profile.Width || state.Height != profile.Height ||
					state.FPS != profile.Framerate {
					send(result{stage: "profile-mismatch", err: errors.New("native capture profile was not applied")})
					return
				}
				send(result{state: state})
				return
			}
			if !send(result{state: state}) {
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
	inputSeen, startingSeen := false, false
	for {
		select {
		case value := <-ready:
			if value.err != nil {
				return value.state, captureProfileFailure(ctx, profile, value.stage, value.err)
			}
			if value.state.State == "active" {
				return value.state, nil
			}
			if allowQuiet && timer != nil {
				if value.input && !inputSeen {
					if !startingSeen {
						return CaptureState{}, captureProfileFailure(ctx, profile, "status-invalid",
							errors.New("native capture input arrived before its starting state"))
					}
					inputSeen = true
					timer.Reset(startTimeout)
					timeout = timer.C
				} else if value.state.State == "starting" && !inputSeen {
					startingSeen = true
					timer.Stop()
					timeout = nil
				}
			}
		case <-timeout:
			return CaptureState{}, captureProfileFailure(ctx, profile, "wait-timeout",
				errors.New("native capture profile timed out"))
		case <-ctx.Done():
			return CaptureState{}, captureProfileFailure(ctx, profile, "share-stopped",
				errors.New("native share stopped"))
		}
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
			publications := make(map[publicationKey]*mediaedge.Publication, len(session.publications))
			for key, publication := range session.publications {
				publications[key] = publication
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
			for key, publication := range publications {
				if sample, ok := publication.QualitySample(now); ok {
					session.emit(Event{Type: "publication-quality", ShareID: session.shareID,
						Current:               func() bool { return session.ownsPublication(key, publication) },
						PublicationGeneration: key.generation, ConnectionID: key.connectionID, PublicationQuality: &sample})
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
		if next := session.currentAudioStream(); next != current {
			current = next
			continue
		}
		if err == nil && frame.Kind == nativecapture.FramePCM {
			session.mu.Lock()
			paused := session.paused
			session.mu.Unlock()
			if paused {
				continue
			}
			err = session.audioSource.WritePCM(frame.Data, frame.Duration)
			if err == nil {
				continue
			}
		}
		slog.DebugContext(session.ctx, "piik-client", "event", "capture-audio-stream-ended",
			"share", diagnostics.ID(session.shareID), "frameKind", frame.Kind, "eof", errors.Is(err, io.EOF),
			"canceled", session.ctx.Err() != nil, diagnostics.Error(err))
		// Audio failure leaves video live. Only an explicit source replacement
		// changes this owner; its buffered wake also covers an earlier commit.
		for session.currentAudioStream() == current {
			select {
			case <-session.audioChanged:
			case <-session.ctx.Done():
				return
			}
		}
		current = session.currentAudioStream()
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
		state.HardwareOnly != (state.Codec == "h264") || len(state.Outputs) < 1 || len(state.Outputs) > 6 {
		return CaptureState{}, errors.New("native capture state is invalid")
	}
	for _, output := range state.Outputs {
		if !output.Valid() {
			return CaptureState{}, errors.New("native capture output profile is invalid")
		}
	}
	if state.State == "starting" &&
		(state.AdapterIndex == nil || (state.Codec == "h264" && state.EncoderIndex == nil) ||
			state.AdapterName == "" || state.AdapterIdentity == "" ||
			state.EncoderName == "" || state.EncoderIdentity == "") {
		return CaptureState{}, errors.New("native capture starting state is incomplete")
	}
	original := state.Outputs[min(1, len(state.Outputs)-1)]
	if state.State == "active" &&
		((state.Codec == "h264" && !validH264ProfileLevelID(state.ProfileLevelID)) ||
			(state.Codec == "vp8" && state.ProfileLevelID != "") ||
			state.Width != original.Width ||
			state.Height != original.Height ||
			state.FPS != original.Framerate ||
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
