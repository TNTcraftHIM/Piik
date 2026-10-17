package remoteinput

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
)

// Each authenticated room endpoint gets a fresh key through room signaling,
// never through a media relay. Random nonces survive native-session replacement;
// authenticated direction and sequence reject reflected or delayed packets.
type inputCipher struct {
	aead           cipher.AEAD
	sent, received uint64
}

func newInputCipher(key string) (*inputCipher, error) {
	bytes, err := hex.DecodeString(key)
	if err != nil || len(bytes) != 32 {
		return nil, errors.New("invalid input key")
	}
	block, err := aes.NewCipher(bytes)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &inputCipher{aead: aead}, nil
}

func (c *inputCipher) open(data, epoch string) ([]byte, error) {
	bytes, err := base64.StdEncoding.DecodeString(data)
	if err != nil || len(bytes) < 20+c.aead.Overhead() || len(bytes) > 1536 {
		return nil, errors.New("invalid input packet")
	}
	seq := binary.BigEndian.Uint64(bytes[:8])
	if seq <= c.received {
		return nil, errors.New("stale input packet")
	}
	plain, err := c.aead.Open(nil, bytes[8:20], bytes[20:], inputAAD(0, bytes[:8], epoch))
	if err == nil {
		c.received = seq
	}
	return plain, err
}

func (c *inputCipher) seal(data []byte, epoch string) string {
	c.sent++
	header := make([]byte, 20)
	binary.BigEndian.PutUint64(header, c.sent)
	_, _ = rand.Read(header[8:])
	return base64.StdEncoding.EncodeToString(c.aead.Seal(header, header[8:], data, inputAAD(1, header[:8], epoch)))
}

func inputAAD(direction byte, sequence []byte, epoch string) []byte {
	return append(append([]byte{direction}, sequence...), []byte(epoch)...)
}
