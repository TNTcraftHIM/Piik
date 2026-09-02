package nativecontrol

import (
	"testing"

	"github.com/TNTcraftHIM/Screener/native/client/internal/loopback"
	"github.com/TNTcraftHIM/Screener/native/client/internal/nativecapture"
)

func TestSTUNURLsUseTheCurrentBoundedWire(t *testing.T) {
	servers, err := pionICEServers([]iceServer{{URLs: []string{
		"stun:share.bonfire.icu:3478",
		"stun:stun.cloudflare.com:3478",
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
	session := New("missing-capture-process", nativecapture.Capabilities{})
	t.Cleanup(func() { _ = session.Close() })
	for _, payload := range []string{
		`{"version":2,"id":"request_sources","type":"list-windows","extra":true}`,
		`{"version":1,"id":"request_sources","type":"list-windows"}`,
		`{"version":2,"id":"short","type":"stop-share","shareId":"share_123456"}`,
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
