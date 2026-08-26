import { DatabaseSync } from "node:sqlite";

import {
  codeEntryPolicySchema,
  roomCodeSchema,
  type CodeEntryPolicy,
} from "../shared/protocol.js";

const ROOM_DATABASE_APPLICATION_ID = 0x5343524e;
const ROOM_DATABASE_SCHEMA_VERSION = 1;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export interface StoredRoomAuthority {
  roomId: string;
  hostTokenDigest: Buffer;
  viewerGrantDigest: Buffer;
  viewerAuthorizationGeneration: string;
  codeEntryPolicy: CodeEntryPolicy;
  viewerPasswordMaterial: Buffer | null;
  leaseExpiresAtMs: number | null;
}

export class RoomDatabase {
  private database: DatabaseSync | undefined;

  constructor(private readonly path: string) {
    if (!path || path === ":memory:") {
      throw new Error("Room database path must identify a file");
    }
  }

  initialize(
    startupNowMs: number,
    activeLeaseExpiresAtMs: number,
  ): StoredRoomAuthority[] {
    if (this.database) {
      throw new Error("Room database is already initialized");
    }
    assertTimestamp(startupNowMs, "Room database startup time", true);
    assertTimestamp(
      activeLeaseExpiresAtMs,
      "Room database active-room lease deadline",
    );
    if (activeLeaseExpiresAtMs <= startupNowMs) {
      throw new Error("Room database active-room lease deadline must be in the future");
    }

    const database = new DatabaseSync(this.path, { timeout: 0 });
    try {
      const lockingMode = database
        .prepare("PRAGMA main.locking_mode = EXCLUSIVE")
        .get() as Record<string, unknown> | undefined;
      if (lockingMode?.locking_mode !== "exclusive") {
        throw new Error("Room database could not acquire exclusive locking mode");
      }

      database.exec("BEGIN EXCLUSIVE");
      let restored: StoredRoomAuthority[];
      try {
        this.ensureExactSchema(database);
        assertDatabaseIntegrity(database);
        const stored = readStoredRooms(database);
        const expiredCount = stored.filter(
          (room) =>
            room.leaseExpiresAtMs !== null &&
            room.leaseExpiresAtMs <= startupNowMs,
        ).length;
        const activeCount = stored.filter(
          (room) => room.leaseExpiresAtMs === null,
        ).length;

        const deleted = database
          .prepare(
            `DELETE FROM rooms
              WHERE lease_expires_at_ms IS NOT NULL
                AND lease_expires_at_ms <= ?`,
          )
          .run(startupNowMs).changes;
        if (Number(deleted) !== expiredCount) {
          throw new Error("Room database expiry cleanup changed an unexpected row count");
        }

        const converted = database
          .prepare(
            `UPDATE rooms
                SET lease_expires_at_ms = ?
              WHERE lease_expires_at_ms IS NULL`,
          )
          .run(activeLeaseExpiresAtMs).changes;
        if (Number(converted) !== activeCount) {
          throw new Error("Room database active-room recovery changed an unexpected row count");
        }

        restored = stored.flatMap((room) => {
          if (
            room.leaseExpiresAtMs !== null &&
            room.leaseExpiresAtMs <= startupNowMs
          ) {
            return [];
          }
          return [
            room.leaseExpiresAtMs === null
              ? { ...room, leaseExpiresAtMs: activeLeaseExpiresAtMs }
              : room,
          ];
        });
        database.exec("COMMIT");
      } catch (error) {
        if (database.isTransaction) {
          database.exec("ROLLBACK");
        }
        throw error;
      }

      this.database = database;
      return restored;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  insertRoom(room: StoredRoomAuthority): void {
    assertStoredRoom(room);
    this.transaction((database) => {
      assertSingleChange(insertStoredRoom(database, room), "insert");
    });
  }

  setLeaseDeadline(
    roomId: string,
    hostTokenDigest: Buffer,
    leaseExpiresAtMs: number | null,
  ): void {
    assertRoomIdentity(roomId, hostTokenDigest);
    if (leaseExpiresAtMs !== null) {
      assertTimestamp(leaseExpiresAtMs, "Room lease deadline");
    }
    this.transaction((database) => {
      const changes = database
        .prepare(
          `UPDATE rooms
              SET lease_expires_at_ms = ?
            WHERE room_id = ? AND host_token_digest = ?`,
        )
        .run(leaseExpiresAtMs, roomId, hostTokenDigest).changes;
      assertSingleChange(changes, "lease update");
    });
  }

  setViewerPassword(
    roomId: string,
    hostTokenDigest: Buffer,
    viewerPasswordMaterial: Buffer | null,
  ): void {
    assertRoomIdentity(roomId, hostTokenDigest);
    assertPasswordMaterial(viewerPasswordMaterial);
    this.transaction((database) => {
      const changes = database
        .prepare(
          `UPDATE rooms
              SET viewer_password_material = ?
            WHERE room_id = ? AND host_token_digest = ?`,
        )
        .run(viewerPasswordMaterial, roomId, hostTokenDigest).changes;
      assertSingleChange(changes, "password update");
    });
  }

  setCodeEntryPolicy(
    roomId: string,
    hostTokenDigest: Buffer,
    codeEntryPolicy: CodeEntryPolicy,
  ): void {
    assertRoomIdentity(roomId, hostTokenDigest);
    if (!codeEntryPolicySchema.safeParse(codeEntryPolicy).success) {
      throw new Error("Room code-entry policy is invalid");
    }
    this.transaction((database) => {
      const changes = database
        .prepare(
          `UPDATE rooms
              SET code_entry_policy = ?
            WHERE room_id = ? AND host_token_digest = ?`,
        )
        .run(codeEntryPolicy, roomId, hostTokenDigest).changes;
      assertSingleChange(changes, "code-entry policy update");
    });
  }

  setViewerGrant(
    roomId: string,
    hostTokenDigest: Buffer,
    viewerGrantDigest: Buffer,
    viewerAuthorizationGeneration: string,
  ): void {
    assertRoomIdentity(roomId, hostTokenDigest);
    assertDigest(viewerGrantDigest, "Viewer grant");
    assertAuthorizationGeneration(viewerAuthorizationGeneration);
    this.transaction((database) => {
      const changes = database
        .prepare(
          `UPDATE rooms
              SET viewer_grant_digest = ?,
                  viewer_authorization_generation = ?
            WHERE room_id = ? AND host_token_digest = ?`,
        )
        .run(
          viewerGrantDigest,
          viewerAuthorizationGeneration,
          roomId,
          hostTokenDigest,
        ).changes;
      assertSingleChange(changes, "Viewer grant update");
    });
  }

  deleteRoom(roomId: string, hostTokenDigest: Buffer): void {
    assertRoomIdentity(roomId, hostTokenDigest);
    this.transaction((database) => {
      const changes = database
        .prepare(
          "DELETE FROM rooms WHERE room_id = ? AND host_token_digest = ?",
        )
        .run(roomId, hostTokenDigest).changes;
      assertSingleChange(changes, "delete");
    });
  }

  replaceRoom(
    oldRoomId: string,
    oldHostTokenDigest: Buffer,
    replacement: StoredRoomAuthority,
  ): void {
    assertRoomIdentity(oldRoomId, oldHostTokenDigest);
    assertStoredRoom(replacement);
    if (replacement.roomId === oldRoomId) {
      throw new Error("Replacement room ID must be different");
    }
    this.transaction((database) => {
      assertSingleChange(
        insertStoredRoom(database, replacement),
        "replacement insert",
      );
      const deleted = database
        .prepare(
          "DELETE FROM rooms WHERE room_id = ? AND host_token_digest = ?",
        )
        .run(oldRoomId, oldHostTokenDigest).changes;
      assertSingleChange(deleted, "replacement delete");
    });
  }

  close(): void {
    const database = this.database;
    this.database = undefined;
    if (database?.isOpen) {
      database.close();
    }
  }

  private ensureExactSchema(database: DatabaseSync): void {
    const applicationId = readPragmaInteger(database, "application_id");
    const schemaVersion = readPragmaInteger(database, "user_version");
    const schemaObjects = database
      .prepare(
        `SELECT type, name
           FROM sqlite_schema
          WHERE name NOT LIKE 'sqlite_%'
          ORDER BY type, name`,
      )
      .all() as Array<Record<string, unknown>>;

    if (
      applicationId === 0 &&
      schemaVersion === 0 &&
      schemaObjects.length === 0
    ) {
      database.exec(`
        CREATE TABLE rooms (
          room_id TEXT PRIMARY KEY NOT NULL
            CHECK (room_id GLOB '[1-9][0-9][0-9][0-9]'),
          host_token_digest BLOB NOT NULL
            CHECK (typeof(host_token_digest) = 'blob' AND length(host_token_digest) = 32),
          viewer_grant_digest BLOB NOT NULL
            CHECK (typeof(viewer_grant_digest) = 'blob' AND length(viewer_grant_digest) = 32),
          viewer_authorization_generation TEXT NOT NULL
            CHECK (
              length(viewer_authorization_generation) = 22 AND
              viewer_authorization_generation NOT GLOB '*[^A-Za-z0-9_-]*'
            ),
          code_entry_policy TEXT NOT NULL
            CHECK (code_entry_policy IN ('open', 'private')),
          viewer_password_material BLOB NULL
            CHECK (
              viewer_password_material IS NULL OR
              (typeof(viewer_password_material) = 'blob' AND length(viewer_password_material) = 48)
            ),
          lease_expires_at_ms INTEGER NULL
            CHECK (
              lease_expires_at_ms IS NULL OR
              (lease_expires_at_ms > 0 AND lease_expires_at_ms <= ${MAX_SAFE_INTEGER})
            )
        ) STRICT;
        PRAGMA application_id = ${ROOM_DATABASE_APPLICATION_ID};
        PRAGMA user_version = ${ROOM_DATABASE_SCHEMA_VERSION};
      `);
      return;
    }

    if (applicationId !== ROOM_DATABASE_APPLICATION_ID) {
      throw new Error("Room database application identity does not match");
    }
    if (schemaVersion !== ROOM_DATABASE_SCHEMA_VERSION) {
      throw new Error("Room database schema version does not match");
    }
    if (
      schemaObjects.length !== 1 ||
      schemaObjects[0]?.type !== "table" ||
      schemaObjects[0]?.name !== "rooms"
    ) {
      throw new Error("Room database schema objects do not match");
    }
    assertExactColumns(database);
  }

  private transaction(operation: (database: DatabaseSync) => void): void {
    const database = this.database;
    if (!database?.isOpen) {
      throw new Error("Room database is not initialized");
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      operation(database);
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) {
        database.exec("ROLLBACK");
      }
      throw error;
    }
  }
}

function insertStoredRoom(
  database: DatabaseSync,
  room: StoredRoomAuthority,
): number | bigint {
  return database
    .prepare(
      `INSERT INTO rooms (
         room_id,
         host_token_digest,
         viewer_grant_digest,
         viewer_authorization_generation,
         code_entry_policy,
         viewer_password_material,
         lease_expires_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      room.roomId,
      room.hostTokenDigest,
      room.viewerGrantDigest,
      room.viewerAuthorizationGeneration,
      room.codeEntryPolicy,
      room.viewerPasswordMaterial,
      room.leaseExpiresAtMs,
    ).changes;
}

function readStoredRooms(database: DatabaseSync): StoredRoomAuthority[] {
  const rows = database
    .prepare(
      `SELECT
         room_id,
         host_token_digest,
         viewer_grant_digest,
         viewer_authorization_generation,
         code_entry_policy,
         viewer_password_material,
         lease_expires_at_ms
       FROM rooms
       ORDER BY room_id`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const room: StoredRoomAuthority = {
      roomId: readString(row.room_id, "room ID"),
      hostTokenDigest: readDigest(row.host_token_digest, "Host token"),
      viewerGrantDigest: readDigest(row.viewer_grant_digest, "Viewer grant"),
      viewerAuthorizationGeneration: readString(
        row.viewer_authorization_generation,
        "Viewer authorization generation",
      ),
      codeEntryPolicy: readCodeEntryPolicy(row.code_entry_policy),
      viewerPasswordMaterial: readPasswordMaterial(
        row.viewer_password_material,
      ),
      leaseExpiresAtMs: readNullableTimestamp(row.lease_expires_at_ms),
    };
    assertStoredRoom(room);
    return room;
  });
}

function assertStoredRoom(room: StoredRoomAuthority): void {
  if (!roomCodeSchema.safeParse(room.roomId).success) {
    throw new Error("Room database contains an invalid room ID");
  }
  assertDigest(room.hostTokenDigest, "Host token");
  assertDigest(room.viewerGrantDigest, "Viewer grant");
  assertAuthorizationGeneration(room.viewerAuthorizationGeneration);
  if (!codeEntryPolicySchema.safeParse(room.codeEntryPolicy).success) {
    throw new Error("Room database contains an invalid code-entry policy");
  }
  assertPasswordMaterial(room.viewerPasswordMaterial);
  if (room.leaseExpiresAtMs !== null) {
    assertTimestamp(room.leaseExpiresAtMs, "Room database lease deadline");
  }
}

function assertRoomIdentity(roomId: string, hostTokenDigest: Buffer): void {
  if (!roomCodeSchema.safeParse(roomId).success) {
    throw new Error("Room ID is invalid");
  }
  assertDigest(hostTokenDigest, "Host token");
}

function assertDigest(value: Uint8Array, name: string): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new Error(`${name} digest must contain 32 bytes`);
  }
}

function assertPasswordMaterial(value: Uint8Array | null): void {
  if (value !== null && (!(value instanceof Uint8Array) || value.byteLength !== 48)) {
    throw new Error("Viewer password material must contain 48 bytes");
  }
}

function assertAuthorizationGeneration(value: string): void {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    throw new Error("Viewer authorization generation is invalid");
  }
  if (
    decoded.byteLength !== 16 ||
    decoded.toString("base64url") !== value
  ) {
    throw new Error("Viewer authorization generation is invalid");
  }
}

function assertTimestamp(value: number, name: string, allowZero = false): void {
  if (
    !Number.isSafeInteger(value) ||
    (allowZero ? value < 0 : value <= 0)
  ) {
    throw new Error(`${name} must be a safe positive integer`);
  }
}

function assertSingleChange(
  changes: number | bigint,
  operation: string,
): void {
  if (Number(changes) !== 1) {
    throw new Error(`Room database ${operation} did not match current authority`);
  }
}

function assertDatabaseIntegrity(database: DatabaseSync): void {
  const rows = database.prepare("PRAGMA quick_check").all() as Array<
    Record<string, unknown>
  >;
  if (rows.length !== 1 || rows[0]?.quick_check !== "ok") {
    throw new Error("Room database integrity check failed");
  }
}

function assertExactColumns(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(rooms)").all() as Array<
    Record<string, unknown>
  >;
  const expected = [
    ["room_id", "TEXT", 1, 1],
    ["host_token_digest", "BLOB", 1, 0],
    ["viewer_grant_digest", "BLOB", 1, 0],
    ["viewer_authorization_generation", "TEXT", 1, 0],
    ["code_entry_policy", "TEXT", 1, 0],
    ["viewer_password_material", "BLOB", 0, 0],
    ["lease_expires_at_ms", "INTEGER", 0, 0],
  ] as const;
  if (
    columns.length !== expected.length ||
    columns.some((column, index) => {
      const [name, type, notNull, primaryKey] = expected[index]!;
      return (
        column.name !== name ||
        column.type !== type ||
        column.notnull !== notNull ||
        column.pk !== primaryKey
      );
    })
  ) {
    throw new Error("Room database columns do not match the current schema");
  }
}

function readPragmaInteger(database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as
    | Record<string, unknown>
    | undefined;
  const value = row?.[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Room database ${name} is invalid`);
  }
  return value;
}

function readString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`Room database contains an invalid ${name}`);
  }
  return value;
}

function readDigest(value: unknown, name: string): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new Error(`Room database contains an invalid ${name} digest`);
  }
  return Buffer.from(value);
}

function readCodeEntryPolicy(value: unknown): CodeEntryPolicy {
  const parsed = codeEntryPolicySchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Room database contains an invalid code-entry policy");
  }
  return parsed.data;
}

function readPasswordMaterial(value: unknown): Buffer | null {
  if (value === null) {
    return null;
  }
  if (!(value instanceof Uint8Array) || value.byteLength !== 48) {
    throw new Error("Room database contains invalid Viewer password material");
  }
  return Buffer.from(value);
}

function readNullableTimestamp(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Room database contains an invalid lease deadline");
  }
  return value;
}
