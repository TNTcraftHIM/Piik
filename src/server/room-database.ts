import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 2;
const MAX_ROOM_ID = 999_999_999_999;

export interface StoredRoom {
  roomId: string;
  hostTokenDigest: Buffer;
  viewerGrantDigest: Buffer | null;
}

export class RoomDatabase {
  private readonly database: DatabaseSync;
  private readonly random: (size: number) => Buffer;

  constructor(path: string, random: (size: number) => Buffer = randomBytes) {
    this.random = random;
    this.database = new DatabaseSync(path, { timeout: 5_000 });
    try {
      this.initialize();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  loadRooms(): StoredRoom[] {
    const rows = this.database
      .prepare(
        "SELECT id, host_token_digest, viewer_grant_digest FROM rooms ORDER BY id",
      )
      .all();

    return rows.map((row) => {
      const roomId = readSafeInteger(row.id, "room id");
      if (
        !(row.host_token_digest instanceof Uint8Array) ||
        row.host_token_digest.byteLength !== 32
      ) {
        throw new Error("Room database contains an invalid host token digest");
      }
      return {
        roomId: roomId.toString(),
        hostTokenDigest: Buffer.from(row.host_token_digest),
        viewerGrantDigest: readViewerGrantDigest(row.viewer_grant_digest),
      };
    });
  }

  createRoom(
    hostTokenDigest: Buffer,
    viewerGrantDigestForRoom: (roomId: string) => Buffer | null,
  ): StoredRoom {
    assertDigest(hostTokenDigest, "Host token");

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database
        .prepare(
          "INSERT INTO rooms (host_token_digest, viewer_grant_digest) VALUES (?, NULL)",
        )
        .run(hostTokenDigest);
      const roomId = readSafeInteger(result.lastInsertRowid, "created room id");
      const roomIdText = roomId.toString();
      const viewerGrantDigest = viewerGrantDigestForRoom(roomIdText);
      if (viewerGrantDigest !== null) {
        assertDigest(viewerGrantDigest, "Viewer grant");
        const updated = this.database
          .prepare("UPDATE rooms SET viewer_grant_digest = ? WHERE id = ?")
          .run(viewerGrantDigest, roomId).changes;
        if (updated !== 1) {
          throw new Error("Created room could not be updated");
        }
      }
      this.database.exec("COMMIT");
      return {
        roomId: roomIdText,
        hostTokenDigest: Buffer.from(hostTokenDigest),
        viewerGrantDigest:
          viewerGrantDigest === null ? null : Buffer.from(viewerGrantDigest),
      };
    } catch (error) {
      if (this.database.isTransaction) {
        this.database.exec("ROLLBACK");
      }
      throw error;
    }
  }

  updateViewerGrantDigest(
    roomId: string,
    viewerGrantDigest: Buffer | null,
  ): void {
    const numericRoomId = parseRoomId(roomId);
    if (viewerGrantDigest !== null) {
      assertDigest(viewerGrantDigest, "Viewer grant");
    }
    const changes = this.database
      .prepare("UPDATE rooms SET viewer_grant_digest = ? WHERE id = ?")
      .run(viewerGrantDigest, numericRoomId).changes;
    if (changes !== 1) {
      throw new Error("Persistent room is missing from the room database");
    }
  }

  deleteRoom(roomId: string): boolean {
    const numericRoomId = parseRoomId(roomId);
    return (
      this.database.prepare("DELETE FROM rooms WHERE id = ?").run(numericRoomId)
        .changes === 1
    );
  }

  close(): void {
    if (this.database.isOpen) {
      this.database.close();
    }
  }

  private initialize(): void {
    const row = this.database.prepare("PRAGMA user_version").get();
    const version = readSafeInteger(row?.user_version, "schema version");
    if (version === SCHEMA_VERSION) {
      return;
    }
    if (version === 1) {
      this.migrateV1();
      return;
    }
    if (version !== 0) {
      throw new Error(`Unsupported room database schema version ${version}`);
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(`
        CREATE TABLE rooms (
          id INTEGER PRIMARY KEY AUTOINCREMENT
            CHECK (id BETWEEN 1 AND ${MAX_ROOM_ID}),
          host_token_digest BLOB NOT NULL
            CHECK (length(host_token_digest) = 32),
          viewer_grant_digest BLOB NULL
            CHECK (
              viewer_grant_digest IS NULL OR
              length(viewer_grant_digest) = 32
            )
        ) STRICT;
        PRAGMA user_version = ${SCHEMA_VERSION};
        COMMIT;
      `);
    } catch (error) {
      if (this.database.isTransaction) {
        this.database.exec("ROLLBACK");
      }
      throw error;
    }
  }

  private migrateV1(): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(`
        ALTER TABLE rooms ADD COLUMN viewer_grant_digest BLOB NULL
          CHECK (
            viewer_grant_digest IS NULL OR
            length(viewer_grant_digest) = 32
          );
      `);
      const roomIds = this.database.prepare("SELECT id FROM rooms ORDER BY id").all();
      const lockRoom = this.database.prepare(
        "UPDATE rooms SET viewer_grant_digest = ? WHERE id = ?",
      );
      for (const row of roomIds) {
        const roomId = readSafeInteger(row.id, "room id");
        const lockedDigest = this.random(32);
        assertDigest(lockedDigest, "Migration random source");
        if (lockRoom.run(lockedDigest, roomId).changes !== 1) {
          throw new Error("Room database migration lost a room row");
        }
      }
      this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
    } catch (error) {
      if (this.database.isTransaction) {
        this.database.exec("ROLLBACK");
      }
      throw error;
    }
  }
}

function assertDigest(value: Buffer, name: string): void {
  if (value.byteLength !== 32) {
    throw new Error(`${name} digest must contain 32 bytes`);
  }
}

function readViewerGrantDigest(value: unknown): Buffer | null {
  if (value === null) {
    return null;
  }
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new Error("Room database contains an invalid viewer grant digest");
  }
  return Buffer.from(value);
}

function parseRoomId(roomId: string): number {
  if (!/^[1-9]\d{0,11}$/.test(roomId)) {
    throw new Error("Room id must be a positive integer with at most 12 digits");
  }
  return Number(roomId);
}

function readSafeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Room database contains an invalid ${name}`);
  }
  return value;
}
