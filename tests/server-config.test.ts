import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/server/config.ts";

describe("server configuration", () => {
  it("allows local development without STUN and defaults the origin", () => {
    const config = loadConfig({ NODE_ENV: "development", PORT: "9123" });

    expect(config.listenHost).toBe("0.0.0.0");
    expect(config.publicBaseUrl.href).toBe("http://localhost:9123/");
    expect(config.allowedOrigins).toEqual(new Set(["http://localhost:9123"]));
    expect(config.stunUrls).toEqual([]);
    expect(config.maxViewersPerRoom).toBe(8);
    expect(config.peerAssistedMedia).toBe(false);
    expect(config.peerAssistedRoomIds).toBeUndefined();
    expect(config.livekitFallback).toBeUndefined();
    expect(config.peerIceTurn).toBeUndefined();
    expect(
      loadConfig({
        PEER_ICE_TURN_URLS: "",
        PEER_ICE_TURN_SHARED_SECRET: "",
        PEER_ICE_TURN_CREDENTIAL_TTL_SECONDS: "",
      }).peerIceTurn,
    ).toBeUndefined();
  });

  it("enables Peer ICE TURN only from a complete exact-room tuple", () => {
    const config = loadConfig({
      PEER_ASSISTED_MEDIA: "true",
      PEER_ASSISTED_ROOM_IDS: "1",
      PEER_ICE_TURN_URLS: "turn:relay-a.test:3478?transport=udp",
      PEER_ICE_TURN_SHARED_SECRET: "t".repeat(32),
      PEER_ICE_TURN_CREDENTIAL_TTL_SECONDS: "300",
    });

    expect(config.peerIceTurn).toEqual({
      urls: ["turn:relay-a.test:3478?transport=udp"],
      sharedSecret: "t".repeat(32),
      credentialTtlSeconds: 300,
    });
  });

  it.each([
    { PEER_ICE_TURN_URLS: "turn:relay.test:3478?transport=udp" },
    { PEER_ICE_TURN_SHARED_SECRET: "t".repeat(32) },
    { PEER_ICE_TURN_CREDENTIAL_TTL_SECONDS: "300" },
    {
      PEER_ICE_TURN_URLS: "",
      PEER_ICE_TURN_SHARED_SECRET: "t".repeat(32),
      PEER_ICE_TURN_CREDENTIAL_TTL_SECONDS: "300",
    },
  ])("rejects a partial Peer ICE TURN tuple", (partial) => {
    expect(() => loadConfig(partial)).toThrow(
      "PEER_ICE_TURN_URLS, PEER_ICE_TURN_SHARED_SECRET, and PEER_ICE_TURN_CREDENTIAL_TTL_SECONDS must be configured together",
    );
  });

  it("bounds Peer ICE TURN transport, secret, TTL, and feature ownership", () => {
    const tuple = {
      PEER_ICE_TURN_URLS: "turn:relay.test:3478?transport=udp",
      PEER_ICE_TURN_SHARED_SECRET: "t".repeat(32),
      PEER_ICE_TURN_CREDENTIAL_TTL_SECONDS: "300",
    };
    expect(() => loadConfig(tuple)).toThrow(
      "Peer ICE TURN requires PEER_ASSISTED_MEDIA=true",
    );
    for (const url of [
      "turn:relay.test:3478",
      "turn:relay.test:3478?transport=tcp",
      "turns:relay.test:5349?transport=udp",
    ]) {
      expect(() =>
        loadConfig({ ...tuple, PEER_ICE_TURN_URLS: url }),
      ).toThrow("PEER_ICE_TURN_URLS");
    }
    for (const ttl of ["299", "1801", "1.5"]) {
      expect(() =>
        loadConfig({
          ...tuple,
          PEER_ICE_TURN_CREDENTIAL_TTL_SECONDS: ttl,
        }),
      ).toThrow("PEER_ICE_TURN_CREDENTIAL_TTL_SECONDS");
    }
    expect(() =>
      loadConfig({ ...tuple, PEER_ICE_TURN_SHARED_SECRET: "short" }),
    ).toThrow("PEER_ICE_TURN_SHARED_SECRET");
    expect(() =>
      loadConfig({
        ...tuple,
        PEER_ICE_TURN_URLS:
          "turn:relay-a.test:3478?transport=udp,turn:relay-b.test:3478?transport=udp",
      }),
    ).toThrow("PEER_ICE_TURN_URLS must contain at most 1 URL");
  });

  it("requires an independent Peer ICE TURN shared secret", () => {
    expect(() =>
      loadConfig({
        HOST_ADMISSION_PASSWORD: "x".repeat(32),
        PEER_ASSISTED_MEDIA: "true",
        PEER_ASSISTED_ROOM_IDS: "1",
        PEER_ICE_TURN_URLS: "turn:relay.test:3478?transport=udp",
        PEER_ICE_TURN_SHARED_SECRET: "x".repeat(32),
        PEER_ICE_TURN_CREDENTIAL_TTL_SECONDS: "300",
      }),
    ).toThrow("PEER_ICE_TURN_SHARED_SECRET must use independent values");
  });

  it("enables LiveKit fallback only for a complete credential tuple", () => {
    const config = loadConfig({
      PEER_ASSISTED_MEDIA: "true",
      PEER_ASSISTED_ROOM_IDS: "1",
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
        PEER_ASSISTED_ROOM_IDS: "1",
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
        STUN_URLS: "stun:stun.test:3478",
        PEER_ASSISTED_MEDIA: "true",
        PEER_ASSISTED_ROOM_IDS: "1",
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

  it.each([
    {
      HOST_ADMISSION_PASSWORD: "x".repeat(32),
      PEER_ASSISTED_MEDIA: "true",
      PEER_ASSISTED_ROOM_IDS: "1",
      LIVEKIT_URL: "wss://livekit.test",
      LIVEKIT_API_KEY: "test-key",
      LIVEKIT_API_SECRET: "x".repeat(32),
    },
    {
      PEER_ASSISTED_MEDIA: "true",
      PEER_ASSISTED_ROOM_IDS: "1",
      LIVEKIT_URL: "wss://livekit.test",
      LIVEKIT_API_KEY: "x".repeat(32),
      LIVEKIT_API_SECRET: "x".repeat(32),
    },
  ])("rejects reused infrastructure secrets", (environment) => {
    expect(() => loadConfig(environment)).toThrow(
      "HOST_ADMISSION_PASSWORD, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must use independent values",
    );
  });

  it("requires an explicit boolean to enable peer-assisted media", () => {
    expect(
      loadConfig({
        PEER_ASSISTED_MEDIA: "true",
        PEER_ASSISTED_ROOM_IDS: "1",
      }).peerAssistedMedia,
    ).toBe(true);
    expect(loadConfig({ PEER_ASSISTED_MEDIA: "false" }).peerAssistedMedia).toBe(
      false,
    );
    expect(() => loadConfig({ PEER_ASSISTED_MEDIA: "1" })).toThrow(
      "PEER_ASSISTED_MEDIA must be true or false",
    );
    expect(() =>
      loadConfig({
        PEER_ASSISTED_MEDIA: "true",
        PEER_ASSISTED_ROOM_IDS: "1",
        MAX_VIEWERS_PER_ROOM: "9",
      }),
    ).toThrow(
      "PEER_ASSISTED_MEDIA currently supports at most 8 viewers per room",
    );
  });

  it("requires and parses a strict peer-assisted room allowlist", () => {
    expect(
      loadConfig({
        PEER_ASSISTED_MEDIA: "true",
        PEER_ASSISTED_ROOM_IDS: " 1,123456789012 ",
      }).peerAssistedRoomIds,
    ).toEqual(new Set(["1", "123456789012"]));
    for (const peerAssistedRoomIds of [undefined, "  "]) {
      expect(() =>
        loadConfig({
          PEER_ASSISTED_MEDIA: "true",
          ...(peerAssistedRoomIds === undefined
            ? {}
            : { PEER_ASSISTED_ROOM_IDS: peerAssistedRoomIds }),
        }),
      ).toThrow(
        "PEER_ASSISTED_MEDIA=true requires non-empty PEER_ASSISTED_ROOM_IDS",
      );
    }
  });

  it("requires peer-assisted media for a non-empty room allowlist", () => {
    expect(() =>
      loadConfig({
        PEER_ASSISTED_MEDIA: "false",
        PEER_ASSISTED_ROOM_IDS: "1",
      }),
    ).toThrow("PEER_ASSISTED_ROOM_IDS requires PEER_ASSISTED_MEDIA=true");
  });

  it.each(["0", "01", "1234567890123", "room-1", "1,,2", "1,1"])(
    "rejects an invalid peer-assisted room allowlist: %s",
    (roomIds) => {
      expect(() =>
        loadConfig({
          PEER_ASSISTED_MEDIA: "true",
          PEER_ASSISTED_ROOM_IDS: roomIds,
        }),
      ).toThrow("PEER_ASSISTED_ROOM_IDS");
    },
  );

  it("allows an explicit loopback listen host", () => {
    expect(loadConfig({ LISTEN_HOST: " 127.0.0.1 " }).listenHost).toBe(
      "127.0.0.1",
    );
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

  it("requires STUN but not TURN in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://share.test",
        HOST_ADMISSION_PASSWORD: "host-password-12",
      }),
    ).toThrow("STUN is required in production");

    const config = loadConfig({
      NODE_ENV: "production",
      PUBLIC_BASE_URL: "https://share.test",
      HOST_ADMISSION_PASSWORD: "easy-key",
      STUN_URLS: "stun:stun.test:3478",
    });
    expect(config.stunUrls).toEqual(["stun:stun.test:3478"]);
  });

  it("allows STUN-only production with LiveKit configured", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      PUBLIC_BASE_URL: "https://share.test",
      HOST_ADMISSION_PASSWORD: "host-password-12",
      STUN_URLS: "stun:stun.test:3478",
      PEER_ASSISTED_MEDIA: "true",
      PEER_ASSISTED_ROOM_IDS: "1",
      LIVEKIT_URL: "wss://livekit.test",
      LIVEKIT_API_KEY: "test-key",
      LIVEKIT_API_SECRET: "s".repeat(32),
    });

    expect(config.livekitFallback?.url).toBe("wss://livekit.test");
  });

  it.each([1, 16])(
    "accepts a per-room viewer limit at boundary %i",
    (maxViewersPerRoom) => {
      expect(
        loadConfig({ MAX_VIEWERS_PER_ROOM: String(maxViewersPerRoom) })
          .maxViewersPerRoom,
      ).toBe(maxViewersPerRoom);
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

  it("accepts uppercase STUN schemes and IPv6 hosts", () => {
    expect(
      loadConfig({ STUN_URLS: "STUN:[2001:db8::1]:3478" }).stunUrls,
    ).toEqual(["STUN:[2001:db8::1]:3478"]);
  });

  it.each([
    "stun:stun.test/path",
    "stun:stun.test?transport=udp",
    "stun:stun.test#fragment",
    "stun:",
    "stun:stun.test:",
    "stun:stun.test:0",
    "stun:user@stun.test:3478",
  ])("rejects a malformed STUN URL: %s", (invalidUrl) => {
    expect(() => loadConfig({ STUN_URLS: invalidUrl })).toThrow(
      "STUN_URLS contains an invalid STUN URL",
    );
  });

  it("rejects non-STUN schemes in the ordinary ICE configuration", () => {
    expect(() => loadConfig({ STUN_URLS: "turn:turn.test:3478" })).toThrow(
      "STUN_URLS contains an invalid STUN URL",
    );
    expect(() => loadConfig({ STUN_URLS: "stuns:stun.test:5349" })).toThrow(
      "STUN_URLS contains an invalid STUN URL",
    );
  });

  it.each([
    "TURN_URLS",
    "TURN_SHARED_SECRET",
    "TURN_CREDENTIAL_TTL_SECONDS",
  ] as const)("rejects removed TURN configuration even when %s is blank", (name) => {
    expect(() => loadConfig({ [name]: "" })).toThrow(
      `${name} is no longer supported`,
    );
  });

  it("rejects more STUN URLs than the authenticated wire can carry", () => {
    expect(() =>
      loadConfig({
        STUN_URLS: Array.from(
          { length: 9 },
          (_, index) => `stun:stun-${index}.test:3478`,
        ).join(","),
      }),
    ).toThrow("STUN_URLS must contain at most 8 URLs");
  });

  it("requires and accepts a bounded production Host admission password", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://share.test",
        STUN_URLS: "stun:stun.test:3478",
      }),
    ).toThrow("HOST_ADMISSION_PASSWORD is required in production");
    const config = loadConfig({
      NODE_ENV: "production",
      PUBLIC_BASE_URL: "https://share.test",
      HOST_ADMISSION_PASSWORD: "easy-key",
      STUN_URLS: "stun:stun.test:3478",
    });
    expect(config.hostAdmissionPassword).toBe("easy-key");
  });

  it("requires Host admission protection for a persistent room database", () => {
    expect(() => loadConfig({ ROOM_DATABASE_PATH: "rooms.sqlite" })).toThrow(
      "ROOM_DATABASE_PATH requires HOST_ADMISSION_PASSWORD",
    );

    const config = loadConfig({
      HOST_ADMISSION_PASSWORD: "host-password-12",
      ROOM_DATABASE_PATH: "rooms.sqlite",
    });
    expect(config.roomDatabasePath).toBe("rooms.sqlite");
  });

  it("rejects an in-memory room database in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://share.test",
        HOST_ADMISSION_PASSWORD: "host-password-12",
        ROOM_DATABASE_PATH: ":memory:",
        STUN_URLS: "stun:stun.test:3478",
      }),
    ).toThrow("ROOM_DATABASE_PATH must be file-backed in production");
  });

  it.each(["x".repeat(7), "密码密码密码密码", "contains spaces", "x".repeat(129)])(
    "rejects a Host admission password outside the visible ASCII boundary",
    (hostAdmissionPassword) => {
      expect(() =>
        loadConfig({ HOST_ADMISSION_PASSWORD: hostAdmissionPassword }),
      ).toThrow(
        "HOST_ADMISSION_PASSWORD must contain 8 to 128 visible ASCII bytes",
      );
    },
  );

  it.each([undefined, "", "legacy-password"])(
    "rejects the removed ACCESS_PASSWORD configuration",
    (accessPassword) => {
      expect(() => loadConfig({ ACCESS_PASSWORD: accessPassword })).toThrow(
        "ACCESS_PASSWORD is no longer supported; use HOST_ADMISSION_PASSWORD",
      );
    },
  );
});
