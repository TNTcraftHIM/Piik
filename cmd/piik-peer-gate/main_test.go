package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func TestRunReportsRouteFailure(t *testing.T) {
	done := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.CloseNow()
		var auth json.RawMessage
		if err := wsjson.Read(r.Context(), conn, &auth); err != nil {
			t.Error(err)
			return
		}
		if err := wsjson.Write(r.Context(), conn, protocol.RouteStatusMessage{
			Type: "route-status", Revision: 1, State: "failed", Reason: "route-exhausted",
		}); err != nil {
			t.Error(err)
			return
		}
		<-done
	}))
	defer server.Close()
	defer close(done)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result := run(ctx, gateConfig{
		SignalURL: "ws" + strings.TrimPrefix(server.URL, "http"),
		Origin:    server.URL, RoomID: "1234", ClientID: "remote_test", ViewerGrant: "test",
	})
	if result.Passed || result.Error != "route assignment failed" {
		t.Fatalf("expected the route failure, got %+v", result)
	}
}

func TestIncomingUsesCurrentWireFieldNames(t *testing.T) {
	payload := []byte(`{
		"type":"route-update",
		"revision":7,
		"phase":"prepare",
		"assignment":{"upstream":{"kind":"peer","peerId":"peer_12345678"}},
		"candidate":{"connectionId":"conn_12345678"}
	}`)
	var message incoming
	if err := json.Unmarshal(payload, &message); err != nil {
		t.Fatal(err)
	}
	if message.Type != "route-update" || message.Revision != 7 ||
		message.Phase != "prepare" || message.Assignment.Upstream == nil ||
		message.Assignment.Upstream.Kind != "peer" ||
		message.Assignment.Upstream.PeerID != "peer_12345678" ||
		message.Candidate.ConnectionID != "conn_12345678" {
		t.Fatalf("decoded route update = %+v", message)
	}
}

func TestParseICEServersAcceptsWireStringAndArray(t *testing.T) {
	servers, err := parseICEServers([]wireICEServer{
		{URLs: json.RawMessage(`"stun:example.test:3478"`)},
		{URLs: json.RawMessage(`["stun:example.test:3479","stun:example.test:3480"]`)},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(servers) != 2 || len(servers[0].URLs) != 1 ||
		servers[0].URLs[0] != "stun:example.test:3478" ||
		len(servers[1].URLs) != 2 {
		t.Fatalf("parsed ICE servers = %+v", servers)
	}
}

func TestParseICEServersRejectsMalformedWireValue(t *testing.T) {
	if _, err := parseICEServers([]wireICEServer{
		{URLs: json.RawMessage(`{"unexpected":true}`)},
	}); err == nil {
		t.Fatal("malformed ICE server was accepted")
	}
}
