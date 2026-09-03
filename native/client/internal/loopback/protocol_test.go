package loopback

import (
	"testing"
)

func TestDecodeRequestAcceptsOnlyTheCurrentShape(t *testing.T) {
	valid := []string{
		`{"version":5,"id":"request_hello","type":"hello"}`,
		`{"version":5,"id":"request_ping","type":"ping"}`,
	}
	for _, payload := range valid {
		if _, err := decodeRequest([]byte(payload)); err != nil {
			t.Fatalf("decodeRequest(%s) = %v", payload, err)
		}
	}
	invalid := []string{
		`{"version":3,"id":"request_ping","type":"ping"}`,
		`{"version":5,"id":"short","type":"ping"}`,
		`{"version":5,"id":"request_ping","type":"ping","extra":true}`,
		`{"version":5,"id":"request_hello","type":"hello","nonce":"obsolete"}`,
		`{"version":5,"id":"request_ping","type":"ping"} trailing`,
	}
	for _, payload := range invalid {
		if _, err := decodeRequest([]byte(payload)); err == nil {
			t.Fatalf("decodeRequest accepted %s", payload)
		}
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
	payload := []byte(`{"version":5,"id":"request_extension","type":"extension","value":1}`)
	message, err := decodeEnvelope(payload)
	if err != nil || message.Type != "extension" {
		t.Fatalf("extension envelope = %+v, %v", message, err)
	}
	if _, err = decodeRequest(payload); err == nil {
		t.Fatal("base message decoder accepted extension fields")
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
