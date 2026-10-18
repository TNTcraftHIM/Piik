package remoteinput

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"strings"
	"testing"

	"github.com/TNTcraftHIM/Piik/internal/media/inputroute"
)

func TestRoutedInputRejectsForgeryReflectionAndReplay(t *testing.T) {
	host, _ := newInputCipher(strings.Repeat("ab", 32))
	epoch := strings.Repeat("cd", 16)
	header := make([]byte, 20)
	binary.BigEndian.PutUint64(header, 1)
	_, _ = rand.Read(header[8:])
	// Escaped quotes/backslashes at the text limit must survive the same relay
	// envelope as keys, with no alternate channel or widened queue budget.
	plain, _ := json.Marshal(inputEvent{Type: "text", Text: strings.Repeat("\\\"", maxTextBytes/2), Grant: strings.Repeat("a", 64)})
	bytes := host.aead.Seal(header, header[8:], plain, inputAAD(0, header[:8], epoch))
	packet := base64.StdEncoding.EncodeToString(bytes)
	envelope, _ := json.Marshal(inputroute.Packet{ID: strings.Repeat("b", 32), Epoch: epoch, Data: packet})
	if len(plain) > maxInputBytes || len(envelope) > inputroute.MaxPacket {
		t.Fatal("valid text does not fit the input transport")
	}
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
