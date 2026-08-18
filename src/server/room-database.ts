import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 1;
const MAX_ROOM_ID = 999_999_999_999;

export interface StoredRoom {
  roomId: string;
  hostTokenDigest: Buffer;
}

export class RoomDatabase {
  private readonly database: DatabaseSync;

  constructor(path: string) {
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
        "SELECT id, host_token_digest FROM rooms ORDER BY id",
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
      };
    });
  }

  createRoom(hostTokenDigest: Buffer): StoredRoom {
    if (hostTokenDigest.byteLength !== 32) {
      throw new Error("Host token digest must contain 32 bytes");
    }

    const result = this.database
      .prepare("INSERT INTO rooms (host_token_digest) VALUES (?)")
      .run(hostTokenDigest);
    const roomId = readSafeInteger(result.lastInsertRowid, "created room id");
    return {
      roomId: roomId.toString(),
      hostTokenDigest: Buffer.from(hostTokenDigest),
    };
  }

  deleteRoom(roomId: string): boolean {
    if (!/^[1-9]\d{0,11}$/.test(roomId)) {
      throw new Error("Room id must be a positive integer with at most 12 digits");
    }
    return (
      this.database.prepare("DELETE FROM rooms WHERE id = ?").run(Number(roomId))
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
            CHECK (length(host_token_digest) = 32)
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
}

function readSafeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Room database contains an invalid ${name}`);
  }
  return value;
}
