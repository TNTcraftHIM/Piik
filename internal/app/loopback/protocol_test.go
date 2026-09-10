package loopback

import (
	"strings"
	"testing"
)

func TestDecodeRequestAcceptsOnlyTheCurrentShape(t *testing.T) {
	valid := []string{
		`{"version":9,"id":"request_hello","type":"hello"}`,
		`{"version":9,"id":"request_ping","type":"ping"}`,
	}
	for _, payload := range valid {
		if _, err := decodeRequest([]byte(payload)); err != nil {
			t.Fatalf("decodeRequest(%s) = %v", payload, err)
		}
	}
	invalid := []string{
		`{"version":3,"id":"request_ping","type":"ping"}`,
		`{"version":9,"id":"short","type":"ping"}`,
		`{"version":9,"id":"request_ping","type":"ping","extra":true}`,
		`{"version":9,"id":"request_hello","type":"hello","nonce":"obsolete"}`,
		`{"version":9,"id":"request_ping","type":"ping"} trailing`,
	}
	for _, payload := range invalid {
		if _, err := decodeRequest([]byte(payload)); err == nil {
			t.Fatalf("decodeRequest accepted %s", payload)
		}
	}
}

func TestDecodeRequestUsesTheSharedIdentifierBoundary(t *testing.T) {
	identifier := "request_" + strings.Repeat("a", 248)
	if len(identifier) != 256 {
		t.Fatalf("test identifier length = %d", len(identifier))
	}
	payload := []byte(`{"version":9,"id":"` + identifier + `","type":"ping"}`)
	if _, err := decodeRequest(payload); err != nil {
		t.Fatalf("maximum identifier was rejected: %v", err)
	}
	tooLong := []byte(`{"version":9,"id":"` + identifier + `a","type":"ping"}`)
	if _, err := decodeRequest(tooLong); err == nil {
		t.Fatal("identifier beyond the boundary was accepted")
	}
}

func TestValidateMessagesRequireTheExpectedPhase(t *testing.T) {
	hello := controlMessage{Version: ProtocolVersion, ID: "request_hello", Type: "hello"}
	if err := validateHello(hello); err != nil {
		t.Fatalf("validateHello = %v", err)
	}
	ping := controlMessage{Version: ProtocolVersion, ID: "request_ping", Type: "ping"}
	if err := validatePing(ping); err != nil {
		t.Fatal(err)
	}
	if err := validatePing(hello); err == nil {
		t.Fatal("validatePing accepted hello")
	}
	if err := validateHello(ping); err == nil {
		t.Fatal("validateHello accepted ping")
	}
}

func TestEnvelopeAllowsAnExtensionToOwnItsStrictShape(t *testing.T) {
	payload := []byte(`{"version":9,"id":"request_extension","type":"extension","value":1}`)
	message, err := decodeEnvelope(payload)
	if err != nil || message.Type != "extension" {
		t.Fatalf("extension envelope = %+v, %v", message, err)
	}
	if _, err = decodeRequest(payload); err == nil {
		t.Fatal("base message decoder accepted extension fields")
	}
}

func TestResponseBoundFitsOneSourcePreview(t *testing.T) {
	preview := map[string]string{
		"type": "source-preview",
		"mime": "image/bmp",
		"data": strings.Repeat("A", (54+320*180*3)*4/3),
	}
	if _, err := encodeMessage(preview); err != nil {
		t.Fatalf("320x180 preview was rejected: %v", err)
	}
	preview["data"] = strings.Repeat("A", MaxControlMessageBytes)
	if _, err := encodeMessage(preview); err == nil {
		t.Fatal("response beyond the message bound was accepted")
	}
}

func TestNormalizePortRangeUsesTheBoundedDefaults(t *testing.T) {
	start, end := normalizePortRange(0, 0)
	if start != DefaultPortStart || end != DefaultPortEnd {
		t.Fatalf("default range = %d-%d", start, end)
	}
	start, end = normalizePortRange(0, 40000)
	if start != 40000 || end != 40000 {
		t.Fatalf("single-port range = %d-%d", start, end)
	}
}
