package remoteinput

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"strings"
	"testing"
)

func TestRoutedInputRejectsForgeryReflectionAndReplay(t *testing.T) {
	host, _ := newInputCipher(strings.Repeat("ab", 32))
	epoch := strings.Repeat("cd", 16)
	header := make([]byte, 20)
	binary.BigEndian.PutUint64(header, 1)
	_, _ = rand.Read(header[8:])
	plain := []byte(`{"type":"reset","grant":"approved-only"}`)
	bytes := host.aead.Seal(header, header[8:], plain, inputAAD(0, header[:8], epoch))
	packet := base64.StdEncoding.EncodeToString(bytes)
	forged := append([]byte{}, bytes...)
	forged[len(forged)-1] ^= 1
	if _, err := host.open(base64.StdEncoding.EncodeToString(forged), epoch); err == nil {
		t.Fatal("relay modification accepted")
	}
	if _, err := host.open(host.seal(plain, epoch), epoch); err == nil {
		t.Fatal("Host reply reflected as input")
	}
	if _, err := host.open(packet, strings.Repeat("ef", 16)); err == nil {
		t.Fatal("relay replaced the input channel epoch")
	}
	if decoded, err := host.open(packet, epoch); err != nil || string(decoded) != string(plain) {
		t.Fatal("valid endpoint input rejected", err)
	}
	if _, err := host.open(packet, epoch); err == nil {
		t.Fatal("delayed input replay accepted")
	}
}
