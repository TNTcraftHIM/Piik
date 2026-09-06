package room

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TNTcraftHIM/Screener/internal/server/protocol"
)

// The scenarios below are ported from tests/room-database.test.ts.

func databasePath(t *testing.T) string {
	t.Helper()
	// t.TempDir registers its removal before any store cleanup below, so the
	// database is always closed first; Windows will not remove an open file.
	return filepath.Join(t.TempDir(), "rooms.sqlite")
}

func stableStore(t *testing.T, path string, testClock *clock, options Options) *Store {
	t.Helper()
	database, err := NewDatabase(path)
	if err != nil {
		t.Fatalf("NewDatabase: %v", err)
	}
	if options.LeaseMs == 0 {
		options.LeaseMs = 1_000
	}
	if options.MaxRooms == 0 {
		options.MaxRooms = 8
	}
	options.MaxViewersPerRoom = 8
	options.Database = database
	options.Now = func() int64 { return testClock.nowMs }
	store, err := New(options)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.Initialize(); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	return store
}

func rawDatabase(t *testing.T, path string) *sql.DB {
	t.Helper()
	database, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path))
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return database
}

func rawExec(t *testing.T, path, statement string) {
	t.Helper()
	if _, err := rawDatabase(t, path).Exec(statement); err != nil {
		t.Fatalf("raw exec %q: %v", statement, err)
	}
}

func dbViewerInput(roomID, sessionID, viewerGrant string) ConnectParticipantInput {
	input := viewerInput(roomID, sessionID, viewerGrant)
	input.ClientID = "client-" + sessionID
	return input
}

func TestDoesNotPersistARoomWhenPasswordDerivationIsBusy(t *testing.T) {
	path := databasePath(t)
	testClock := &clock{nowMs: 1_000}
	first := stableStore(t, path, testClock, Options{MaxRooms: 1})

	withSaturatedGate(t, first, func() {
		_, err := tryCreateRoom(first, protocol.CodeEntryPrivate, "room-password", "4321")
		expectCode(t, err, CodeRoomBusy)
	})
	if first.Size() != 0 {
		t.Fatalf("size = %d, want 0", first.Size())
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	second := stableStore(t, path, testClock, Options{MaxRooms: 1})
	if second.Size() != 0 {
		t.Fatalf("restored size = %d, want 0", second.Size())
	}
	if created := createRoom(t, second, protocol.CodeEntryPrivate, "", "4321"); created.RoomID != "4321" {
		t.Fatalf("room = %q, want 4321", created.RoomID)
	}
}

func TestRestoresTheExactAuthorityAggregateWithoutParticipants(t *testing.T) {
	path := databasePath(t)
	testClock := &clock{nowMs: 1_000}
	first := stableStore(t, path, testClock, Options{})
	room := createRoom(t, first, protocol.CodeEntryOpen, "", "4321")
	if _, err := first.SetCodeEntryPolicy(
		room.RoomID, protocol.CodeEntryPrivate, room.HostToken); err != nil {
		t.Fatalf("SetCodeEntryPolicy: %v", err)
	}
	if _, err := trySetViewerPassword(
		first, room.RoomID, "room-password", room.HostToken); err != nil {
		t.Fatalf("SetViewerPassword: %v", err)
	}
	rotated, err := first.SetViewerGrant(room.RoomID, "rotate", room.HostToken)
	if err != nil {
		t.Fatalf("SetViewerGrant: %v", err)
	}
	host := mustConnect(t, first, hostInput(room.RoomID, room.HostToken))
	oldViewer := mustConnect(t, first, dbViewerInput(room.RoomID, "old-viewer", rotated.ViewerGrant))
	if connected, ok := first.GetConnectedHost(room.RoomID); !ok || connected.PeerID != host.PeerID {
		t.Fatalf("host = %+v %v", connected, ok)
	}
	if _, ok := first.GetConnectedViewer(room.RoomID, oldViewer.PeerID); !ok {
		t.Fatal("viewer is not connected")
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	testClock.nowMs = 2_000
	second := stableStore(t, path, testClock, Options{})
	if second.Size() != 1 {
		t.Fatalf("restored size = %d, want 1", second.Size())
	}
	if _, ok := second.GetConnectedHost(room.RoomID); ok {
		t.Fatal("a restored room reported a connected host")
	}
	if viewers := second.GetConnectedViewers(room.RoomID); len(viewers) != 0 {
		t.Fatalf("restored viewers = %+v", viewers)
	}
	_, err = second.ConnectParticipant(dbViewerInput(room.RoomID, "revoked-grant", room.ViewerGrant))
	expectCode(t, err, CodeInvalidToken)

	granted := mustConnect(t, second, dbViewerInput(room.RoomID, "current-grant", rotated.ViewerGrant))
	if granted.ExpiresAt == nil || *granted.ExpiresAt != "1970-01-01T00:00:03.000Z" {
		t.Fatalf("expiresAt = %v", granted.ExpiresAt)
	}
	if granted.ViewerAuthorizationGeneration != rotated.ViewerAuthorizationGeneration {
		t.Fatalf("generation = %q, want %q",
			granted.ViewerAuthorizationGeneration, rotated.ViewerAuthorizationGeneration)
	}
	connected, err := tryConnectViewerWithPassword(second, ConnectViewerWithPasswordInput{
		RoomID:    room.RoomID,
		Password:  "room-password",
		ClientID:  "password-client",
		SessionID: "password-session",
	}, nil)
	if err != nil || connected.CodeEntryPolicy != protocol.CodeEntryPrivate {
		t.Fatalf("password login = %+v, %v", connected, err)
	}
	_, err = second.ConnectParticipant(hostInput(room.RoomID, "wrong-token"))
	expectCode(t, err, CodeInvalidToken)
	resumed := mustConnect(t, second, hostInput(room.RoomID, room.HostToken, "recovered-host"))
	if resumed.ExpiresAt != nil {
		t.Fatalf("resumed expiresAt = %v, want null", *resumed.ExpiresAt)
	}
	if err := second.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	raw := rawDatabase(t, path)
	rows, err := raw.Query("SELECT * FROM rooms")
	if err != nil {
		t.Fatalf("raw query: %v", err)
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		t.Fatalf("Columns: %v", err)
	}
	want := []string{
		"room_id", "host_token_digest", "viewer_grant_digest",
		"viewer_authorization_generation", "code_entry_policy",
		"viewer_password_material", "lease_expires_at_ms",
	}
	if strings.Join(columns, ",") != strings.Join(want, ",") {
		t.Fatalf("columns = %v", columns)
	}
	if !rows.Next() {
		t.Fatal("no stored room")
	}
	var (
		roomID           string
		hostDigest       []byte
		grantDigest      []byte
		generation       string
		policy           string
		material         []byte
		leaseExpiresAtMs sql.NullInt64
	)
	if err := rows.Scan(&roomID, &hostDigest, &grantDigest, &generation, &policy,
		&material, &leaseExpiresAtMs); err != nil {
		t.Fatalf("Scan: %v", err)
	}
	hostTokenDigest := sha256.Sum256([]byte(room.HostToken))
	if !bytes.Equal(hostDigest, hostTokenDigest[:]) {
		t.Fatal("stored Host token digest does not match")
	}
	grantTokenDigest := sha256.Sum256([]byte(rotated.ViewerGrant))
	if !bytes.Equal(grantDigest, grantTokenDigest[:]) {
		t.Fatal("stored Viewer grant digest does not match")
	}
	if len(material) != 48 {
		t.Fatalf("password material = %d bytes, want 48", len(material))
	}
	// Nothing reversible is stored: no token, grant or password appears.
	stored := roomID + generation + policy + string(hostDigest) + string(grantDigest) + string(material)
	for _, secret := range []string{room.HostToken, rotated.ViewerGrant, "room-password"} {
		if strings.Contains(stored, secret) {
			t.Fatal("a credential was stored verbatim")
		}
	}
}

func TestConvertsAnActiveMarkerOnceAndPreservesDormantDeadlines(t *testing.T) {
	path := databasePath(t)
	testClock := &clock{nowMs: 100}
	first := stableStore(t, path, testClock, Options{})
	room := createRoom(t, first, protocol.CodeEntryOpen, "", "5678")
	mustConnect(t, first, hostInput(room.RoomID, room.HostToken))
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	testClock.nowMs = 500
	second := stableStore(t, path, testClock, Options{})
	firstRestart := mustConnect(t, second, dbViewerInput(room.RoomID, "first-restart", room.ViewerGrant))
	if firstRestart.ExpiresAt == nil || *firstRestart.ExpiresAt != "1970-01-01T00:00:01.500Z" {
		t.Fatalf("expiresAt = %v", firstRestart.ExpiresAt)
	}
	if err := second.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	testClock.nowMs = 700
	third := stableStore(t, path, testClock, Options{})
	secondRestart := mustConnect(t, third, dbViewerInput(room.RoomID, "second-restart", room.ViewerGrant))
	if secondRestart.ExpiresAt == nil || *secondRestart.ExpiresAt != "1970-01-01T00:00:01.500Z" {
		t.Fatalf("expiresAt = %v", secondRestart.ExpiresAt)
	}
	if err := third.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	testClock.nowMs = 1_501
	fourth := stableStore(t, path, testClock, Options{})
	if fourth.Size() != 0 {
		t.Fatalf("size = %d, want 0", fourth.Size())
	}
	replacement := createRoom(t, fourth, protocol.CodeEntryOpen, "", room.RoomID)
	if replacement.RoomID != room.RoomID {
		t.Fatalf("replacement room = %q", replacement.RoomID)
	}
	_, err := fourth.ConnectParticipant(hostInput(room.RoomID, room.HostToken))
	expectCode(t, err, CodeInvalidToken)
	_, err = fourth.ConnectParticipant(dbViewerInput(room.RoomID, "stale-grant", room.ViewerGrant))
	expectCode(t, err, CodeInvalidToken)
}

func TestPreservesTheExactHostDisconnectDeadline(t *testing.T) {
	path := databasePath(t)
	testClock := &clock{nowMs: 100}
	first := stableStore(t, path, testClock, Options{})
	room := createRoom(t, first, protocol.CodeEntryOpen, "", "5890")
	host := mustConnect(t, first, hostInput(room.RoomID, room.HostToken))
	testClock.nowMs = 250
	if _, err := first.DisconnectParticipant(room.RoomID, host.PeerID, "host-session"); err != nil {
		t.Fatalf("DisconnectParticipant: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	testClock.nowMs = 500
	second := stableStore(t, path, testClock, Options{})
	dormant := mustConnect(t, second, dbViewerInput(room.RoomID, "dormant-viewer", room.ViewerGrant))
	if dormant.ExpiresAt == nil || *dormant.ExpiresAt != "1970-01-01T00:00:01.250Z" {
		t.Fatalf("expiresAt = %v", dormant.ExpiresAt)
	}
}

func TestPersistsExplicitRoomDeletionBeforeRecyclingItsCode(t *testing.T) {
	path := databasePath(t)
	testClock := &clock{nowMs: 10}
	first := stableStore(t, path, testClock, Options{})
	room := createRoom(t, first, protocol.CodeEntryOpen, "", "6789")
	closed, err := first.AbandonRoom(room.RoomID)
	if err != nil || closed == nil || closed.RoomID != room.RoomID {
		t.Fatalf("AbandonRoom = %v, %v", closed, err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	second := stableStore(t, path, testClock, Options{})
	if second.Size() != 0 {
		t.Fatalf("size = %d, want 0", second.Size())
	}
	replacement := createRoom(t, second, protocol.CodeEntryOpen, "", room.RoomID)
	if replacement.RoomID != room.RoomID {
		t.Fatalf("replacement room = %q", replacement.RoomID)
	}
	if replacement.HostToken == room.HostToken || replacement.ViewerGrant == room.ViewerGrant {
		t.Fatal("the recycled code kept the old credentials")
	}
}

func TestRollsBackABatchExpiryWhenAnyAuthorityIsStale(t *testing.T) {
	path := databasePath(t)
	testClock := &clock{nowMs: 10}
	first := stableStore(t, path, testClock, Options{})
	createRoom(t, first, protocol.CodeEntryOpen, "", "4321")
	createRoom(t, first, protocol.CodeEntryOpen, "", "5678")
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	database, err := NewDatabase(path)
	if err != nil {
		t.Fatalf("NewDatabase: %v", err)
	}
	restored, err := database.Initialize(testClock.nowMs, 1_010)
	if err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	if len(restored) != 2 {
		t.Fatalf("restored %d rooms, want 2", len(restored))
	}
	err = database.DeleteRooms([]RoomIdentity{
		{RoomID: restored[0].RoomID, HostTokenDigest: restored[0].HostTokenDigest},
		{RoomID: restored[1].RoomID, HostTokenDigest: make([]byte, 32)},
	})
	if err == nil || err.Error() != "Room database delete did not match current authority" {
		t.Fatalf("DeleteRooms: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	second := stableStore(t, path, testClock, Options{})
	if second.Size() != 2 {
		t.Fatalf("size = %d, want 2", second.Size())
	}
}

func TestPersistsRoomReplacementAsOneAuthorityTransition(t *testing.T) {
	path := databasePath(t)
	testClock := &clock{nowMs: 10}
	first := stableStore(t, path, testClock, Options{})
	original := createRoom(t, first, protocol.CodeEntryOpen, "", "4321")
	replacement, err := tryReplaceRoom(
		first, original.RoomID, original.HostToken, protocol.CodeEntryPrivate, "new-password")
	if err != nil {
		t.Fatalf("ReplaceRoom: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	second := stableStore(t, path, testClock, Options{})
	if second.Size() != 1 {
		t.Fatalf("size = %d, want 1", second.Size())
	}
	_, err = second.ConnectParticipant(hostInput(original.RoomID, original.HostToken))
	expectCode(t, err, CodeInvalidToken)
	connected := mustConnect(t, second, dbViewerInput(
		replacement.Created.RoomID, "replacement-viewer", replacement.Created.ViewerGrant))
	if connected.RoomID != replacement.Created.RoomID {
		t.Fatalf("viewer joined %q", connected.RoomID)
	}
	withPassword, err := tryConnectViewerWithPassword(second, ConnectViewerWithPasswordInput{
		RoomID:    replacement.Created.RoomID,
		Password:  "new-password",
		ClientID:  "password-viewer",
		SessionID: "password-session",
	}, nil)
	if err != nil || withPassword.RoomID != replacement.Created.RoomID {
		t.Fatalf("password login = %+v, %v", withPassword, err)
	}
}

// TestOpensThePathWithURIReservedCharactersLiterally: `new DatabaseSync(path)`
// opened the literal path, while the driver's DSN is a URI in which `%41`
// decodes to `A` and `#` ends the file name; the file must still be the
// configured one, and the busy-timeout pragma must survive the escaping.
func TestOpensThePathWithURIReservedCharactersLiterally(t *testing.T) {
	testClock := &clock{nowMs: 10}
	path := filepath.Join(t.TempDir(), "rooms%41#1.sqlite")
	first := stableStore(t, path, testClock, Options{})
	createRoom(t, first, protocol.CodeEntryOpen, "", "4321")
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("the configured file was not the one opened: %v", err)
	}
	if second := stableStore(t, path, testClock, Options{}); second.Size() != 1 {
		t.Fatalf("restored size = %d, want 1", second.Size())
	}
}

func TestRejectsAnotherOwnerOfTheSameDatabase(t *testing.T) {
	path := databasePath(t)
	first, err := NewDatabase(path)
	if err != nil {
		t.Fatalf("NewDatabase: %v", err)
	}
	if _, err := first.Initialize(0, 1_000); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	contender, err := NewDatabase(path)
	if err != nil {
		t.Fatalf("NewDatabase: %v", err)
	}
	_, err = contender.Initialize(0, 1_000)
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "locked") {
		t.Fatalf("contender Initialize = %v, want a lock failure", err)
	}
	if err := contender.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	successor, err := NewDatabase(path)
	if err != nil {
		t.Fatalf("NewDatabase: %v", err)
	}
	restored, err := successor.Initialize(0, 1_000)
	if err != nil || len(restored) != 0 {
		t.Fatalf("successor Initialize = %v, %v", restored, err)
	}
	if err := successor.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func TestRejectsAnUnknownDatabaseIdentity(t *testing.T) {
	for _, testCase := range []struct{ name, mutation string }{
		{"application identity", "PRAGMA application_id = 1"},
		{"schema version", "PRAGMA user_version = 2"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			path := databasePath(t)
			initial, err := NewDatabase(path)
			if err != nil {
				t.Fatalf("NewDatabase: %v", err)
			}
			if _, err := initial.Initialize(0, 1_000); err != nil {
				t.Fatalf("Initialize: %v", err)
			}
			if err := initial.Close(); err != nil {
				t.Fatalf("Close: %v", err)
			}
			rawExec(t, path, testCase.mutation)

			reopened, err := NewDatabase(path)
			if err != nil {
				t.Fatalf("NewDatabase: %v", err)
			}
			_, err = reopened.Initialize(0, 1_000)
			if err == nil || !strings.Contains(err.Error(), "does not match") {
				t.Fatalf("Initialize = %v", err)
			}
			if err := reopened.Close(); err != nil {
				t.Fatalf("Close: %v", err)
			}
		})
	}
}

func TestRejectsAnAlteredCurrentVersionSchema(t *testing.T) {
	path := databasePath(t)
	initial, err := NewDatabase(path)
	if err != nil {
		t.Fatalf("NewDatabase: %v", err)
	}
	if _, err := initial.Initialize(0, 1_000); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	if err := initial.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	rawExec(t, path, "ALTER TABLE rooms ADD COLUMN unexpected TEXT")

	reopened, err := NewDatabase(path)
	if err != nil {
		t.Fatalf("NewDatabase: %v", err)
	}
	_, err = reopened.Initialize(0, 1_000)
	if err == nil || err.Error() != "Room database columns do not match the current schema" {
		t.Fatalf("Initialize = %v", err)
	}
	if err := reopened.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func TestRejectsCorruptAuthorityRows(t *testing.T) {
	path := databasePath(t)
	testClock := &clock{nowMs: 100}
	initial := stableStore(t, path, testClock, Options{})
	createRoom(t, initial, protocol.CodeEntryOpen, "", "7890")
	if err := initial.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	raw := rawDatabase(t, path)
	if _, err := raw.Exec("PRAGMA ignore_check_constraints = ON"); err != nil {
		t.Fatalf("raw pragma: %v", err)
	}
	if _, err := raw.Exec("UPDATE rooms SET host_token_digest = zeroblob(31)"); err != nil {
		t.Fatalf("raw update: %v", err)
	}
	if err := raw.Close(); err != nil {
		t.Fatalf("raw close: %v", err)
	}

	database, err := NewDatabase(path)
	if err != nil {
		t.Fatalf("NewDatabase: %v", err)
	}
	reopened, err := New(Options{
		LeaseMs:           1_000,
		MaxRooms:          8,
		MaxViewersPerRoom: 8,
		Now:               func() int64 { return testClock.nowMs },
		Database:          database,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// The oracle accepts either rejection: this SQLite build reports the broken
	// row from PRAGMA quick_check before the digest length assertion runs.
	err = reopened.Initialize()
	if err == nil || (!strings.Contains(err.Error(), "Host token") &&
		!strings.Contains(err.Error(), "integrity")) {
		t.Fatalf("Initialize = %v", err)
	}
	if err := reopened.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

// TestRejectsInvalidAuthorityArguments keeps the assertions the TypeScript ran
// before touching SQLite: STRICT would accept an integral REAL or a numeric
// TEXT timestamp, and a caller mistake must not reach the file at all.
func TestRejectsInvalidAuthorityArguments(t *testing.T) {
	valid := StoredRoomAuthority{
		RoomID:                        "1234",
		HostTokenDigest:               make([]byte, 32),
		ViewerGrantDigest:             make([]byte, 32),
		ViewerAuthorizationGeneration: "MzMzMzMzMzMzMzMzMzMzMw",
		CodeEntryPolicy:               protocol.CodeEntryOpen,
	}
	lease := int64(protocol.MaxSafeInteger + 1)
	shortDigest := make([]byte, 31)
	for _, testCase := range []struct {
		name string
		run  func(*Database) error
		want string
	}{
		{"room ID", func(d *Database) error {
			room := valid
			room.RoomID = "0123"
			return d.InsertRoom(room)
		}, "Room database contains an invalid room ID"},
		{"host digest", func(d *Database) error {
			room := valid
			room.HostTokenDigest = shortDigest
			return d.InsertRoom(room)
		}, "Host token digest must contain 32 bytes"},
		{"grant digest", func(d *Database) error {
			room := valid
			room.ViewerGrantDigest = shortDigest
			return d.InsertRoom(room)
		}, "Viewer grant digest must contain 32 bytes"},
		{"generation", func(d *Database) error {
			room := valid
			room.ViewerAuthorizationGeneration = "MzMzMzMzMzMzMzMzMzMzMw=="
			return d.InsertRoom(room)
		}, "Viewer authorization generation is invalid"},
		{"policy", func(d *Database) error {
			room := valid
			room.CodeEntryPolicy = "public"
			return d.InsertRoom(room)
		}, "Room database contains an invalid code-entry policy"},
		{"password material", func(d *Database) error {
			room := valid
			room.ViewerPasswordMaterial = make([]byte, 47)
			return d.InsertRoom(room)
		}, "Viewer password material must contain 48 bytes"},
		{"lease deadline", func(d *Database) error {
			room := valid
			room.LeaseExpiresAtMs = &lease
			return d.InsertRoom(room)
		}, "Room database lease deadline must be a safe positive integer"},
		{"identity", func(d *Database) error {
			return d.SetLeaseDeadline("123", make([]byte, 32), nil)
		}, "Room ID is invalid"},
		{"update policy", func(d *Database) error {
			return d.SetCodeEntryPolicy("1234", make([]byte, 32), "public")
		}, "Room code-entry policy is invalid"},
		{"replacement identity", func(d *Database) error {
			return d.ReplaceRoom("1234", make([]byte, 32), valid)
		}, "Replacement room ID must be different"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			database, err := NewDatabase(databasePath(t))
			if err != nil {
				t.Fatalf("NewDatabase: %v", err)
			}
			if _, err := database.Initialize(0, 1_000); err != nil {
				t.Fatalf("Initialize: %v", err)
			}
			defer func() { _ = database.Close() }()
			if err := testCase.run(database); err == nil || err.Error() != testCase.want {
				t.Fatalf("error = %v, want %q", err, testCase.want)
			}
		})
	}
}

func TestRejectsAMemoryDatabasePath(t *testing.T) {
	for _, path := range []string{"", ":memory:"} {
		if _, err := NewDatabase(path); err == nil ||
			err.Error() != "Room database path must identify a file" {
			t.Fatalf("NewDatabase(%q) = %v", path, err)
		}
	}
}

func TestRejectsASecondInitialize(t *testing.T) {
	path := databasePath(t)
	database, err := NewDatabase(path)
	if err != nil {
		t.Fatalf("NewDatabase: %v", err)
	}
	if _, err := database.Initialize(0, 1_000); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	if _, err := database.Initialize(0, 1_000); err == nil ||
		err.Error() != "Room database is already initialized" {
		t.Fatalf("second Initialize = %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := database.InsertRoom(StoredRoomAuthority{
		RoomID:                        "1234",
		HostTokenDigest:               make([]byte, 32),
		ViewerGrantDigest:             make([]byte, 32),
		ViewerAuthorizationGeneration: "MzMzMzMzMzMzMzMzMzMzMw",
		CodeEntryPolicy:               protocol.CodeEntryOpen,
	}); err == nil || err.Error() != "Room database is not initialized" {
		t.Fatalf("InsertRoom after Close = %v", err)
	}
}

func TestRejectsAnActiveLeaseThatIsNotInTheFuture(t *testing.T) {
	database, err := NewDatabase(databasePath(t))
	if err != nil {
		t.Fatalf("NewDatabase: %v", err)
	}
	if _, err := database.Initialize(1_000, 1_000); err == nil ||
		err.Error() != "Room database active-room lease deadline must be in the future" {
		t.Fatalf("Initialize = %v", err)
	}
	if _, err := database.Initialize(-1, 1_000); err == nil ||
		err.Error() != "Room database startup time must be a safe positive integer" {
		t.Fatalf("Initialize = %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}
