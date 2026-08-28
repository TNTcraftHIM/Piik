import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_VIEWERS_PER_ROOM_LIMIT,
  createRoomResponseSchema,
  roomAccessUpdateResponseSchema,
} from "../src/shared/protocol.ts";
import {
  createScreenerServer,
  type CreateServerOptions,
  type ScreenerServer,
} from "../src/server/app.ts";
import type { ServerConfig } from "../src/server/config.ts";
import {
  ROOM_CAPACITY,
  RoomStore,
  RoomStoreError,
} from "../src/server/room-store.ts";
import { FakeSfuRoomControl } from "./fake-sfu-room-control.ts";

const allowedOrigin = "http://allowed.test";
const siteAccessPassword = "instance-access-password";
let runningServer: ScreenerServer | undefined;
const temporaryDirectories: string[] = [];
afterEach(async () => {
  try {
    await runningServer?.close();
    runningServer = undefined;
  } finally {
    for (const directory of temporaryDirectories.splice(0).reverse()) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

function temporaryRoomDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "screener-server-room-db-"));
  temporaryDirectories.push(directory);
  return join(directory, "rooms.sqlite");
}

function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    nodeEnv: "test",
    port: 0,
    listenHost: "127.0.0.1",
    publicBaseUrl: new URL("https://share.example.test"),
    allowedOrigins: new Set([allowedOrigin]),
    siteAccessPassword,
    roomLeaseMs: 86_400_000,
    maxViewersPerRoom: 8,
    peerAssistedMedia: false,
    endpointMediaCopyCapacity: 2,
    stunUrls: [],
    ...overrides,
  };
}

async function start(
  config = testConfig(),
  options: Pick<
    CreateServerOptions,
    | "now"
    | "roomStore"
    | "siteAccessTtlSeconds"
    | "sfuTokenIssuer"
    | "sfuRoomControl"
  > = {},
): Promise<string> {
  const sfuRoomControl =
    options.sfuRoomControl ??
    (config.livekitFallback ? new FakeSfuRoomControl() : undefined);
  runningServer = await createScreenerServer({
    ...options,
    ...(sfuRoomControl ? { sfuRoomControl } : {}),
    config,
    serveFrontend: false,
  });
  const port = await runningServer.listen(0, "127.0.0.1");
  return `http://127.0.0.1:${port}`;
}

function cookiePair(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error("Expected a Set-Cookie header");
  }
  return setCookie.split(";", 1)[0]!;
}

async function login(baseUrl: string): Promise<Response> {
  return fetch(`${baseUrl}/api/site-access`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${siteAccessPassword}`,
      Origin: allowedOrigin,
    },
  });
}

async function createRoom(
  baseUrl: string,
  cookie?: string,
  codeEntryPolicy: "open" | "private" = "open",
  roomPassword?: string,
  preferredRoomId?: string,
): Promise<Response> {
  return fetch(`${baseUrl}/api/rooms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: allowedOrigin,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({
      codeEntryPolicy,
      ...(roomPassword === undefined ? {} : { roomPassword }),
      ...(preferredRoomId === undefined ? {} : { preferredRoomId }),
    }),
  });
}

async function updateRoomAccess(
  baseUrl: string,
  roomId: string,
  hostToken: string | undefined,
  body: unknown,
  options: { cookie?: string; origin?: string; method?: string } = {},
): Promise<Response> {
  return fetch(`${baseUrl}/api/rooms/${roomId}/access`, {
    method: options.method ?? "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: options.origin ?? allowedOrigin,
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(hostToken ? { Authorization: `Bearer ${hostToken}` } : {}),
    },
    body:
      (options.method ?? "POST") === "POST"
        ? JSON.stringify(body)
        : undefined,
  });
}

async function replaceRoom(
  baseUrl: string,
  roomId: string,
  hostToken: string,
  body: unknown,
  cookie?: string,
): Promise<Response> {
  return fetch(`${baseUrl}/api/rooms/${roomId}/replacement`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: allowedOrigin,
      Authorization: `Bearer ${hostToken}`,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("site access", () => {
  it("reports status and issues a stateless 24-hour cookie", async () => {
    const baseUrl = await start();
    const initial = await fetch(`${baseUrl}/api/site-access`);

    expect(initial.status).toBe(200);
    expect(initial.headers.get("cache-control")).toBe("no-store");
    expect(initial.headers.get("set-cookie")).toBeNull();
    expect(await initial.json()).toEqual({
      required: true,
      authenticated: false,
    });

    const denied = await fetch(`${baseUrl}/api/site-access`, {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong-password",
        Origin: allowedOrigin,
      },
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("set-cookie")).toBeNull();

    const authenticated = await login(baseUrl);
    const setCookie = authenticated.headers.get("set-cookie") ?? "";
    expect(authenticated.status).toBe(200);
    expect(setCookie).toContain("screener-site-access=v1.");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=86400");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("Secure");
    expect(setCookie).not.toContain(siteAccessPassword);

    const deniedRenewal = await fetch(`${baseUrl}/api/site-access`, {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong-password",
        Cookie: cookiePair(authenticated),
        Origin: allowedOrigin,
      },
    });
    expect(deniedRenewal.status).toBe(401);
    expect(deniedRenewal.headers.get("set-cookie")).toBeNull();

    const status = await fetch(`${baseUrl}/api/site-access`, {
      headers: { Cookie: cookiePair(authenticated) },
    });
    expect(status.headers.get("set-cookie")).toContain(
      "screener-site-access=v1.",
    );
    expect(await status.json()).toEqual({
      required: true,
      authenticated: true,
    });
  });

  it("renews an authenticated cookie across successive idle deadlines", async () => {
    let now = 1_000;
    const baseUrl = await start(testConfig(), {
      now: () => now,
      siteAccessTtlSeconds: 12,
    });
    const authenticated = await login(baseUrl);
    const originalCookie = cookiePair(authenticated);

    now = 7_000;
    const firstRenewal = await fetch(`${baseUrl}/api/site-access`, {
      headers: { Cookie: originalCookie },
    });
    const firstRenewedCookie = cookiePair(firstRenewal);
    expect(firstRenewedCookie).not.toBe(originalCookie);

    now = 13_000;
    const expiredOriginal = await fetch(`${baseUrl}/api/site-access`, {
      headers: { Cookie: originalCookie },
    });
    expect(expiredOriginal.headers.get("set-cookie")).toBeNull();
    expect((await expiredOriginal.json()).authenticated).toBe(false);

    const secondRenewal = await fetch(`${baseUrl}/api/site-access`, {
      headers: { Cookie: firstRenewedCookie },
    });
    const secondRenewedCookie = cookiePair(secondRenewal);
    expect(secondRenewedCookie).not.toBe(firstRenewedCookie);

    now = 20_000;
    const expiredFirstRenewal = await fetch(`${baseUrl}/api/site-access`, {
      headers: { Cookie: firstRenewedCookie },
    });
    expect(expiredFirstRenewal.headers.get("set-cookie")).toBeNull();
    expect((await expiredFirstRenewal.json()).authenticated).toBe(false);

    const activeSecondRenewal = await fetch(`${baseUrl}/api/site-access`, {
      headers: { Cookie: secondRenewedCookie },
    });
    expect(activeSecondRenewal.headers.get("set-cookie")).not.toBeNull();
    expect((await activeSecondRenewal.json()).authenticated).toBe(true);
  });

  it("uses a secure __Host- cookie for production HTTPS", async () => {
    const baseUrl = await start(testConfig({ nodeEnv: "production" }));
    const response = await login(baseUrl);
    const setCookie = response.headers.get("set-cookie") ?? "";

    expect(setCookie).toContain("__Host-screener-site-access=");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("Domain=");
  });

  it("requires an allowed Origin and an empty login body", async () => {
    const baseUrl = await start();
    const authorization = {
      Authorization: `Bearer ${siteAccessPassword}`,
    };

    expect(
      (
        await fetch(`${baseUrl}/api/site-access`, {
          method: "POST",
          headers: authorization,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${baseUrl}/api/site-access`, {
          method: "POST",
          headers: { ...authorization, Origin: "https://foreign.test" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${baseUrl}/api/site-access`, {
          method: "POST",
          headers: { ...authorization, Origin: `${allowedOrigin}/path` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${baseUrl}/api/site-access`, {
          method: "POST",
          headers: { ...authorization, Origin: allowedOrigin },
          body: "{}",
        })
      ).status,
    ).toBe(400);
  });

  it("rejects an expired or modified cookie", async () => {
    let now = 1_000;
    const baseUrl = await start(testConfig(), {
      now: () => now,
      siteAccessTtlSeconds: 1,
    });
    const authenticated = await login(baseUrl);
    const cookie = cookiePair(authenticated);

    const modified = await fetch(`${baseUrl}/api/site-access`, {
      headers: { Cookie: `${cookie}x` },
    });
    expect((await modified.json()).authenticated).toBe(false);

    now = 2_000;
    const expired = await fetch(`${baseUrl}/api/site-access`, {
      headers: { Cookie: cookie },
    });
    expect(await expired.json()).toEqual({
      required: true,
      authenticated: false,
    });
  });

  it("is immediately authenticated when the access password is empty", async () => {
    const baseUrl = await start(
      testConfig({ siteAccessPassword: undefined }),
    );
    const status = await fetch(`${baseUrl}/api/site-access`);

    expect(await status.json()).toEqual({
      required: false,
      authenticated: true,
    });
    const post = await fetch(`${baseUrl}/api/site-access`, {
      method: "POST",
      headers: { Origin: allowedOrigin },
    });
    expect(post.status).toBe(200);
    expect(post.headers.get("set-cookie")).toBeNull();
  });
});

describe("room HTTP API", () => {
  it("requires a logged-in browser when access protection is enabled", async () => {
    const baseUrl = await start();
    const anonymous = await createRoom(baseUrl);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBeNull();

    const bearerBypass = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${siteAccessPassword}`,
        "Content-Type": "application/json",
        Origin: allowedOrigin,
      },
      body: JSON.stringify({ codeEntryPolicy: "open" }),
    });
    expect(bearerBypass.status).toBe(401);
  });

  it("creates a room with an independent fragment-only Viewer grant", async () => {
    const baseUrl = await start();
    const authenticated = await login(baseUrl);
    const response = await createRoom(baseUrl, cookiePair(authenticated));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = createRoomResponseSchema.parse(await response.json());
    const invite = new URL(body.inviteUrl);
    expect(body.roomId).toMatch(/^[1-9]\d{3}$/);
    expect(invite.origin).toBe("https://share.example.test");
    expect(invite.pathname).toBe(`/r/${body.roomId}`);
    expect(invite.hash).toMatch(/^#v=[A-Za-z0-9_-]{21}[AQgw]$/);
    expect(invite.search).toBe("");
    expect(body.codeEntryPolicy).toBe("open");
    expect("viewerGrantExpiresAt" in body).toBe(false);
    expect(body.expiresAt).toBeTruthy();
    expect(body.roomLeaseSeconds).toBe(86_400);
    expect("iceConfig" in body).toBe(false);
  });

  it("passes the shared Viewer ceiling to room admission", async () => {
    const baseUrl = await start(
      testConfig({
        siteAccessPassword: undefined,
        maxViewersPerRoom: MAX_VIEWERS_PER_ROOM_LIMIT,
      }),
    );

    expect((await createRoom(baseUrl)).status).toBe(201);
    expect(runningServer?.roomStore.maxViewersPerRoom).toBe(
      MAX_VIEWERS_PER_ROOM_LIMIT,
    );
  });

  it("creates private rooms with optional passwords atomically", async () => {
    const baseUrl = await start();
    const authenticated = await login(baseUrl);
    const cookie = cookiePair(authenticated);
    const response = await createRoom(
      baseUrl,
      cookie,
      "private",
      "room-password",
    );
    expect(response.status).toBe(201);
    expect(createRoomResponseSchema.parse(await response.json())).toMatchObject({
      codeEntryPolicy: "private",
    });

    const withoutPassword = await createRoom(baseUrl, cookie, "private");
    expect(withoutPassword.status).toBe(201);
    expect(
      createRoomResponseSchema.parse(await withoutPassword.json()),
    ).toMatchObject({ codeEntryPolicy: "private" });
  });

  it("allows explicit open creation without site access in local mode", async () => {
    const baseUrl = await start(
      testConfig({ siteAccessPassword: undefined }),
    );
    const response = await createRoom(baseUrl, undefined, "open");
    expect(response.status).toBe(201);
    const body = createRoomResponseSchema.parse(await response.json());
    expect(body).toMatchObject({
      codeEntryPolicy: "open",
    });
    expect(new URL(body.inviteUrl).hash).toContain("#v=");
  });

  it("allocates unique four-digit codes concurrently", async () => {
    const baseUrl = await start();
    const authenticated = await login(baseUrl);
    const cookie = cookiePair(authenticated);
    const create = () => createRoom(baseUrl, cookie);

    const responses = await Promise.all([create(), create()]);
    const rooms = await Promise.all(
      responses.map(async (response) =>
        createRoomResponseSchema.parse(await response.json()),
      ),
    );
    expect(new Set(rooms.map((room) => room.roomId)).size).toBe(2);
    expect(rooms.every((room) => room.expiresAt !== null)).toBe(true);
  });

  it("reuses a free preferred code and never replaces an occupied room", async () => {
    const baseUrl = await start(testConfig({ roomLeaseMs: 90_000 }));
    const authenticated = await login(baseUrl);
    const cookie = cookiePair(authenticated);

    const preferred = createRoomResponseSchema.parse(
      await (await createRoom(baseUrl, cookie, "open", undefined, "4321")).json(),
    );
    const fallback = createRoomResponseSchema.parse(
      await (await createRoom(baseUrl, cookie, "open", undefined, "4321")).json(),
    );

    expect(preferred.roomId).toBe("4321");
    expect(preferred.roomLeaseSeconds).toBe(90);
    expect(fallback.roomId).not.toBe("4321");
    expect(fallback.hostToken).not.toBe(preferred.hostToken);
  });

  it("replaces a room with a different authority and closes old membership", async () => {
    const baseUrl = await start();
    const authenticated = await login(baseUrl);
    const cookie = cookiePair(authenticated);
    const original = createRoomResponseSchema.parse(
      await (
        await createRoom(baseUrl, cookie, "private", "old-password", "4321")
      ).json(),
    );
    const host = runningServer!.roomStore.connectParticipant({
      roomId: original.roomId,
      role: "host",
      token: original.hostToken,
      clientId: "host-client",
      sessionId: "host-session",
    });
    runningServer!.roomStore.connectParticipant({
      roomId: original.roomId,
      role: "viewer",
      viewerGrant: new URL(original.inviteUrl).hash.slice(3),
      clientId: "viewer-client",
      sessionId: "viewer-session",
    });

    expect(
      (
        await replaceRoom(
          baseUrl,
          original.roomId,
          original.hostToken,
          { codeEntryPolicy: "open" },
        )
      ).status,
    ).toBe(401);
    const response = await replaceRoom(
      baseUrl,
      original.roomId,
      original.hostToken,
      { codeEntryPolicy: "private", roomPassword: "new-password" },
      cookie,
    );
    expect(response.status).toBe(201);
    const replacement = createRoomResponseSchema.parse(await response.json());

    expect(replacement.roomId).not.toBe(original.roomId);
    expect(replacement.codeEntryPolicy).toBe("private");
    expect(runningServer!.roomStore.getConnectedHost(original.roomId)).toBeUndefined();
    expect(runningServer!.roomStore.getConnectedViewers(original.roomId)).toEqual([]);
    expect(() =>
      runningServer!.roomStore.connectParticipant({
        roomId: original.roomId,
        role: "host",
        token: original.hostToken,
        clientId: "old-host",
        sessionId: "old-session",
      }),
    ).toThrow(new RoomStoreError("INVALID_TOKEN"));
    expect(host.peerId).toBeTruthy();
  });

  it("keeps valid Host authority on a transient replacement rejection", async () => {
    const config = testConfig();
    const roomStore = new RoomStore({
      leaseMs: config.roomLeaseMs,
      maxRooms: ROOM_CAPACITY,
      maxViewersPerRoom: config.maxViewersPerRoom,
    });
    const original = await roomStore.createRoom("private", "room-password");
    vi.spyOn(roomStore, "replaceRoom").mockRejectedValueOnce(
      new RoomStoreError("ROOM_ACCESS_DENIED"),
    );
    const baseUrl = await start(config, { roomStore });
    const cookie = cookiePair(await login(baseUrl));

    const response = await replaceRoom(
      baseUrl,
      original.roomId,
      original.hostToken,
      { codeEntryPolicy: "private", roomPassword: "room-password" },
      cookie,
    );

    expect(response.status).toBe(503);
    expect(
      roomStore.connectParticipant({
        roomId: original.roomId,
        role: "host",
        token: original.hostToken,
        clientId: "retained-host",
        sessionId: "retained-host-session",
      }).roomId,
    ).toBe(original.roomId);
  });

  it("maps a busy password gate to 503 for every HTTP mutation", async () => {
    const config = testConfig();
    const roomStore = new RoomStore({
      leaseMs: config.roomLeaseMs,
      maxRooms: ROOM_CAPACITY,
      maxViewersPerRoom: config.maxViewersPerRoom,
    });
    const original = await roomStore.createRoom("private", "room-password");
    const baseUrl = await start(config, { roomStore });
    const cookie = cookiePair(await login(baseUrl));

    vi.spyOn(roomStore, "createRoom").mockRejectedValueOnce(
      new RoomStoreError("ROOM_BUSY"),
    );
    const creation = await createRoom(
      baseUrl,
      cookie,
      "private",
      "room-password",
    );
    expect(creation.status).toBe(503);
    expect(await creation.json()).toEqual({
      error: "Room creation unavailable",
    });

    vi.spyOn(roomStore, "replaceRoom").mockRejectedValueOnce(
      new RoomStoreError("ROOM_BUSY"),
    );
    const replacement = await replaceRoom(
      baseUrl,
      original.roomId,
      original.hostToken,
      { codeEntryPolicy: "private", roomPassword: "room-password" },
      cookie,
    );
    expect(replacement.status).toBe(503);
    expect(await replacement.json()).toEqual({
      error: "Room replacement unavailable",
    });

    vi.spyOn(roomStore, "setViewerPassword").mockRejectedValueOnce(
      new RoomStoreError("ROOM_BUSY"),
    );
    const update = await updateRoomAccess(
      baseUrl,
      original.roomId,
      original.hostToken,
      { action: "set-viewer-password", password: "room-password" },
      { cookie },
    );
    expect(update.status).toBe(503);
    expect(await update.json()).toEqual({
      error: "Room access update unavailable",
    });
    expect(roomStore.size).toBe(1);
  });

  it("manages dormant room access without starting sharing or renewing", async () => {
    let nowMs = 0;
    const baseUrl = await start(
      testConfig({ roomLeaseMs: 1_000 }),
      { now: () => nowMs },
    );
    const authenticated = await login(baseUrl);
    const cookie = cookiePair(authenticated);
    const createdResponse = await createRoom(baseUrl, cookie);
    const room = createRoomResponseSchema.parse(await createdResponse.json());
    nowMs = 900;

    const policy = await updateRoomAccess(
      baseUrl,
      room.roomId,
      room.hostToken,
      { action: "set-code-entry-policy", policy: "private" },
      { cookie },
    );
    expect(policy.status).toBe(200);
    expect(policy.headers.get("cache-control")).toBe("no-store");
    expect(roomAccessUpdateResponseSchema.parse(await policy.json())).toEqual({
      type: "code-entry-policy-updated",
      codeEntryPolicy: "private",
      viewerPasswordEnabled: false,
    });

    const password = await updateRoomAccess(
      baseUrl,
      room.roomId,
      room.hostToken,
      { action: "set-viewer-password", password: "room-password" },
      { cookie },
    );
    expect(roomAccessUpdateResponseSchema.parse(await password.json())).toEqual({
      type: "viewer-password-updated",
      enabled: true,
    });
    const removedPassword = await updateRoomAccess(
      baseUrl,
      room.roomId,
      room.hostToken,
      { action: "set-viewer-password", password: null },
      { cookie },
    );
    expect(
      roomAccessUpdateResponseSchema.parse(await removedPassword.json()),
    ).toEqual({
      type: "viewer-password-updated",
      enabled: false,
    });

    const rotated = await updateRoomAccess(
      baseUrl,
      room.roomId,
      room.hostToken,
      { action: "rotate-viewer-grant" },
      { cookie },
    );
    const rotatedBody = roomAccessUpdateResponseSchema.parse(
      await rotated.json(),
    );
    expect(rotatedBody.type).toBe("viewer-grant-updated");
    expect(rotatedBody.type === "viewer-grant-updated" && rotatedBody.inviteUrl)
      .toMatch(/#v=[A-Za-z0-9_-]{22}$/);

    const revoked = await updateRoomAccess(
      baseUrl,
      room.roomId,
      room.hostToken,
      { action: "revoke-viewer-grant" },
      { cookie },
    );
    expect(roomAccessUpdateResponseSchema.parse(await revoked.json())).toMatchObject({
      type: "viewer-grant-updated",
      inviteUrl: null,
    });
    expect(runningServer?.roomStore.getConnectedHost(room.roomId)).toBeUndefined();

    nowMs = 1_001;
    expect(
      runningServer?.roomStore
        .expireRooms()
        .map((expired) => expired.roomId),
    ).toContain(room.roomId);
  });

  it("requires same-origin site access and the exact room Host token", async () => {
    const baseUrl = await start();
    const authenticated = await login(baseUrl);
    const cookie = cookiePair(authenticated);
    const first = createRoomResponseSchema.parse(
      await (await createRoom(baseUrl, cookie)).json(),
    );
    const second = createRoomResponseSchema.parse(
      await (await createRoom(baseUrl, cookie)).json(),
    );
    const action = { action: "rotate-viewer-grant" };

    expect(
      (await updateRoomAccess(baseUrl, first.roomId, first.hostToken, action))
        .status,
    ).toBe(401);
    expect(
      (
        await updateRoomAccess(baseUrl, first.roomId, first.hostToken, action, {
          cookie,
          origin: "https://foreign.test",
        })
      ).status,
    ).toBe(403);
    expect(
      (await updateRoomAccess(baseUrl, first.roomId, undefined, action, { cookie }))
        .status,
    ).toBe(404);
    expect(
      (
        await updateRoomAccess(baseUrl, first.roomId, "wrong-token", action, {
          cookie,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await updateRoomAccess(baseUrl, first.roomId, second.hostToken, action, {
          cookie,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await updateRoomAccess(
          baseUrl,
          first.roomId,
          first.hostToken,
          { action: "unknown" },
          { cookie },
        )
      ).status,
    ).toBe(400);
    const method = await updateRoomAccess(
      baseUrl,
      first.roomId,
      first.hostToken,
      action,
      { cookie, method: "GET" },
    );
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("POST");
  });

  it("rejects malformed room requests and foreign browser origins", async () => {
    const baseUrl = await start(
      testConfig({ siteAccessPassword: undefined }),
    );
    const withBody = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: allowedOrigin,
      },
      body: "{}",
    });
    expect(withBody.status).toBe(400);

    const foreign = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://foreign.test" },
      body: JSON.stringify({ codeEntryPolicy: "open" }),
    });
    expect(foreign.status).toBe(403);
  });

  it("returns service unavailable at the global room bound", async () => {
    const baseUrl = await start(
      testConfig({ siteAccessPassword: undefined }),
      {
        roomStore: new RoomStore({
          leaseMs: 86_400_000,
          maxRooms: 1,
          maxViewersPerRoom: 8,
        }),
      },
    );
    const create = () => createRoom(baseUrl);

    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(503);
  });
});

describe("server HTTP listener and health", () => {
  it("restores stable room authority across an application restart", async () => {
    const roomDatabasePath = temporaryRoomDatabasePath();
    let nowMs = 100;
    const config = testConfig({
      siteAccessPassword: undefined,
      roomDatabasePath,
      roomLeaseMs: 1_000,
    });
    const first = await createScreenerServer({
      config,
      serveFrontend: false,
      now: () => nowMs,
    });
    let second: ScreenerServer | undefined;
    try {
      const firstPort = await first.listen(0, "127.0.0.1");
      const created = createRoomResponseSchema.parse(
        await (
          await createRoom(`http://127.0.0.1:${firstPort}`, undefined, "private")
        ).json(),
      );
      await first.close();

      nowMs = 200;
      second = await createScreenerServer({
        config,
        serveFrontend: false,
        now: () => nowMs,
      });
      const secondPort = await second.listen(0, "127.0.0.1");
      expect(second.roomStore.size).toBe(1);
      const update = await updateRoomAccess(
        `http://127.0.0.1:${secondPort}`,
        created.roomId,
        created.hostToken,
        { action: "set-code-entry-policy", policy: "open" },
      );
      expect(update.status).toBe(200);
      expect(await update.json()).toMatchObject({
        type: "code-entry-policy-updated",
        codeEntryPolicy: "open",
      });
    } finally {
      await second?.close();
      await first.close();
    }
  });

  it("starts with an injected optional SFU token issuer", async () => {
    const baseUrl = await start(
      testConfig({
        peerAssistedMedia: true,
        livekitFallback: {
          url: "ws://livekit.test:7880",
          apiUrl: "http://livekit.test:7880",
          apiKey: "test-key",
          apiSecret: "s".repeat(32),
        },
      }),
      {
        sfuTokenIssuer: {
          issueToken: async () => "unused-test-token",
        },
      },
    );

    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
  });

  it("clears a stale managed LiveKit room before a restarted server serves traffic", async () => {
    const roomControl = new FakeSfuRoomControl();
    const staleFence = {
      roomId: "42",
      shareGeneration: "stale_share_generation",
      publicationGeneration: "stale_publication_generation",
    };
    roomControl.seedRoom(staleFence, ["host", "viewer:stale"]);
    const baseUrl = await start(
      testConfig({
        peerAssistedMedia: true,
        livekitFallback: {
          url: "ws://livekit.test:7880",
          apiUrl: "http://127.0.0.1:7880",
          apiKey: "test-key",
          apiSecret: "s".repeat(32),
        },
      }),
      {
        sfuTokenIssuer: {
          issueToken: async () => "unused-test-token",
        },
        sfuRoomControl: roomControl,
      },
    );

    expect(roomControl.initializeCalls).toBe(1);
    expect(roomControl.startupDeletedRoomNames).toHaveLength(1);
    expect(roomControl.rooms.size).toBe(0);
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
  });

  it("binds the application listener before LiveKit reconciliation", async () => {
    let releaseInitialization!: () => void;
    const roomControl = new FakeSfuRoomControl();
    roomControl.initializeBarrier = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });
    runningServer = await createScreenerServer({
      config: testConfig({
        peerAssistedMedia: true,
        livekitFallback: {
          url: "ws://livekit.test:7880",
          apiUrl: "http://127.0.0.1:7880",
          apiKey: "test-key",
          apiSecret: "s".repeat(32),
        },
      }),
      serveFrontend: false,
      sfuRoomControl: roomControl,
      sfuTokenIssuer: {
        issueToken: async () => "unused-test-token",
      },
    });

    const listen = runningServer.listen(0, "127.0.0.1");
    try {
      await vi.waitFor(() => {
        expect(roomControl.initializeCalls).toBe(1);
        expect(runningServer?.httpServer.address()).not.toBeNull();
      });
      const address = runningServer.httpServer.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a TCP server address");
      }
      expect(runningServer.httpServer.listenerCount("upgrade")).toBe(0);
      const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
    } finally {
      releaseInitialization();
    }

    await expect(listen).resolves.toBeGreaterThan(0);
    expect(runningServer.httpServer.listenerCount("upgrade")).toBe(1);
  });

  it("makes no LiveKit call when another process owns the listener", async () => {
    const owner = await createScreenerServer({
      config: testConfig(),
      serveFrontend: false,
    });
    const ownerPort = await owner.listen(0, "127.0.0.1");
    const unavailableDatabasePath = join(
      temporaryRoomDatabasePath(),
      "missing-parent",
      "rooms.sqlite",
    );
    const roomControl = new FakeSfuRoomControl();
    const contender = await createScreenerServer({
      config: testConfig({
        roomDatabasePath: unavailableDatabasePath,
        peerAssistedMedia: true,
        livekitFallback: {
          url: "ws://livekit.test:7880",
          apiUrl: "http://127.0.0.1:7880",
          apiKey: "test-key",
          apiSecret: "s".repeat(32),
        },
      }),
      serveFrontend: false,
      sfuRoomControl: roomControl,
      sfuTokenIssuer: {
        issueToken: async () => "unused-test-token",
      },
    });

    try {
      await expect(contender.listen(ownerPort, "127.0.0.1")).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
      expect(roomControl.initializeCalls).toBe(0);
      expect(existsSync(unavailableDatabasePath)).toBe(false);
    } finally {
      await contender.close();
      await owner.close();
    }
  });

  it("rejects a second database owner before LiveKit reconciliation", async () => {
    const roomDatabasePath = temporaryRoomDatabasePath();
    const owner = await createScreenerServer({
      config: testConfig({ roomDatabasePath }),
      serveFrontend: false,
    });
    await owner.listen(0, "127.0.0.1");
    const roomControl = new FakeSfuRoomControl();
    const contender = await createScreenerServer({
      config: testConfig({
        roomDatabasePath,
        peerAssistedMedia: true,
        livekitFallback: {
          url: "ws://livekit.test:7880",
          apiUrl: "http://127.0.0.1:7880",
          apiKey: "test-key",
          apiSecret: "s".repeat(32),
        },
      }),
      serveFrontend: false,
      sfuRoomControl: roomControl,
      sfuTokenIssuer: {
        issueToken: async () => "unused-test-token",
      },
    });

    try {
      await expect(contender.listen(0, "127.0.0.1")).rejects.toThrow(
        /locked/i,
      );
      expect(roomControl.initializeCalls).toBe(0);
      expect(contender.httpServer.listening).toBe(false);
      expect(contender.httpServer.listenerCount("upgrade")).toBe(0);
    } finally {
      await contender.close();
      await owner.close();
    }
  });

  it("rejects a mismatched database before LiveKit reconciliation", async () => {
    const roomDatabasePath = temporaryRoomDatabasePath();
    const raw = new DatabaseSync(roomDatabasePath);
    raw.exec("CREATE TABLE unrelated(value TEXT) STRICT");
    raw.close();
    const roomControl = new FakeSfuRoomControl();
    runningServer = await createScreenerServer({
      config: testConfig({
        roomDatabasePath,
        peerAssistedMedia: true,
        livekitFallback: {
          url: "ws://livekit.test:7880",
          apiUrl: "http://127.0.0.1:7880",
          apiKey: "test-key",
          apiSecret: "s".repeat(32),
        },
      }),
      serveFrontend: false,
      sfuRoomControl: roomControl,
      sfuTokenIssuer: {
        issueToken: async () => "unused-test-token",
      },
    });

    await expect(runningServer.listen(0, "127.0.0.1")).rejects.toThrow(
      "Room database application identity does not match",
    );
    expect(roomControl.initializeCalls).toBe(0);
    expect(runningServer.httpServer.listening).toBe(false);
    expect(runningServer.httpServer.listenerCount("upgrade")).toBe(0);
  });

  it("rejects an inaccessible database path before LiveKit reconciliation", async () => {
    const roomDatabasePath = join(
      temporaryRoomDatabasePath(),
      "missing-parent",
      "rooms.sqlite",
    );
    const roomControl = new FakeSfuRoomControl();
    runningServer = await createScreenerServer({
      config: testConfig({
        roomDatabasePath,
        peerAssistedMedia: true,
        livekitFallback: {
          url: "ws://livekit.test:7880",
          apiUrl: "http://127.0.0.1:7880",
          apiKey: "test-key",
          apiSecret: "s".repeat(32),
        },
      }),
      serveFrontend: false,
      sfuRoomControl: roomControl,
      sfuTokenIssuer: {
        issueToken: async () => "unused-test-token",
      },
    });

    await expect(runningServer.listen(0, "127.0.0.1")).rejects.toThrow();
    expect(roomControl.initializeCalls).toBe(0);
    expect(existsSync(roomDatabasePath)).toBe(false);
    expect(runningServer.httpServer.listening).toBe(false);
    expect(runningServer.httpServer.listenerCount("upgrade")).toBe(0);
  });

  it("holds listener ownership until an in-flight startup reconciliation settles", async () => {
    let releaseInitialization!: () => void;
    const roomControl = new FakeSfuRoomControl();
    roomControl.initializeBarrier = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });
    runningServer = await createScreenerServer({
      config: testConfig({
        peerAssistedMedia: true,
        livekitFallback: {
          url: "ws://livekit.test:7880",
          apiUrl: "http://127.0.0.1:7880",
          apiKey: "test-key",
          apiSecret: "s".repeat(32),
        },
      }),
      serveFrontend: false,
      sfuRoomControl: roomControl,
      sfuTokenIssuer: {
        issueToken: async () => "unused-test-token",
      },
    });
    const listen = runningServer.listen(0, "127.0.0.1");
    await vi.waitFor(() => {
      expect(roomControl.initializeCalls).toBe(1);
      expect(runningServer?.httpServer.address()).not.toBeNull();
    });
    const address = runningServer.httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP server address");
    }

    let closed = false;
    const closing = runningServer.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    expect(runningServer.httpServer.listening).toBe(true);

    const contender = await createScreenerServer({
      config: testConfig(),
      serveFrontend: false,
    });
    try {
      await expect(
        contender.listen(address.port, "127.0.0.1"),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await contender.close();
    }

    releaseInitialization();
    await expect(listen).resolves.toBe(address.port);
    await closing;
    runningServer = undefined;
    expect(closed).toBe(true);
  });

  it("closes the listener when LiveKit startup reconciliation fails", async () => {
    const roomControl = new FakeSfuRoomControl();
    roomControl.initializeError = new Error("startup reconciliation failed");
    runningServer = await createScreenerServer({
      config: testConfig({
        peerAssistedMedia: true,
        livekitFallback: {
          url: "ws://livekit.test:7880",
          apiUrl: "http://127.0.0.1:7880",
          apiKey: "test-key",
          apiSecret: "s".repeat(32),
        },
      }),
      serveFrontend: false,
      sfuRoomControl: roomControl,
      sfuTokenIssuer: {
        issueToken: async () => "unused-test-token",
      },
    });

    await expect(runningServer.listen(0, "127.0.0.1")).rejects.toThrow(
      "startup reconciliation failed",
    );
    expect(roomControl.initializeCalls).toBe(1);
    expect(runningServer.httpServer.listening).toBe(false);
    expect(runningServer.httpServer.listenerCount("upgrade")).toBe(0);
  });

  it("uses the configured listen host by default", async () => {
    runningServer = await createScreenerServer({
      config: testConfig(),
      serveFrontend: false,
    });
    await runningServer.listen(0);
    const address = runningServer.httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP server address");
    }
    expect(address.address).toBe("127.0.0.1");
  });

  it("reports process liveness without access checks", async () => {
    const baseUrl = await start();
    const response = await fetch(`${baseUrl}/healthz`, {
      headers: { Origin: "https://foreign.test" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("only accepts GET health checks", async () => {
    const baseUrl = await start();
    const response = await fetch(`${baseUrl}/healthz`, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });
});
