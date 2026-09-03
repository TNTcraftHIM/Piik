package nativecontrol

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"unicode"

	"github.com/TNTcraftHIM/Screener/native/client/internal/loopback"
	"github.com/TNTcraftHIM/Screener/native/client/internal/nativecapture"
	"github.com/TNTcraftHIM/Screener/native/client/internal/nativehost"
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

	mu     sync.Mutex
	host   *nativehost.Session
	closed bool
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
	}
	go session.relayEvents()
	return session
}

func (session *Session) Events() <-chan any {
	return session.events
}

func (session *Session) Handle(_ context.Context, payload []byte) (any, error) {
	var envelope requestEnvelope
	if err := decodeEnvelope(payload, &envelope); err != nil {
		return nil, err
	}
	switch envelope.Type {
	case "capture-options":
		var request captureOptionsRequest
		if err := decodeStrict(payload, &request); err != nil || request.Type != envelope.Type {
			return nil, errors.New("native capture-options request is invalid")
		}
		return captureOptionsResponse{
			responseEnvelope: response(envelope, "capture-options"),
			Adapters:         session.capabilities.Adapters,
		}, nil
	case "list-sources":
		var request listSourcesRequest
		if err := decodeStrict(payload, &request); err != nil || request.Type != envelope.Type {
			return nil, errors.New("native list-sources request is invalid")
		}
		targets, err := nativecapture.ListSources(session.ctx, session.captureProcess)
		if err != nil {
			return nil, err
		}
		return sourceListResponse{
			responseEnvelope: response(envelope, "source-list"),
			Sources:          targets,
		}, nil
	case "source-preview":
		var request sourcePreviewRequest
		if err := decodeStrict(payload, &request); err != nil || request.Type != envelope.Type {
			return nil, errors.New("native source-preview request is invalid")
		}
		preview, err := nativecapture.PreviewSource(
			session.ctx,
			session.captureProcess,
			request.Source,
		)
		data := ""
		if err == nil {
			data = base64.StdEncoding.EncodeToString(preview)
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
			request.EdgeCapacity < 1 || request.EdgeCapacity > maxEdgeCapacity {
			return nil, errors.New("native start-share request is invalid")
		}
		return session.startShare(envelope, request)
	case "prepare-edge":
		var request prepareEdgeRequest
		if err := decodeStrict(payload, &request); err != nil ||
			request.Type != envelope.Type ||
			!validIdentities(request.ShareID, request.ConnectionID) {
			return nil, errors.New("native prepare-edge request is invalid")
		}
		return session.prepareEdge(envelope, request)
	case "prepare-local-edge":
		var request prepareLocalEdgeRequest
		if err := decodeStrict(payload, &request); err != nil ||
			request.Type != envelope.Type ||
			!validIdentities(request.ShareID, request.ConnectionID) {
			return nil, errors.New("native prepare-local-edge request is invalid")
		}
		return session.prepareLocalEdge(envelope, request)
	case "edge-answer":
		var request edgeAnswerRequest
		if err := decodeStrict(payload, &request); err != nil ||
			request.Type != envelope.Type ||
			!validIdentities(request.ShareID, request.ConnectionID) ||
			len(request.SDP) == 0 || len(request.SDP) > maxSDPBytes {
			return nil, errors.New("native edge-answer request is invalid")
		}
		host := session.current(request.ShareID)
		if host == nil {
			return nil, errors.New("native share does not exist")
		}
		if err := host.SetAnswer(
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
			return nil, errors.New("native edge-candidate request is invalid")
		}
		host := session.current(request.ShareID)
		if host == nil {
			return nil, errors.New("native share does not exist")
		}
		if err := host.AddCandidate(request.ConnectionID, request.Candidate); err != nil {
			return nil, err
		}
		return response(envelope, "edge-candidate-accepted"), nil
	case "close-edge":
		var request closeEdgeRequest
		if err := decodeStrict(payload, &request); err != nil ||
			request.Type != envelope.Type ||
			!validIdentities(request.ShareID, request.ConnectionID) {
			return nil, errors.New("native close-edge request is invalid")
		}
		host := session.current(request.ShareID)
		if host == nil {
			return nil, errors.New("native share does not exist")
		}
		host.CloseEdge(request.ConnectionID)
		return response(envelope, "edge-closed"), nil
	case "stop-share":
		var request stopShareRequest
		if err := decodeStrict(payload, &request); err != nil ||
			request.Type != envelope.Type ||
			!identityPattern.MatchString(request.ShareID) {
			return nil, errors.New("native stop-share request is invalid")
		}
		if err := session.stopShare(request.ShareID); err != nil {
			return nil, err
		}
		return response(envelope, "share-stopped"), nil
	case "pause-share":
		var request pauseShareRequest
		if err := decodeStrict(payload, &request); err != nil ||
			request.Type != envelope.Type ||
			!validIdentities(request.ShareID) {
			return nil, errors.New("native pause-share request is invalid")
		}
		host := session.current(request.ShareID)
		if host == nil {
			return nil, errors.New("native share does not exist")
		}
		host.SetPaused(request.Paused)
		return response(envelope, "share-paused"), nil
	default:
		return nil, errors.New("native control message is unsupported")
	}
}

func (session *Session) Close() error {
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return nil
	}
	session.closed = true
	host := session.host
	session.host = nil
	session.mu.Unlock()
	session.cancel()
	if host != nil {
		_ = host.Close()
	}
	return nil
}

func (session *Session) startShare(
	envelope requestEnvelope,
	request startShareRequest,
) (any, error) {
	session.mu.Lock()
	if session.closed || session.host != nil {
		session.mu.Unlock()
		return nil, errors.New("native share is already active")
	}
	session.mu.Unlock()
	host, err := nativehost.Start(session.ctx, nativehost.Options{
		ShareID:        request.ShareID,
		CaptureProcess: session.captureProcess,
		Video: nativecapture.VideoOptions{
			Target:       request.Source,
			AdapterIndex: request.AdapterIndex,
			EncoderIndex: request.EncoderIndex,
		},
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
	if session.closed || session.host != nil {
		session.mu.Unlock()
		_ = host.Close()
		return nil, errors.New("native share is unavailable")
	}
	session.host = host
	session.mu.Unlock()
	go session.watchHost(host)
	return shareStartedResponse{
		responseEnvelope: response(envelope, "share-started"),
		ShareID:          request.ShareID,
		Audio:            host.HasAudio(),
	}, nil
}

func (session *Session) prepareEdge(
	envelope requestEnvelope,
	request prepareEdgeRequest,
) (any, error) {
	servers, err := pionICEServers(request.ICEServers)
	if err != nil {
		return nil, err
	}
	host := session.current(request.ShareID)
	if host == nil {
		return nil, errors.New("native share does not exist")
	}
	offer, err := host.PrepareEdge(request.ConnectionID, servers)
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
	host := session.current(request.ShareID)
	if host == nil {
		return nil, errors.New("native share does not exist")
	}
	offer, err := host.PrepareLocalEdge(request.ConnectionID)
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

func (session *Session) stopShare(shareID string) error {
	session.mu.Lock()
	host := session.host
	if host == nil || host.ShareID() != shareID {
		session.mu.Unlock()
		return errors.New("native share does not exist")
	}
	session.host = nil
	session.mu.Unlock()
	return host.Close()
}

func (session *Session) current(shareID string) *nativehost.Session {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed || session.host == nil || session.host.ShareID() != shareID {
		return nil
	}
	return session.host
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
		case <-session.ctx.Done():
			return
		}
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
			eventEnvelope: base,
			LocalType:     event.LocalType,
			RemoteType:    event.RemoteType,
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
		return nil, errors.New("native ICE server list is too large")
	}
	result := make([]webrtc.ICEServer, 0, len(values))
	for _, server := range values {
		if len(server.URLs) == 0 || len(server.URLs) > maxURLsPerServer {
			return nil, errors.New("native ICE server is invalid")
		}
		urls := make([]string, 0, len(server.URLs))
		for _, value := range server.URLs {
			if !validSTUNURL(value) {
				return nil, errors.New("native STUN URL is invalid")
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
		return errors.New("native control envelope is invalid")
	}
	return nil
}

func decodeStrict(payload []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return errors.New("native control message is invalid")
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
