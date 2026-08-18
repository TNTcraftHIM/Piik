import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/server/config.ts";

describe("server configuration", () => {
  it("allows development without TURN and defaults the origin", () => {
    const config = loadConfig({ NODE_ENV: "development", PORT: "9123" });

    expect(config.publicBaseUrl.href).toBe("http://localhost:9123/");
    expect(config.allowedOrigins).toEqual(new Set(["http://localhost:9123"]));
    expect(config.turnUrls).toEqual([]);
  });

  it("requires room creation authorization and TURN in production", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "production", PUBLIC_BASE_URL: "https://share.test" }),
    ).toThrow("ROOM_CREATION_TOKEN");

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://share.test",
        ROOM_CREATION_TOKEN: "c".repeat(32),
      }),
    ).toThrow("TURN is required");

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://share.test",
        ROOM_CREATION_TOKEN: "c".repeat(32),
        TURN_URLS: "turn:turn.test:3478",
        TURN_SHARED_SECRET: "t".repeat(32),
      }),
    ).toThrow("STUN is required");
  });

  it("accepts complete production configuration", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      PUBLIC_BASE_URL: "https://share.test",
      ROOM_CREATION_TOKEN: "c".repeat(32),
      STUN_URLS: "stun:turn.test:3478,stuns:turn.test:5349",
      TURN_URLS: "turn:turn.test:3478,turns:turn.test:5349",
      TURN_SHARED_SECRET: "t".repeat(32),
    });

    expect(config.turnUrls).toHaveLength(2);
    expect(config.turnSharedSecret).toBe("t".repeat(32));
  });

  it("rejects weak production secrets", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://share.test",
        ROOM_CREATION_TOKEN: "too-short",
        STUN_URLS: "stun:turn.test:3478",
        TURN_URLS: "turn:turn.test:3478",
        TURN_SHARED_SECRET: "t".repeat(32),
      }),
    ).toThrow("ROOM_CREATION_TOKEN must contain at least 32 bytes");

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://share.test",
        ROOM_CREATION_TOKEN: "c".repeat(32),
        STUN_URLS: "stun:turn.test:3478",
        TURN_URLS: "turn:turn.test:3478",
        TURN_SHARED_SECRET: "too-short",
      }),
    ).toThrow("TURN_SHARED_SECRET must contain at least 32 bytes");
  });

  it("rejects partial TURN settings and mismatched ICE schemes", () => {
    expect(() => loadConfig({ TURN_URLS: "turn:turn.test:3478" })).toThrow(
      "TURN_URLS and TURN_SHARED_SECRET",
    );
    expect(() => loadConfig({ STUN_URLS: "https://stun.test" })).toThrow(
      "STUN_URLS contains an unsupported URL scheme",
    );
    expect(() =>
      loadConfig({
        TURN_URLS: "stun:turn.test:3478",
        TURN_SHARED_SECRET: "turn-secret",
      }),
    ).toThrow("TURN_URLS contains an unsupported URL scheme");
    expect(() => loadConfig({ TURN_CREDENTIAL_TTL_SECONDS: "3601" })).toThrow(
      "TURN_CREDENTIAL_TTL_SECONDS must be between 60 and 3600",
    );
  });
});
