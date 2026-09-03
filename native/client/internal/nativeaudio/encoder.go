package nativeaudio

import (
	"encoding/binary"
	"errors"

	gopus "github.com/thesyncim/gopus"
)

const (
	SampleRate        = 48_000
	Channels          = 2
	FrameSamples      = 960
	FrameBytes        = FrameSamples * Channels * 2
	MaxPacketBytes    = 4_000
	DefaultBitrate    = 128_000
	defaultComplexity = 5
)

// Encoder adapts the capture process's fixed 48 kHz PCM frames to WebRTC
// Opus packets. The buffers are owned by the encoder and reused after each
// Encode call; the returned packet must be consumed before the next call.
type Encoder struct {
	codec  *gopus.Encoder
	pcm    [FrameSamples * Channels]int16
	packet [MaxPacketBytes]byte
}

func NewEncoder(bitrate int) (*Encoder, error) {
	if bitrate < 6_000 || bitrate > 510_000 {
		return nil, errors.New("native audio bitrate is outside the Opus range")
	}
	codec, err := gopus.NewEncoder(gopus.EncoderConfig{
		SampleRate:  SampleRate,
		Channels:    Channels,
		Application: gopus.ApplicationAudio,
	})
	if err != nil {
		return nil, err
	}
	if err = codec.SetBitrate(bitrate); err != nil {
		return nil, err
	}
	if err = codec.SetComplexity(defaultComplexity); err != nil {
		return nil, err
	}
	codec.SetDTX(false)
	if err = codec.SetInBandFEC(gopus.InBandFECDisabled); err != nil {
		return nil, err
	}
	return &Encoder{codec: codec}, nil
}

// Encode accepts one interleaved little-endian PCM16 frame and returns an
// Opus packet backed by the encoder's reusable output buffer.
func (encoder *Encoder) Encode(pcm []byte) ([]byte, error) {
	if encoder == nil || encoder.codec == nil || len(pcm) != FrameBytes {
		return nil, errors.New("native audio PCM frame is invalid")
	}
	for index := range encoder.pcm {
		encoder.pcm[index] = int16(binary.LittleEndian.Uint16(
			pcm[index*2 : index*2+2],
		))
	}
	count, err := encoder.codec.EncodeInt16(encoder.pcm[:], encoder.packet[:])
	if err != nil {
		return nil, err
	}
	if count <= 0 || count > len(encoder.packet) {
		return nil, errors.New("native audio encoder returned an invalid packet")
	}
	return encoder.packet[:count], nil
}
