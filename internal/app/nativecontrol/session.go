package nativecontrol

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/TNTcraftHIM/Piik/internal/app/loopback"
	"github.com/TNTcraftHIM/Piik/internal/app/mediaedge"
	"github.com/TNTcraftHIM/Piik/internal/app/nativecapture"
	"github.com/TNTcraftHIM/Piik/internal/app/nativehost"
	"github.com/TNTcraftHIM/Piik/internal/app/nativeviewer"
	"github.com/TNTcraftHIM/Piik/internal/diagnostics"
	"github.com/pion/webrtc/v4"
)

const (
	maxSDPBytes       = 48 * 1024
	maxCandidateBytes = 4096
	maxSTUNURLBytes   = 512
	maxICEServers     = 8
	maxURLsPerServer  = 8
	maxEdgeCapacity   = 3
)

var identityPattern = regexp.MustCompile("^[A-Za-z0-9_-]{8,256}$")

type Session struct {
	captureProcess string
	capabilities   nativecapture.Capabilities
	portMapping    bool
	ctx            context.Context
	cancel         context.CancelFunc
	events         chan any
	hostEvents     chan nativehost.Event
	viewerEvents   chan nativeviewer.Event

	mu         sync.Mutex
	host       *nativehost.Session
	viewer     *nativeviewer.Session
	closed     bool
	updateDone chan struct{}
}

type outboundMediaSession interface {
	SetAnswer(string, webrtc.SessionDescription) error
	AddCandidate(string, *webrtc.ICECandidateInit) error
	CloseEdge(string)
}

func New(
	captureProcess string,
	capabilities nativecapture.Capabilities,
	portMapping bool,
) *Session {
	ctx, cancel := context.WithCancel(context.Background())
	session := &Session{
		captureProcess: captureProcess,
		capabilities:   capabilities,
		portMapping:    portMapping,
		ctx:            ctx,
		cancel:         cancel,
		events:         make(chan any, 256),
		hostEvents:     make(chan nativehost.Event, 256),
		viewerEvents:   make(chan nativeviewer.Event, 256),
	}
	go session.relayEvents()
	return session
}

func (session *Session) Events() <-chan any {
	return session.events
}

type protocolViolation string

func (err protocolViolation) Error() string { return string(err) }

// Malformed commands close the control connection. Valid commands that cannot
// complete fail only their request; an already-retired teardown target is ACKed.
func (session *Session) Handle(ctx context.Context, payload []byte) (result any, returnedErr error) {
	var envelope requestEnvelope
	if err := decodeEnvelope(payload, &envelope); err != nil {
		return nil, err
	}
	complete := session.traceRequest(envelope, payload)
	asynchronous := false
	defer func() {
		var invalid protocolViolation
		if returnedErr != nil && !errors.As(returnedErr, &invalid) {
			result = operationFailure(envelope, returnedErr)
			returnedErr = nil
		}
		if !asynchronous {
			complete(result, returnedErr)
		}
	}()
	switch envelope.Type {
	case "prepare-publication", "publication-media", "publication-answer", "publication-candidate", "publication-layers", "close-publication":
		return session.handlePublication(envelope, payload)
	case "capture-options":
		var request captureOptionsRequest
		if err := decodeStrict(payload, &request); err != nil || request.Type != envelope.Type {
			return nil, protocolViolation("native capture-options request is invalid")
		}
		return captureOptionsResponse{
			responseEnvelope: response(envelope, "capture-options"),
			Adapters:         session.capabilities.Adapters,
		}, nil
	case "list-sources":
		var request listSourcesRequest
		if err := decodeStrict(payload, &request); err != nil || request.Type != envelope.Type {
			return nil, protocolViolation("native list-sources request is invalid")
		}
		targets, err := nativecapture.ListSources(ctx, session.captureProcess)
		if err != nil {
			return operationFailure(envelope, err), nil
		}
		return sourceListResponse{
			responseEnvelope: response(envelope, "source-list"),
			Sources:          targets,
		}, nil
	case "source-preview":
		var request sourcePreviewRequest
		if err := decodeStrict(payload, &request); err != nil || request.Type != envelope.Type {
			return nil, protocolViolation("native source-preview request is invalid")
		}
		preview, err := nativecapture.PreviewSource(
			ctx,
			session.captureProcess,
			request.Source,
		)
		data := ""
		if err == nil {
			data = base64.StdEncoding.EncodeToString(preview)
		} else {
			operationFailure(envelope, err)
		}
		return sourcePreviewResponse{
			responseEnvelope: response(envelope, "source-preview"),
			SourceKey:        captureTargetKey(request.Source),
			Mime:             "image/bmp",
			Data:             data,
		}, nil
	case "start-share":
		var request startShareRequest
		if err := decodeStrict(payload, &request); err != nil ||
			request.Type != envelope.Type ||
			!identityPattern.MatchString(request.ShareID) ||
			!request.Source.Valid() ||
			request.EdgeCapacity < 1 || request.EdgeCapacity > maxEdgeCapacity ||
			(request.Codec != "auto" && request.Codec != "h264" && request.Codec != "vp8") ||
			!validQualitySettings(request.Profile) {
			return nil, protocolViolation("native start-share request is invalid")
		}
		slog.Debug("piik-client", "event", "native-profile-requested", "requestId", envelope.ID,
			"share", diagnostics.ID(request.ShareID), "profile", nativeQualityProfile(request.Profile), "codec", request.Codec, "audio", request.Audio,
			"sourceKind", request.Source.Kind, "adapterIndex", request.AdapterIndex, "encoderIndex", request.EncoderIndex)
		return session.startShare(ctx, envelope, request)
	case "update-share":
		var request updateShareRequest
		if err := decodeStrict(payload, &request); err != nil ||
			request.Type != envelope.Type ||
			!validIdentities(request.ShareID) ||
			!validQualitySettings(request.Profile) {
			return nil, protocolViolation("native update-share request is invalid")
		}
		profile := nativeQualityProfile(request.Profile)
		slog.Debug("piik-client", "event", "native-profile-requested", "requestId", envelope.ID,
			"share", diagnostics.ID(request.ShareID), "profile", profile)
		var err error
		if host := session.current(request.ShareID); host != nil {
			result = session.updateHost(host, envelope, request.ShareID, profile, complete)
			asynchronous = result == nil
			return result, nil
		} else if viewer := session.currentViewer(request.ShareID); viewer != nil {
			err = viewer.UpdateProfile(profile.Video)
		} else {
			return nil, errors.New("native share does not exist")
		}
		return session.shareUpdateResult(envelope, request.ShareID, profile, err), nil
	case "replace-share-source":
		var request replaceShareSourceRequest
		if err := decodeStrict(payload, &request); err != nil ||
			request.Type != envelope.Type ||
			!validIdentities(request.ShareID) || !request.Source.Valid() {
			return nil, protocolViolation("native replace-share-source request is invalid")
		}
		host := session.current(request.ShareID)
		if host == nil {
			return nil, errors.New("native share does not exist")
		}
		session.mu.Lock()
		updating := session.updateDone != nil
		session.mu.Unlock()
		if updating {
			return operationFailure(envelope, errors.New("native quality update is still active")), nil
		}
		audio := request.Audio && session.capabilities.Summary().AudioFor(
			request.Source.Kind,
		)
		slog.Debug("piik-client", "event", "native-source-requested", "requestId", envelope.ID,
			"share", diagnostics.ID(request.ShareID), "sourceKind", request.Source.Kind, "audio", audio,
			"adapterIndex", request.AdapterIndex, "encoderIndex", request.EncoderIndex)
		err := host.ReplaceSource(ctx, nativecapture.VideoOptions{
			Target:            request.Source,
			ShowCaptureBorder: request.ShowCaptureBorder && session.capabilities.CaptureBorderControl,
			AdapterIndex:      request.AdapterIndex,
			EncoderIndex:      request.EncoderIndex,
		}, audio)
		if err != nil {
			return operationFailure(envelope, err), nil
		}
		slog.Debug("piik-client", "event", "native-source-applied", "requestId", envelope.ID,
			"share", diagnostics.ID(request.ShareID), "sourceKind", request.Source.Kind, "audio", audio)
		return shareSourceReplacedResponse{
			responseEnvelope: response(envelope, "share-source-replaced"),
			ShareID:          request.ShareID,
		}, nil
	case "prepare-edge":
		var request prepareEdgeRequest
		if err := decodeStrict(payload, &request); err != nil ||
			request.Type != envelope.Type ||
			!validIdentities(request.ShareID, request.ConnectionID) {
			return nil, protocolViolation("native prepare-edge request is invalid")
		}
		return session.prepareEdge(envelope, request)
	case "prepare-local-edge":
		var request prepareLocalEdgeRequest
		if err := decodeStrict(payload, &request); err != nil ||
			request.Type != envelope.Type ||
			!validIdentities(request.ShareID, request.ConnectionID) {
			return nil, protocolViolation("native prepare-local-edge request is invalid")
		}
		return session.prepareLocalEdge(envelope, request)
	case "receive-offer":
		var request receiveOfferRequest
		if err := decodeStrict(payload, &request); err != nil ||
			request.Type != envelope.Type ||
			!validIdentities(request.ShareID, request.ConnectionID) ||
			request.EdgeCapacity < 1 || request.EdgeCapacity > maxEdgeCapacity ||
			len(request.SDP) == 0 || len(request.SDP) > maxSDPBytes {
			return nil, protocolViolation("native receive-offer request is invalid")
		}
		return session.receiveOffer(envelope, request)
	case "receive-candidate":
		var request receiveCandidateRequest
		if err := decodeStrict(payload, &request); err != nil ||
			request.Type != envelope.Type ||
			!validIdentities(request.ShareID, request.ConnectionID) ||
			!validCandidate(request.Candidate) {
			return nil, protocolViolation("native receive-candidate request is invalid")
		}
		viewer := session.currentViewer(request.ShareID)
		if viewer == nil {
			return nil, errors.New("native Viewer session does not exist")
		}
		if err := viewer.AddReceiverCandidate(request.ConnectionID, request.Candidate); err != nil {
			return nil, err
		}
		return response(envelope, "receive-candidate-accepted"), nil
	case "close-receiver":
		var request closeReceiverRequest
		if err := decodeStrict(payload, &request); err != nil ||
			request.Type != envelope.Type ||
			!validIdentities(request.ShareID, request.ConnectionID) {
			return nil, protocolViolation("native close-receiver request is invalid")
		}
		if viewer := session.currentViewer(request.ShareID); viewer != nil {
			viewer.CloseReceiver(request.ConnectionID)
		}
		return response(envelope, "receiver-closed"), nil
	case "stop-receive":
		var request stopReceiveRequest
		if err := decodeStrict(payload, &request); err != nil ||
			request.Type != envelope.Type || !validIdentities(request.ShareID) {
			return nil, protocolViolation("native stop-receive request is invalid")
		}
		session.stopViewer(request.ShareID)
		return response(envelope, "receive-stopped"), nil
	case "edge-answer":
		var request edgeAnswerRequest
		if err := decodeStrict(payload, &request); err != nil ||
			request.Type != envelope.Type ||
			!validIdentities(request.ShareID, request.ConnectionID) ||
			len(request.SDP) == 0 || len(request.SDP) > maxSDPBytes {
			return nil, protocolViolation("native edge-answer request is invalid")
		}
		media := session.currentMedia(request.ShareID)
		if media == nil {
			return nil, errors.New("native media session does not exist")
		}
		if err := media.SetAnswer(
			request.ConnectionID,
			webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: request.SDP},
		); err != nil {
			return nil, err
		}
		return response(envelope, "edge-answer-accepted"), nil
	case "edge-candidate":
		var request edgeCandidateRequest
		if err := decodeStrict(payload, &request); err != nil ||
			request.Type != envelope.Type ||
			!validIdentities(request.ShareID, request.ConnectionID) ||
			!validCandidate(request.Candidate) {
			return nil, protocolViolation("native edge-candidate request is invalid")
		}
		media := session.currentMedia(request.ShareID)
		if media == nil {
			return nil, errors.New("native media session does not exist")
		}
		if err := media.AddCandidate(request.ConnectionID, request.Candidate); err != nil {
			return nil, err
		}
		return response(envelope, "edge-candidate-accepted"), nil
	case "close-edge":
		var request closeEdgeRequest
		if err := decodeStrict(payload, &request); err != nil ||
			request.Type != envelope.Type ||
			!validIdentities(request.ShareID, request.ConnectionID) {
			return nil, protocolViolation("native close-edge request is invalid")
		}
		if media := session.currentMedia(request.ShareID); media != nil {
			media.CloseEdge(request.ConnectionID)
		}
		return response(envelope, "edge-closed"), nil
	case "stop-share":
		var request stopShareRequest
		if err := decodeStrict(payload, &request); err != nil ||
			request.Type != envelope.Type ||
			!identityPattern.MatchString(request.ShareID) {
			return nil, protocolViolation("native stop-share request is invalid")
		}
		err := session.stopShare(request.ShareID)
		if err != nil {
			return nil, err
		}
		return response(envelope, "share-stopped"), nil
	case "pause-share":
		var request pauseShareRequest
		if err := decodeStrict(payload, &request); err != nil ||
			request.Type != envelope.Type ||
			!validIdentities(request.ShareID) {
			return nil, protocolViolation("native pause-share request is invalid")
		}
		host := session.current(request.ShareID)
		if host == nil {
			return nil, errors.New("native share does not exist")
		}
		host.SetPaused(request.Paused)
		slog.Debug("piik-client", "event", "native-share-paused", "requestId", envelope.ID,
			"share", diagnostics.ID(request.ShareID), "paused", request.Paused)
		return response(envelope, "share-paused"), nil
	default:
		return nil, protocolViolation("native control message is unsupported")
	}
}

func (session *Session) Close() error {
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return nil
	}
	session.closed = true
	updateDone := session.updateDone
	host := session.host
	viewer := session.viewer
	session.host = nil
	session.viewer = nil
	session.mu.Unlock()
	session.cancel()
	if host != nil {
		_ = host.Close()
	}
	if viewer != nil {
		_ = viewer.Close()
	}
	if updateDone != nil {
		<-updateDone
	}
	return nil
}

func (session *Session) updateHost(host *nativehost.Session, request requestEnvelope, shareID string, profile nativehost.QualityProfile, complete func(any, error)) any {
	session.mu.Lock()
	if session.closed || session.host != host || session.updateDone != nil {
		session.mu.Unlock()
		return operationFailure(request, errors.New("native quality update is unavailable or already active"))
	}
	done := make(chan struct{})
	session.updateDone = done
	session.mu.Unlock()
	go func() {
		err := host.UpdateProfile(profile)
		session.mu.Lock()
		current := !session.closed && session.host == host
		if !current && err == nil {
			err = errors.New("native share stopped during quality update")
		}
		result := session.shareUpdateResult(request, shareID, profile, err)
		complete(result, err)
		close(done)
		if session.closed {
			session.updateDone = nil
			session.mu.Unlock()
			return
		}
		// Release admission before an enqueued ACK can trigger the next update.
		select {
		case session.events <- result:
			session.updateDone = nil
			session.mu.Unlock()
			return
		default:
			session.mu.Unlock()
		}
		// Backpressure retains one completion but never holds the stop mutex.
		session.emit(result)
		session.mu.Lock()
		if session.updateDone == done {
			session.updateDone = nil
		}
		session.mu.Unlock()
	}()
	return nil
}

func (session *Session) shareUpdateResult(request requestEnvelope, shareID string, profile nativehost.QualityProfile, err error) any {
	if err != nil {
		return operationFailure(request, err)
	}
	slog.Debug("piik-client", "event", "native-profile-applied", "requestId", request.ID,
		"share", diagnostics.ID(shareID), "profile", profile)
	return shareUpdatedResponse{responseEnvelope: response(request, "share-updated"), ShareID: shareID}
}

func (session *Session) startShare(
	ctx context.Context,
	envelope requestEnvelope,
	request startShareRequest,
) (any, error) {
	profile := nativeQualityProfile(request.Profile)
	if request.Codec == "vp8" && !session.capabilities.SoftwareVP8 {
		return nil, errors.New("native VP8 encoding is unavailable")
	}
	session.mu.Lock()
	if session.updateDone != nil {
		session.mu.Unlock()
		return operationFailure(envelope, errors.New("native quality update is still active")), nil
	}
	if session.closed || session.host != nil || session.viewer != nil {
		session.mu.Unlock()
		return nil, errors.New("native share is already active")
	}
	session.mu.Unlock()
	host, err := nativehost.Start(ctx, nativehost.Options{
		ShareID:        request.ShareID,
		CaptureProcess: session.captureProcess,
		Video: nativecapture.VideoOptions{
			Target:            request.Source,
			ShowCaptureBorder: request.ShowCaptureBorder && session.capabilities.CaptureBorderControl,
			Codec:             request.Codec,
			AdapterIndex:      request.AdapterIndex,
			EncoderIndex:      request.EncoderIndex,
			Profile:           profile.Video,
		},
		Profile:      profile,
		EdgeCapacity: request.EdgeCapacity,
		AudioEnabled: request.Audio && session.capabilities.Summary().AudioFor(
			request.Source.Kind,
		),
		PortMapping: session.portMapping,
		Events:      session.hostEvents,
	})
	if err != nil {
		return nil, err
	}
	session.mu.Lock()
	if session.closed || session.host != nil || session.viewer != nil {
		session.mu.Unlock()
		_ = host.Close()
		return nil, errors.New("native share is unavailable")
	}
	session.host = host
	session.mu.Unlock()
	codec := host.Codec()
	slog.Debug("piik-client", "event", "native-profile-applied", "requestId", envelope.ID,
		"share", diagnostics.ID(request.ShareID), "profile", profile, "codec", codec, "audio", host.HasAudio())
	go session.watchHost(host)
	return shareStartedResponse{
		responseEnvelope: response(envelope, "share-started"),
		ShareID:          request.ShareID,
		Audio:            host.HasAudio(),
		Codec:            codec,
	}, nil
}

func validQualitySettings(settings qualitySettings) bool {
	return nativeQualityProfile(settings).Valid()
}

func nativeQualityProfile(settings qualitySettings) nativehost.QualityProfile {
	width, height := uint32(0), uint32(0)
	switch settings.Resolution {
	case "480p":
		width, height = 854, 480
	case "720p":
		width, height = 1280, 720
	case "1080p":
		width, height = 1920, 1080
	case "1440p":
		width, height = 2560, 1440
	}
	audioBitrate := 0
	switch settings.ScreenAudioQuality {
	case "", "music":
		audioBitrate = 128_000
	case "saver":
		audioBitrate = 64_000
	case "very-high":
		audioBitrate = 192_000
	}
	return nativehost.QualityProfile{
		Video: nativecapture.VideoProfile{
			Width:      width,
			Height:     height,
			Framerate:  settings.MaxFramerate,
			Bitrate:    settings.MaxBitrate,
			Preference: settings.DegradationPreference,
		},
		AudioBitrate: audioBitrate,
	}
}

func (session *Session) prepareEdge(
	envelope requestEnvelope,
	request prepareEdgeRequest,
) (any, error) {
	servers, err := pionICEServers(request.ICEServers)
	if err != nil {
		return nil, err
	}
	var offer webrtc.SessionDescription
	if host := session.current(request.ShareID); host != nil && request.SourceConnectionID == "" {
		offer, err = host.PrepareEdge(request.ConnectionID, servers)
	} else if viewer := session.currentViewer(request.ShareID); viewer != nil &&
		identityPattern.MatchString(request.SourceConnectionID) {
		offer, err = viewer.PrepareEdge(
			request.SourceConnectionID,
			request.ConnectionID,
			servers,
		)
	} else {
		return nil, errors.New("native media source does not exist")
	}
	if err != nil {
		return nil, err
	}
	return edgeOfferResponse{
		responseEnvelope: response(envelope, "edge-offer"),
		ShareID:          request.ShareID,
		ConnectionID:     request.ConnectionID,
		SDP:              offer.SDP,
	}, nil
}

func (session *Session) prepareLocalEdge(
	envelope requestEnvelope,
	request prepareLocalEdgeRequest,
) (any, error) {
	var offer webrtc.SessionDescription
	var err error
	if host := session.current(request.ShareID); host != nil && request.SourceConnectionID == "" {
		offer, err = host.PrepareLocalEdge(request.ConnectionID)
	} else if viewer := session.currentViewer(request.ShareID); viewer != nil &&
		identityPattern.MatchString(request.SourceConnectionID) {
		offer, err = viewer.PrepareLocalEdge(
			request.SourceConnectionID,
			request.ConnectionID,
		)
	} else {
		return nil, errors.New("native media source does not exist")
	}
	if err != nil {
		return nil, err
	}
	return edgeOfferResponse{
		responseEnvelope: response(envelope, "edge-offer"),
		ShareID:          request.ShareID,
		ConnectionID:     request.ConnectionID,
		SDP:              offer.SDP,
	}, nil
}

func (session *Session) receiveOffer(
	envelope requestEnvelope,
	request receiveOfferRequest,
) (any, error) {
	servers, err := pionICEServers(request.ICEServers)
	if err != nil {
		return nil, err
	}
	viewer, err := session.ensureViewer(request.ShareID, request.EdgeCapacity)
	if err != nil {
		return nil, err
	}
	answer, audio, codec, err := viewer.AcceptOffer(
		request.ConnectionID,
		webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: request.SDP},
		servers,
	)
	if err != nil {
		return nil, err
	}
	return receiveAnswerResponse{
		responseEnvelope: response(envelope, "receive-answer"),
		ShareID:          request.ShareID,
		ConnectionID:     request.ConnectionID,
		SDP:              answer.SDP,
		Audio:            audio,
		Codec:            codec,
	}, nil
}

func (session *Session) stopShare(shareID string) error {
	session.mu.Lock()
	host := session.host
	if host == nil || host.ShareID() != shareID {
		session.mu.Unlock()
		return nil
	}
	session.host = nil
	updateDone := session.updateDone
	session.mu.Unlock()
	err := host.Close()
	if updateDone != nil {
		<-updateDone
	}
	return err
}

func (session *Session) current(shareID string) *nativehost.Session {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed || session.host == nil || session.host.ShareID() != shareID {
		return nil
	}
	return session.host
}

func (session *Session) ensureViewer(
	shareID string,
	edgeCapacity int,
) (*nativeviewer.Session, error) {
	session.mu.Lock()
	if session.closed || session.host != nil {
		session.mu.Unlock()
		return nil, errors.New("native media role is unavailable")
	}
	if session.viewer != nil {
		viewer := session.viewer
		session.mu.Unlock()
		if viewer.ShareID() != shareID {
			return nil, errors.New("native Viewer session identity changed")
		}
		return viewer, nil
	}
	session.mu.Unlock()
	viewer, err := nativeviewer.Start(session.ctx, nativeviewer.Options{
		ShareID: shareID, EdgeCapacity: edgeCapacity,
		PortMapping: session.portMapping, Events: session.viewerEvents,
		Relay: &mediaedge.RelayOptions{CaptureProcess: session.captureProcess, Capabilities: session.capabilities},
	})
	if err != nil {
		return nil, err
	}
	session.mu.Lock()
	if session.closed || session.host != nil || session.viewer != nil {
		session.mu.Unlock()
		_ = viewer.Close()
		return nil, errors.New("native media role is unavailable")
	}
	session.viewer = viewer
	session.mu.Unlock()
	return viewer, nil
}

func (session *Session) currentViewer(shareID string) *nativeviewer.Session {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed || session.viewer == nil || session.viewer.ShareID() != shareID {
		return nil
	}
	return session.viewer
}

func (session *Session) currentMedia(shareID string) outboundMediaSession {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed {
		return nil
	}
	if session.host != nil && session.host.ShareID() == shareID {
		return session.host
	}
	if session.viewer != nil && session.viewer.ShareID() == shareID {
		return session.viewer
	}
	return nil
}

func (session *Session) stopViewer(shareID string) {
	session.mu.Lock()
	viewer := session.viewer
	if viewer == nil || viewer.ShareID() != shareID {
		session.mu.Unlock()
		return
	}
	session.viewer = nil
	session.mu.Unlock()
	_ = viewer.Close()
}

func (session *Session) watchHost(host *nativehost.Session) {
	err, open := <-host.Done()
	session.mu.Lock()
	if session.host == host {
		session.host = nil
	}
	session.mu.Unlock()
	if open {
		session.emit(shareEndedEvent{
			Version: loopback.ProtocolVersion,
			Type:    "share-ended",
			ShareID: host.ShareID(),
			Failed:  err != nil,
		})
	}
}

func (session *Session) relayEvents() {
	for {
		select {
		case event := <-session.hostEvents:
			session.emit(eventMessage(event))
		case event := <-session.viewerEvents:
			session.emit(viewerEventMessage(event))
		case <-session.ctx.Done():
			return
		}
	}
}

func viewerEventMessage(event nativeviewer.Event) any {
	base := eventEnvelope{
		Version:      loopback.ProtocolVersion,
		Type:         event.Type,
		ShareID:      event.ShareID,
		ConnectionID: event.ConnectionID,
	}
	switch event.Type {
	case "edge-candidate":
		return edgeCandidateEvent{eventEnvelope: base, Candidate: event.Candidate}
	case "edge-state":
		return edgeStateEvent{eventEnvelope: base, State: event.State}
	case "edge-path":
		return edgePathEvent{
			eventEnvelope:    base,
			LocalType:        event.LocalType,
			RemoteType:       event.RemoteType,
			NatTraversalPath: event.NatTraversalPath,
		}
	case "edge-quality":
		quality := event.Quality
		return edgeQualityEvent{
			eventEnvelope:         base,
			SampleTimestampMs:     quality.SampleTimestampMs,
			SampleWindowMs:        quality.SampleWindowMs,
			RTPStatsID:            quality.RTPStatsID,
			TrackIdentifier:       quality.TrackIdentifier,
			State:                 quality.State,
			Reason:                quality.Reason,
			IntervalFramesEncoded: quality.IntervalFramesEncoded,
			FramesPerSecond:       quality.FramesPerSecond,
			BitrateKbps:           quality.BitrateKbps,
			AvailableOutgoingKbps: quality.AvailableOutgoingKbps,
			Width:                 quality.Width,
			Height:                quality.Height,
		}
	default:
		return edgeStateEvent{eventEnvelope: base, State: event.State}
	}
}

func (session *Session) emit(event any) {
	select {
	case session.events <- event:
	case <-session.ctx.Done():
	}
}

func eventMessage(event nativehost.Event) any {
	base := eventEnvelope{
		Version:               loopback.ProtocolVersion,
		Type:                  event.Type,
		ShareID:               event.ShareID,
		ConnectionID:          event.ConnectionID,
		PublicationGeneration: event.PublicationGeneration,
	}
	switch event.Type {
	case "publication-quality":
		return publicationQualityEvent{eventEnvelope: base, PublicationQualitySample: *event.PublicationQuality}
	case "edge-candidate", "publication-candidate":
		return edgeCandidateEvent{eventEnvelope: base, Candidate: event.Candidate}
	case "edge-state", "publication-state":
		return edgeStateEvent{eventEnvelope: base, State: event.State}
	case "edge-path":
		return edgePathEvent{
			eventEnvelope:    base,
			LocalType:        event.LocalType,
			RemoteType:       event.RemoteType,
			NatTraversalPath: event.NatTraversalPath,
		}
	case "edge-quality":
		quality := event.Quality
		return edgeQualityEvent{
			eventEnvelope:         base,
			SampleTimestampMs:     quality.SampleTimestampMs,
			SampleWindowMs:        quality.SampleWindowMs,
			RTPStatsID:            quality.RTPStatsID,
			TrackIdentifier:       quality.TrackIdentifier,
			State:                 quality.State,
			Reason:                quality.Reason,
			IntervalFramesEncoded: quality.IntervalFramesEncoded,
			FramesPerSecond:       quality.FramesPerSecond,
			BitrateKbps:           quality.BitrateKbps,
			AvailableOutgoingKbps: quality.AvailableOutgoingKbps,
			Width:                 quality.Width,
			Height:                quality.Height,
		}
	default:
		return captureStateEvent{eventEnvelope: base, State: event.State}
	}
}

func pionICEServers(values []iceServer) ([]webrtc.ICEServer, error) {
	if len(values) > maxICEServers {
		return nil, protocolViolation("native ICE server list is too large")
	}
	result := make([]webrtc.ICEServer, 0, len(values))
	for _, server := range values {
		if len(server.URLs) == 0 || len(server.URLs) > maxURLsPerServer {
			return nil, protocolViolation("native ICE server is invalid")
		}
		urls := make([]string, 0, len(server.URLs))
		for _, value := range server.URLs {
			if !validSTUNURL(value) {
				return nil, protocolViolation("native STUN URL is invalid")
			}
			urls = append(urls, value)
		}
		result = append(result, webrtc.ICEServer{URLs: urls})
	}
	return result, nil
}

func validSTUNURL(value string) bool {
	if len(value) < 6 || len(value) > maxSTUNURLBytes ||
		!strings.EqualFold(value[:5], "stun:") {
		return false
	}
	authority := value[5:]
	if authority == "" || strings.ContainsAny(authority, "/?#@") ||
		strings.IndexFunc(authority, unicode.IsSpace) >= 0 ||
		strings.HasSuffix(authority, ":") {
		return false
	}
	parsed, err := url.Parse("http://" + authority)
	if err != nil || parsed.Hostname() == "" || parsed.User != nil ||
		(parsed.Path != "" && parsed.Path != "/") ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	port := parsed.Port()
	if port == "" {
		return true
	}
	number, err := strconv.Atoi(port)
	return err == nil && number > 0 && number <= 65_535
}

func validCandidate(candidate *webrtc.ICECandidateInit) bool {
	if candidate == nil {
		return true
	}
	return len(candidate.Candidate) <= maxCandidateBytes &&
		(candidate.SDPMid == nil || len(*candidate.SDPMid) <= 128) &&
		(candidate.UsernameFragment == nil || len(*candidate.UsernameFragment) <= 256)
}

func validIdentities(values ...string) bool {
	for _, value := range values {
		if !identityPattern.MatchString(value) {
			return false
		}
	}
	return true
}

func captureTargetKey(target nativecapture.CaptureTarget) string {
	if target.Kind == "window" {
		return "window:" + target.SourceID + ":" +
			strconv.FormatUint(uint64(target.PID), 10) + ":" + target.CreationTime
	}
	return "display:" + target.SourceID
}

func decodeEnvelope(payload []byte, envelope *requestEnvelope) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	if err := decoder.Decode(envelope); err != nil || decoder.Decode(&struct{}{}) != io.EOF ||
		envelope.Version != loopback.ProtocolVersion ||
		!identityPattern.MatchString(envelope.ID) || envelope.Type == "" {
		return protocolViolation("native control envelope is invalid")
	}
	return nil
}

func decodeStrict(payload []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return protocolViolation("native control message is invalid")
	}
	return nil
}

func response(request requestEnvelope, responseType string) responseEnvelope {
	return responseEnvelope{
		Version: loopback.ProtocolVersion,
		ID:      request.ID,
		Type:    responseType,
	}
}

func operationFailure(request requestEnvelope, causes ...error) requestFailedResponse {
	if len(causes) > 0 {
		slog.Debug("piik-client", "event", "native-operation-failed", "requestId", request.ID,
			"requestType", diagnostics.SafeText(request.Type), diagnostics.Error(causes[0]))
	}
	return requestFailedResponse{
		responseEnvelope: response(request, "request-failed"),
		Code:             "operation-failed",
	}
}

func (session *Session) traceRequest(request requestEnvelope, payload []byte) func(any, error) {
	if !slog.Default().Enabled(session.ctx, slog.LevelDebug) {
		return func(any, error) {}
	}
	// Read only identities: source titles, SDP, candidates and media never enter the log.
	var identity struct {
		ShareID               string `json:"shareId"`
		ConnectionID          string `json:"connectionId"`
		SourceConnectionID    string `json:"sourceConnectionId"`
		PublicationGeneration string `json:"publicationGeneration"`
	}
	_ = json.Unmarshal(payload, &identity)
	logger := slog.Default().With("requestId", request.ID, "requestType", diagnostics.SafeText(request.Type),
		"share", diagnostics.ID(identity.ShareID), "connection", diagnostics.ID(identity.ConnectionID),
		"sourceConnection", diagnostics.ID(identity.SourceConnectionID), "publication", diagnostics.ID(identity.PublicationGeneration))
	started := time.Now()
	logger.Debug("piik-client", "event", "native-request-started")
	return func(result any, err error) {
		failure, rejected := result.(requestFailedResponse)
		logger.Debug("piik-client", "event", "native-request-ended", "durationMs", time.Since(started).Milliseconds(),
			"failed", err != nil || rejected, "code", failure.Code, diagnostics.Error(err))
	}
}
