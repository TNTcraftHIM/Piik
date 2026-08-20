package remote

import (
	"encoding/json"
	"strings"
	"testing"
)

const validHostAuthenticated = `{"type":"authenticated","protocol":"screener-v2","role":"host","peerId":"host-peer","roomExpiresAt":null,"maxViewers":3,"hostOnline":true,"connectionId":null,"viewerPeerIds":[],"iceConfig":{"iceServers":[{"urls":["stun:example.test"]}]},"viewerPolicy":"private-link","viewerAuthorizationGeneration":"viewer_generation_12345678"}`

const validPeerAssistedHostAuthenticated = `{"type":"authenticated","protocol":"screener-v2","role":"host","peerId":"host-peer","roomExpiresAt":null,"maxViewers":3,"hostOnline":true,"connectionId":null,"viewerPeerIds":["viewer-1","viewer-2"],"iceConfig":{"iceServers":[{"urls":["stun:example.test"]}]},"viewerPolicy":"private-link","viewerAuthorizationGeneration":"viewer_generation_12345678","mediaMode":"peer-assisted","mediaAssignment":{"parentPeerId":null,"childPeerIds":["viewer-1","viewer-2"]},"routeRevision":7,"routeAssignment":{"upstream":{"kind":"none"},"childPeerIds":["viewer-1","viewer-2"],"sfuPublicationGeneration":null},"qualitySettings":{"resolution":"1080p","maxFramerate":60,"maxBitrate":8000000,"degradationPreference":"maintain-resolution"}}`

func TestMarshalHostSignalShapes(t *testing.T) {
	mid := "0"
	line := uint16(0)
	tests := []struct {
		name    string
		payload any
		want    string
	}{
		{
			name: "offer",
			payload: outboundDescriptionPayload{
				Kind: "description", ConnectionID: "connection-1",
				Description: sessionDescription{Type: "offer", SDP: "v=0"},
			},
			want: `{"type":"signal","targetPeerId":"viewer-1","payload":{"kind":"description","connectionId":"connection-1","description":{"type":"offer","sdp":"v=0"}}}`,
		},
		{
			name: "candidate",
			payload: outboundCandidatePayload{
				Kind: "candidate", ConnectionID: "connection-1",
				Candidate: &iceCandidate{Candidate: "candidate:1", SDPMid: &mid, SDPMLineIndex: &line},
			},
			want: `{"type":"signal","targetPeerId":"viewer-1","payload":{"kind":"candidate","connectionId":"connection-1","candidate":{"candidate":"candidate:1","sdpMid":"0","sdpMLineIndex":0}}}`,
		},
		{
			name:    "end-of-candidates",
			payload: outboundCandidatePayload{Kind: "candidate", ConnectionID: "connection-1", Candidate: nil},
			want:    `{"type":"signal","targetPeerId":"viewer-1","payload":{"kind":"candidate","connectionId":"connection-1","candidate":null}}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			encoded, err := json.Marshal(outboundSignalMessage{Type: "signal", TargetPeerID: "viewer-1", Payload: test.payload})
			if err != nil {
				t.Fatal(err)
			}
			if string(encoded) != test.want {
				t.Fatalf("signal JSON = %s\nwant        = %s", encoded, test.want)
			}
		})
	}
}

func TestDecodeOrdinaryHostAuthentication(t *testing.T) {
	message, err := decodeServerMessage([]byte(validHostAuthenticated))
	if err != nil {
		t.Fatal(err)
	}
	if message.MaxViewers != 3 || message.Type != "authenticated" || message.Role != "host" ||
		message.ViewerPolicy != "private-link" {
		t.Fatalf("authentication = %+v", message)
	}
}

func TestDecodePeerAssistedHostAuthentication(t *testing.T) {
	message, err := decodeServerMessage([]byte(validPeerAssistedHostAuthenticated))
	if err != nil {
		t.Fatal(err)
	}
	if !message.PeerAssisted || message.RouteRevision != 7 || len(message.MediaAssignment.ChildPeerIDs) != 2 {
		t.Fatalf("peer-assisted authentication = %+v", message)
	}
}

func TestDecodePeerAssistedHostAuthenticationRejectsInvalidAuthority(t *testing.T) {
	tests := map[string]func(map[string]any){
		"third-child": func(message map[string]any) {
			children := []any{"viewer-1", "viewer-2", "viewer-3"}
			message["mediaAssignment"].(map[string]any)["childPeerIds"] = children
			message["routeAssignment"].(map[string]any)["childPeerIds"] = children
		},
		"duplicate-child": func(message map[string]any) {
			children := []any{"viewer-1", "viewer-1"}
			message["mediaAssignment"].(map[string]any)["childPeerIds"] = children
			message["routeAssignment"].(map[string]any)["childPeerIds"] = children
		},
		"host-parent": func(message map[string]any) {
			message["mediaAssignment"].(map[string]any)["parentPeerId"] = "viewer-1"
		},
		"host-upstream": func(message map[string]any) {
			message["routeAssignment"].(map[string]any)["upstream"] = map[string]any{"kind": "peer", "peerId": "viewer-1"}
		},
		"extra-upstream-field": func(message map[string]any) {
			message["routeAssignment"].(map[string]any)["upstream"] = map[string]any{"kind": "none", "peerId": ""}
		},
		"mismatched-children": func(message map[string]any) {
			message["routeAssignment"].(map[string]any)["childPeerIds"] = []any{"viewer-2", "viewer-1"}
		},
		"missing-quality": func(message map[string]any) { delete(message, "qualitySettings") },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			var candidate map[string]any
			if err := json.Unmarshal([]byte(validPeerAssistedHostAuthenticated), &candidate); err != nil {
				t.Fatal(err)
			}
			mutate(candidate)
			payload, err := json.Marshal(candidate)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = decodeServerMessage(payload); err == nil {
				t.Fatal("invalid peer-assisted authority was accepted")
			}
		})
	}
}

func TestDecodePeerAssistedRouteMessages(t *testing.T) {
	tests := []struct {
		payload  string
		typeName string
	}{
		{`{"type":"media-assignment","mediaAssignment":{"parentPeerId":null,"childPeerIds":["viewer-1"]}}`, "media-assignment"},
		{`{"type":"route-update","revision":8,"phase":"active","assignment":{"upstream":{"kind":"none"},"childPeerIds":["viewer-1"],"sfuPublicationGeneration":null}}`, "route-update"},
		{`{"type":"sfu-config","revision":8,"url":"wss://example.test","token":"opaque"}`, "sfu-config"},
		{`{"type":"selected-edge-turn","edgeKind":"host-sfu-ingress","revision":8,"hostPeerId":"host-peer","publicationGeneration":"publication-1","oldConnectionId":"connection-old","newConnectionId":"connection-new","expiresAt":"2030-01-01T00:00:00Z","iceServer":{"urls":["turn:example.test?transport=udp"],"username":"1:abcdefghijklmnop","credential":"opaque"}}`, "selected-edge-turn"},
	}
	for _, test := range tests {
		message, err := decodeServerMessage([]byte(test.payload))
		if err != nil || message.Type != test.typeName {
			t.Fatalf("decode %s = %+v, %v", test.typeName, message, err)
		}
	}
}

func TestDecodeOrdinaryHostAuthenticationRejectsInvalidVariants(t *testing.T) {
	tests := map[string]func(map[string]any){
		"missing-protocol": func(message map[string]any) { delete(message, "protocol") },
		"wrong-protocol":   func(message map[string]any) { message["protocol"] = "legacy-protocol" },
		"missing-max":      func(message map[string]any) { delete(message, "maxViewers") },
		"zero-max":         func(message map[string]any) { message["maxViewers"] = 0 },
		"too-large-max":    func(message map[string]any) { message["maxViewers"] = 17 },
		"peer-mode-extra":  func(message map[string]any) { message["mediaMode"] = "peer-assisted" },
		"wrong-role":       func(message map[string]any) { message["role"] = "viewer" },
		"legacy-ice-shape": func(message map[string]any) {
			message["iceConfig"].(map[string]any)["expiresAt"] = nil
		},
		"turn-url": func(message map[string]any) {
			message["iceConfig"] = map[string]any{"iceServers": []any{map[string]any{"urls": "turn:example.test"}}}
		},
		"missing-viewer-policy":     func(message map[string]any) { delete(message, "viewerPolicy") },
		"wrong-viewer-policy":       func(message map[string]any) { message["viewerPolicy"] = "friends" },
		"missing-viewer-generation": func(message map[string]any) { delete(message, "viewerAuthorizationGeneration") },
		"invalid-viewer-generation": func(message map[string]any) { message["viewerAuthorizationGeneration"] = "short" },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			var candidate map[string]any
			if err := json.Unmarshal([]byte(validHostAuthenticated), &candidate); err != nil {
				t.Fatal(err)
			}
			mutate(candidate)
			payload, err := json.Marshal(candidate)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = decodeServerMessage(payload); err == nil {
				t.Fatal("invalid authentication was accepted")
			}
		})
	}
}

func TestDecodeServerMessageRejectsRemovedICERefresh(t *testing.T) {
	payload := []byte(`{"type":"ice-config","iceConfig":{"iceServers":[]}}`)
	if _, err := decodeServerMessage(payload); err == nil {
		t.Fatal("removed ICE refresh message was accepted")
	}
}

func TestDecodeUnknownServerMessageDoesNotReflectUntrustedType(t *testing.T) {
	const secret = "password=g1.1.1893456000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA@https://private.test/path"
	_, err := decodeServerMessage([]byte(`{"type":"` + secret + `"}`))
	if err == nil || err.Error() != "signaling message type is unsupported" {
		t.Fatalf("unknown message error = %v", err)
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatal("unknown message error reflected untrusted input")
	}
}

func TestDecodeAndIgnoreBoundedViewerQualityEvidence(t *testing.T) {
	const valid = `{"type":"viewer-quality-evidence","viewerPeerId":"viewer-1","parentPeerId":"host-peer","guard":{"connectionId":"connection-1","routeRevision":0},"sequence":1,"windowMs":2000,"metrics":{"width":1280,"height":720,"framesPerSecond":30,"bitrateKbps":3000,"packetsReceivedDelta":100,"packetsLostDelta":0,"jitterMs":2.5,"framesDecodedDelta":60,"framesDroppedDelta":0,"decodeMsPerFrame":1.5,"freezeCountDelta":0,"freezeDurationMsDelta":0,"codec":"video/VP8","codecProfile":null,"codecParameters":"max-fr=30; max-fs=3600"}}`
	message, err := decodeServerMessage([]byte(valid))
	if err != nil {
		t.Fatal(err)
	}
	if message.Type != "viewer-quality-evidence" {
		t.Fatalf("message type = %q", message.Type)
	}
	if err = (&Session{}).handle(message); err != nil {
		t.Fatalf("fixed-HIGH rejected read-only viewer evidence: %v", err)
	}
}

func TestDecodeViewerQualityEvidenceRejectsInvalidVariants(t *testing.T) {
	const valid = `{"type":"viewer-quality-evidence","viewerPeerId":"viewer-1","parentPeerId":"host-peer","guard":{"connectionId":"connection-1","routeRevision":0},"sequence":1,"windowMs":2000,"metrics":{"width":1280,"height":720,"framesPerSecond":30,"bitrateKbps":3000,"packetsReceivedDelta":100,"packetsLostDelta":0,"jitterMs":2.5,"framesDecodedDelta":60,"framesDroppedDelta":0,"decodeMsPerFrame":1.5,"freezeCountDelta":0,"freezeDurationMsDelta":0,"codec":"video/VP8","codecProfile":null,"codecParameters":"max-fr=30; max-fs=3600"}}`
	tests := map[string]func(map[string]any){
		"extra-envelope-field": func(message map[string]any) { message["roomId"] = "1" },
		"missing-metric": func(message map[string]any) {
			delete(message["metrics"].(map[string]any), "bitrateKbps")
		},
		"extra-metric": func(message map[string]any) {
			message["metrics"].(map[string]any)["decoderImplementation"] = "private"
		},
		"extra-guard-field": func(message map[string]any) {
			message["guard"].(map[string]any)["peerId"] = "viewer-1"
		},
		"missing-guard-field": func(message map[string]any) {
			delete(message["guard"].(map[string]any), "routeRevision")
		},
		"invalid-viewer-id": func(message map[string]any) {
			message["viewerPeerId"] = "short"
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			var candidate map[string]any
			if err := json.Unmarshal([]byte(valid), &candidate); err != nil {
				t.Fatal(err)
			}
			mutate(candidate)
			payload, err := json.Marshal(candidate)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = decodeServerMessage(payload); err == nil {
				t.Fatal("invalid viewer quality evidence was accepted")
			}
		})
	}
}

func TestDecodeViewerQualityEvidenceRejectsOversizedPayload(t *testing.T) {
	payload := make([]byte, maxQualityEvidence+1)
	if err := validateViewerQualityEvidence(payload); err == nil || err.Error() != "viewer quality evidence is too large" {
		t.Fatalf("oversized viewer quality evidence error = %v", err)
	}
}

func TestPionConfigurationNormalizesUppercaseStunScheme(t *testing.T) {
	config, err := decodeICEConfig([]byte(`{"iceServers":[{"urls":["STUN:[2001:db8::1]:3478"]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	pionConfig, err := pionConfiguration(config)
	if err != nil {
		t.Fatal(err)
	}
	if got := pionConfig.ICEServers[0].URLs[0]; got != "stun:[2001:db8::1]:3478" {
		t.Fatalf("Pion STUN URL = %q", got)
	}
}

func TestDecodeInboundSignalRejectsCrossVariantFields(t *testing.T) {
	tests := []string{
		`{"kind":"description","connectionId":"connection-1","description":{"type":"answer","sdp":"v=0"},"candidate":null}`,
		`{"kind":"candidate","connectionId":"connection-1"}`,
		`{"kind":"description","connectionId":"connection-1","description":{"type":"offer","sdp":"v=0"}}`,
	}
	for _, payload := range tests {
		if _, err := decodeInboundSignalPayload([]byte(payload)); err == nil {
			t.Fatalf("invalid payload was accepted: %s", payload)
		}
	}
}

func TestDecodeInboundSignalRejectsCandidateLineAboveProtocolBound(t *testing.T) {
	payload := []byte(`{"kind":"candidate","connectionId":"connection-1","candidate":{"candidate":"candidate:1","sdpMLineIndex":256}}`)
	if _, err := decodeInboundSignalPayload(payload); err == nil {
		t.Fatal("candidate line 256 was accepted")
	}
}

func TestMarshalAbandonRoomShape(t *testing.T) {
	encoded, err := json.Marshal(simpleMessage{Type: "abandon-room"})
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"type":"abandon-room"}` {
		t.Fatalf("abandon JSON = %s", encoded)
	}
}
