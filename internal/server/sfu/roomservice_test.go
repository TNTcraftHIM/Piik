package sfu

// The Twirp wire contract recorded in evidence/livekit.md section 3: request
// path, method, headers, body and per-call service-token grant for each of the
// five RPCs, plus the exact not-found rule.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

type capturedCall struct {
	path        string
	method      string
	contentType string
	authorized  string
	body        map[string]any
}

func captureLiveKit(
	t *testing.T,
	reply func(method string) (int, string, string),
) (*[]capturedCall, string) {
	t.Helper()
	var calls []capturedCall
	server := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, request *http.Request) {
			var body map[string]any
			_ = json.NewDecoder(request.Body).Decode(&body)
			if body == nil {
				body = map[string]any{}
			}
			calls = append(calls, capturedCall{
				path:        request.URL.Path,
				method:      request.Method,
				contentType: request.Header.Get("Content-Type"),
				authorized:  request.Header.Get("Authorization"),
				body:        body,
			})
			name := request.URL.Path[strings.LastIndexByte(request.URL.Path, '/')+1:]
			status, contentType, payload := reply(name)
			writer.Header().Set("Content-Type", contentType)
			writer.WriteHeader(status)
			_, _ = writer.Write([]byte(payload))
		}))
	t.Cleanup(server.Close)
	return &calls, server.URL
}

func TestRoomServiceRequestShape(t *testing.T) {
	const room = "screener-v1.42.a_1234567.b_1234567"
	calls, apiURL := captureLiveKit(t, func(method string) (int, string, string) {
		switch method {
		case "ListRooms":
			return 200, "application/json", `{"rooms":[{"sid":"RM_x","name":"` + room + `","empty_timeout":0}]}`
		case "ListParticipants":
			return 200, "application/json", `{"participants":[{"sid":"PA_x","identity":"host","state":"ACTIVE"}]}`
		default:
			return 200, "application/json", `{}`
		}
	})
	// The ws->http rewrite of TwirpRpc, exercised on the way in.
	service := newRoomService(strings.Replace(apiURL, "http", "ws", 1),
		newSigner(testAPIKey, testAPISecret))
	ctx := context.Background()

	if _, err := service.listRooms(ctx, nil); err != nil {
		t.Fatalf("listRooms: %v", err)
	}
	if _, err := service.listRooms(ctx, []string{room}); err != nil {
		t.Fatalf("filtered listRooms: %v", err)
	}
	if err := service.createRoom(ctx, room, 9); err != nil {
		t.Fatalf("createRoom: %v", err)
	}
	if err := service.deleteRoom(ctx, room); err != nil {
		t.Fatalf("deleteRoom: %v", err)
	}
	participants, err := service.listParticipants(ctx, room)
	if err != nil {
		t.Fatalf("listParticipants: %v", err)
	}
	if len(participants) != 1 || participants[0].Identity != "host" {
		t.Fatalf("participants = %v", participants)
	}
	if err := service.removeParticipant(ctx, room, "viewer:viewer_peer_12345678"); err != nil {
		t.Fatalf("removeParticipant: %v", err)
	}

	wanted := []struct {
		path  string
		body  map[string]any
		grant map[string]any
	}{
		{"ListRooms", map[string]any{}, map[string]any{"roomList": true}},
		{"ListRooms", map[string]any{"names": []any{room}}, map[string]any{"roomList": true}},
		{"CreateRoom", map[string]any{"name": room, "maxParticipants": float64(9)},
			map[string]any{"roomCreate": true}},
		{"DeleteRoom", map[string]any{"room": room}, map[string]any{"roomCreate": true}},
		{"ListParticipants", map[string]any{"room": room},
			map[string]any{"roomAdmin": true, "room": room}},
		{"RemoveParticipant", map[string]any{"room": room, "identity": "viewer:viewer_peer_12345678"},
			map[string]any{"roomAdmin": true, "room": room}},
	}
	if len(*calls) != len(wanted) {
		t.Fatalf("calls = %d, want %d", len(*calls), len(wanted))
	}
	for index, call := range *calls {
		want := wanted[index]
		if call.path != "/twirp/livekit.RoomService/"+want.path {
			t.Fatalf("call %d path = %s", index, call.path)
		}
		if call.method != http.MethodPost {
			t.Fatalf("call %d method = %s", index, call.method)
		}
		if call.contentType != "application/json;charset=UTF-8" {
			t.Fatalf("call %d content-type = %q", index, call.contentType)
		}
		if !strings.HasPrefix(call.authorized, "Bearer ") {
			t.Fatalf("call %d authorization = %q", index, call.authorized)
		}
		if !reflect.DeepEqual(call.body, want.body) {
			t.Fatalf("call %d body = %v, want %v", index, call.body, want.body)
		}

		claims := decodeSegment(t,
			strings.Split(strings.TrimPrefix(call.authorized, "Bearer "), ".")[1])
		if _, present := claims["sub"]; present {
			t.Fatalf("call %d service token must carry no sub", index)
		}
		if claims["iss"] != testAPIKey {
			t.Fatalf("call %d iss = %v", index, claims["iss"])
		}
		if lifetime := claims["exp"].(float64) - claims["nbf"].(float64); lifetime != 600 {
			t.Fatalf("call %d service token exp - nbf = %v, want 600", index, lifetime)
		}
		grant, _ := claims["video"].(map[string]any)
		if !reflect.DeepEqual(grant, want.grant) {
			t.Fatalf("call %d grant = %v, want %v", index, grant, want.grant)
		}
	}
}

// TestRoomServiceNotFoundRule pins isNotFound: HTTP 404 or code "not_found",
// nothing else. Both arms of the TypeScript `||` are reachable.
func TestRoomServiceNotFoundRule(t *testing.T) {
	for name, testCase := range map[string]struct {
		status      int
		contentType string
		payload     string
		notFound    bool
	}{
		"twirp not found":  {404, "application/json", `{"code":"not_found","msg":"missing"}`, true},
		"status only":      {404, "text/plain", "Not Found", true},
		"code only":        {500, "application/json", `{"code":"not_found","msg":"missing"}`, true},
		"already exists":   {409, "application/json", `{"code":"already_exists","msg":"duplicate"}`, false},
		"internal":         {500, "application/json", `{"code":"internal","msg":"boom"}`, false},
		"unauthenticated":  {401, "application/json", `{"Error":"invalid API key"}`, false},
		"plain text error": {503, "text/plain", "unavailable", false},
	} {
		_, apiURL := captureLiveKit(t, func(string) (int, string, string) {
			return testCase.status, testCase.contentType, testCase.payload
		})
		service := newRoomService(apiURL, newSigner(testAPIKey, testAPISecret))
		err := service.deleteRoom(context.Background(), "screener-v1.42.a_1234567.b_1234567")
		if err == nil {
			t.Fatalf("%s: want an error", name)
		}
		if isNotFound(err) != testCase.notFound {
			t.Fatalf("%s: isNotFound = %v, want %v (%v)", name, !testCase.notFound, testCase.notFound, err)
		}
	}
}
