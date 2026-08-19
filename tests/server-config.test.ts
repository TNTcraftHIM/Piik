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
    expect(config.peerAssistedMedia).toBe(false);
    expect(config.peerAssistedRoomIds).toBeUndefined();
    expect(config.livekitFallback).toBeUndefined();
  });

  it("enables LiveKit fallback only for a complete credential tuple", () => {
    const config = loadConfig({
      PEER_ASSISTED_MEDIA: "true",
      LIVEKIT_URL: " ws://livekit.test:7880 ",
      LIVEKIT_API_KEY: " test-key ",
      LIVEKIT_API_SECRET: ` ${"s".repeat(32)} `,
    });

    expect(config.livekitFallback).toEqual({
      url: "ws://livekit.test:7880",
      apiKey: "test-key",
      apiSecret: "s".repeat(32),
      maxSfuRootsPerRoom: 2,
    });
  });

  it.each(["1", "2"])(
    "accepts an SFU root limit of %s when fallback is configured",
    (maxSfuRootsPerRoom) => {
      const config = loadConfig({
        PEER_ASSISTED_MEDIA: "true",
        LIVEKIT_URL: "wss://livekit.test",
        LIVEKIT_API_KEY: "test-key",
        LIVEKIT_API_SECRET: "s".repeat(32),
        MAX_SFU_ROOTS_PER_ROOM: maxSfuRootsPerRoom,
      });

      expect(config.livekitFallback?.maxSfuRootsPerRoom).toBe(
        Number(maxSfuRootsPerRoom),
      );
    },
  );

  it("does not activate fallback from the root limit alone", () => {
    expect(
      loadConfig({ MAX_SFU_ROOTS_PER_ROOM: "2" }).livekitFallback,
    ).toBeUndefined();
  });

  it("requires peer-assisted media for LiveKit fallback", () => {
    expect(() =>
      loadConfig({
        PEER_ASSISTED_MEDIA: "false",
        LIVEKIT_URL: "wss://livekit.test",
        LIVEKIT_API_KEY: "test-key",
        LIVEKIT_API_SECRET: "s".repeat(32),
      }),
    ).toThrow("LiveKit fallback requires PEER_ASSISTED_MEDIA=true");
  });

  it.each([
    { LIVEKIT_URL: "wss://livekit.test" },
    { LIVEKIT_API_KEY: "test-key" },
    { LIVEKIT_API_SECRET: "s".repeat(32) },
    {
      LIVEKIT_URL: "wss://livekit.test",
      LIVEKIT_API_KEY: "test-key",
    },
  ])("rejects a partial LiveKit credential tuple", (partial) => {
    expect(() => loadConfig(partial)).toThrow(
      "LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be configured together",
    );
  });

  it.each([
    "https://livekit.test",
    "wss://user:pass@livekit.test",
    "wss://livekit.test/rtc",
    "wss://livekit.test?token=value",
    "wss://livekit.test#fragment",
  ])("rejects an invalid LiveKit origin: %s", (url) => {
    expect(() =>
      loadConfig({
        LIVEKIT_URL: url,
        LIVEKIT_API_KEY: "test-key",
        LIVEKIT_API_SECRET: "s".repeat(32),
      }),
    ).toThrow("LIVEKIT_URL");
  });

  it("requires wss for LiveKit fallback in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://share.test",
        LIVEKIT_URL: "ws://livekit.test:7880",
        LIVEKIT_API_KEY: "test-key",
        LIVEKIT_API_SECRET: "s".repeat(32),
      }),
    ).toThrow("LIVEKIT_URL must use wss in production");
  });

  it("rejects a short LiveKit API secret and invalid root limits", () => {
    const fallback = {
      LIVEKIT_URL: "wss://livekit.test",
      LIVEKIT_API_KEY: "test-key",
      LIVEKIT_API_SECRET: "s".repeat(32),
    };

    expect(() =>
      loadConfig({ ...fallback, LIVEKIT_API_SECRET: "too-short" }),
    ).toThrow("LIVEKIT_API_SECRET must contain at least 32 bytes");
    for (const maxSfuRootsPerRoom of ["0", "3", "1.5"]) {
      expect(() =>
        loadConfig({
          ...fallback,
          MAX_SFU_ROOTS_PER_ROOM: maxSfuRootsPerRoom,
        }),
      ).toThrow("MAX_SFU_ROOTS_PER_ROOM");
    }
  });

  it("keeps production STUN and TURN mandatory with LiveKit configured", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://share.test",
        PEER_ASSISTED_MEDIA: "true",
        LIVEKIT_URL: "wss://livekit.test",
        LIVEKIT_API_KEY: "test-key",
        LIVEKIT_API_SECRET: "s".repeat(32),
      }),
    ).toThrow("TURN is required in production");
  });

  it.each([
    {
      ACCESS_PASSWORD: "x".repeat(32),
      TURN_URLS: "turn:turn.test:3478",
      TURN_SHARED_SECRET: "x".repeat(32),
    },
    {
      ACCESS_PASSWORD: "x".repeat(32),
      PEER_ASSISTED_MEDIA: "true",
      LIVEKIT_URL: "wss://livekit.test",
      LIVEKIT_API_KEY: "test-key",
      LIVEKIT_API_SECRET: "x".repeat(32),
    },
    {
      TURN_URLS: "turn:turn.test:3478",
      TURN_SHARED_SECRET: "x".repeat(32),
      PEER_ASSISTED_MEDIA: "true",
      LIVEKIT_URL: "wss://livekit.test",
      LIVEKIT_API_KEY: "test-key",
      LIVEKIT_API_SECRET: "x".repeat(32),
    },
    {
      PEER_ASSISTED_MEDIA: "true",
      LIVEKIT_URL: "wss://livekit.test",
      LIVEKIT_API_KEY: "x".repeat(32),
      LIVEKIT_API_SECRET: "x".repeat(32),
    },
  ])("rejects reused infrastructure secrets", (environment) => {
    expect(() => loadConfig(environment)).toThrow(
      "ACCESS_PASSWORD, TURN_SHARED_SECRET, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must use independent values",
    );
  });

  it("requires an explicit boolean to enable peer-assisted media", () => {
    expect(loadConfig({ PEER_ASSISTED_MEDIA: "true" }).peerAssistedMedia).toBe(
      true,
    );
    expect(loadConfig({ PEER_ASSISTED_MEDIA: "false" }).peerAssistedMedia).toBe(
      false,
    );
    expect(() => loadConfig({ PEER_ASSISTED_MEDIA: "1" })).toThrow(
      "PEER_ASSISTED_MEDIA must be true or false",
    );
    expect(() =>
      loadConfig({
        PEER_ASSISTED_MEDIA: "true",
        MAX_VIEWERS_PER_ROOM: "9",
      }),
    ).toThrow(
      "PEER_ASSISTED_MEDIA currently supports at most 8 viewers per room",
    );
  });

  it("parses an optional strict peer-assisted room allowlist", () => {
    expect(
      loadConfig({
        PEER_ASSISTED_MEDIA: "true",
        PEER_ASSISTED_ROOM_IDS: " 1,123456789012 ",
      }).peerAssistedRoomIds,
    ).toEqual(new Set(["1", "123456789012"]));
    expect(
      loadConfig({
        PEER_ASSISTED_MEDIA: "true",
        PEER_ASSISTED_ROOM_IDS: "  ",
      }).peerAssistedRoomIds,
    ).toBeUndefined();
  });

  it("requires peer-assisted media for a non-empty room allowlist", () => {
    expect(() =>
      loadConfig({
        PEER_ASSISTED_MEDIA: "false",
        PEER_ASSISTED_ROOM_IDS: "1",
      }),
    ).toThrow("PEER_ASSISTED_ROOM_IDS requires PEER_ASSISTED_MEDIA=true");
  });

  it.each([
    "0",
    "01",
    "1234567890123",
    "room-1",
    "1,,2",
    "1,1",
  ])("rejects an invalid peer-assisted room allowlist: %s", (roomIds) => {
    expect(() =>
      loadConfig({
        PEER_ASSISTED_MEDIA: "true",
        PEER_ASSISTED_ROOM_IDS: roomIds,
      }),
    ).toThrow("PEER_ASSISTED_ROOM_IDS");
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
    expect(config.roomDatabasePath).toBeUndefined();
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

  it("accepts a short production access password", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      PUBLIC_BASE_URL: "https://share.test",
      ACCESS_PASSWORD: "short-pass1",
      STUN_URLS: "stun:turn.test:3478",
      TURN_URLS: requiredProductionTurnUrls,
      TURN_SHARED_SECRET: "t".repeat(32),
    });

    expect(config.accessPassword).toBe("short-pass1");
  });

  it("rejects a weak production TURN secret", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://share.test",
        ACCESS_PASSWORD: "x",
        STUN_URLS: "stun:turn.test:3478",
        TURN_URLS: requiredProductionTurnUrls,
        TURN_SHARED_SECRET: "too-short",
      }),
    ).toThrow("TURN_SHARED_SECRET must contain at least 32 bytes");
  });

  it("requires access protection for a persistent room database", () => {
    expect(() =>
      loadConfig({ ROOM_DATABASE_PATH: "rooms.sqlite" }),
    ).toThrow("ROOM_DATABASE_PATH requires ACCESS_PASSWORD");

    const config = loadConfig({
      ACCESS_PASSWORD: "x",
      ROOM_DATABASE_PATH: "rooms.sqlite",
    });
    expect(config.roomDatabasePath).toBe("rooms.sqlite");
  });

  it("rejects an in-memory room database in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://share.test",
        ACCESS_PASSWORD: "x",
        ROOM_DATABASE_PATH: ":memory:",
      }),
    ).toThrow("ROOM_DATABASE_PATH must be file-backed in production");
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
