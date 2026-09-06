package sfu

// Ported from tests/livekit-token.test.ts. The TypeScript verified with the
// SDK's TokenVerifier; here the JWT is split, the HS256 signature recomputed
// and the payload compared to the claim set recorded in evidence/livekit.md
// section 2.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

const (
	testAPIKey = "test-api-key"
	// Placeholder credential copied from tests/livekit-token.test.ts.
	testAPISecret             = "ssssssssssssssssssssssssssssssss"
	testShareGeneration       = "share_generation_12345678"
	testPublicationGeneration = "publication_12345678"
)

// decodeToken checks the signature and returns the header and payload claims.
func decodeToken(t *testing.T, token string) (map[string]any, map[string]any) {
	t.Helper()
	segments := strings.Split(token, ".")
	if len(segments) != 3 {
		t.Fatalf("token has %d segments, want 3", len(segments))
	}
	mac := hmac.New(sha256.New, []byte(testAPISecret))
	mac.Write([]byte(segments[0] + "." + segments[1]))
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if segments[2] != want {
		t.Fatal("HS256 signature does not verify with the API secret")
	}
	return decodeSegment(t, segments[0]), decodeSegment(t, segments[1])
}

func decodeSegment(t *testing.T, segment string) map[string]any {
	t.Helper()
	raw, err := base64.RawURLEncoding.DecodeString(segment)
	if err != nil {
		t.Fatalf("base64: %v", err)
	}
	var claims map[string]any
	if err := json.Unmarshal(raw, &claims); err != nil {
		t.Fatalf("json: %v", err)
	}
	return claims
}

func testIssuer(t *testing.T, maxViewersPerRoom int) *LiveKitTokenIssuer {
	t.Helper()
	issuer, err := NewLiveKitTokenIssuer(LiveKitTokenIssuerOptions{
		APIKey:            testAPIKey,
		APISecret:         testAPISecret,
		MaxViewersPerRoom: maxViewersPerRoom,
	})
	if err != nil {
		t.Fatalf("NewLiveKitTokenIssuer: %v", err)
	}
	return issuer
}

func issue(t *testing.T, issuer *LiveKitTokenIssuer, request TokenRequest) (map[string]any, map[string]any) {
	t.Helper()
	token, err := issuer.IssueToken(request)
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}
	return decodeToken(t, token)
}

func TestTokenIssuesGenerationBoundHostToken(t *testing.T) {
	before := time.Now().Unix()
	header, claims := issue(t, testIssuer(t, 8), TokenRequest{
		RoomID:                "42",
		Role:                  "host",
		PeerID:                "host_peer_12345678",
		ShareGeneration:       testShareGeneration,
		PublicationGeneration: testPublicationGeneration,
	})
	after := time.Now().Unix()

	// jose emitted exactly {"alg":"HS256"}: no typ, no kid.
	if !reflect.DeepEqual(header, map[string]any{"alg": "HS256"}) {
		t.Fatalf("header = %v", header)
	}
	if claims["iss"] != testAPIKey || claims["sub"] != "host" {
		t.Fatalf("iss/sub = %v/%v", claims["iss"], claims["sub"])
	}
	notBefore, expires := claims["nbf"].(float64), claims["exp"].(float64)
	if expires-notBefore != 5*60 {
		t.Fatalf("exp - nbf = %v, want 300", expires-notBefore)
	}
	if notBefore < float64(before) || notBefore > float64(after) {
		t.Fatalf("nbf = %v, want it inside [%d,%d]", notBefore, before, after)
	}
	if _, present := claims["iat"]; present {
		t.Fatal("iat must be absent")
	}
	if _, present := claims["identity"]; present {
		t.Fatal("identity must be absent")
	}
	if _, present := claims["roomConfig"]; present {
		t.Fatal("roomConfig must be absent")
	}
	want := map[string]any{
		"roomJoin":             true,
		"room":                 "screener-v1.42." + testShareGeneration + "." + testPublicationGeneration,
		"canPublish":           true,
		"canSubscribe":         false,
		"canPublishData":       false,
		"canUpdateOwnMetadata": false,
		"canPublishSources":    []any{"screen_share", "screen_share_audio"},
	}
	assertVideoGrant(t, claims, want)
}

func TestTokenIssuesSubscribeOnlyViewerToken(t *testing.T) {
	const viewerPeerID = "viewer_root_12345678"
	_, claims := issue(t, testIssuer(t, 3), TokenRequest{
		RoomID:                "7",
		Role:                  "viewer",
		PeerID:                viewerPeerID,
		ShareGeneration:       testShareGeneration,
		PublicationGeneration: testPublicationGeneration,
	})

	if claims["sub"] != "viewer:"+viewerPeerID {
		t.Fatalf("sub = %v", claims["sub"])
	}
	// canPublishSources is dropped entirely for a viewer, and canPublish must
	// be present as false: an absent flag reads as granted to LiveKit.
	assertVideoGrant(t, claims, map[string]any{
		"roomJoin":             true,
		"room":                 "screener-v1.7." + testShareGeneration + "." + testPublicationGeneration,
		"canPublish":           false,
		"canSubscribe":         true,
		"canPublishData":       false,
		"canUpdateOwnMetadata": false,
	})
}

func TestTokenIsolatesPublicationGenerations(t *testing.T) {
	issuer := testIssuer(t, 8)
	request := TokenRequest{
		RoomID:          "7",
		Role:            "host",
		PeerID:          "host_peer_12345678",
		ShareGeneration: testShareGeneration,
	}
	request.PublicationGeneration = "generation_first_12345678"
	_, first := issue(t, issuer, request)
	request.PublicationGeneration = "generation_second_12345678"
	_, second := issue(t, issuer, request)

	firstRoom := first["video"].(map[string]any)["room"]
	secondRoom := second["video"].(map[string]any)["room"]
	if firstRoom == secondRoom {
		t.Fatalf("both generations share the room %v", firstRoom)
	}
}

func TestTokenRejectsInvalidRequestsAndCredentials(t *testing.T) {
	issuer := testIssuer(t, 8)
	base := TokenRequest{
		RoomID:                "42",
		Role:                  "host",
		PeerID:                "host_peer_12345678",
		ShareGeneration:       testShareGeneration,
		PublicationGeneration: testPublicationGeneration,
	}
	for name, mutate := range map[string]func(*TokenRequest){
		"zero room":    func(request *TokenRequest) { request.RoomID = "0" },
		"leading zero": func(request *TokenRequest) { request.RoomID = "042" },
		"thirteen digits": func(request *TokenRequest) {
			request.RoomID = "1234567890123"
		},
		"empty room":   func(request *TokenRequest) { request.RoomID = "" },
		"short peer":   func(request *TokenRequest) { request.PeerID = "short" },
		"dotted share": func(request *TokenRequest) { request.ShareGeneration = "has.dot.12345678" },
		"empty publication": func(request *TokenRequest) {
			request.PublicationGeneration = ""
		},
		"unicode peer": func(request *TokenRequest) { request.PeerID = "peer_é_12345678" },
	} {
		request := base
		mutate(&request)
		if _, err := issuer.IssueToken(request); err == nil {
			t.Fatalf("%s: want a rejection", name)
		}
	}

	for name, options := range map[string]LiveKitTokenIssuerOptions{
		"empty key":    {APIKey: "", APISecret: testAPISecret, MaxViewersPerRoom: 8},
		"short secret": {APIKey: testAPIKey, APISecret: strings.Repeat("s", 31), MaxViewersPerRoom: 8},
		"no viewers":   {APIKey: testAPIKey, APISecret: testAPISecret, MaxViewersPerRoom: 0},
		"too many viewers": {
			APIKey: testAPIKey, APISecret: testAPISecret, MaxViewersPerRoom: 21,
		},
	} {
		if _, err := NewLiveKitTokenIssuer(options); err == nil {
			t.Fatalf("%s: want a rejection", name)
		}
	}
}

// assertVideoGrant compares the whole claim: an extra or missing key is a
// different grant, which is the point of canPublishSources being absent for a
// viewer and canPublish being present as false.
func assertVideoGrant(t *testing.T, claims map[string]any, want map[string]any) {
	t.Helper()
	grant, ok := claims["video"].(map[string]any)
	if !ok {
		t.Fatalf("video = %v", claims["video"])
	}
	if !reflect.DeepEqual(grant, want) {
		t.Fatalf("video = %v, want %v", grant, want)
	}
}
