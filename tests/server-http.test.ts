import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRoomResponseSchema } from "../src/shared/protocol.ts";
import {
  createScreenerServer,
  type CreateServerOptions,
  type ScreenerServer,
} from "../src/server/app.ts";
import type { ServerConfig } from "../src/server/config.ts";

const allowedOrigin = "http://allowed.test";
const accessPassword = "instance-access-password";
let runningServer: ScreenerServer | undefined;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await runningServer?.close();
  runningServer = undefined;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "screener-http-"));
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
    accessPassword,
    roomTtlMs: 14_400_000,
    maxRooms: 10,
    maxViewersPerRoom: 8,
    stunUrls: [],
    turnUrls: [],
    turnCredentialTtlSeconds: 3_600,
    ...overrides,
  };
}

async function start(
  config = testConfig(),
  options: Pick<CreateServerOptions, "now" | "accessSessionTtlSeconds"> = {},
): Promise<string> {
  runningServer = await createScreenerServer({
    ...options,
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
  return fetch(`${baseUrl}/api/session`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessPassword}`,
      Origin: allowedOrigin,
    },
  });
}

describe("site access session", () => {
  it("reports status and issues a stateless 12-hour cookie", async () => {
    const baseUrl = await start();
    const initial = await fetch(`${baseUrl}/api/session`);

    expect(initial.status).toBe(200);
    expect(initial.headers.get("cache-control")).toBe("no-store");
    expect(await initial.json()).toEqual({
      required: true,
      authenticated: false,
    });

    const denied = await fetch(`${baseUrl}/api/session`, {
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
    expect(setCookie).toContain("screener-session=v1.");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=43200");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("Secure");
    expect(setCookie).not.toContain(accessPassword);

    const status = await fetch(`${baseUrl}/api/session`, {
      headers: { Cookie: cookiePair(authenticated) },
    });
    expect(await status.json()).toEqual({
      required: true,
      authenticated: true,
    });
  });

  it("uses a secure __Host- cookie for production HTTPS", async () => {
    const baseUrl = await start(testConfig({ nodeEnv: "production" }));
    const response = await login(baseUrl);
    const setCookie = response.headers.get("set-cookie") ?? "";

    expect(setCookie).toContain("__Host-screener-session=");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("Domain=");
  });

  it("requires an allowed Origin and an empty login body", async () => {
    const baseUrl = await start();
    const authorization = { Authorization: `Bearer ${accessPassword}` };

    expect(
      (
        await fetch(`${baseUrl}/api/session`, {
          method: "POST",
          headers: authorization,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${baseUrl}/api/session`, {
          method: "POST",
          headers: { ...authorization, Origin: "https://foreign.test" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${baseUrl}/api/session`, {
          method: "POST",
          headers: { ...authorization, Origin: `${allowedOrigin}/path` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${baseUrl}/api/session`, {
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
      accessSessionTtlSeconds: 1,
    });
    const authenticated = await login(baseUrl);
    const cookie = cookiePair(authenticated);

    const modified = await fetch(`${baseUrl}/api/session`, {
      headers: { Cookie: `${cookie}x` },
    });
    expect((await modified.json()).authenticated).toBe(false);

    now = 2_000;
    const expired = await fetch(`${baseUrl}/api/session`, {
      headers: { Cookie: cookie },
    });
    expect(await expired.json()).toEqual({
      required: true,
      authenticated: false,
    });
  });

  it("is immediately authenticated when the access password is empty", async () => {
    const baseUrl = await start(testConfig({ accessPassword: undefined }));
    const status = await fetch(`${baseUrl}/api/session`);

    expect(await status.json()).toEqual({
      required: false,
      authenticated: true,
    });
    const post = await fetch(`${baseUrl}/api/session`, {
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
    const anonymous = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: { Origin: allowedOrigin },
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBeNull();

    const bearerBypass = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessPassword}`,
        Origin: allowedOrigin,
      },
    });
    expect(bearerBypass.status).toBe(401);
  });

  it("creates a numeric room and token-free invite for an authenticated browser", async () => {
    const baseUrl = await start();
    const authenticated = await login(baseUrl);
    const response = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: {
        Cookie: cookiePair(authenticated),
        Origin: allowedOrigin,
      },
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = createRoomResponseSchema.parse(await response.json());
    const invite = new URL(body.inviteUrl);
    expect(body.roomId).toMatch(/^\d{12}$/);
    expect(invite.origin).toBe("https://share.example.test");
    expect(invite.pathname).toBe(`/r/${body.roomId}`);
    expect(invite.hash).toBe("");
    expect(invite.search).toBe("");
    expect("iceConfig" in body).toBe(false);
  });

  it("allows room creation without a session in public mode", async () => {
    const baseUrl = await start(testConfig({ accessPassword: undefined }));
    const response = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: { Origin: allowedOrigin },
    });
    expect(response.status).toBe(201);
  });

  it("persists sequential protected rooms across server restarts", async () => {
    const config = testConfig({ roomDatabasePath: temporaryDatabasePath() });
    let baseUrl = await start(config);
    const authenticated = await login(baseUrl);
    const cookie = cookiePair(authenticated);
    const create = () =>
      fetch(`${baseUrl}/api/rooms`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: allowedOrigin },
      });

    const responses = await Promise.all([create(), create()]);
    const rooms = await Promise.all(
      responses.map(async (response) =>
        createRoomResponseSchema.parse(await response.json()),
      ),
    );
    expect(
      rooms.map((room) => Number(room.roomId)).sort((left, right) => left - right),
    ).toEqual([1, 2]);
    expect(rooms.every((room) => room.expiresAt === null)).toBe(true);

    await runningServer?.close();
    runningServer = undefined;
    baseUrl = await start(config);
    const third = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: allowedOrigin },
    });
    expect(createRoomResponseSchema.parse(await third.json())).toMatchObject({
      roomId: "3",
      expiresAt: null,
    });
  });

  it("rejects request bodies and foreign browser origins", async () => {
    const baseUrl = await start(testConfig({ accessPassword: undefined }));
    const withBody = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: { Origin: allowedOrigin },
      body: "{}",
    });
    expect(withBody.status).toBe(400);

    const foreign = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: { Origin: "https://foreign.test" },
    });
    expect(foreign.status).toBe(403);
  });

  it("returns service unavailable at the global room bound", async () => {
    const baseUrl = await start(
      testConfig({ accessPassword: undefined, maxRooms: 1 }),
    );
    const create = () =>
      fetch(`${baseUrl}/api/rooms`, {
        method: "POST",
        headers: { Origin: allowedOrigin },
      });

    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(503);
  });
});

describe("server HTTP listener and health", () => {
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
