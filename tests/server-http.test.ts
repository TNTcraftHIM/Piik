import { afterEach, describe, expect, it } from "vitest";

import { createRoomResponseSchema } from "../src/shared/protocol.ts";
import {
  createScreenerServer,
  type ScreenerServer,
} from "../src/server/app.ts";
import type { ServerConfig } from "../src/server/config.ts";

const allowedOrigin = "http://allowed.test";
let runningServer: ScreenerServer | undefined;

afterEach(async () => {
  await runningServer?.close();
  runningServer = undefined;
});

function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    nodeEnv: "test",
    port: 0,
    publicBaseUrl: new URL("https://share.example.test"),
    allowedOrigins: new Set([allowedOrigin]),
    roomCreationToken: "create-secret",
    roomTtlMs: 14_400_000,
    maxRooms: 10,
    stunUrls: [],
    turnUrls: [],
    turnCredentialTtlSeconds: 3_600,
    ...overrides,
  };
}

async function start(config = testConfig()): Promise<string> {
  runningServer = await createScreenerServer({ config, serveFrontend: false });
  const port = await runningServer.listen(0, "127.0.0.1");
  return `http://127.0.0.1:${port}`;
}

describe("room HTTP API", () => {
  it("creates a no-store room response with an invite fragment", async () => {
    const baseUrl = await start();
    const response = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: {
        Authorization: "Bearer create-secret",
        Origin: allowedOrigin,
      },
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = createRoomResponseSchema.parse(await response.json());
    const invite = new URL(body.inviteUrl);
    expect(invite.origin).toBe("https://share.example.test");
    expect(invite.pathname).toBe(`/r/${body.roomId}`);
    expect(new URLSearchParams(invite.hash.slice(1)).get("token")).toHaveLength(43);
    expect(invite.search).toBe("");
    expect(body.iceConfig.relayAvailable).toBe(false);
  });

  it("requires the configured creation token", async () => {
    const baseUrl = await start();
    const response = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: { Origin: allowedOrigin },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("rejects a request body and a foreign browser origin", async () => {
    const baseUrl = await start();
    const bodyResponse = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: {
        Authorization: "Bearer create-secret",
        "Content-Type": "application/json",
        Origin: allowedOrigin,
      },
      body: "{}",
    });
    expect(bodyResponse.status).toBe(400);

    const originResponse = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: {
        Authorization: "Bearer create-secret",
        Origin: "https://foreign.example.test",
      },
    });
    expect(originResponse.status).toBe(403);
  });

  it("returns service unavailable at the global room bound", async () => {
    const baseUrl = await start(testConfig({ maxRooms: 1 }));
    const create = () =>
      fetch(`${baseUrl}/api/rooms`, {
        method: "POST",
        headers: {
          Authorization: "Bearer create-secret",
          Origin: allowedOrigin,
        },
      });

    expect((await create()).status).toBe(201);
    const full = await create();
    expect(full.status).toBe(503);
    expect(await full.json()).toEqual({ error: "Room capacity reached" });
  });
});
