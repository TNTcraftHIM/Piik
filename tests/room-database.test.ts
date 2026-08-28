import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { RoomDatabase } from "../src/server/room-database.ts";
import { RoomStore, RoomStoreError } from "../src/server/room-store.ts";

interface MutableClock {
  nowMs: number;
}

const temporaryDirectories: string[] = [];
const stores: RoomStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0).reverse()) {
    store.close();
  }
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "screener-room-db-"));
  temporaryDirectories.push(directory);
  return join(directory, "rooms.sqlite");
}

function stableStore(
  path: string,
  clock: MutableClock,
  options: { maxRooms?: number; leaseMs?: number } = {},
): RoomStore {
  const store = new RoomStore({
    leaseMs: options.leaseMs ?? 1_000,
    maxRooms: options.maxRooms ?? 8,
    maxViewersPerRoom: 8,
    now: () => clock.nowMs,
    database: new RoomDatabase(path),
  });
  store.initialize();
  stores.push(store);
  return store;
}

function hostInput(
  roomId: string,
  hostToken: string,
  sessionId = "host-session",
) {
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
) {
  return {
    roomId,
    role: "viewer" as const,
    ...(viewerGrant ? { viewerGrant } : {}),
    clientId: `client-${sessionId}`,
    sessionId,
  };
}

function closeStore(store: RoomStore): void {
  store.close();
  const index = stores.indexOf(store);
  if (index >= 0) {
    stores.splice(index, 1);
  }
}

describe("SQLite stable room authority", () => {
  it("does not persist a room when password derivation is busy", async () => {
    const path = databasePath();
    const clock = { nowMs: 1_000 };
    const first = stableStore(path, clock, { maxRooms: 1 });
    const attempts = Array.from({ length: 18 }, (_, index) =>
      first.connectViewerWithPassword(
        {
          roomId: "9999",
          password: "gate-password",
          clientId: `gate-client-${index}`,
          sessionId: `gate-session-${index}`,
        },
        () => index < 2,
      ),
    );
    try {
      await expect(
        first.createRoom("private", "room-password", "4321"),
      ).rejects.toEqual(new RoomStoreError("ROOM_BUSY"));
    } finally {
      await Promise.allSettled(attempts);
    }
    expect(first.size).toBe(0);
    closeStore(first);

    const second = stableStore(path, clock, { maxRooms: 1 });
    expect(second.size).toBe(0);
    expect((await second.createRoom("private", null, "4321")).roomId).toBe(
      "4321",
    );
  });

  it("restores the exact authority aggregate without participants", async () => {
    const path = databasePath();
    const clock = { nowMs: 1_000 };
    const first = stableStore(path, clock);
    const room = await first.createRoom("open", null, "4321");
    first.setCodeEntryPolicy(room.roomId, "private", room.hostToken);
    await first.setViewerPassword(
      room.roomId,
      "room-password",
      room.hostToken,
    );
    const rotated = first.setViewerGrant(
      room.roomId,
      "rotate",
      room.hostToken,
    );
    const host = first.connectParticipant(
      hostInput(room.roomId, room.hostToken),
    );
    const oldViewer = first.connectParticipant(
      viewerInput(room.roomId, "old-viewer", rotated.viewerGrant!),
    );
    expect(first.getConnectedHost(room.roomId)).toMatchObject({
      peerId: host.peerId,
    });
    expect(first.getConnectedViewer(room.roomId, oldViewer.peerId)).toBeDefined();
    closeStore(first);

    clock.nowMs = 2_000;
    const second = stableStore(path, clock);
    expect(second.size).toBe(1);
    expect(second.getConnectedHost(room.roomId)).toBeUndefined();
    expect(second.getConnectedViewers(room.roomId)).toEqual([]);
    expect(() =>
      second.connectParticipant(
        viewerInput(room.roomId, "revoked-grant", room.viewerGrant!),
      ),
    ).toThrow(new RoomStoreError("INVALID_TOKEN"));

    const granted = second.connectParticipant(
      viewerInput(room.roomId, "current-grant", rotated.viewerGrant!),
    );
    expect(granted.expiresAt).toBe(new Date(3_000).toISOString());
    expect(granted.viewerAuthorizationGeneration).toBe(
      rotated.viewerAuthorizationGeneration,
    );
    await expect(
      second.connectViewerWithPassword({
        roomId: room.roomId,
        password: "room-password",
        clientId: "password-client",
        sessionId: "password-session",
      }),
    ).resolves.toMatchObject({ codeEntryPolicy: "private" });
    expect(() =>
      second.connectParticipant(hostInput(room.roomId, "wrong-token")),
    ).toThrow(new RoomStoreError("INVALID_TOKEN"));
    expect(
      second.connectParticipant(
        hostInput(room.roomId, room.hostToken, "recovered-host"),
      ).expiresAt,
    ).toBeNull();
    closeStore(second);

    const raw = new DatabaseSync(path);
    try {
      const row = raw.prepare("SELECT * FROM rooms").get() as Record<
        string,
        unknown
      >;
      expect(Object.keys(row).sort()).toEqual(
        [
          "room_id",
          "host_token_digest",
          "viewer_grant_digest",
          "viewer_authorization_generation",
          "code_entry_policy",
          "viewer_password_material",
          "lease_expires_at_ms",
        ].sort(),
      );
      expect(Buffer.from(row.host_token_digest as Uint8Array)).toEqual(
        createHash("sha256").update(room.hostToken).digest(),
      );
      expect(Buffer.from(row.viewer_grant_digest as Uint8Array)).toEqual(
        createHash("sha256").update(rotated.viewerGrant!).digest(),
      );
      expect(row.viewer_password_material).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(row.viewer_password_material as Uint8Array)).toHaveLength(
        48,
      );
      expect(JSON.stringify(row)).not.toContain(room.hostToken);
      expect(JSON.stringify(row)).not.toContain(rotated.viewerGrant!);
      expect(JSON.stringify(row)).not.toContain("room-password");
    } finally {
      raw.close();
    }
  });

  it("converts an active marker once and preserves dormant deadlines", async () => {
    const path = databasePath();
    const clock = { nowMs: 100 };
    const first = stableStore(path, clock);
    const room = await first.createRoom("open", null, "5678");
    first.connectParticipant(hostInput(room.roomId, room.hostToken));
    closeStore(first);

    clock.nowMs = 500;
    const second = stableStore(path, clock);
    const firstRestart = second.connectParticipant(
      viewerInput(room.roomId, "first-restart", room.viewerGrant!),
    );
    expect(firstRestart.expiresAt).toBe(new Date(1_500).toISOString());
    closeStore(second);

    clock.nowMs = 700;
    const third = stableStore(path, clock);
    const secondRestart = third.connectParticipant(
      viewerInput(room.roomId, "second-restart", room.viewerGrant!),
    );
    expect(secondRestart.expiresAt).toBe(new Date(1_500).toISOString());
    closeStore(third);

    clock.nowMs = 1_501;
    const fourth = stableStore(path, clock);
    expect(fourth.size).toBe(0);
    const replacement = await fourth.createRoom("open", null, room.roomId);
    expect(replacement.roomId).toBe(room.roomId);
    expect(() =>
      fourth.connectParticipant(hostInput(room.roomId, room.hostToken)),
    ).toThrow(new RoomStoreError("INVALID_TOKEN"));
    expect(() =>
      fourth.connectParticipant(
        viewerInput(room.roomId, "stale-grant", room.viewerGrant!),
      ),
    ).toThrow(new RoomStoreError("INVALID_TOKEN"));
  });

  it("preserves the exact Host disconnect deadline", async () => {
    const path = databasePath();
    const clock = { nowMs: 100 };
    const first = stableStore(path, clock);
    const room = await first.createRoom("open", null, "5890");
    const host = first.connectParticipant(
      hostInput(room.roomId, room.hostToken),
    );
    clock.nowMs = 250;
    first.disconnectParticipant(room.roomId, host.peerId, "host-session");
    closeStore(first);

    clock.nowMs = 500;
    const second = stableStore(path, clock);
    expect(
      second.connectParticipant(
        viewerInput(room.roomId, "dormant-viewer", room.viewerGrant!),
      ).expiresAt,
    ).toBe(new Date(1_250).toISOString());
  });

  it("persists explicit room deletion before recycling its code", async () => {
    const path = databasePath();
    const clock = { nowMs: 10 };
    const first = stableStore(path, clock);
    const room = await first.createRoom("open", null, "6789");
    expect(first.abandonRoom(room.roomId)?.roomId).toBe(room.roomId);
    closeStore(first);

    const second = stableStore(path, clock);
    expect(second.size).toBe(0);
    const replacement = await second.createRoom("open", null, room.roomId);
    expect(replacement.roomId).toBe(room.roomId);
    expect(replacement.hostToken).not.toBe(room.hostToken);
    expect(replacement.viewerGrant).not.toBe(room.viewerGrant);
  });

  it("rolls back a batch expiry when any exact room authority is stale", async () => {
    const path = databasePath();
    const clock = { nowMs: 10 };
    const first = stableStore(path, clock);
    await first.createRoom("open", null, "4321");
    await first.createRoom("open", null, "5678");
    closeStore(first);

    const database = new RoomDatabase(path);
    const restored = database.initialize(clock.nowMs, 1_010);
    expect(restored).toHaveLength(2);
    expect(() =>
      database.deleteRooms([
        {
          roomId: restored[0]!.roomId,
          hostTokenDigest: restored[0]!.hostTokenDigest,
        },
        {
          roomId: restored[1]!.roomId,
          hostTokenDigest: Buffer.alloc(32),
        },
      ]),
    ).toThrow("Room database delete did not match current authority");
    database.close();

    const second = stableStore(path, clock);
    expect(second.size).toBe(2);
  });

  it("persists room replacement as one authority transition", async () => {
    const path = databasePath();
    const clock = { nowMs: 10 };
    const first = stableStore(path, clock);
    const original = await first.createRoom("open", null, "4321");
    const replacement = await first.replaceRoom(
      original.roomId,
      original.hostToken,
      "private",
      "new-password",
    );
    closeStore(first);

    const second = stableStore(path, clock);
    expect(second.size).toBe(1);
    expect(() =>
      second.connectParticipant(
        hostInput(original.roomId, original.hostToken),
      ),
    ).toThrow(new RoomStoreError("INVALID_TOKEN"));
    expect(
      second.connectParticipant(
        viewerInput(
          replacement.created.roomId,
          "replacement-viewer",
          replacement.created.viewerGrant!,
        ),
      ).roomId,
    ).toBe(replacement.created.roomId);
    await expect(
      second.connectViewerWithPassword({
        roomId: replacement.created.roomId,
        password: "new-password",
        clientId: "password-viewer",
        sessionId: "password-session",
      }),
    ).resolves.toMatchObject({ roomId: replacement.created.roomId });
  });

  it("rejects another owner of the same database", () => {
    const path = databasePath();
    const first = new RoomDatabase(path);
    first.initialize(0, 1_000);
    try {
      const contender = new RoomDatabase(path);
      expect(() => contender.initialize(0, 1_000)).toThrow(/locked/i);
      contender.close();
    } finally {
      first.close();
    }

    const successor = new RoomDatabase(path);
    expect(successor.initialize(0, 1_000)).toEqual([]);
    successor.close();
  });

  it.each([
    ["application identity", "PRAGMA application_id = 1"],
    ["schema version", "PRAGMA user_version = 2"],
  ])("rejects an unknown %s", (_name, mutation) => {
    const path = databasePath();
    const initial = new RoomDatabase(path);
    initial.initialize(0, 1_000);
    initial.close();

    const raw = new DatabaseSync(path);
    raw.exec(mutation);
    raw.close();

    const reopened = new RoomDatabase(path);
    expect(() => reopened.initialize(0, 1_000)).toThrow(/does not match/);
    reopened.close();
  });

  it("rejects an altered current-version schema", () => {
    const path = databasePath();
    const initial = new RoomDatabase(path);
    initial.initialize(0, 1_000);
    initial.close();

    const raw = new DatabaseSync(path);
    raw.exec("ALTER TABLE rooms ADD COLUMN unexpected TEXT");
    raw.close();

    const reopened = new RoomDatabase(path);
    expect(() => reopened.initialize(0, 1_000)).toThrow(
      "Room database columns do not match the current schema",
    );
    reopened.close();
  });

  it("rejects corrupt authority rows instead of partially restoring them", async () => {
    const path = databasePath();
    const clock = { nowMs: 100 };
    const initial = stableStore(path, clock);
    await initial.createRoom("open", null, "7890");
    closeStore(initial);

    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA ignore_check_constraints = ON");
    raw.prepare("UPDATE rooms SET host_token_digest = zeroblob(31)").run();
    raw.close();

    const reopened = new RoomStore({
      leaseMs: 1_000,
      maxRooms: 8,
      maxViewersPerRoom: 8,
      now: () => clock.nowMs,
      database: new RoomDatabase(path),
    });
    expect(() => reopened.initialize()).toThrow(/integrity|Host token/i);
    reopened.close();
  });
});
