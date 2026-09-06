package sfu

// Twirp/JSON client for livekit.RoomService, covering exactly the five RPCs
// src/server/sfu-room-control.ts used through RoomServiceClient. The wire
// contract is evidence/livekit.md section 3.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	// requestTimeout is RoomServiceClient's `requestTimeout: 5`, applied per
	// HTTP request. There is no retry and no failover.
	requestTimeout  = 5 * time.Second
	twirpPathPrefix = "/twirp/livekit.RoomService/"
	// maxResponseBytes bounds a hostile or broken RoomService reply; the four
	// decoded shapes are tiny.
	maxResponseBytes = 1 << 20
)

// twirpError is the Twirp JSON error body {"code":..,"msg":..} plus the HTTP
// status. It is unexported on purpose: the only question the server ever asks
// is isNotFound, and the body must never be logged.
type twirpError struct {
	status  int
	code    string
	message string
}

func (failure *twirpError) Error() string {
	return fmt.Sprintf("livekit %s: %s (HTTP %d)",
		failure.code, failure.message, failure.status)
}

// isNotFound ports isNotFound(): HTTP 404 or the twirp code "not_found", and
// nothing else, so a 409 already_exists still propagates.
func isNotFound(err error) bool {
	var failure *twirpError
	return errors.As(err, &failure) &&
		(failure.status == http.StatusNotFound || failure.code == "not_found")
}

type roomRecord struct {
	Name string `json:"name"`
}

type participantRecord struct {
	Identity string `json:"identity"`
}

// roomService is the LiveKitRoomService interface of the TypeScript, bound to
// the real RoomService rather than to an injected double.
type roomService struct {
	baseURL string
	signer  signer
}

// newRoomService applies TwirpRpc's ws->http host rewrite and drops a trailing
// slash so the path prefix below is exact.
func newRoomService(apiURL string, credentials signer) roomService {
	if strings.HasPrefix(apiURL, "ws") {
		apiURL = "http" + strings.TrimPrefix(apiURL, "ws")
	}
	return roomService{baseURL: strings.TrimSuffix(apiURL, "/"), signer: credentials}
}

func (service roomService) call(
	ctx context.Context,
	method string,
	grant videoGrant,
	request any,
	response any,
) error {
	body, err := json.Marshal(request)
	if err != nil {
		return err
	}
	token, err := service.signer.serviceToken(grant)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost,
		service.baseURL+twirpPathPrefix+method, bytes.NewReader(body))
	if err != nil {
		return err
	}
	httpRequest.Header.Set("Content-Type", "application/json;charset=UTF-8")
	httpRequest.Header.Set("Authorization", "Bearer "+token)
	httpResponse, err := http.DefaultClient.Do(httpRequest)
	if err != nil {
		return err
	}
	defer httpResponse.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(httpResponse.Body, maxResponseBytes))
	if err != nil {
		return err
	}
	if httpResponse.StatusCode < 200 || httpResponse.StatusCode >= 300 {
		return newTwirpError(httpResponse, payload)
	}
	if response == nil {
		return nil
	}
	return json.Unmarshal(payload, response)
}

// newTwirpError decodes {"code","msg"} when the reply claims JSON. LiveKit's
// own 401 is plain text or {"Error":...}, which keeps code empty and so is not
// a not-found, exactly as the TypeScript SDK behaved.
func newTwirpError(response *http.Response, payload []byte) *twirpError {
	failure := &twirpError{status: response.StatusCode, message: "Unknown internal error"}
	if strings.HasPrefix(response.Header.Get("Content-Type"), "application/json") {
		var body struct {
			Code string `json:"code"`
			Msg  string `json:"msg"`
		}
		if json.Unmarshal(payload, &body) == nil && body.Code != "" {
			failure.code = body.Code
			failure.message = body.Msg
		}
	}
	return failure
}

func (service roomService) listRooms(ctx context.Context, names []string) ([]roomRecord, error) {
	// protobuf-es omits an empty repeated field, so an unfiltered list sends {}.
	request := struct {
		Names []string `json:"names,omitempty"`
	}{Names: names}
	var response struct {
		Rooms []roomRecord `json:"rooms"`
	}
	if err := service.call(ctx, "ListRooms",
		videoGrant{RoomList: true}, request, &response); err != nil {
		return nil, err
	}
	return response.Rooms, nil
}

func (service roomService) createRoom(ctx context.Context, room string, maxParticipants int) error {
	request := struct {
		Name            string `json:"name"`
		MaxParticipants int    `json:"maxParticipants"`
	}{Name: room, MaxParticipants: maxParticipants}
	// The TypeScript discarded the returned Room record.
	return service.call(ctx, "CreateRoom", videoGrant{RoomCreate: true}, request, nil)
}

func (service roomService) deleteRoom(ctx context.Context, room string) error {
	request := struct {
		Room string `json:"room"`
	}{Room: room}
	return service.call(ctx, "DeleteRoom", videoGrant{RoomCreate: true}, request, nil)
}

func (service roomService) listParticipants(ctx context.Context, room string) ([]participantRecord, error) {
	request := struct {
		Room string `json:"room"`
	}{Room: room}
	var response struct {
		Participants []participantRecord `json:"participants"`
	}
	if err := service.call(ctx, "ListParticipants",
		videoGrant{RoomAdmin: true, Room: room}, request, &response); err != nil {
		return nil, err
	}
	return response.Participants, nil
}

func (service roomService) removeParticipant(ctx context.Context, room string, identity string) error {
	// revokeTokenTs stays absent, as the TypeScript passed undefined.
	request := struct {
		Room     string `json:"room"`
		Identity string `json:"identity"`
	}{Room: room, Identity: identity}
	return service.call(ctx, "RemoveParticipant",
		videoGrant{RoomAdmin: true, Room: room}, request, nil)
}
