import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { MAX_VIEWERS_PER_ROOM_LIMIT } from "../src/shared/protocol.ts";
import { RoomDatabase } from "../src/server/room-database.ts";
import {
  RoomStore,
  RoomStoreError,
} from "../src/server/room-store.ts";

function expectRoomError(action: () => unknown, code: RoomStoreError["code"]): void {
  try {
    action();
    throw new Error("Expected RoomStoreError");
  } catch (error) {
    expect(error).toBeInstanceOf(RoomStoreError);
    expect((error as RoomStoreError).code).toBe(code);
  }
}

function viewerGrant(room: { viewerGrant: string | null }): string {
  if (!room.viewerGrant) {
    throw new Error("Expected a private room Viewer grant");
  }
  return room.viewerGrant;
}

describe("RoomStore", () => {
  it("creates a four-hour room and authenticates both roles", () => {
    const now = Date.UTC(2026, 7, 18, 12);
    const store = new RoomStore({
      ttlMs: 14_400_000,
      maxRooms: 10,
      maxViewersPerRoom: 3,
      now: () => now,
    });
    const room = store.createRoom();

    expect(room.roomId).toMatch(/^[1-9]\d{11}$/);
    expect(room.hostToken).toHaveLength(43);
    expect(room.expiresAt).toBe(new Date(now + 14_400_000).toISOString());
    expect(
      store.connectParticipant({
        roomId: room.roomId,
        role: "viewer",
        viewerGrant: viewerGrant(room),
        clientId: "viewer-client-1",
        sessionId: "viewer-session-1",
      }),
    ).toMatchObject({ role: "viewer", hostOnline: false });
    expect(
      store.connectParticipant({
        roomId: room.roomId,
        role: "host",
        token: room.hostToken,
        clientId: "host-client-1",
        sessionId: "host-session-1",
      }),
    ).toMatchObject({
      role: "host",
      hostOnline: true,
      viewerPeerIds: expect.any(Array),
    });
  });

  it("rejects an invalid host token without exposing which value failed", () => {
    const store = new RoomStore({
      ttlMs: 10_000,
      maxRooms: 10,
      maxViewersPerRoom: 3,
    });
    const room = store.createRoom();

    expectRoomError(
      () =>
        store.connectParticipant({
          roomId: room.roomId,
          role: "host",
          token: "wrong-host-token".padEnd(32, "x"),
          clientId: "host-client-1",
          sessionId: "host-session-1",
        }),
      "INVALID_TOKEN",
    );
  });

  it("keeps peer identity stable and ignores disconnect from a replaced socket", () => {
    const store = new RoomStore({
      ttlMs: 10_000,
      maxRooms: 10,
      maxViewersPerRoom: 3,
    });
    const room = store.createRoom();
    const first = store.connectParticipant({
      roomId: room.roomId,
      role: "viewer",
      viewerGrant: viewerGrant(room),
      clientId: "stable-viewer-client",
      sessionId: "viewer-session-old",
    });
    const replacement = store.connectParticipant({
      roomId: room.roomId,
      role: "viewer",
      viewerGrant: viewerGrant(room),
      clientId: "stable-viewer-client",
      sessionId: "viewer-session-new",
    });

    expect(replacement.peerId).toBe(first.peerId);
    expect(replacement.replacedSessionId).toBe("viewer-session-old");
    expect(
      store.disconnectParticipant(room.roomId, first.peerId, "viewer-session-old"),
    ).toBeUndefined();
    expect(store.getConnectedViewer(room.roomId, first.peerId)?.sessionId).toBe(
      "viewer-session-new",
    );
  });

  it("reserves the configured viewer slots until a disconnected viewer is released", () => {
    const store = new RoomStore({
      ttlMs: 10_000,
      maxRooms: 10,
      maxViewersPerRoom: 2,
    });
    const room = store.createRoom();
    const viewers = [1, 2].map((number) =>
      store.connectParticipant({
        roomId: room.roomId,
        role: "viewer",
        viewerGrant: viewerGrant(room),
        clientId: `viewer-client-${number}`,
        sessionId: `viewer-session-${number}`,
      }),
    );

    expectRoomError(
      () =>
        store.connectParticipant({
          roomId: room.roomId,
          role: "viewer",
          viewerGrant: viewerGrant(room),
          clientId: "viewer-client-3",
          sessionId: "viewer-session-3",
        }),
      "ROOM_FULL",
    );

    store.disconnectParticipant(room.roomId, viewers[0].peerId, "viewer-session-1");
    expectRoomError(
      () =>
        store.connectParticipant({
          roomId: room.roomId,
          role: "viewer",
          viewerGrant: viewerGrant(room),
          clientId: "viewer-client-3",
          sessionId: "viewer-session-3",
        }),
      "ROOM_FULL",
    );
    expect(store.removeDisconnectedViewer(room.roomId, viewers[0].peerId)).toBe(true);
    expect(
      store.connectParticipant({
        roomId: room.roomId,
        role: "viewer",
        viewerGrant: viewerGrant(room),
        clientId: "viewer-client-3",
        sessionId: "viewer-session-3",
      }).role,
    ).toBe("viewer");
    expect(store.maxViewersPerRoom).toBe(2);
  });

  it("allows only the same host identity to replace an online host", () => {
    const store = new RoomStore({
      ttlMs: 10_000,
      maxRooms: 10,
      maxViewersPerRoom: 3,
    });
    const room = store.createRoom();
    const first = store.connectParticipant({
      roomId: room.roomId,
      role: "host",
      token: room.hostToken,
      clientId: "stable-host-client",
      sessionId: "host-session-old",
    });
    const replacement = store.connectParticipant({
      roomId: room.roomId,
      role: "host",
      token: room.hostToken,
      clientId: "stable-host-client",
      sessionId: "host-session-new",
    });

    expect(replacement.peerId).toBe(first.peerId);
    expect(replacement.replacedSessionId).toBe("host-session-old");
    expectRoomError(
      () =>
        store.connectParticipant({
          roomId: room.roomId,
          role: "host",
          token: room.hostToken,
          clientId: "different-host-client",
          sessionId: "different-host-session",
        }),
      "HOST_ALREADY_CONNECTED",
    );
  });

  it("expires and globally bounds transient rooms", () => {
    let now = 1_000;
    const expiringStore = new RoomStore({
      ttlMs: 100,
      maxRooms: 1,
      maxViewersPerRoom: 3,
      now: () => now,
    });
    const room = expiringStore.createRoom();
    expectRoomError(() => expiringStore.createRoom(), "ROOM_LIMIT");

    now = 1_100;
    expectRoomError(
      () =>
        expiringStore.connectParticipant({
          roomId: room.roomId,
          role: "host",
          token: room.hostToken,
          clientId: "host-client-1",
          sessionId: "host-session-1",
        }),
      "ROOM_EXPIRED",
    );
    expect(expiringStore.expireRooms()).toHaveLength(1);
    expect(expiringStore.size).toBe(0);

    expect(expiringStore.createRoom()).toBeDefined();
  });

  it("persists permanent room identity and host authorization across restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "screener-room-store-"));
    const databasePath = join(directory, "rooms.sqlite");
    const now = Date.UTC(2026, 7, 18, 12);
    let store: RoomStore | undefined;

    try {
      store = new RoomStore({
        ttlMs: 100,
        maxRooms: 10,
        maxViewersPerRoom: 3,
        now: () => now,
        database: new RoomDatabase(databasePath),
      });
      const first = store.createRoom();
      expect(first).toMatchObject({ roomId: "1", expiresAt: null });
      expect(store.expireRooms(now + 1_000_000)).toEqual([]);
      store.close();
      store = undefined;

      expect(readFileSync(databasePath).includes(Buffer.from(first.hostToken))).toBe(
        false,
      );
      expect(
        readFileSync(databasePath).includes(Buffer.from(viewerGrant(first))),
      ).toBe(false);

      store = new RoomStore({
        ttlMs: 100,
        maxRooms: 10,
        maxViewersPerRoom: 3,
        now: () => now + 1_000_000,
        database: new RoomDatabase(databasePath),
      });
      expect(
        store.connectParticipant({
          roomId: first.roomId,
          role: "viewer",
          viewerGrant: viewerGrant(first),
          clientId: "viewer-after-restart",
          sessionId: "viewer-session-after-restart",
        }),
      ).toMatchObject({ expiresAt: null, hostOnline: false });
      expect(
        store.connectParticipant({
          roomId: first.roomId,
          role: "host",
          token: first.hostToken,
          clientId: "host-after-restart",
          sessionId: "host-session-after-restart",
        }),
      ).toMatchObject({ expiresAt: null, hostOnline: true });
      const second = store.createRoom();
      expect(second).toMatchObject({ roomId: "2", expiresAt: null });
      expect(store.abandonRoom(first.roomId)).toBeDefined();
      expectRoomError(
        () =>
          store!.connectParticipant({
            roomId: first.roomId,
            role: "viewer",
            viewerGrant: viewerGrant(first),
            clientId: "viewer-after-abandon",
            sessionId: "viewer-session-after-abandon",
          }),
        "INVALID_TOKEN",
      );
      expect(store.createRoom()).toMatchObject({ roomId: "3", expiresAt: null });
    } finally {
      store?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails private Viewer access closed and scopes grants to one room", () => {
    const now = Date.UTC(2026, 7, 18, 12);
    const store = new RoomStore({
      ttlMs: 14_400_000,
      maxRooms: 10,
      maxViewersPerRoom: 3,
      now: () => now,
    });
    const first = store.createRoom();
    const second = store.createRoom();

    for (const candidate of [undefined, "not-a-grant", viewerGrant(second)]) {
      expectRoomError(
        () =>
          store.connectParticipant({
            roomId: first.roomId,
            role: "viewer",
            ...(candidate ? { viewerGrant: candidate } : {}),
            clientId: `viewer-${candidate ?? "missing"}`,
            sessionId: `session-${candidate ?? "missing"}`,
          }),
        "INVALID_TOKEN",
      );
    }

    expect(
      store.connectParticipant({
        roomId: first.roomId,
        role: "viewer",
        viewerGrant: viewerGrant(first),
        clientId: "authorized-viewer",
        sessionId: "authorized-session",
      }),
    ).toMatchObject({ viewerPolicy: "private-link" });
  });

  it("allows grant-free viewing only for an explicitly public room", () => {
    const store = new RoomStore({
      ttlMs: 10_000,
      maxRooms: 10,
      maxViewersPerRoom: 3,
    });
    const room = store.createRoom("public-watch");

    expect(room).toMatchObject({
      viewerPolicy: "public-watch",
      viewerGrant: null,
      viewerGrantExpiresAt: null,
    });
    expect(
      store.connectParticipant({
        roomId: room.roomId,
        role: "viewer",
        clientId: "public-viewer",
        sessionId: "public-session",
      }),
    ).toMatchObject({ viewerPolicy: "public-watch" });
  });

  it("treats public-to-private as a strong Viewer authorization rotation", () => {
    const store = new RoomStore({
      ttlMs: 10_000,
      maxRooms: 10,
      maxViewersPerRoom: 3,
    });
    const room = store.createRoom("public-watch");
    const connected = store.connectParticipant({
      roomId: room.roomId,
      role: "viewer",
      clientId: "public-viewer",
      sessionId: "public-session",
    });

    const update = store.setViewerAccess(room.roomId, "rotate");

    expect(update).toMatchObject({
      viewerPolicy: "private-link",
      revokedViewers: [
        { peerId: connected.peerId, sessionId: "public-session" },
      ],
    });
    expect(update.viewerGrant).toBeTruthy();
    expect(update.viewerAuthorizationGeneration).not.toBe(
      connected.viewerAuthorizationGeneration,
    );
    expectRoomError(
      () =>
        store.connectParticipant({
          roomId: room.roomId,
          role: "viewer",
          clientId: "grant-free-after-rotation",
          sessionId: "grant-free-session",
        }),
      "INVALID_TOKEN",
    );
    expect(
      store.connectParticipant({
        roomId: room.roomId,
        role: "viewer",
        viewerGrant: viewerGrant(update),
        clientId: "private-viewer",
        sessionId: "private-session",
      }),
    ).toMatchObject({
      viewerPolicy: "private-link",
      viewerAuthorizationGeneration: update.viewerAuthorizationGeneration,
    });
  });

  it("keeps old authorization and connected Viewers when persistence fails", () => {
    const database = new RoomDatabase(":memory:");
    const store = new RoomStore({
      ttlMs: 10_000,
      maxRooms: 10,
      maxViewersPerRoom: 3,
      database,
    });
    const room = store.createRoom();
    const connected = store.connectParticipant({
      roomId: room.roomId,
      role: "viewer",
      viewerGrant: viewerGrant(room),
      clientId: "existing-viewer",
      sessionId: "existing-session",
    });
    vi.spyOn(database, "updateViewerGrantDigest").mockImplementation(() => {
      throw new Error("disk write failed");
    });

    expect(() => store.setViewerAccess(room.roomId, "rotate")).toThrow(
      "disk write failed",
    );
    expect(store.getConnectedViewer(room.roomId, connected.peerId)).toEqual({
      peerId: connected.peerId,
      sessionId: "existing-session",
    });
    expect(
      store.connectParticipant({
        roomId: room.roomId,
        role: "viewer",
        viewerGrant: viewerGrant(room),
        clientId: "new-viewer",
        sessionId: "new-session",
      }),
    ).toMatchObject({
      viewerAuthorizationGeneration: connected.viewerAuthorizationGeneration,
    });
    store.close();
  });

  it("does not persist a room when its authorization generation cannot be created", () => {
    const database = new RoomDatabase(":memory:");
    let randomCall = 0;
    const store = new RoomStore({
      ttlMs: 10_000,
      maxRooms: 10,
      maxViewersPerRoom: 3,
      database,
      random: (size) => {
        randomCall += 1;
        return Buffer.alloc(randomCall === 2 ? size - 1 : size, randomCall);
      },
    });

    expect(() => store.createRoom()).toThrow(
      "Authorization generation random source must return 16 bytes",
    );
    expect(database.loadRooms()).toEqual([]);
    store.close();
  });

  it("keeps persisted authorization and Viewers when generation creation fails", () => {
    const database = new RoomDatabase(":memory:");
    let randomValue = 0;
    let failGeneration = false;
    const store = new RoomStore({
      ttlMs: 10_000,
      maxRooms: 10,
      maxViewersPerRoom: 3,
      database,
      random: (size) => {
        randomValue += 1;
        return Buffer.alloc(
          failGeneration && size === 16 ? size - 1 : size,
          randomValue,
        );
      },
    });
    const room = store.createRoom();
    const connected = store.connectParticipant({
      roomId: room.roomId,
      role: "viewer",
      viewerGrant: viewerGrant(room),
      clientId: "existing-viewer",
      sessionId: "existing-session",
    });
    const persistedDigest = database.loadRooms()[0].viewerGrantDigest;

    failGeneration = true;
    expect(() => store.setViewerAccess(room.roomId, "rotate")).toThrow(
      "Authorization generation random source must return 16 bytes",
    );
    failGeneration = false;

    expect(database.loadRooms()[0].viewerGrantDigest).toEqual(persistedDigest);
    expect(store.getConnectedViewer(room.roomId, connected.peerId)).toEqual({
      peerId: connected.peerId,
      sessionId: "existing-session",
    });
    expect(
      store.connectParticipant({
        roomId: room.roomId,
        role: "viewer",
        viewerGrant: viewerGrant(room),
        clientId: "new-viewer",
        sessionId: "new-session",
      }),
    ).toMatchObject({
      viewerAuthorizationGeneration: connected.viewerAuthorizationGeneration,
    });
    store.close();
  });

  it("commits a strong rotation before invalidating old Viewer authority", () => {
    const store = new RoomStore({
      ttlMs: 10_000,
      maxRooms: 10,
      maxViewersPerRoom: 3,
    });
    const room = store.createRoom();
    const connected = store.connectParticipant({
      roomId: room.roomId,
      role: "viewer",
      viewerGrant: viewerGrant(room),
      clientId: "old-viewer",
      sessionId: "old-session",
    });

    const update = store.setViewerAccess(room.roomId, "rotate");
    expect(update.viewerAuthorizationGeneration).not.toBe(
      connected.viewerAuthorizationGeneration,
    );
    expect(update.revokedViewers).toEqual([
      { peerId: connected.peerId, sessionId: "old-session" },
    ]);
    expect(store.getConnectedViewer(room.roomId, connected.peerId)).toBeUndefined();
    expectRoomError(
      () =>
        store.connectParticipant({
          roomId: room.roomId,
          role: "viewer",
          viewerGrant: viewerGrant(room),
          clientId: "old-grant-viewer",
          sessionId: "old-grant-session",
        }),
      "INVALID_TOKEN",
    );
    expect(
      store.connectParticipant({
        roomId: room.roomId,
        role: "viewer",
        viewerGrant: viewerGrant(update),
        clientId: "new-grant-viewer",
        sessionId: "new-grant-session",
      }),
    ).toMatchObject({
      viewerAuthorizationGeneration: update.viewerAuthorizationGeneration,
    });
  });

  it("migrates every v1 room to a distinct locked private digest", () => {
    const directory = mkdtempSync(join(tmpdir(), "screener-room-migration-"));
    const databasePath = join(directory, "rooms.sqlite");
    try {
      createV1Database(databasePath, 2);
      let randomIndex = 0;
      const database = new RoomDatabase(databasePath, (size) =>
        Buffer.alloc(size, ++randomIndex),
      );

      const rooms = database.loadRooms();
      expect(rooms).toHaveLength(2);
      expect(rooms.every((room) => room.viewerGrantDigest?.byteLength === 32)).toBe(
        true,
      );
      expect(rooms[0].viewerGrantDigest).not.toEqual(rooms[1].viewerGrantDigest);
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls a failed v1 migration back to the untouched v1 schema", () => {
    const directory = mkdtempSync(join(tmpdir(), "screener-room-rollback-"));
    const databasePath = join(directory, "rooms.sqlite");
    try {
      createV1Database(databasePath, 2);
      let calls = 0;
      expect(
        () =>
          new RoomDatabase(databasePath, (size) => {
            calls += 1;
            return Buffer.alloc(calls === 2 ? size - 1 : size, calls);
          }),
      ).toThrow("Migration random source digest must contain 32 bytes");

      const inspection = new DatabaseSync(databasePath);
      expect(inspection.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 1,
      });
      expect(
        inspection
          .prepare("PRAGMA table_info(rooms)")
          .all()
          .map((column) => column.name),
      ).toEqual(["id", "host_token_digest"]);
      expect(inspection.prepare("SELECT COUNT(*) AS count FROM rooms").get()).toEqual(
        { count: 2 },
      );
      inspection.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([0, 1.5, MAX_VIEWERS_PER_ROOM_LIMIT + 1])(
    "rejects invalid per-room viewer limit %s",
    (maxViewersPerRoom) => {
      expect(
        () =>
          new RoomStore({
            ttlMs: 10_000,
            maxRooms: 10,
            maxViewersPerRoom,
          }),
      ).toThrow(
        `Room viewer limit must be an integer between 1 and ${MAX_VIEWERS_PER_ROOM_LIMIT}`,
      );
    },
  );
});

function createV1Database(path: string, roomCount: number): void {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_token_digest BLOB NOT NULL CHECK (length(host_token_digest) = 32)
    ) STRICT;
    PRAGMA user_version = 1;
  `);
  const insert = database.prepare(
    "INSERT INTO rooms (host_token_digest) VALUES (?)",
  );
  for (let index = 0; index < roomCount; index += 1) {
    insert.run(Buffer.alloc(32, index + 1));
  }
  database.close();
}
