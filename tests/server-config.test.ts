import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/server/config.ts";

const requiredProductionTurnUrls =
  "turn:turn.test:3478?transport=udp,turn:turn.test:3478?transport=tcp";

describe("server configuration", () => {
  it("allows development without TURN and defaults the origin", () => {
    const config = loadConfig({ NODE_ENV: "development", PORT: "9123" });

    expect(config.listenHost).toBe("0.0.0.0");
    expect(config.publicBaseUrl.href).toBe("http://localhost:9123/");
    expect(config.allowedOrigins).toEqual(new Set(["http://localhost:9123"]));
    expect(config.turnUrls).toEqual([]);
    expect(config.maxViewersPerRoom).toBe(8);
  });

  it("allows an explicit loopback listen host", () => {
    const config = loadConfig({ LISTEN_HOST: " 127.0.0.1 " });

    expect(config.listenHost).toBe("127.0.0.1");
  });

  it.each([
    "https://user:pass@share.test",
    "https://share.test/path",
    "https://share.test?query=1",
    "https://share.test#fragment",
  ])("rejects a PUBLIC_BASE_URL that is not a plain origin: %s", (url) => {
    expect(() => loadConfig({ PUBLIC_BASE_URL: url })).toThrow(
      "PUBLIC_BASE_URL must be an origin",
    );
  });

  it("allows an optional access password but requires TURN in production", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "production", PUBLIC_BASE_URL: "https://share.test" }),
    ).toThrow("TURN is required");

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://share.test",
        ACCESS_PASSWORD: "c".repeat(12),
      }),
    ).toThrow("TURN is required");

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://share.test",
        ACCESS_PASSWORD: "c".repeat(12),
        TURN_URLS: "turn:turn.test:3478",
        TURN_SHARED_SECRET: "t".repeat(32),
      }),
    ).toThrow("STUN is required");
  });

  it("accepts complete production configuration", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      PUBLIC_BASE_URL: "https://share.test",
      STUN_URLS: "stun:turn.test:3478,stuns:turn.test:5349",
      TURN_URLS: requiredProductionTurnUrls,
      TURN_SHARED_SECRET: "t".repeat(32),
    });

    expect(config.accessPassword).toBeUndefined();
    expect(config.turnUrls).toHaveLength(2);
    expect(config.turnSharedSecret).toBe("t".repeat(32));
  });

  it.each([1, 16])(
    "accepts a per-room viewer limit at boundary %i",
    (maxViewersPerRoom) => {
      const config = loadConfig({
        MAX_VIEWERS_PER_ROOM: String(maxViewersPerRoom),
      });

      expect(config.maxViewersPerRoom).toBe(maxViewersPerRoom);
    },
  );

  it.each(["0", "17", "1.5"])(
    "rejects invalid per-room viewer limit %s",
    (maxViewersPerRoom) => {
      expect(() =>
        loadConfig({ MAX_VIEWERS_PER_ROOM: maxViewersPerRoom }),
      ).toThrow("MAX_VIEWERS_PER_ROOM");
    },
  );

  it.each([5349, 443])(
    "accepts optional TURN/TLS over TCP on production port %i",
    (tlsPort) => {
      const config = loadConfig({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://share.test",
        ACCESS_PASSWORD: "c".repeat(12),
        STUN_URLS: "stun:turn.test:3478",
        TURN_URLS: `${requiredProductionTurnUrls},turns:turn.test:${tlsPort}?transport=tcp`,
        TURN_SHARED_SECRET: "t".repeat(32),
      });

      expect(config.turnUrls.at(-1)).toBe(
        `turns:turn.test:${tlsPort}?transport=tcp`,
      );
    },
  );

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
          ACCESS_PASSWORD: "c".repeat(12),
          STUN_URLS: "stun:turn.test:3478",
          TURN_URLS: `${requiredProductionTurnUrls},${invalidUrl}`,
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
        "turn:turn.test:3478?transport=udp,turn:turn.test:3478",
    },
  ])("rejects production TURN URLs missing $missing", ({ urls }) => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://share.test",
        ACCESS_PASSWORD: "c".repeat(12),
        STUN_URLS: "stun:turn.test:3478",
        TURN_URLS: urls,
        TURN_SHARED_SECRET: "t".repeat(32),
      }),
    ).toThrow(
      "TURN_URLS must include explicit TURN/UDP and TURN/TCP endpoints in production",
    );
  });

  it("rejects weak production secrets", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://share.test",
        ACCESS_PASSWORD: "too-short",
        STUN_URLS: "stun:turn.test:3478",
        TURN_URLS: "turn:turn.test:3478",
        TURN_SHARED_SECRET: "t".repeat(32),
      }),
    ).toThrow("ACCESS_PASSWORD must contain at least 12 bytes");

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://share.test",
        ACCESS_PASSWORD: "c".repeat(12),
        STUN_URLS: "stun:turn.test:3478",
        TURN_URLS: "turn:turn.test:3478",
        TURN_SHARED_SECRET: "too-short",
      }),
    ).toThrow("TURN_SHARED_SECRET must contain at least 32 bytes");
  });

  it.each(["密码密码密码密码", "contains spaces", "x".repeat(129)])(
    "rejects an access password that cannot be carried safely in a header",
    (accessPassword) => {
      expect(() => loadConfig({ ACCESS_PASSWORD: accessPassword })).toThrow(
        "ACCESS_PASSWORD must contain at most 128 visible ASCII characters",
      );
    },
  );

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
