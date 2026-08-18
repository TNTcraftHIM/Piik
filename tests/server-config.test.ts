import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/server/config.ts";

const completeProductionTurnUrls =
  "turn:turn.test:3478?transport=udp,turn:turn.test:3478?transport=tcp,turns:turn.test:443?transport=tcp";

describe("server configuration", () => {
  it("allows development without TURN and defaults the origin", () => {
    const config = loadConfig({ NODE_ENV: "development", PORT: "9123" });

    expect(config.listenHost).toBe("0.0.0.0");
    expect(config.publicBaseUrl.href).toBe("http://localhost:9123/");
    expect(config.allowedOrigins).toEqual(new Set(["http://localhost:9123"]));
    expect(config.turnUrls).toEqual([]);
  });

  it("allows an explicit loopback listen host", () => {
    const config = loadConfig({ LISTEN_HOST: " 127.0.0.1 " });

    expect(config.listenHost).toBe("127.0.0.1");
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
      TURN_URLS: completeProductionTurnUrls,
      TURN_SHARED_SECRET: "t".repeat(32),
    });

    expect(config.turnUrls).toHaveLength(3);
    expect(config.turnSharedSecret).toBe("t".repeat(32));
  });

  it("does not require transport coverage outside production", () => {
    const config = loadConfig({
      TURN_URLS: "turn:turn.test:3478",
      TURN_SHARED_SECRET: "development-secret",
    });

    expect(config.turnUrls).toEqual(["turn:turn.test:3478"]);
  });

  it("accepts a valid uppercase scheme, IPv6 host, and secure UDP URL", () => {
    const config = loadConfig({
      TURN_URLS: "TURNS:[2001:db8::1]:443?transport=udp",
      TURN_SHARED_SECRET: "development-secret",
    });

    expect(config.turnUrls).toEqual([
      "TURNS:[2001:db8::1]:443?transport=udp",
    ]);
  });

  it("rejects every malformed ICE URL, including extras after valid TURN URLs", () => {
    const invalidTurnUrls = [
      "turn:turn.test/path?transport=udp",
      "turn:turn.test:3478/?transport=udp",
      "turn:turn.test:3478?transport=udp#",
      "turn:turn.test:3478?transport=udp&",
      "turn:turn.test:3478?",
      "turn:turn.test:?transport=udp",
      "turn:turn.test:0?transport=udp",
      "turn:user@turn.test:3478?transport=udp",
      "turn:turn.test:3478?transport=UDP",
      "turn:turn.test:3478?transport=%75dp",
    ];
    for (const invalidUrl of invalidTurnUrls) {
      expect(() =>
        loadConfig({
          NODE_ENV: "production",
          PUBLIC_BASE_URL: "https://share.test",
          ROOM_CREATION_TOKEN: "c".repeat(32),
          STUN_URLS: "stun:turn.test:3478",
          TURN_URLS: `${completeProductionTurnUrls},${invalidUrl}`,
          TURN_SHARED_SECRET: "t".repeat(32),
        }),
      ).toThrow("TURN_URLS contains an invalid ICE URL");
    }

    for (const invalidUrl of [
      "stun:turn.test/path",
      "stun:turn.test?transport=udp",
      "stun:turn.test#",
    ]) {
      expect(() => loadConfig({ STUN_URLS: invalidUrl })).toThrow(
        "STUN_URLS contains an invalid ICE URL",
      );
    }
  });

  it.each([
    {
      missing: "TURN/UDP",
      urls:
        "turn:turn.test:3478,turn:turn.test:3478?transport=tcp,turns:turn.test:443?transport=tcp",
    },
    {
      missing: "TURN/TCP",
      urls:
        "turn:turn.test:3478?transport=udp,turns:turn.test:443?transport=tcp",
    },
    {
      missing: "TURN/TLS on TCP port 443",
      urls:
        "turn:turn.test:3478?transport=udp,turn:turn.test:3478?transport=tcp,turns:turn.test:5349?transport=tcp",
    },
    {
      missing: "explicit TURN/TLS transport",
      urls:
        "turn:turn.test:3478?transport=udp,turn:turn.test:3478?transport=tcp,turns:turn.test:443",
    },
  ])("rejects production TURN URLs missing $missing", ({ urls }) => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://share.test",
        ROOM_CREATION_TOKEN: "c".repeat(32),
        STUN_URLS: "stun:turn.test:3478",
        TURN_URLS: urls,
        TURN_SHARED_SECRET: "t".repeat(32),
      }),
    ).toThrow(
      "TURN_URLS must include explicit TURN/UDP, TURN/TCP, and TURN/TLS on TCP port 443 endpoints in production",
    );
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
