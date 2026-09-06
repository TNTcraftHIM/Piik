package room

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/TNTcraftHIM/Screener/internal/server/protocol"
)

// testdata/node-rooms.db was written once by node:sqlite (DatabaseSync) with
// the schema of src/server/room-database.ts and two synthetic rooms: 4321 is
// active (NULL lease) with a 48-byte password material, 5678 is dormant with a
// lease of 1000 ms. No real token, grant or password is involved. The extension
// is .db because .gitignore excludes *.sqlite repository-wide.
func copyNodeFixture(t *testing.T) string {
	t.Helper()
	fixture, err := os.ReadFile(filepath.Join("testdata", "node-rooms.db"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	path := filepath.Join(t.TempDir(), "rooms.sqlite")
	if err := os.WriteFile(path, fixture, 0o600); err != nil {
		t.Fatalf("write fixture copy: %v", err)
	}
	return path
}

func openFixture(t *testing.T, startupNowMs, activeLeaseExpiresAtMs int64) []StoredRoomAuthority {
	t.Helper()
	database, err := NewDatabase(copyNodeFixture(t))
	if err != nil {
		t.Fatalf("NewDatabase: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	restored, err := database.Initialize(startupNowMs, activeLeaseExpiresAtMs)
	if err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	return restored
}

func TestRecoversANodeWrittenDatabase(t *testing.T) {
	restored := openFixture(t, 5_000, 6_000)
	if len(restored) != 1 {
		t.Fatalf("restored %d rooms, want 1 (the dormant room was due at 1000)", len(restored))
	}
	room := restored[0]
	if room.RoomID != "4321" || room.CodeEntryPolicy != protocol.CodeEntryPrivate {
		t.Fatalf("restored %+v", room)
	}
	if room.LeaseExpiresAtMs == nil || *room.LeaseExpiresAtMs != 6_000 {
		t.Fatalf("active room lease = %v, want the startup lease 6000", room.LeaseExpiresAtMs)
	}
	if !bytes.Equal(room.HostTokenDigest, bytes.Repeat([]byte{0x11}, 32)) ||
		!bytes.Equal(room.ViewerGrantDigest, bytes.Repeat([]byte{0x22}, 32)) {
		t.Fatal("digests did not survive the Node round trip")
	}
	if room.ViewerAuthorizationGeneration != "MzMzMzMzMzMzMzMzMzMzMw" {
		t.Fatalf("generation = %q", room.ViewerAuthorizationGeneration)
	}
	if !bytes.Equal(room.ViewerPasswordMaterial, bytes.Repeat([]byte{0x44}, 48)) {
		t.Fatalf("password material = %d bytes", len(room.ViewerPasswordMaterial))
	}
}

func TestKeepsADormantNodeWrittenDeadline(t *testing.T) {
	restored := openFixture(t, 500, 1_500)
	if len(restored) != 2 {
		t.Fatalf("restored %d rooms, want 2", len(restored))
	}
	// readStoredRooms orders by room_id.
	if restored[0].RoomID != "4321" || restored[0].LeaseExpiresAtMs == nil ||
		*restored[0].LeaseExpiresAtMs != 1_500 {
		t.Fatalf("active room = %+v", restored[0])
	}
	if restored[1].RoomID != "5678" || restored[1].LeaseExpiresAtMs == nil ||
		*restored[1].LeaseExpiresAtMs != 1_000 {
		t.Fatalf("dormant room = %+v", restored[1])
	}
	if restored[1].ViewerPasswordMaterial != nil {
		t.Fatalf("dormant room material = %v, want nil", restored[1].ViewerPasswordMaterial)
	}
}

func TestStoreRestoresANodeWrittenDatabase(t *testing.T) {
	testClock := &clock{nowMs: 5_000}
	store := stableStore(t, copyNodeFixture(t), testClock, Options{LeaseMs: 1_000})
	if store.Size() != 1 {
		t.Fatalf("size = %d, want 1", store.Size())
	}
	// The recovered room holds the startup lease: 5000 + 1000.
	testClock.nowMs = 6_001
	expired, err := store.ExpireRooms(testClock.nowMs)
	if err != nil {
		t.Fatalf("ExpireRooms: %v", err)
	}
	if len(expired) != 1 || expired[0].RoomID != "4321" {
		t.Fatalf("expired = %+v", expired)
	}
}

// TestSchemaTextMatchesTheNodeFixture proves the CREATE TABLE text this package
// executes is byte for byte the one src/server/room-database.ts executed.
func TestSchemaTextMatchesTheNodeFixture(t *testing.T) {
	path := databasePath(t)
	database, err := NewDatabase(path)
	if err != nil {
		t.Fatalf("NewDatabase: %v", err)
	}
	if _, err := database.Initialize(0, 1_000); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	created := readSchemaText(t, path)
	fixture := readSchemaText(t, copyNodeFixture(t))
	if created.sql != fixture.sql {
		t.Fatalf("schema text differs\n go:   %q\n node: %q", created.sql, fixture.sql)
	}
	if created.applicationID != fixture.applicationID ||
		created.applicationID != roomDatabaseApplicationID {
		t.Fatalf("application_id go=%d node=%d", created.applicationID, fixture.applicationID)
	}
	if created.userVersion != fixture.userVersion ||
		created.userVersion != roomDatabaseSchemaVersion {
		t.Fatalf("user_version go=%d node=%d", created.userVersion, fixture.userVersion)
	}
}

type schemaText struct {
	sql           string
	applicationID int64
	userVersion   int64
}

func readSchemaText(t *testing.T, path string) schemaText {
	t.Helper()
	raw := rawDatabase(t, path)
	var text schemaText
	if err := raw.QueryRow(
		"SELECT sql FROM sqlite_schema WHERE name = 'rooms'").Scan(&text.sql); err != nil {
		t.Fatalf("read schema: %v", err)
	}
	if err := raw.QueryRow("PRAGMA application_id").Scan(&text.applicationID); err != nil {
		t.Fatalf("read application_id: %v", err)
	}
	if err := raw.QueryRow("PRAGMA user_version").Scan(&text.userVersion); err != nil {
		t.Fatalf("read user_version: %v", err)
	}
	return text
}
