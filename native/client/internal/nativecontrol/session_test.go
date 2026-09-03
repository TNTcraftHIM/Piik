package nativecontrol

import (
	"testing"

	"github.com/TNTcraftHIM/Screener/native/client/internal/loopback"
	"github.com/TNTcraftHIM/Screener/native/client/internal/nativecapture"
)

func TestSTUNURLsUseTheCurrentBoundedWire(t *testing.T) {
	servers, err := pionICEServers([]iceServer{{URLs: []string{
		"stun:example.test:3478",
		"stun:example.test:3479",
	}}})
	if err != nil || len(servers) != 1 || len(servers[0].URLs) != 2 {
		t.Fatalf("servers = %+v, %v", servers, err)
	}
	for _, value := range []string{
		"turn:example.com:3478",
		"stun:user@example.com:3478",
		"stun:example.com:0",
		"stun:example.com/path",
	} {
		if validSTUNURL(value) {
			t.Fatalf("invalid STUN URL accepted: %s", value)
		}
	}
}

func TestControlMessagesRejectUnknownFieldsAndStaleVersions(t *testing.T) {
	session := New("missing-capture-process", nativecapture.Capabilities{}, false)
	t.Cleanup(func() { _ = session.Close() })
	for _, payload := range []string{
		`{"version":5,"id":"request_sources","type":"list-sources","extra":true}`,
		`{"version":4,"id":"request_sources","type":"list-sources"}`,
		`{"version":5,"id":"short","type":"stop-share","shareId":"share_123456"}`,
	} {
		if _, err := session.Handle(t.Context(), []byte(payload)); err == nil {
			t.Fatalf("invalid control message accepted: %s", payload)
		}
	}
}

func TestResponseKeepsTheRequestIdentity(t *testing.T) {
	value := response(requestEnvelope{
		Version: loopback.ProtocolVersion,
		ID:      "request_123456",
		Type:    "stop-share",
	}, "share-stopped")
	if value.Version != loopback.ProtocolVersion || value.ID != "request_123456" ||
		value.Type != "share-stopped" {
		t.Fatalf("response = %+v", value)
	}
}

func TestPrepareLocalEdgeOwnsOneStrictRequestShape(t *testing.T) {
	session := New("missing-capture-process", nativecapture.Capabilities{}, false)
	t.Cleanup(func() { _ = session.Close() })
	valid := `{"version":5,"id":"request_local_edge","type":"prepare-local-edge","shareId":"share_123456","connectionId":"edge_1234567"}`
	if _, err := session.Handle(t.Context(), []byte(valid)); err == nil || err.Error() != "native share does not exist" {
		t.Fatalf("valid local-edge request stopped at wrong boundary: %v", err)
	}
	invalid := `{"version":5,"id":"request_local_edge","type":"prepare-local-edge","shareId":"share_123456","connectionId":"edge_1234567","iceServers":[]}`
	if _, err := session.Handle(t.Context(), []byte(invalid)); err == nil || err.Error() != "native prepare-local-edge request is invalid" {
		t.Fatalf("extended local-edge request was accepted: %v", err)
	}
}

func TestPreviewFailureReturnsAnAdvisoryResponse(t *testing.T) {
	session := New("missing-capture-process", nativecapture.Capabilities{}, false)
	t.Cleanup(func() { _ = session.Close() })
	value, err := session.Handle(t.Context(), []byte(
		`{"version":5,"id":"request_preview","type":"source-preview","source":{"kind":"display","sourceId":"65537","title":"Display 1"}}`,
	))
	if err != nil {
		t.Fatal(err)
	}
	response, ok := value.(sourcePreviewResponse)
	if !ok || response.Data != "" || response.SourceKey != "display:65537" {
		t.Fatalf("preview response = %#v", value)
	}
}
