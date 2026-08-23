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

async function expectRoomErrorAsync(
  action: () => Promise<unknown>,
  code: RoomStoreError["code"],
): Promise<void> {
  await expect(action()).rejects.toMatchObject({ code });
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

  it("admits one Host plus the 20-Viewer room ceiling", () => {
    const store = new RoomStore({
      ttlMs: 10_000,
      maxRooms: 10,
      maxViewersPerRoom: MAX_VIEWERS_PER_ROOM_LIMIT,
    });
    const room = store.createRoom();

    expect(
      store.connectParticipant({
        roomId: room.roomId,
        role: "host",
        token: room.hostToken,
        clientId: "host-client",
        sessionId: "host-session",
      }).role,
    ).toBe("host");

    for (let index = 1; index <= MAX_VIEWERS_PER_ROOM_LIMIT; index += 1) {
      expect(
        store.connectParticipant({
          roomId: room.roomId,
          role: "viewer",
          viewerGrant: viewerGrant(room),
          clientId: `viewer-client-${index}`,
          sessionId: `viewer-session-${index}`,
        }).role,
      ).toBe("viewer");
    }

    expectRoomError(
      () =>
        store.connectParticipant({
          roomId: room.roomId,
          role: "viewer",
          viewerGrant: viewerGrant(room),
          clientId: `viewer-client-${MAX_VIEWERS_PER_ROOM_LIMIT + 1}`,
          sessionId: `viewer-session-${MAX_VIEWERS_PER_ROOM_LIMIT + 1}`,
        }),
      "ROOM_FULL",
    );
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

  it("keeps provisional native rooms in memory when persistence is configured", () => {
    let now = Date.UTC(2026, 7, 18, 12);
    const directory = mkdtempSync(join(tmpdir(), "screener-provisional-room-"));
    const databasePath = join(directory, "rooms.sqlite");
    const database = new RoomDatabase(databasePath);
    const store = new RoomStore({
      ttlMs: 14_400_000,
      maxRooms: 3,
      maxViewersPerRoom: 3,
      now: () => now,
      database,
    });
    try {
      const provisional = store.createRoom("private-link", 300);
      expect(provisional.expiresAt).not.toBeNull();
      expect(database.loadRooms()).toEqual([]);

      const persistent = store.createRoom();
      expect(persistent).toMatchObject({ roomId: "1", expiresAt: null });
      expect(database.loadRooms()).toHaveLength(1);

      now += 300_001;
      expect(store.expireRooms()).toEqual([
        { roomId: provisional.roomId, sessionIds: [] },
      ]);
      expect(database.loadRooms()).toHaveLength(1);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reclaims only the disconnected current Host after the provisional lease", () => {
    let now = Date.UTC(2026, 7, 18, 12);
    const store = new RoomStore({
      ttlMs: 14_400_000,
      maxRooms: 2,
      maxViewersPerRoom: 3,
      now: () => now,
    });
    const room = store.createRoom("private-link", 300);
    const first = store.connectParticipant({
      roomId: room.roomId,
      role: "host",
      token: room.hostToken,
      clientId: "native-host",
      sessionId: "native-session-1",
    });

    now += 301_000;
    expect(store.expireRooms()).toEqual([]);
    const replacement = store.connectParticipant({
      roomId: room.roomId,
      role: "host",
      token: room.hostToken,
      clientId: "native-host",
      sessionId: "native-session-2",
    });
    expect(replacement.replacedSessionId).toBe("native-session-1");
    expect(
      store.disconnectParticipant(room.roomId, first.peerId, "native-session-1"),
    ).toBeUndefined();

    now += 301_000;
    expect(store.expireRooms()).toEqual([]);
    expect(
      store.disconnectParticipant(
        room.roomId,
        replacement.peerId,
        "native-session-2",
      ),
    ).toMatchObject({ role: "host" });
    expect(store.expireRooms(now + 299_999)).toEqual([]);
    expect(store.expireRooms(now + 300_001)).toEqual([
      { roomId: room.roomId, sessionIds: [] },
    ]);

    const ttlRoom = store.createRoom("private-link", 300);
    const ttlHost = store.connectParticipant({
      roomId: ttlRoom.roomId,
      role: "host",
      token: ttlRoom.hostToken,
      clientId: "native-ttl-host",
      sessionId: "native-ttl-session",
    });
    expect(store.expireRooms(now + 14_400_001)).toEqual([
      { roomId: ttlRoom.roomId, sessionIds: ["native-ttl-session"] },
    ]);
    expect(ttlHost.hostOnline).toBe(true);
  });

  it("never restores a provisional native room from SQLite after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "screener-provisional-restart-"));
    const databasePath = join(directory, "rooms.sqlite");
    let store: RoomStore | undefined;
    try {
      store = new RoomStore({
        ttlMs: 14_400_000,
        maxRooms: 2,
        maxViewersPerRoom: 3,
        database: new RoomDatabase(databasePath),
      });
      const room = store.createRoom("private-link", 300);
      store.close();
      store = new RoomStore({
        ttlMs: 14_400_000,
        maxRooms: 2,
        maxViewersPerRoom: 3,
        database: new RoomDatabase(databasePath),
      });
      expectRoomError(
        () =>
          store!.connectParticipant({
            roomId: room.roomId,
            role: "host",
            token: room.hostToken,
            clientId: "native-after-restart",
            sessionId: "native-after-restart",
          }),
        "INVALID_TOKEN",
      );
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

  it("accepts, changes, and removes a private room password", async () => {
    const store = new RoomStore({
      ttlMs: 10_000,
      maxRooms: 10,
      maxViewersPerRoom: 5,
    });
    const room = store.createRoom();
    const host = store.connectParticipant({
      roomId: room.roomId,
      role: "host",
      token: room.hostToken,
      clientId: "password-host",
      sessionId: "password-host-session",
    });
    expect(host.viewerPasswordEnabled).toBe(false);

    await expect(
      store.setViewerPassword(
        room.roomId,
        "easy-password",
        "password-host-session",
      ),
    ).resolves.toBe(true);
    await expect(
      store.connectViewerWithPassword({
        roomId: room.roomId,
        password: "easy-password",
        clientId: "password-viewer-1",
        sessionId: "password-viewer-session-1",
      }),
    ).resolves.toMatchObject({ role: "viewer", viewerPasswordEnabled: true });
    await expectRoomErrorAsync(
      () =>
        store.connectViewerWithPassword({
          roomId: room.roomId,
          password: "wrong-password",
          clientId: "wrong-password-viewer",
          sessionId: "wrong-password-session",
        }),
      "INVALID_TOKEN",
    );

    await store.setViewerPassword(
      room.roomId,
      "new-password",
      "password-host-session",
    );
    await expectRoomErrorAsync(
      () =>
        store.connectViewerWithPassword({
          roomId: room.roomId,
          password: "easy-password",
          clientId: "old-password-viewer",
          sessionId: "old-password-session",
        }),
      "INVALID_TOKEN",
    );
    await expect(
      store.connectViewerWithPassword({
        roomId: room.roomId,
        password: "new-password",
        clientId: "password-viewer-2",
        sessionId: "password-viewer-session-2",
      }),
    ).resolves.toMatchObject({ role: "viewer" });

    await expect(
      store.setViewerPassword(room.roomId, null, "password-host-session"),
    ).resolves.toBe(false);
    await expectRoomErrorAsync(
      () =>
        store.connectViewerWithPassword({
          roomId: room.roomId,
          password: "new-password",
          clientId: "removed-password-viewer",
          sessionId: "removed-password-session",
        }),
      "INVALID_TOKEN",
    );
    expect(
      store.connectParticipant({
        roomId: room.roomId,
        role: "viewer",
        viewerGrant: viewerGrant(room),
        clientId: "grant-still-works",
        sessionId: "grant-still-works-session",
      }).role,
    ).toBe("viewer");
  });

  it("bounds pending password derivations and skips stale waiters", async () => {
    const store = new RoomStore({
      ttlMs: 10_000,
      maxRooms: 10,
      maxViewersPerRoom: 3,
    });
    let mayStartCalls = 0;
    const attempts = Array.from({ length: 40 }, (_, index) =>
      store.connectViewerWithPassword(
        {
          roomId: "999999",
          password: "bounded-password",
          clientId: `bounded-client-${index}`,
          sessionId: `bounded-session-${index}`,
        },
        () => {
          mayStartCalls += 1;
          return index < 2;
        },
      ),
    );

    const results = await Promise.allSettled(attempts);
    expect(mayStartCalls).toBe(18);
    expect(
      results.every(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof RoomStoreError &&
          result.reason.code === "INVALID_TOKEN",
      ),
    ).toBe(true);
  });

  it("does not reveal a full private room after a correct password", async () => {
    const store = new RoomStore({
      ttlMs: 10_000,
      maxRooms: 10,
      maxViewersPerRoom: 1,
    });
    const room = store.createRoom();
    store.connectParticipant({
      roomId: room.roomId,
      role: "host",
      token: room.hostToken,
      clientId: "full-password-host",
      sessionId: "full-password-host-session",
    });
    await store.setViewerPassword(
      room.roomId,
      "full-password",
      "full-password-host-session",
    );
    store.connectParticipant({
      roomId: room.roomId,
      role: "viewer",
      viewerGrant: viewerGrant(room),
      clientId: "full-room-viewer",
      sessionId: "full-room-viewer-session",
    });

    await expectRoomErrorAsync(
      () =>
        store.connectViewerWithPassword({
          roomId: room.roomId,
          password: "full-password",
          clientId: "full-password-viewer",
          sessionId: "full-password-viewer-session",
        }),
      "INVALID_TOKEN",
    );
  });

  it("does not commit a password after the Host session is replaced", async () => {
    const store = new RoomStore({
      ttlMs: 10_000,
      maxRooms: 10,
      maxViewersPerRoom: 3,
    });
    const room = store.createRoom();
    store.connectParticipant({
      roomId: room.roomId,
      role: "host",
      token: room.hostToken,
      clientId: "same-host",
      sessionId: "old-host-session",
    });

    const pending = store.setViewerPassword(
      room.roomId,
      "stale-password",
      "old-host-session",
    );
    store.connectParticipant({
      roomId: room.roomId,
      role: "host",
      token: room.hostToken,
      clientId: "same-host",
      sessionId: "new-host-session",
    });

    await expect(pending).rejects.toMatchObject({ code: "INVALID_TOKEN" });
    await expectRoomErrorAsync(
      () =>
        store.connectViewerWithPassword({
          roomId: room.roomId,
          password: "stale-password",
          clientId: "stale-password-viewer",
          sessionId: "stale-password-viewer-session",
        }),
      "INVALID_TOKEN",
    );
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
      expect(rooms.every((room) => room.viewerPasswordMaterial === null)).toBe(
        true,
      );
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("migrates v2 rooms to a nullable checked password material column", () => {
    const directory = mkdtempSync(join(tmpdir(), "screener-room-v2-migration-"));
    const databasePath = join(directory, "rooms.sqlite");
    try {
      createV2Database(databasePath);
      const database = new RoomDatabase(databasePath);
      expect(database.loadRooms()).toMatchObject([
        { roomId: "1", viewerPasswordMaterial: null },
      ]);
      database.updateViewerPassword("1", Buffer.alloc(48, 7));
      expect(database.loadRooms()[0].viewerPasswordMaterial).toEqual(
        Buffer.alloc(48, 7),
      );
      expect(() =>
        database.updateViewerPassword("1", Buffer.alloc(47)),
      ).toThrow("Viewer password material must contain 48 bytes");
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

function createV2Database(path: string): void {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_token_digest BLOB NOT NULL CHECK (length(host_token_digest) = 32),
      viewer_grant_digest BLOB NULL
        CHECK (viewer_grant_digest IS NULL OR length(viewer_grant_digest) = 32)
    ) STRICT;
    PRAGMA user_version = 2;
  `);
  database
    .prepare(
      "INSERT INTO rooms (host_token_digest, viewer_grant_digest) VALUES (?, ?)",
    )
    .run(Buffer.alloc(32, 1), Buffer.alloc(32, 2));
  database.close();
}
