import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

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
      clientId: "stable-viewer-client",
      sessionId: "viewer-session-old",
    });
    const replacement = store.connectParticipant({
      roomId: room.roomId,
      role: "viewer",
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
        clientId: `viewer-client-${number}`,
        sessionId: `viewer-session-${number}`,
      }),
    );

    expectRoomError(
      () =>
        store.connectParticipant({
          roomId: room.roomId,
          role: "viewer",
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
