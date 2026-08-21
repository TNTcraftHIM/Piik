package remote

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
)

const (
	signalingProtocol  = "screener-v4"
	maxProtocolViewers = 16
	maxRouteRevision   = int64(1<<53 - 1)
	maxSignalSDPBytes  = 48 << 10
	maxQualityEvidence = 2 << 10
)

var opaqueIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}$`)

type sessionDescription struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

type iceCandidate struct {
	Candidate        string  `json:"candidate"`
	SDPMid           *string `json:"sdpMid,omitempty"`
	SDPMLineIndex    *uint16 `json:"sdpMLineIndex,omitempty"`
	UsernameFragment *string `json:"usernameFragment,omitempty"`
}

type inboundSignalPayload struct {
	Kind         string
	ConnectionID string
	Description  *sessionDescription
	Candidate    *iceCandidate
}

type outboundDescriptionPayload struct {
	Kind         string             `json:"kind"`
	ConnectionID string             `json:"connectionId"`
	Description  sessionDescription `json:"description"`
}

type outboundCandidatePayload struct {
	Kind         string        `json:"kind"`
	ConnectionID string        `json:"connectionId"`
	Candidate    *iceCandidate `json:"candidate"`
}

type outboundSignalMessage struct {
	Type         string `json:"type"`
	TargetPeerID string `json:"targetPeerId"`
	Payload      any    `json:"payload"`
}

type authenticateMessage struct {
	Type            string `json:"type"`
	Protocol        string `json:"protocol"`
	RoomID          string `json:"roomId"`
	Role            string `json:"role"`
	Token           string `json:"token"`
	ClientID        string `json:"clientId"`
	ShareGeneration string `json:"shareGeneration"`
}

type simpleMessage struct {
	Type string `json:"type"`
}

type mediaAssignment struct {
	ParentPeerID json.RawMessage `json:"parentPeerId"`
	ChildPeerIDs []string        `json:"childPeerIds"`
}

type participantRouteAssignment struct {
	Upstream struct {
		Kind   string  `json:"kind"`
		PeerID *string `json:"peerId,omitempty"`
	} `json:"upstream"`
	ChildPeerIDs             []string        `json:"childPeerIds"`
	SFUPublicationGeneration json.RawMessage `json:"sfuPublicationGeneration"`
}

type serverMessage struct {
	Type            string
	Role            string
	PeerID          string
	FromPeerID      string
	ViewerPeerIDs   []string
	ConnectionID    string
	Rebuild         bool
	MaxViewers      int
	IceConfig       iceConfig
	ViewerPolicy    string
	Payload         inboundSignalPayload
	Code            string
	Message         string
	Reason          string
	PeerAssisted    bool
	MediaAssignment mediaAssignment
	RouteAssignment participantRouteAssignment
	RouteRevision   int64
	RoutePhase      string
	EdgeKind        string
	NewConnectionID string
}

func readServerMessage(ctx context.Context, conn *websocket.Conn) (serverMessage, error) {
	messageType, payload, err := conn.Read(ctx)
	if err != nil {
		return serverMessage{}, err
	}
	if messageType != websocket.MessageText {
		return serverMessage{}, errors.New("signaling message is not text")
	}
	return decodeServerMessage(payload)
}

func decodeServerMessage(payload []byte) (serverMessage, error) {
	var discriminator struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(payload, &discriminator); err != nil || discriminator.Type == "" {
		return serverMessage{}, errors.New("signaling message is not valid JSON")
	}
	switch discriminator.Type {
	case "authenticated":
		return decodeAuthenticatedMessage(payload)
	case "peer-joined", "peer-left":
		var wire struct {
			Type   string `json:"type"`
			PeerID string `json:"peerId"`
		}
		if err := decodeStrict(payload, &wire); err != nil || !validOpaqueID(wire.PeerID) {
			return serverMessage{}, errors.New("peer presence message is invalid")
		}
		return serverMessage{Type: wire.Type, PeerID: wire.PeerID}, nil
	case "signal":
		var wire struct {
			Type       string          `json:"type"`
			FromPeerID string          `json:"fromPeerId"`
			Payload    json.RawMessage `json:"payload"`
		}
		if err := decodeStrict(payload, &wire); err != nil || !validOpaqueID(wire.FromPeerID) {
			return serverMessage{}, errors.New("viewer signal envelope is invalid")
		}
		signal, err := decodeInboundSignalPayload(wire.Payload)
		if err != nil {
			return serverMessage{}, err
		}
		return serverMessage{Type: wire.Type, FromPeerID: wire.FromPeerID, Payload: signal}, nil
	case "restart-request":
		var wire struct {
			Type         string `json:"type"`
			FromPeerID   string `json:"fromPeerId"`
			ConnectionID string `json:"connectionId"`
			Rebuild      *bool  `json:"rebuild"`
		}
		if err := decodeStrict(payload, &wire); err != nil || wire.Rebuild == nil ||
			!validOpaqueID(wire.FromPeerID) || !validOpaqueID(wire.ConnectionID) {
			return serverMessage{}, errors.New("viewer restart request is invalid")
		}
		return serverMessage{Type: wire.Type, FromPeerID: wire.FromPeerID, ConnectionID: wire.ConnectionID, Rebuild: *wire.Rebuild}, nil
	case "media-assignment":
		var wire struct {
			Type            string          `json:"type"`
			MediaAssignment json.RawMessage `json:"mediaAssignment"`
		}
		if err := decodeStrict(payload, &wire); err != nil {
			return serverMessage{}, errors.New("media assignment message is invalid")
		}
		assignment, err := decodeHostMediaAssignment(wire.MediaAssignment)
		if err != nil {
			return serverMessage{}, err
		}
		return serverMessage{Type: wire.Type, MediaAssignment: assignment}, nil
	case "route-update":
		var wire struct {
			Type       string          `json:"type"`
			Revision   int64           `json:"revision"`
			Phase      string          `json:"phase"`
			Assignment json.RawMessage `json:"assignment"`
		}
		if err := decodeStrict(payload, &wire); err != nil {
			return serverMessage{}, errors.New("route update message is invalid")
		}
		assignment, assignmentErr := decodeHostRouteAssignment(wire.Assignment)
		if wire.Revision < 0 || wire.Revision > maxRouteRevision || assignmentErr != nil || wire.Phase != "prepare" && wire.Phase != "active" {
			return serverMessage{}, errors.New("route update message is invalid")
		}
		return serverMessage{Type: wire.Type, RouteRevision: wire.Revision, RoutePhase: wire.Phase, RouteAssignment: assignment}, nil
	case "sfu-config":
		var wire struct {
			Type     string `json:"type"`
			Revision int64  `json:"revision"`
		}
		if err := json.Unmarshal(payload, &wire); err != nil || wire.Revision < 0 || wire.Revision > maxRouteRevision {
			return serverMessage{}, errors.New("SFU configuration message is invalid")
		}
		return serverMessage{Type: wire.Type, RouteRevision: wire.Revision}, nil
	case "selected-edge-turn":
		var wire struct {
			Type            string `json:"type"`
			EdgeKind        string `json:"edgeKind"`
			Revision        int64  `json:"revision"`
			NewConnectionID string `json:"newConnectionId"`
		}
		if err := json.Unmarshal(payload, &wire); err != nil || wire.Revision < 0 || wire.Revision > maxRouteRevision ||
			(wire.EdgeKind != "host-sfu-ingress" && wire.EdgeKind != "peer-selected") || !validOpaqueID(wire.NewConnectionID) {
			return serverMessage{}, errors.New("selected-edge TURN message is invalid")
		}
		return serverMessage{Type: wire.Type, EdgeKind: wire.EdgeKind, RouteRevision: wire.Revision, NewConnectionID: wire.NewConnectionID}, nil
	case "viewer-quality-evidence":
		if err := validateViewerQualityEvidence(payload); err != nil {
			return serverMessage{}, err
		}
		return serverMessage{Type: discriminator.Type}, nil
	case "error":
		var wire struct {
			Type    string `json:"type"`
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		if err := decodeStrict(payload, &wire); err != nil || !validErrorCode(wire.Code) || len(wire.Message) < 1 || len(wire.Message) > 256 {
			return serverMessage{}, errors.New("signaling error message is invalid")
		}
		return serverMessage{Type: wire.Type, Code: wire.Code, Message: wire.Message}, nil
	case "room-closed":
		var wire struct {
			Type   string `json:"type"`
			Reason string `json:"reason"`
		}
		if err := decodeStrict(payload, &wire); err != nil || wire.Reason != "host-ended" && wire.Reason != "expired" {
			return serverMessage{}, errors.New("room closure message is invalid")
		}
		return serverMessage{Type: wire.Type, Reason: wire.Reason}, nil
	default:
		return serverMessage{}, errors.New("signaling message type is unsupported")
	}
}

type viewerQualityEvidenceMetrics struct {
	Width                 json.RawMessage `json:"width"`
	Height                json.RawMessage `json:"height"`
	FramesPerSecond       json.RawMessage `json:"framesPerSecond"`
	BitrateKbps           json.RawMessage `json:"bitrateKbps"`
	PacketsReceivedDelta  json.RawMessage `json:"packetsReceivedDelta"`
	PacketsLostDelta      json.RawMessage `json:"packetsLostDelta"`
	JitterMs              json.RawMessage `json:"jitterMs"`
	FramesDecodedDelta    json.RawMessage `json:"framesDecodedDelta"`
	FramesDroppedDelta    json.RawMessage `json:"framesDroppedDelta"`
	DecodeMsPerFrame      json.RawMessage `json:"decodeMsPerFrame"`
	FreezeCountDelta      json.RawMessage `json:"freezeCountDelta"`
	FreezeDurationMsDelta json.RawMessage `json:"freezeDurationMsDelta"`
	Codec                 json.RawMessage `json:"codec"`
	CodecProfile          json.RawMessage `json:"codecProfile"`
	CodecParameters       json.RawMessage `json:"codecParameters"`
}

func validateViewerQualityEvidence(payload []byte) error {
	if len(payload) > maxQualityEvidence {
		return errors.New("viewer quality evidence is too large")
	}
	var wire struct {
		Type         string `json:"type"`
		ViewerPeerID string `json:"viewerPeerId"`
		ParentPeerID string `json:"parentPeerId"`
		Guard        struct {
			ConnectionID  string          `json:"connectionId"`
			RouteRevision json.RawMessage `json:"routeRevision"`
		} `json:"guard"`
		Sequence json.RawMessage              `json:"sequence"`
		WindowMS json.RawMessage              `json:"windowMs"`
		Metrics  viewerQualityEvidenceMetrics `json:"metrics"`
	}
	if err := decodeStrict(payload, &wire); err != nil || wire.Type != "viewer-quality-evidence" ||
		!validOpaqueID(wire.ViewerPeerID) || !validOpaqueID(wire.ParentPeerID) ||
		!validOpaqueID(wire.Guard.ConnectionID) ||
		!allJSONFieldsPresent(
			wire.Guard.RouteRevision,
			wire.Sequence,
			wire.WindowMS,
			wire.Metrics.Width,
			wire.Metrics.Height,
			wire.Metrics.FramesPerSecond,
			wire.Metrics.BitrateKbps,
			wire.Metrics.PacketsReceivedDelta,
			wire.Metrics.PacketsLostDelta,
			wire.Metrics.JitterMs,
			wire.Metrics.FramesDecodedDelta,
			wire.Metrics.FramesDroppedDelta,
			wire.Metrics.DecodeMsPerFrame,
			wire.Metrics.FreezeCountDelta,
			wire.Metrics.FreezeDurationMsDelta,
			wire.Metrics.Codec,
			wire.Metrics.CodecProfile,
			wire.Metrics.CodecParameters,
		) {
		return errors.New("viewer quality evidence envelope is invalid")
	}
	return nil
}

func allJSONFieldsPresent(fields ...json.RawMessage) bool {
	for _, field := range fields {
		if len(field) == 0 {
			return false
		}
	}
	return true
}

func decodeAuthenticatedMessage(payload []byte) (serverMessage, error) {
	var wire struct {
		Type                          string          `json:"type"`
		Protocol                      string          `json:"protocol"`
		Role                          string          `json:"role"`
		PeerID                        string          `json:"peerId"`
		RoomExpiresAt                 json.RawMessage `json:"roomExpiresAt"`
		MaxViewers                    *int            `json:"maxViewers"`
		HostOnline                    *bool           `json:"hostOnline"`
		ConnectionID                  json.RawMessage `json:"connectionId"`
		ViewerPeerIDs                 []string        `json:"viewerPeerIds"`
		IceConfig                     json.RawMessage `json:"iceConfig"`
		ViewerPolicy                  string          `json:"viewerPolicy"`
		ViewerAuthorizationGeneration string          `json:"viewerAuthorizationGeneration"`
		MediaMode                     *string         `json:"mediaMode,omitempty"`
		MediaAssignment               json.RawMessage `json:"mediaAssignment,omitempty"`
		RouteRevision                 *int64          `json:"routeRevision,omitempty"`
		RouteAssignment               json.RawMessage `json:"routeAssignment,omitempty"`
		QualitySettings               json.RawMessage `json:"qualitySettings,omitempty"`
		SFUStandbyURL                 json.RawMessage `json:"sfuStandbyUrl,omitempty"`
	}
	if err := decodeStrict(payload, &wire); err != nil || wire.Type != "authenticated" ||
		wire.Protocol != signalingProtocol ||
		wire.Role != "host" || !validOpaqueID(wire.PeerID) || wire.MaxViewers == nil ||
		*wire.MaxViewers < 1 || *wire.MaxViewers > maxProtocolViewers || wire.HostOnline == nil ||
		!*wire.HostOnline || !bytes.Equal(bytes.TrimSpace(wire.ConnectionID), []byte("null")) ||
		wire.ViewerPeerIDs == nil || len(wire.ViewerPeerIDs) > *wire.MaxViewers ||
		(wire.ViewerPolicy != "private-link" && wire.ViewerPolicy != "public-watch") ||
		!validOpaqueID(wire.ViewerAuthorizationGeneration) {
		return serverMessage{}, errors.New("host authentication response is invalid")
	}
	if err := validateNullableTime(wire.RoomExpiresAt); err != nil {
		return serverMessage{}, errors.New("host room expiry is invalid")
	}
	for _, peerID := range wire.ViewerPeerIDs {
		if !validOpaqueID(peerID) {
			return serverMessage{}, errors.New("host viewer roster is invalid")
		}
	}
	config, err := decodeICEConfig(wire.IceConfig)
	if err != nil {
		return serverMessage{}, err
	}
	peerAssisted := wire.MediaMode != nil
	var assignment mediaAssignment
	var routeAssignment participantRouteAssignment
	var routeRevision int64
	if !peerAssisted {
		if len(wire.MediaAssignment) != 0 || wire.RouteRevision != nil || len(wire.RouteAssignment) != 0 || len(wire.QualitySettings) != 0 || len(wire.SFUStandbyURL) != 0 {
			return serverMessage{}, errors.New("host authentication response is invalid")
		}
	} else {
		if *wire.MediaMode != "peer-assisted" {
			return serverMessage{}, errors.New("host authentication response is invalid")
		}
		assignment, err = decodeHostMediaAssignment(wire.MediaAssignment)
		if err != nil {
			return serverMessage{}, errors.New("host authentication response is invalid")
		}
		routeAssignment, err = decodeHostRouteAssignment(wire.RouteAssignment)
		if err != nil || strings.Join(assignment.ChildPeerIDs, "\x00") != strings.Join(routeAssignment.ChildPeerIDs, "\x00") {
			return serverMessage{}, errors.New("host authentication response is invalid")
		}
		if wire.RouteRevision == nil || *wire.RouteRevision < 0 || *wire.RouteRevision > maxRouteRevision || len(wire.QualitySettings) == 0 {
			return serverMessage{}, errors.New("host authentication response is invalid")
		}
		routeRevision = *wire.RouteRevision
	}
	return serverMessage{
		Type:            wire.Type,
		Role:            wire.Role,
		PeerID:          wire.PeerID,
		MaxViewers:      *wire.MaxViewers,
		ViewerPeerIDs:   append([]string(nil), wire.ViewerPeerIDs...),
		IceConfig:       config,
		ViewerPolicy:    wire.ViewerPolicy,
		PeerAssisted:    peerAssisted,
		MediaAssignment: assignment,
		RouteAssignment: routeAssignment,
		RouteRevision:   routeRevision,
	}, nil
}

func decodeHostMediaAssignment(payload []byte) (mediaAssignment, error) {
	var assignment mediaAssignment
	if err := decodeStrict(payload, &assignment); err != nil || !bytes.Equal(bytes.TrimSpace(assignment.ParentPeerID), []byte("null")) || !validChildPeerIDs(assignment.ChildPeerIDs) {
		return mediaAssignment{}, errors.New("host media assignment is invalid")
	}
	return assignment, nil
}

func decodeHostRouteAssignment(payload []byte) (participantRouteAssignment, error) {
	var assignment participantRouteAssignment
	if err := decodeStrict(payload, &assignment); err != nil || assignment.Upstream.Kind != "none" || assignment.Upstream.PeerID != nil || !validChildPeerIDs(assignment.ChildPeerIDs) {
		return participantRouteAssignment{}, errors.New("host route assignment is invalid")
	}
	if _, err := decodeNullableOpaqueID(assignment.SFUPublicationGeneration); err != nil {
		return participantRouteAssignment{}, errors.New("host route assignment is invalid")
	}
	return assignment, nil
}

func decodeNullableOpaqueID(payload []byte) (string, error) {
	if bytes.Equal(bytes.TrimSpace(payload), []byte("null")) {
		return "", nil
	}
	var value string
	if len(payload) == 0 || json.Unmarshal(payload, &value) != nil || !validOpaqueID(value) {
		return "", errors.New("nullable opaque ID is invalid")
	}
	return value, nil
}

func validChildPeerIDs(peerIDs []string) bool {
	if peerIDs == nil || len(peerIDs) > maxHostEdges {
		return false
	}
	seen := make(map[string]struct{}, len(peerIDs))
	for _, peerID := range peerIDs {
		if !validOpaqueID(peerID) {
			return false
		}
		if _, duplicate := seen[peerID]; duplicate {
			return false
		}
		seen[peerID] = struct{}{}
	}
	return true
}

func decodeInboundSignalPayload(payload []byte) (inboundSignalPayload, error) {
	var discriminator struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(payload, &discriminator); err != nil {
		return inboundSignalPayload{}, errors.New("viewer signal payload is invalid")
	}
	switch discriminator.Kind {
	case "description":
		var wire struct {
			Kind         string             `json:"kind"`
			ConnectionID string             `json:"connectionId"`
			Description  sessionDescription `json:"description"`
		}
		if err := decodeStrict(payload, &wire); err != nil || !validOpaqueID(wire.ConnectionID) ||
			wire.Description.Type != "answer" || len(wire.Description.SDP) < 1 || len(wire.Description.SDP) > maxSignalSDPBytes {
			return inboundSignalPayload{}, errors.New("viewer answer payload is invalid")
		}
		return inboundSignalPayload{Kind: wire.Kind, ConnectionID: wire.ConnectionID, Description: &wire.Description}, nil
	case "candidate":
		var wire struct {
			Kind         string          `json:"kind"`
			ConnectionID string          `json:"connectionId"`
			Candidate    json.RawMessage `json:"candidate"`
		}
		if err := decodeStrict(payload, &wire); err != nil || !validOpaqueID(wire.ConnectionID) || len(wire.Candidate) == 0 {
			return inboundSignalPayload{}, errors.New("viewer candidate payload is invalid")
		}
		if bytes.Equal(bytes.TrimSpace(wire.Candidate), []byte("null")) {
			return inboundSignalPayload{Kind: wire.Kind, ConnectionID: wire.ConnectionID}, nil
		}
		var candidate iceCandidate
		if err := decodeStrict(wire.Candidate, &candidate); err != nil || len(candidate.Candidate) > 4096 ||
			candidate.SDPMid != nil && len(*candidate.SDPMid) > 128 ||
			candidate.SDPMLineIndex != nil && *candidate.SDPMLineIndex > 255 ||
			candidate.UsernameFragment != nil && len(*candidate.UsernameFragment) > 256 {
			return inboundSignalPayload{}, errors.New("viewer ICE candidate is invalid")
		}
		return inboundSignalPayload{Kind: wire.Kind, ConnectionID: wire.ConnectionID, Candidate: &candidate}, nil
	default:
		return inboundSignalPayload{}, errors.New("viewer signal kind is invalid")
	}
}

func decodeICEConfig(payload []byte) (iceConfig, error) {
	var wire struct {
		IceServers []iceServer `json:"iceServers"`
	}
	if err := decodeStrict(payload, &wire); err != nil || wire.IceServers == nil || len(wire.IceServers) > 8 {
		return iceConfig{}, errors.New("ICE configuration is invalid")
	}
	for _, server := range wire.IceServers {
		var urls []string
		if err := json.Unmarshal(server.URLs, &urls); err != nil {
			var single string
			if secondErr := json.Unmarshal(server.URLs, &single); secondErr != nil || !validStunURL(single) {
				return iceConfig{}, errors.New("ICE server URLs are invalid")
			}
			continue
		}
		if len(urls) < 1 || len(urls) > 8 {
			return iceConfig{}, errors.New("ICE server URLs are invalid")
		}
		for _, value := range urls {
			if !validStunURL(value) {
				return iceConfig{}, errors.New("ICE server URLs are invalid")
			}
		}
	}
	return iceConfig{IceServers: wire.IceServers}, nil
}

func validStunURL(value string) bool {
	if len(value) < len("stun:a") || len(value) > 512 || !strings.EqualFold(value[:len("stun:")], "stun:") {
		return false
	}
	authority := value[len("stun:"):]
	if authority == "" || strings.ContainsAny(authority, "/\\\t\r\n ?#") || strings.HasSuffix(authority, ":") {
		return false
	}
	parsed, err := url.Parse("//" + authority)
	if err != nil || parsed.Hostname() == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	if port := parsed.Port(); port != "" {
		value, portErr := strconv.Atoi(port)
		return portErr == nil && value > 0 && value <= 65535
	}
	return true
}

func decodeStrict(payload []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("multiple JSON values")
	}
	return nil
}

func validateNullableTime(payload json.RawMessage) error {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 {
		return errors.New("missing time")
	}
	if bytes.Equal(trimmed, []byte("null")) {
		return nil
	}
	var value string
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return err
	}
	_, err := time.Parse(time.RFC3339, value)
	return err
}

func validOpaqueID(value string) bool {
	return opaqueIDPattern.MatchString(value)
}

func validErrorCode(value string) bool {
	switch value {
	case "AUTH_REQUIRED", "INVALID_MESSAGE", "INVALID_TOKEN", "ROOM_EXPIRED", "ROOM_FULL", "HOST_ALREADY_CONNECTED", "PEER_NOT_FOUND", "FORBIDDEN", "SERVER_ERROR":
		return true
	default:
		return false
	}
}
