package protocol

import (
	"encoding/json"
	"errors"
	"net/url"
)

type PresentationRevokedMessage struct {
	Type            string `json:"type"`
	ShareGeneration string `json:"shareGeneration"`
}

func (PresentationRevokedMessage) isServerMessage() {}

func (v *RoomControlMember) UnmarshalJSON(data []byte) error {
	type plain RoomControlMember
	f, err := decodeObject(data, (*plain)(v))
	if err != nil {
		return err
	}
	if err = f.require("peerId", "sharingAllowed", "supported"); err != nil {
		return err
	}
	if !ValidOpaqueID(v.PeerID) {
		return errors.New("invalid control member")
	}
	return nil
}
func (v *RoomOwnershipTransfer) UnmarshalJSON(data []byte) error {
	type plain RoomOwnershipTransfer
	f, err := decodeObject(data, (*plain)(v))
	if err != nil {
		return err
	}
	if err = f.require("id", "fromPeerId", "targetPeerId"); err != nil {
		return err
	}
	if !ValidOpaqueID(v.ID) || !ValidOpaqueID(v.FromPeerID) || !ValidOpaqueID(v.TargetPeerID) {
		return errors.New("invalid ownership transfer")
	}
	return nil
}

func decodeRoomControlState(data []byte) (ServerMessage, error) {
	var v RoomControlStateMessage
	f, err := decodeObject(data, &v)
	if err != nil {
		return nil, err
	}
	if err = f.require("type", "members", "codeEntryPolicy", "viewerPasswordEnabled"); err != nil {
		return nil, err
	}
	for _, key := range []string{"ownerPeerId", "presenterPeerId", "shareGeneration", "transfer"} {
		if !f.has(key) {
			return nil, errors.New("missing room control state")
		}
	}
	for _, value := range []*string{v.OwnerPeerID, v.PresenterPeerID, v.ShareGeneration} {
		if value != nil && !ValidOpaqueID(*value) {
			return nil, errors.New("invalid room control identity")
		}
	}
	if v.CodeEntryPolicy != "open" && v.CodeEntryPolicy != "private" {
		return nil, errors.New("invalid code entry policy")
	}
	if len(v.Members) > MaxParticipantsPerRoomLimit {
		return nil, errors.New("too many room members")
	}
	return v, nil
}
func decodeRoomControlReady(data []byte) (ServerMessage, error) {
	var v RoomControlReadyMessage
	f, err := decodeObject(data, &v)
	if err != nil {
		return nil, err
	}
	if err = f.require("type", "token", "canonicalUrl"); err != nil {
		return nil, err
	}
	u, err := url.Parse(v.CanonicalURL)
	if err != nil || u.Scheme == "" || !ValidToken(v.Token) {
		return nil, errors.New("invalid room control credential")
	}
	return v, nil
}
func decodeRoomOwnershipOffer(data []byte) (ServerMessage, error) {
	var v RoomOwnershipOfferMessage
	f, err := decodeObject(data, &v)
	if err != nil {
		return nil, err
	}
	if err = f.require("type", "offerId", "token"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(v.OfferID) || !ValidToken(v.Token) {
		return nil, errors.New("invalid ownership credential")
	}
	return v, nil
}
func decodeRoomControlError(data []byte) (ServerMessage, error) {
	var v RoomControlErrorMessage
	f, err := decodeObject(data, &v)
	if err != nil {
		return nil, err
	}
	if err = f.require("type", "code"); err != nil {
		return nil, err
	}
	if err = f.optional("requestId"); err != nil {
		return nil, err
	}
	if f.has("requestId") && !ValidOpaqueID(v.RequestID) {
		return nil, errors.New("invalid room control request")
	}
	switch v.Code {
	case "not-allowed", "member-unavailable", "changed", "storage-failed":
		return v, nil
	}
	return nil, errors.New("invalid room control error")
}
func decodePresentationRevoked(data []byte) (ServerMessage, error) {
	var v PresentationRevokedMessage
	f, err := decodeObject(data, &v)
	if err != nil {
		return nil, err
	}
	if err = f.require("type", "shareGeneration"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(v.ShareGeneration) {
		return nil, errors.New("invalid share generation")
	}
	return v, nil
}

type SubscribeRoomControlMessage struct {
	Type string `json:"type"`
}

func (SubscribeRoomControlMessage) isClientMessage() {}

type RoomControlCommand struct {
	Action  string `json:"action"`
	PeerID  string `json:"peerId,omitempty"`
	Allowed *bool  `json:"allowed,omitempty"`
	OfferID string `json:"offerId,omitempty"`
}

func (v *RoomControlCommand) UnmarshalJSON(data []byte) error {
	type plain RoomControlCommand
	f, err := decodeObject(data, (*plain)(v))
	if err != nil {
		return err
	}
	if err = f.require("action"); err != nil {
		return err
	}
	switch v.Action {
	case "grant-sharing":
		if len(f) != 3 || !ValidOpaqueID(v.PeerID) || v.Allowed == nil {
			return errors.New("invalid sharing permission")
		}
	case "transfer-owner":
		if len(f) != 2 || !ValidOpaqueID(v.PeerID) {
			return errors.New("invalid ownership recipient")
		}
	case "cancel-transfer", "accept-transfer", "decline-transfer":
		if len(f) != 2 || !ValidOpaqueID(v.OfferID) {
			return errors.New("invalid ownership offer")
		}
	default:
		return errors.New("unknown room control action")
	}
	return nil
}

type RoomControlCommandMessage struct {
	Type    string             `json:"type"`
	Command RoomControlCommand `json:"command"`
}

func (RoomControlCommandMessage) isClientMessage() {}

type ClaimPresentationMessage struct {
	Type               string          `json:"type"`
	RequestID          string          `json:"requestId"`
	PreviousGeneration *string         `json:"previousGeneration"`
	ShareGeneration    string          `json:"shareGeneration"`
	QualitySettings    QualitySettings `json:"qualitySettings"`
	RoutePolicy        RoutePolicy     `json:"routePolicy"`
}

func (ClaimPresentationMessage) isClientMessage() {}

type AuthenticateMemberMessage struct {
	Type            string                 `json:"type"`
	Protocol        string                 `json:"protocol"`
	RoomID          string                 `json:"roomId"`
	Token           string                 `json:"token"`
	ClientID        string                 `json:"clientId"`
	DisplayName     DisplayName            `json:"displayName"`
	ShareGeneration string                 `json:"shareGeneration,omitempty"`
	SharingPaused   *bool                  `json:"sharingPaused,omitempty"`
	QualitySettings *QualitySettings       `json:"qualitySettings,omitempty"`
	RoutePolicy     RoutePolicy            `json:"routePolicy"`
	RoutePreference *ViewerRoutePreference `json:"routePreference,omitempty"`
}

func (AuthenticateMemberMessage) isClientMessage() {}

func decodeRoomControlCommand(data []byte) (ClientMessage, error) {
	var value RoomControlCommandMessage
	f, err := decodeObject(data, &value)
	if err == nil {
		err = f.require("type", "command")
	}
	return value, err
}
func decodeClaimPresentation(data []byte) (ClientMessage, error) {
	var value ClaimPresentationMessage
	f, err := decodeObject(data, &value)
	if err != nil {
		return nil, err
	}
	if err = f.require("type", "requestId", "shareGeneration", "qualitySettings", "routePolicy"); err != nil {
		return nil, err
	}
	if !f.has("previousGeneration") || !ValidOpaqueID(value.RequestID) || !ValidOpaqueID(value.ShareGeneration) ||
		(value.PreviousGeneration != nil && !ValidOpaqueID(*value.PreviousGeneration)) {
		return nil, errors.New("invalid presentation identity")
	}
	return value, nil
}
func decodeAuthenticateMember(data []byte) (ClientMessage, error) {
	var value AuthenticateMemberMessage
	f, err := decodeObject(data, &value)
	if err != nil {
		return nil, err
	}
	if err = f.require("type", "protocol", "roomId", "token", "clientId", "displayName", "routePolicy"); err != nil {
		return nil, err
	}
	if err = f.optional("shareGeneration", "sharingPaused", "qualitySettings", "routePreference"); err != nil {
		return nil, err
	}
	if value.Protocol != SignalingProtocol || !ValidRoomCode(value.RoomID) || !ValidToken(value.Token) || !ValidOpaqueID(value.ClientID) ||
		(f.has("shareGeneration") && !ValidOpaqueID(value.ShareGeneration)) {
		return nil, errors.New("invalid member authentication")
	}
	return value, nil
}

type RoomControlMember struct {
	PeerID         string `json:"peerId"`
	SharingAllowed bool   `json:"sharingAllowed"`
	Supported      bool   `json:"supported"`
}
type RoomOwnershipTransfer struct {
	ID           string `json:"id"`
	FromPeerID   string `json:"fromPeerId"`
	TargetPeerID string `json:"targetPeerId"`
}
type RoomControlStateMessage struct {
	CodeEntryPolicy       CodeEntryPolicy        `json:"codeEntryPolicy"`
	ViewerPasswordEnabled bool                   `json:"viewerPasswordEnabled"`
	Type                  string                 `json:"type"`
	OwnerPeerID           *string                `json:"ownerPeerId"`
	PresenterPeerID       *string                `json:"presenterPeerId"`
	ShareGeneration       *string                `json:"shareGeneration"`
	Members               []RoomControlMember    `json:"members"`
	Transfer              *RoomOwnershipTransfer `json:"transfer"`
}

func (RoomControlStateMessage) isServerMessage() {}

type RoomControlReadyMessage struct {
	Type         string `json:"type"`
	Token        string `json:"token"`
	CanonicalURL string `json:"canonicalUrl"`
}

func (RoomControlReadyMessage) isServerMessage() {}

type RoomOwnershipOfferMessage struct {
	Type    string `json:"type"`
	OfferID string `json:"offerId"`
	Token   string `json:"token"`
}

func (RoomOwnershipOfferMessage) isServerMessage() {}

type RoomRoleChangedMessage struct {
	Type  string        `json:"type"`
	State ServerMessage `json:"state"`
}

func (RoomRoleChangedMessage) isServerMessage() {}

type RoomControlErrorMessage struct {
	Type      string `json:"type"`
	Code      string `json:"code"`
	RequestID string `json:"requestId,omitempty"`
}

func (RoomControlErrorMessage) isServerMessage() {}

func decodeRoomRoleChanged(data []byte) (ServerMessage, error) {
	var value struct {
		Type  string          `json:"type"`
		State json.RawMessage `json:"state"`
	}
	f, err := decodeObject(data, &value)
	if err != nil {
		return nil, err
	}
	if err = f.require("type", "state"); err != nil {
		return nil, err
	}
	state, err := decodeAuthenticated(value.State)
	return RoomRoleChangedMessage{Type: value.Type, State: state}, err
}
