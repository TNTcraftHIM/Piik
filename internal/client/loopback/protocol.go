package loopback

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
)

const (
	ProtocolVersion        = 9
	ServiceName            = "screener-client"
	ControlSubprotocol     = "screener-client-v9"
	MaxControlMessageBytes = 256 << 10
	DefaultPortStart       = 39721
	DefaultPortEnd         = 39730
)

var (
	requestIDPattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{8,256}$`)
	errInvalidMessage = errors.New("loopback control message is invalid")
)

type controlMessage struct {
	Version int    `json:"version"`
	ID      string `json:"id"`
	Type    string `json:"type"`
}

func decodeEnvelope(payload []byte) (controlMessage, error) {
	var message controlMessage
	decoder := json.NewDecoder(bytes.NewReader(payload))
	if decoder.Decode(&message) != nil || decoder.Decode(&struct{}{}) != io.EOF ||
		message.Version != ProtocolVersion || !requestIDPattern.MatchString(message.ID) ||
		message.Type == "" {
		return controlMessage{}, errInvalidMessage
	}
	return message, nil
}

func decodeRequest(payload []byte) (controlMessage, error) {
	var message controlMessage
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&message) != nil || decoder.Decode(&struct{}{}) != io.EOF ||
		message.Version != ProtocolVersion || !requestIDPattern.MatchString(message.ID) {
		return controlMessage{}, errInvalidMessage
	}
	return message, nil
}

func validateHello(message controlMessage) error {
	if message.Type != "hello" {
		return errInvalidMessage
	}
	return nil
}

func validatePing(message controlMessage) error {
	if message.Type != "ping" {
		return errInvalidMessage
	}
	return nil
}

func encodeMessage(value any) ([]byte, error) {
	payload, err := json.Marshal(value)
	if err != nil || len(payload) == 0 || len(payload) > MaxControlMessageBytes {
		return nil, errInvalidMessage
	}
	return payload, nil
}
