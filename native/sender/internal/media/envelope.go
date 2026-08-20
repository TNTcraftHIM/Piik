package media

import (
	"encoding/binary"
	"errors"
	"time"
)

const (
	EnvelopeVersion     = 1
	EnvelopeHeaderBytes = 20
	MaxMediaPayload     = 1 << 20
	MaxPCMBytes         = 48_000 * 2 * 2 / 10 // 100 ms of 48 kHz stereo s16.

	flagKeyFrame = 1 << 0
)

type Kind uint8

const (
	KindVideo Kind = 1
	KindPCM   Kind = 2
	KindOpus  Kind = 3
)

type Packet struct {
	Kind           Kind
	KeyFrame       bool
	Timestamp100ns uint64
	Duration100ns  uint64
	Data           []byte
}

func EncodePacket(packet Packet) ([]byte, error) {
	if err := validatePacket(packet); err != nil {
		return nil, err
	}
	payload := make([]byte, EnvelopeHeaderBytes+len(packet.Data))
	payload[0] = EnvelopeVersion
	payload[1] = byte(packet.Kind)
	if packet.KeyFrame {
		payload[2] = flagKeyFrame
	}
	binary.BigEndian.PutUint64(payload[4:12], packet.Timestamp100ns)
	binary.BigEndian.PutUint64(payload[12:20], packet.Duration100ns)
	copy(payload[EnvelopeHeaderBytes:], packet.Data)
	return payload, nil
}

func DecodePacket(payload []byte) (Packet, error) {
	if len(payload) <= EnvelopeHeaderBytes || len(payload)-EnvelopeHeaderBytes > MaxMediaPayload {
		return Packet{}, errors.New("media envelope is empty, truncated, or too large")
	}
	if payload[0] != EnvelopeVersion || payload[3] != 0 || payload[2]&^byte(flagKeyFrame) != 0 {
		return Packet{}, errors.New("media envelope header is invalid")
	}
	packet := Packet{
		Kind:           Kind(payload[1]),
		KeyFrame:       payload[2]&flagKeyFrame != 0,
		Timestamp100ns: binary.BigEndian.Uint64(payload[4:12]),
		Duration100ns:  binary.BigEndian.Uint64(payload[12:20]),
		Data:           append([]byte(nil), payload[EnvelopeHeaderBytes:]...),
	}
	if err := validatePacket(packet); err != nil {
		return Packet{}, err
	}
	return packet, nil
}

func (packet Packet) VideoFrame() (Frame, error) {
	if packet.Kind != KindVideo {
		return Frame{}, errors.New("media envelope is not encoded video")
	}
	return Frame{
		KeyFrame:        packet.KeyFrame,
		TimestampMicros: packet.Timestamp100ns / 10,
		DurationMicros:  packet.Duration100ns / 10,
		Data:            packet.Data,
	}, nil
}

func validatePacket(packet Packet) error {
	if len(packet.Data) == 0 || len(packet.Data) > MaxMediaPayload || packet.Duration100ns == 0 ||
		packet.Duration100ns > uint64(time.Second/(100*time.Nanosecond)) {
		return errors.New("media envelope violates the bounded media contract")
	}
	switch packet.Kind {
	case KindVideo:
		if packet.Duration100ns < 10 || packet.Duration100ns%10 != 0 {
			return errors.New("video envelope timestamp unit is invalid")
		}
	case KindPCM:
		if packet.KeyFrame || len(packet.Data) > MaxPCMBytes || len(packet.Data)%4 != 0 {
			return errors.New("PCM envelope is invalid")
		}
	case KindOpus:
		if packet.KeyFrame || len(packet.Data) > 64<<10 {
			return errors.New("Opus envelope is invalid")
		}
	default:
		return errors.New("media envelope kind is invalid")
	}
	return nil
}
