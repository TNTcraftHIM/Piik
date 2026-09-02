package loopback

import (
	"testing"
)

func TestDecodeRequestAcceptsOnlyTheCurrentShape(t *testing.T) {
	valid := []string{
		`{"version":1,"id":"request_hello","type":"hello"}`,
		`{"version":1,"id":"request_ping","type":"ping"}`,
	}
	for _, payload := range valid {
		if _, err := decodeRequest([]byte(payload)); err != nil {
			t.Fatalf("decodeRequest(%s) = %v", payload, err)
		}
	}
	invalid := []string{
		`{"version":2,"id":"request_ping","type":"ping"}`,
		`{"version":1,"id":"short","type":"ping"}`,
		`{"version":1,"id":"request_ping","type":"ping","extra":true}`,
		`{"version":1,"id":"request_hello","type":"hello","nonce":"obsolete"}`,
		`{"version":1,"id":"request_ping","type":"ping"} trailing`,
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
	if err := validateReadyRequest(ping); err != nil {
		t.Fatal(err)
	}
	if err := validateReadyRequest(hello); err == nil {
		t.Fatal("validateReadyRequest accepted hello")
	}
	if err := validateHello(ping); err == nil {
		t.Fatal("validateHello accepted ping")
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
