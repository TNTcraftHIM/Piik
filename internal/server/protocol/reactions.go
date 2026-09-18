package protocol

import "errors"

type SubscribeReactionsMessage struct {
	Type string `json:"type"`
}

type ClientReactionMessage struct {
	Type         string `json:"type"`
	TargetPeerID string `json:"targetPeerId"`
	Prop         string `json:"prop"`
}

type ServerReactionMessage struct {
	Type         string `json:"type"`
	ID           string `json:"id"`
	FromPeerID   string `json:"fromPeerId"`
	TargetPeerID string `json:"targetPeerId"`
	Prop         string `json:"prop"`
}

func (SubscribeReactionsMessage) isClientMessage() {}
func (ClientReactionMessage) isClientMessage()     {}
func (ServerReactionMessage) isServerMessage()     {}

func validReaction(prop string) bool {
	return prop == "tomato" || prop == "poop" || prop == "heart"
}

func decodeClientReaction(data []byte) (ClientMessage, error) {
	var message ClientReactionMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "targetPeerId", "prop"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(message.TargetPeerID) || !validReaction(message.Prop) {
		return nil, errors.New("invalid reaction")
	}
	return message, nil
}

func decodeServerReaction(data []byte) (ServerMessage, error) {
	var message ServerReactionMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "id", "fromPeerId", "targetPeerId", "prop"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(message.ID) || !ValidOpaqueID(message.FromPeerID) || !ValidOpaqueID(message.TargetPeerID) || !validReaction(message.Prop) {
		return nil, errors.New("invalid reaction")
	}
	return message, nil
}
