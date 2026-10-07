package protocol

import (
	"errors"
	"regexp"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

const MaxChatCodePoints = 280
const InteractionIntervalMs = 800

var reactionIDPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

type InteractionPayload struct {
	Kind         string `json:"kind"`
	Text         string `json:"text,omitempty"`
	Reaction     string `json:"reaction,omitempty"`
	TargetPeerID string `json:"targetPeerId,omitempty"`
}

func (payload *InteractionPayload) UnmarshalJSON(data []byte) error {
	type plain InteractionPayload
	var value plain
	fields, err := decodeObject(data, &value)
	if err != nil {
		return err
	}
	if err = fields.require("kind"); err != nil {
		return err
	}
	switch value.Kind {
	case "chat":
		if err = fields.require("text"); err != nil {
			return err
		}
		if fields.has("reaction") || fields.has("targetPeerId") ||
			hasUnpairedSurrogateEscape(fields["text"]) || !validChatText(value.Text) {
			return errors.New("invalid chat payload")
		}
	case "reaction":
		if err = fields.require("reaction"); err != nil {
			return err
		}
		if err = fields.optional("targetPeerId"); err != nil {
			return err
		}
		if fields.has("text") || !reactionIDPattern.MatchString(value.Reaction) ||
			(fields.has("targetPeerId") && !ValidOpaqueID(value.TargetPeerID)) {
			return errors.New("invalid reaction payload")
		}
		switch value.Reaction {
		case "tomato", "poop":
			if !ValidOpaqueID(value.TargetPeerID) {
				return errors.New("throwing a prop requires a participant")
			}
		}
	default:
		return errors.New("unknown interaction kind")
	}
	*payload = InteractionPayload(value)
	return nil
}

func validChatText(value string) bool {
	return utf8.ValidString(value) && utf8.RuneCountInString(value) >= 1 &&
		utf8.RuneCountInString(value) <= MaxChatCodePoints && !forbiddenDisplayNameCharacters.MatchString(value) &&
		norm.NFC.IsNormalString(value) && strings.TrimFunc(value, IsJSWhitespace) == value
}

type SubscribeRoomInteractionsMessage struct {
	Type string `json:"type"`
}
type SendRoomInteractionMessage struct {
	Type      string             `json:"type"`
	RequestID string             `json:"requestId"`
	Payload   InteractionPayload `json:"payload"`
}

func (SubscribeRoomInteractionsMessage) isClientMessage() {}
func (SendRoomInteractionMessage) isClientMessage()       {}

func decodeSendRoomInteraction(data []byte) (ClientMessage, error) {
	var message SendRoomInteractionMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err = present.require("type", "requestId", "payload"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(message.RequestID) {
		return nil, errors.New("invalid interaction requestId")
	}
	// Only received presentation events are extensible. An unregistered command
	// must never acquire meaning merely because its identifier is well-formed.
	if message.Payload.Kind == "reaction" {
		switch message.Payload.Reaction {
		case "wave", "heart", "clap", "laugh", "wow", "party", "fire", "eyes", "star", "sleep", "tomato", "poop":
		default:
			return nil, errors.New("unknown reaction")
		}
	}
	return message, nil
}

type InteractionSender struct {
	PeerID      string      `json:"peerId"`
	Role        Role        `json:"role"`
	DisplayName DisplayName `json:"displayName"`
}

func (sender *InteractionSender) UnmarshalJSON(data []byte) error {
	type plain InteractionSender
	var value plain
	present, err := decodeObject(data, &value)
	if err != nil {
		return err
	}
	if err = present.require("peerId", "role", "displayName"); err != nil {
		return err
	}
	if !ValidOpaqueID(value.PeerID) {
		return errors.New("invalid sender peerId")
	}
	*sender = InteractionSender(value)
	return nil
}

type RoomInteractionsReadyMessage struct {
	Type       string `json:"type"`
	ServerTime Int    `json:"serverTime"`
}
type RoomInteractionMessage struct {
	Type       string             `json:"type"`
	ID         string             `json:"id"`
	RequestID  string             `json:"requestId"`
	OccurredAt Int                `json:"occurredAt"`
	Sender     InteractionSender  `json:"sender"`
	Payload    InteractionPayload `json:"payload"`
}
type RoomInteractionRejectedMessage struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	Reason    string `json:"reason"`
}

func (RoomInteractionsReadyMessage) isServerMessage()   {}
func (RoomInteractionMessage) isServerMessage()         {}
func (RoomInteractionRejectedMessage) isServerMessage() {}

func decodeRoomInteractionsReady(data []byte) (ServerMessage, error) {
	var message RoomInteractionsReadyMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err = present.require("type", "serverTime"); err != nil {
		return nil, err
	}
	if !inRangeInt(message.ServerTime, 0, MaxSafeInteger) {
		return nil, errors.New("invalid interaction server time")
	}
	return message, nil
}

func decodeRoomInteraction(data []byte) (ServerMessage, error) {
	var message RoomInteractionMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err = present.require("type", "id", "requestId", "occurredAt", "sender", "payload"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(message.ID) || !ValidOpaqueID(message.RequestID) {
		return nil, errors.New("invalid interaction identity")
	}
	if !inRangeInt(message.OccurredAt, 0, MaxSafeInteger) {
		return nil, errors.New("invalid interaction time")
	}
	return message, nil
}
func decodeRoomInteractionRejected(data []byte) (ServerMessage, error) {
	var message RoomInteractionRejectedMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err = present.require("type", "requestId", "reason"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(message.RequestID) {
		return nil, errors.New("invalid interaction requestId")
	}
	switch message.Reason {
	case "rate-limited", "target-unavailable", "not-subscribed", "busy":
	default:
		return nil, errors.New("invalid rejection reason")
	}
	return message, nil
}
