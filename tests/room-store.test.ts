import { describe, expect, it } from "vitest";

import { RoomStore, RoomStoreError } from "../src/server/room-store.ts";

interface MutableClock {
  nowMs: number;
}

function store(options: Partial<ConstructorParameters<typeof RoomStore>[0]> = {}) {
  const clock: MutableClock = { nowMs: 0 };
  return {
    clock,
    store: new RoomStore({
      leaseMs: 1_000,
      maxRooms: 2,
      maxViewersPerRoom: 2,
      now: () => clock.nowMs,
      ...options,
    }),
  };
}

function hostInput(roomId: string, hostToken: string, sessionId = "host-session") {
  return {
    roomId,
    role: "host" as const,
    token: hostToken,
    clientId: "host-client",
    sessionId,
  };
}

function viewerInput(
  roomId: string,
  sessionId: string,
  viewerGrant?: string,
  clientId = `viewer-${sessionId}`,
) {
  return {
    roomId,
    role: "viewer" as const,
    ...(viewerGrant ? { viewerGrant } : {}),
    clientId,
    sessionId,
  };
}

function expectRoomError(run: () => unknown, code: string) {
  expect(run).toThrow(new RoomStoreError(code as never));
}

describe("RoomStore", () => {
  it("allocates every free four-digit room code and recycles releases", async () => {
    const { store: roomStore } = store({
      maxRooms: 9_000,
      random: (size) => Buffer.alloc(size),
    });

    const rooms = [];
    for (let index = 0; index < 9_000; index += 1) {
      rooms.push(await roomStore.createRoom());
    }
    expect(new Set(rooms.map((room) => room.roomId)).size).toBe(9_000);
    expect(rooms.every((room) => /^[1-9]\d{3}$/.test(room.roomId))).toBe(true);
    await expect(roomStore.createRoom()).rejects.toEqual(
      new RoomStoreError("ROOM_LIMIT"),
    );

    const released = rooms[4_321]!.roomId;
    expect(roomStore.abandonRoom(released)?.roomId).toBe(released);
    expect((await roomStore.createRoom()).roomId).toBe(released);
  });

  it("rejects room limits beyond the four-digit code space", () => {
    expect(() => store({ maxRooms: 9_001 }).store).toThrow(
      "Room limit must be an integer between 1 and 9000",
    );
  });

  it("keeps active sharing alive and renews only with the exact Host token", async () => {
    const { clock, store: roomStore } = store({ leaseMs: 1_000 });
    const room = await roomStore.createRoom();
    const host = roomStore.connectParticipant(
      hostInput(room.roomId, room.hostToken),
    );
    clock.nowMs = 2_000;
    expect(roomStore.expireRooms()).toEqual([]);

    roomStore.disconnectParticipant(
      room.roomId,
      host.peerId,
      "host-session",
    );
    clock.nowMs = 2_500;
    expect(roomStore.expireRooms()).toEqual([]);

    expectRoomError(
      () => roomStore.connectParticipant(hostInput(room.roomId, "wrong-token")),
      "INVALID_TOKEN",
    );
    const resumed = roomStore.connectParticipant(
      hostInput(room.roomId, room.hostToken, "host-session-2"),
    );
    expect(resumed.expiresAt).toBeNull();

    roomStore.disconnectParticipant(
      room.roomId,
      resumed.peerId,
      "host-session-2",
    );
    roomStore.connectParticipant(
      viewerInput(room.roomId, "viewer-session", room.viewerGrant!),
    );
    clock.nowMs = 3_501;
    expect(roomStore.expireRooms()).toHaveLength(1);
    expectRoomError(
      () =>
        roomStore.connectParticipant(
          hostInput(room.roomId, room.hostToken, "late-host"),
        ),
      "INVALID_TOKEN",
    );
  });

  it("keeps Viewer grants independent from code-entry policy", async () => {
    const { store: roomStore } = store({ maxRooms: 3 });
    const room = await roomStore.createRoom("disabled");

    expectRoomError(
      () => roomStore.connectParticipant(viewerInput(room.roomId, "code-only")),
      "INVALID_TOKEN",
    );
    expect(
      roomStore.connectParticipant(
        viewerInput(room.roomId, "granted", room.viewerGrant!),
      ).role,
    ).toBe("viewer");
  });

  it("keeps the exact Viewer grant valid for the room incarnation", async () => {
    const { clock, store: roomStore } = store({ leaseMs: 1_000 });
    const room = await roomStore.createRoom("disabled");
    roomStore.connectParticipant(hostInput(room.roomId, room.hostToken));

    expect(room.viewerGrant).toMatch(/^[A-Za-z0-9_-]{21}[AQgw]$/);
    clock.nowMs = 8 * 24 * 60 * 60 * 1_000;
    expect(
      roomStore.connectParticipant(
        viewerInput(room.roomId, "room-lived-grant", room.viewerGrant!),
      ).role,
    ).toBe("viewer");
  });

  it("supports open, password, and disabled code entry", async () => {
    const { store: roomStore } = store({ maxRooms: 3 });
    const open = await roomStore.createRoom("open");
    expect(
      roomStore.connectParticipant(viewerInput(open.roomId, "open")).role,
    ).toBe("viewer");

    const password = await roomStore.createRoom("password", "room-password");
    expectRoomError(
      () => roomStore.connectParticipant(viewerInput(password.roomId, "wrong")),
      "INVALID_TOKEN",
    );
    expect(
      await roomStore.connectViewerWithPassword({
        roomId: password.roomId,
        password: "room-password",
        clientId: "password-viewer",
        sessionId: "password-session",
      }),
    ).toMatchObject({ role: "viewer" });

    const disabled = await roomStore.createRoom("disabled");
    expectRoomError(
      () => roomStore.connectParticipant(viewerInput(disabled.roomId, "closed")),
      "INVALID_TOKEN",
    );
  });

  it("bounds password derivations and uses the same path for unknown rooms", async () => {
    const { store: roomStore } = store();
    let mayStartCalls = 0;
    const attempts = Array.from({ length: 40 }, (_, index) =>
      roomStore.connectViewerWithPassword(
        {
          roomId: "9999",
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
          result.reason instanceof RoomStoreError,
      ),
    ).toBe(true);
    expect(
      results.filter(
        (result) =>
          result.status === "rejected" &&
          result.reason.code === "ROOM_NOT_FOUND",
      ),
    ).toHaveLength(2);
  });

  it("rotates and revokes Viewer grants without changing code entry", async () => {
    const { store: roomStore } = store();
    const room = await roomStore.createRoom("open");
    roomStore.connectParticipant(hostInput(room.roomId, room.hostToken));

    const rotated = roomStore.setViewerGrant(
      room.roomId,
      "rotate",
      "host-session",
    );
    expectRoomError(
      () =>
        roomStore.connectParticipant(
          viewerInput(room.roomId, "old-grant", room.viewerGrant!),
        ),
      "INVALID_TOKEN",
    );
    const grantedViewer = roomStore.connectParticipant(
      viewerInput(room.roomId, "new-grant", rotated.viewerGrant!),
    );
    const codeViewer = roomStore.connectParticipant(
      viewerInput(room.roomId, "still-open"),
    );

    const revoked = roomStore.setViewerGrant(
      room.roomId,
      "revoke",
      "host-session",
    );
    expect(revoked.viewerGrant).toBeNull();
    expect(revoked.revokedViewers.map((viewer) => viewer.peerId)).toEqual([
      grantedViewer.peerId,
    ]);
    expect(codeViewer.role).toBe("viewer");
    expect(
      roomStore.getConnectedViewer(room.roomId, codeViewer.peerId),
    ).toMatchObject({ sessionId: "still-open" });
    expectRoomError(
      () =>
        roomStore.connectParticipant(
          viewerInput(room.roomId, "revoked", rotated.viewerGrant!),
        ),
      "INVALID_TOKEN",
    );
  });

  it("keeps the old grant and viewers when rotation cannot create a generation", async () => {
    let failedRandomCall: number | null = null;
    let randomCalls = 0;
    let randomValue = 0;
    const { store: roomStore } = store({
      random: (size) => {
        randomCalls += 1;
        return Buffer.alloc(
          randomCalls === failedRandomCall ? size - 1 : size,
          ++randomValue,
        );
      },
    });
    const room = await roomStore.createRoom("disabled");
    roomStore.connectParticipant(hostInput(room.roomId, room.hostToken));
    const viewer = roomStore.connectParticipant(
      viewerInput(room.roomId, "existing", room.viewerGrant!),
    );

    failedRandomCall = randomCalls + 2;
    expect(() =>
      roomStore.setViewerGrant(room.roomId, "rotate", "host-session"),
    ).toThrow("Authorization generation random source must return 16 bytes");
    failedRandomCall = null;

    expect(
      roomStore.getConnectedViewer(room.roomId, viewer.peerId),
    ).toMatchObject({ sessionId: "existing" });
    expect(
      roomStore.connectParticipant(
        viewerInput(room.roomId, "old-grant-still-valid", room.viewerGrant!),
      ).role,
    ).toBe("viewer");
  });

  it("clears every credential on process restart", async () => {
    const { store: firstStore } = store();
    const room = await firstStore.createRoom("password", "room-password");
    const { store: secondStore } = store();

    const replacement = await secondStore.createRoom("open");
    expect(replacement.roomId).toMatch(/^[1-9]\d{3}$/);
    expectRoomError(
      () =>
        secondStore.connectParticipant(
          hostInput(room.roomId, room.hostToken),
        ),
      "INVALID_TOKEN",
    );
    expectRoomError(
      () =>
        secondStore.connectParticipant(
          viewerInput(room.roomId, "old-grant", room.viewerGrant!),
        ),
      "INVALID_TOKEN",
    );
    await expect(
      secondStore.connectViewerWithPassword({
        roomId: room.roomId,
        password: "room-password",
        clientId: "viewer",
        sessionId: "session",
      }),
    ).rejects.toThrow(new RoomStoreError("ROOM_NOT_FOUND"));
  });

  it("rejects an old grant when a new room reuses the same code", async () => {
    const firstStore = store({
      random: (size) => Buffer.alloc(size, size === 8 ? 0 : 1),
    }).store;
    const firstRoom = await firstStore.createRoom("disabled");
    firstStore.abandonRoom(firstRoom.roomId);

    const secondStore = store({
      random: (size) => Buffer.alloc(size, size === 8 ? 0 : 2),
    }).store;
    const secondRoom = await secondStore.createRoom("disabled");

    expect(secondRoom.roomId).toBe(firstRoom.roomId);
    expect(secondRoom.viewerGrant).not.toBe(firstRoom.viewerGrant);
    expectRoomError(
      () =>
        secondStore.connectParticipant(
          viewerInput(secondRoom.roomId, "old-incarnation", firstRoom.viewerGrant!),
        ),
      "INVALID_TOKEN",
    );
  });
});
