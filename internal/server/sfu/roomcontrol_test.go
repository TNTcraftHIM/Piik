package sfu

// Ported from tests/sfu-room-control.test.ts. The TypeScript injected a
// FakeRoomService; here the real Twirp client runs against an httptest server
// that reproduces that fake's behaviour, so the wire contract recorded in
// evidence/livekit.md section 3 is covered by the same scenarios.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/TNTcraftHIM/Screener/internal/server/ordered"
)

// fakeLiveKit is tests/sfu-room-control.test.ts's FakeRoomService behind the
// real Twirp endpoints.
type fakeLiveKit struct {
	mu sync.Mutex
	// Ordering site: listRooms answers in insertion order, which initialize
	// turns into its delete order.
	rooms ordered.Map[string, map[string]struct{}]
	// operations records the mutating calls, as the TypeScript fake did;
	// listCalls counts the reads it did not record.
	operations               []string
	listCalls                int
	createOptions            []int
	retainDeletedRoom        bool
	retainRemovedParticipant bool
}

func newFakeLiveKit(t *testing.T) (*fakeLiveKit, string) {
	t.Helper()
	fake := &fakeLiveKit{}
	server := httptest.NewServer(http.HandlerFunc(fake.serve))
	t.Cleanup(server.Close)
	return fake, server.URL
}

func (fake *fakeLiveKit) serve(writer http.ResponseWriter, request *http.Request) {
	var body struct {
		Name            string   `json:"name"`
		Names           []string `json:"names"`
		Room            string   `json:"room"`
		Identity        string   `json:"identity"`
		MaxParticipants int      `json:"maxParticipants"`
	}
	_ = json.NewDecoder(request.Body).Decode(&body)
	method := request.URL.Path[strings.LastIndexByte(request.URL.Path, '/')+1:]

	status, payload := http.StatusOK, "{}"
	switch method {
	case "ListRooms":
		payload = fake.listRooms(body.Names)
	case "CreateRoom":
		status, payload = fake.createRoom(body.Name, body.MaxParticipants)
	case "DeleteRoom":
		status, payload = fake.deleteRoom(body.Room)
	case "ListParticipants":
		status, payload = fake.listParticipants(body.Room)
	case "RemoveParticipant":
		status, payload = fake.removeParticipant(body.Room, body.Identity)
	default:
		status, payload = http.StatusNotFound, `{"code":"bad_route","msg":"unknown method"}`
	}
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_, _ = writer.Write([]byte(payload))
}

const notFoundBody = `{"code":"not_found","msg":"missing"}`

func (fake *fakeLiveKit) listRooms(names []string) string {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.listCalls++
	selected := make([]string, 0, fake.rooms.Len())
	for _, name := range fake.rooms.Keys() {
		if len(names) == 0 || slices.Contains(names, name) {
			selected = append(selected, `{"name":`+quote(name)+`}`)
		}
	}
	return `{"rooms":[` + strings.Join(selected, ",") + `]}`
}

func (fake *fakeLiveKit) createRoom(name string, maxParticipants int) (int, string) {
	fake.mu.Lock()
	fake.operations = append(fake.operations, "create:"+name)
	fake.createOptions = append(fake.createOptions, maxParticipants)
	defer fake.mu.Unlock()
	if fake.rooms.Has(name) {
		return http.StatusConflict, `{"code":"already_exists","msg":"room already exists"}`
	}
	fake.rooms.Set(name, map[string]struct{}{})
	return http.StatusOK, `{"name":` + quote(name) + `}`
}

func (fake *fakeLiveKit) deleteRoom(room string) (int, string) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.operations = append(fake.operations, "delete:"+room)
	if !fake.rooms.Has(room) {
		return http.StatusNotFound, notFoundBody
	}
	if !fake.retainDeletedRoom {
		fake.rooms.Delete(room)
	}
	return http.StatusOK, "{}"
}

func (fake *fakeLiveKit) listParticipants(room string) (int, string) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	participants, ok := fake.rooms.Get(room)
	if !ok {
		return http.StatusNotFound, notFoundBody
	}
	records := make([]string, 0, len(participants))
	for identity := range participants {
		records = append(records, `{"identity":`+quote(identity)+`}`)
	}
	return http.StatusOK, `{"participants":[` + strings.Join(records, ",") + `]}`
}

func (fake *fakeLiveKit) removeParticipant(room string, identity string) (int, string) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.operations = append(fake.operations, "remove:"+room+":"+identity)
	participants, ok := fake.rooms.Get(room)
	if !ok {
		return http.StatusNotFound, notFoundBody
	}
	if _, joined := participants[identity]; !joined {
		return http.StatusNotFound, notFoundBody
	}
	if !fake.retainRemovedParticipant {
		delete(participants, identity)
	}
	return http.StatusOK, "{}"
}

// join is the TypeScript fake's join(): it fails when the room is absent.
func (fake *fakeLiveKit) join(room string, identity string) bool {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	participants, ok := fake.rooms.Get(room)
	if !ok {
		return false
	}
	participants[identity] = struct{}{}
	return true
}

func (fake *fakeLiveKit) seed(room string, identities ...string) {
	participants := make(map[string]struct{}, len(identities))
	for _, identity := range identities {
		participants[identity] = struct{}{}
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.rooms.Set(room, participants)
}

func (fake *fakeLiveKit) snapshot() ([]string, []string) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return fake.rooms.Keys(), append([]string(nil), fake.operations...)
}

func (fake *fakeLiveKit) operationLog() []string {
	_, operations := fake.snapshot()
	return operations
}

func (fake *fakeLiveKit) participants(room string) []string {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	found, ok := fake.rooms.Get(room)
	if !ok {
		return nil
	}
	identities := make([]string, 0, len(found))
	for identity := range found {
		identities = append(identities, identity)
	}
	slices.Sort(identities)
	return identities
}

func quote(value string) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

func testControl(t *testing.T, apiURL string) *LiveKitRoomControl {
	t.Helper()
	control, err := NewLiveKitRoomControl(LiveKitRoomControlOptions{
		APIURL:            apiURL,
		APIKey:            testAPIKey,
		APISecret:         testAPISecret,
		MaxViewersPerRoom: 8,
	})
	if err != nil {
		t.Fatalf("NewLiveKitRoomControl: %v", err)
	}
	return control
}

func testFence() ResourceFence {
	return ResourceFence{
		RoomID:                "42",
		ShareGeneration:       testShareGeneration,
		PublicationGeneration: "publication_generation_12345678",
	}
}

func TestRoomControlDrainsManagedRoomsBeforeStartup(t *testing.T) {
	fake, apiURL := newFakeLiveKit(t)
	current := ManagedRoomName(testFence())
	fake.seed(current, "host")

	if err := testControl(t, apiURL).Initialize(context.Background()); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	rooms, operations := fake.snapshot()
	if len(rooms) != 0 {
		t.Fatalf("rooms = %v, want none", rooms)
	}
	if !slices.Equal(operations, []string{"delete:" + current}) {
		t.Fatalf("operations = %v", operations)
	}
}

func TestRoomControlRejectsForeignInstanceAndUnconfirmedDrain(t *testing.T) {
	foreign, foreignURL := newFakeLiveKit(t)
	foreign.seed("another-application")
	err := testControl(t, foreignURL).Initialize(context.Background())
	if err == nil || !strings.Contains(err.Error(), "foreign room") {
		t.Fatalf("Initialize error = %v, want a foreign room refusal", err)
	}
	if operations := foreign.operationLog(); len(operations) != 0 {
		t.Fatalf("operations = %v, want none", operations)
	}

	retained, retainedURL := newFakeLiveKit(t)
	retained.retainDeletedRoom = true
	retained.seed(ManagedRoomName(testFence()))
	err = testControl(t, retainedURL).Initialize(context.Background())
	if err == nil || !strings.Contains(err.Error(), "not empty after startup drain") {
		t.Fatalf("Initialize error = %v, want an unconfirmed drain", err)
	}
}

// TestRoomControlInitializeAcceptsAnEmptyNamespace pins the confirmation call
// itself: an already empty instance still asks a second time.
func TestRoomControlInitializeAcceptsAnEmptyNamespace(t *testing.T) {
	fake, apiURL := newFakeLiveKit(t)
	if err := testControl(t, apiURL).Initialize(context.Background()); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	if operations := fake.operationLog(); len(operations) != 0 {
		t.Fatalf("operations = %v, want none", operations)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.listCalls != 2 {
		t.Fatalf("listRooms calls = %d, want the drain and its confirmation", fake.listCalls)
	}
}

func TestRoomControlRejectsOffLedgerRoom(t *testing.T) {
	fake, apiURL := newFakeLiveKit(t)
	fence := testFence()
	fake.seed(ManagedRoomName(fence), "host")

	err := testControl(t, apiURL).CreateRoom(context.Background(), fence)
	if err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("CreateRoom error = %v, want an existing-room refusal", err)
	}
	if operations := fake.operationLog(); len(operations) != 0 {
		t.Fatalf("operations = %v, want none", operations)
	}
}

func TestRoomControlChecksExactHostParticipant(t *testing.T) {
	fake, apiURL := newFakeLiveKit(t)
	control := testControl(t, apiURL)
	fence := testFence()
	ctx := context.Background()
	if err := control.CreateRoom(ctx, fence); err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	roomName := ManagedRoomName(fence)

	if !fake.join(roomName, "viewer:one") {
		t.Fatal("the viewer must join")
	}
	expectHost(t, control, fence, false)
	if !fake.join(roomName, "host") {
		t.Fatal("the host must join")
	}
	expectHost(t, control, fence, true)
	if err := control.DeleteRoom(ctx, fence); err != nil {
		t.Fatalf("DeleteRoom: %v", err)
	}
	// An absent room reads as an offline host, not as an error.
	expectHost(t, control, fence, false)
}

func TestRoomControlRemovesOnlyTheExactViewer(t *testing.T) {
	fake, apiURL := newFakeLiveKit(t)
	control := testControl(t, apiURL)
	fence := testFence()
	ctx := context.Background()
	if err := control.CreateRoom(ctx, fence); err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	roomName := ManagedRoomName(fence)
	const viewerPeerID = "viewer_peer_12345678"
	for _, identity := range []string{"host", "viewer:" + viewerPeerID, "viewer:other_peer_12345678"} {
		if !fake.join(roomName, identity) {
			t.Fatalf("%s must join", identity)
		}
	}

	subscription := SubscriptionFence{ResourceFence: fence, ViewerPeerID: viewerPeerID}
	if err := control.DrainSubscription(ctx, subscription); err != nil {
		t.Fatalf("DrainSubscription: %v", err)
	}
	if participants := fake.participants(roomName); !slices.Equal(participants,
		[]string{"host", "viewer:other_peer_12345678"}) {
		t.Fatalf("participants = %v", participants)
	}
	// The repeat drain is a not-found removal, which is tolerated.
	if err := control.DrainSubscription(ctx, subscription); err != nil {
		t.Fatalf("repeat DrainSubscription: %v", err)
	}
}

func TestRoomControlRejectsUnconfirmedViewerDrain(t *testing.T) {
	fake, apiURL := newFakeLiveKit(t)
	control := testControl(t, apiURL)
	fence := testFence()
	ctx := context.Background()
	if err := control.CreateRoom(ctx, fence); err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	const viewerPeerID = "viewer_peer_12345678"
	fake.join(ManagedRoomName(fence), "viewer:"+viewerPeerID)
	fake.mu.Lock()
	fake.retainRemovedParticipant = true
	fake.mu.Unlock()

	err := control.DrainSubscription(ctx,
		SubscriptionFence{ResourceFence: fence, ViewerPeerID: viewerPeerID})
	if err == nil || !strings.Contains(err.Error(), "removal was not confirmed") {
		t.Fatalf("DrainSubscription error = %v, want an unconfirmed removal", err)
	}
}

func TestRoomControlRejectsInvalidConfiguration(t *testing.T) {
	for name, options := range map[string]LiveKitRoomControlOptions{
		"no url":       {APIURL: "", APIKey: testAPIKey, APISecret: testAPISecret, MaxViewersPerRoom: 8},
		"no key":       {APIURL: "http://127.0.0.1:7880", APIKey: "", APISecret: testAPISecret, MaxViewersPerRoom: 8},
		"short secret": {APIURL: "http://127.0.0.1:7880", APIKey: testAPIKey, APISecret: strings.Repeat("s", 31), MaxViewersPerRoom: 8},
		"no viewers":   {APIURL: "http://127.0.0.1:7880", APIKey: testAPIKey, APISecret: testAPISecret, MaxViewersPerRoom: 0},
		"too many viewers": {
			APIURL: "http://127.0.0.1:7880", APIKey: testAPIKey,
			APISecret: testAPISecret, MaxViewersPerRoom: 21,
		},
	} {
		if _, err := NewLiveKitRoomControl(options); err == nil {
			t.Fatalf("%s: want a rejection", name)
		}
	}

	// An invalid fence is refused without touching the service.
	fake, apiURL := newFakeLiveKit(t)
	control := testControl(t, apiURL)
	broken := ResourceFence{RoomID: "0", ShareGeneration: testShareGeneration,
		PublicationGeneration: "publication_generation_12345678"}
	if err := control.CreateRoom(context.Background(), broken); err == nil {
		t.Fatal("an invalid fence must be refused")
	}
	if err := control.DrainSubscription(context.Background(), SubscriptionFence{
		ResourceFence: testFence(), ViewerPeerID: "short",
	}); err == nil {
		t.Fatal("an invalid viewer identity must be refused")
	}
	if operations := fake.operationLog(); len(operations) != 0 {
		t.Fatalf("operations = %v, want none", operations)
	}
}

// TestRoomControlPropagatesContextCancellation covers the ctx plumbing that
// carries the 5 second per-request timeout.
func TestRoomControlPropagatesContextCancellation(t *testing.T) {
	_, apiURL := newFakeLiveKit(t)
	control := testControl(t, apiURL)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := control.CreateRoom(ctx, testFence()); err == nil {
		t.Fatal("a cancelled context must abort the call")
	}
}

// TestRoomControlAutoCreateStaysDisabled keeps the deployment contract the
// TypeScript suite asserted next to these scenarios.
func TestRoomControlAutoCreateStaysDisabled(t *testing.T) {
	configuration, err := os.ReadFile("../../../deploy/livekit/livekit.yaml.example")
	if err != nil {
		t.Fatalf("read livekit.yaml.example: %v", err)
	}
	if !regexp.MustCompile(`(?s)room:\s+.*auto_create: false`).Match(configuration) {
		t.Fatal("the tracked LiveKit deployment must keep auto_create disabled")
	}
}

func expectHost(t *testing.T, control *LiveKitRoomControl, fence ResourceFence, want bool) {
	t.Helper()
	exists, err := control.HostParticipantExists(context.Background(), fence)
	if err != nil {
		t.Fatalf("HostParticipantExists: %v", err)
	}
	if exists != want {
		t.Fatalf("HostParticipantExists = %v, want %v", exists, want)
	}
}
