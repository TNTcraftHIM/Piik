package main

import (
	"encoding/json"
	"testing"
)

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
