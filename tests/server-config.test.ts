import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { MAX_VIEWERS_PER_ROOM_LIMIT } from "../src/shared/protocol.ts";
import { loadConfig } from "../src/server/config.ts";

const liveKitAdmission = {
  LIVEKIT_API_URL: "https://livekit-api.test",
} as const;

describe("server configuration", () => {
  it("allows local development without STUN and defaults the origin", () => {
    const config = loadConfig({ NODE_ENV: "development", PORT: "9123" });

    expect(config.listenHost).toBe("0.0.0.0");
    expect(config.publicBaseUrl.href).toBe("http://localhost:9123/");
    expect(config.allowedOrigins).toEqual(new Set(["http://localhost:9123"]));
    expect(config.roomDatabasePath).toBeUndefined();
    expect(config.stunUrls).toEqual([]);
    expect(config.maxViewersPerRoom).toBe(8);
    expect(config.peerAssistedMedia).toBe(false);
    expect(config.endpointMediaCopyCapacity).toBe(2);
    expect(config.livekitFallback).toBeUndefined();
  });

  it("enables LiveKit fallback only for a complete credential tuple", () => {
    const config = loadConfig({
      PEER_ASSISTED_MEDIA: "true",
      LIVEKIT_URL: " ws://livekit.test:7880 ",
      LIVEKIT_API_URL: " http://livekit.test:7880 ",
      LIVEKIT_API_KEY: " test-key ",
      LIVEKIT_API_SECRET: ` ${"s".repeat(32)} `,
    });

    expect(config.livekitFallback).toEqual({
      url: "ws://livekit.test:7880",
      apiUrl: "http://livekit.test:7880",
      apiKey: "test-key",
      apiSecret: "s".repeat(32),
    });
  });

  it("requires peer-assisted media for LiveKit fallback", () => {
    expect(() =>
      loadConfig({
        PEER_ASSISTED_MEDIA: "false",
        LIVEKIT_URL: "wss://livekit.test",
        LIVEKIT_API_KEY: "test-key",
        LIVEKIT_API_SECRET: "s".repeat(32),
        ...liveKitAdmission,
      }),
    ).toThrow("LiveKit fallback requires PEER_ASSISTED_MEDIA=true");
  });

  it.each([
    { LIVEKIT_URL: "wss://livekit.test" },
    { LIVEKIT_API_URL: "https://livekit-api.test" },
    { LIVEKIT_API_KEY: "test-key" },
    { LIVEKIT_API_SECRET: "s".repeat(32) },
    {
      LIVEKIT_URL: "wss://livekit.test",
      LIVEKIT_API_URL: "https://livekit-api.test",
      LIVEKIT_API_KEY: "test-key",
    },
  ])("rejects a partial LiveKit credential tuple", (partial) => {
    expect(() => loadConfig(partial)).toThrow(
      "LIVEKIT_URL, LIVEKIT_API_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be configured together",
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
        ...liveKitAdmission,
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
        LIVEKIT_URL: "ws://livekit.test:7880",
        LIVEKIT_API_KEY: "test-key",
        LIVEKIT_API_SECRET: "s".repeat(32),
        ...liveKitAdmission,
      }),
    ).toThrow("LIVEKIT_URL must use wss in production");
  });

  it.each([
    "ws://livekit-api.test",
    "http://user:pass@livekit-api.test",
    "http://livekit-api.test/rtc",
    "http://livekit-api.test?token=value",
    "http://livekit-api.test#fragment",
  ])("rejects an invalid LiveKit control origin: %s", (apiUrl) => {
    expect(() =>
      loadConfig({
        PEER_ASSISTED_MEDIA: "true",
        LIVEKIT_URL: "wss://livekit.test",
        LIVEKIT_API_URL: apiUrl,
        LIVEKIT_API_KEY: "test-key",
        LIVEKIT_API_SECRET: "s".repeat(32),
      }),
    ).toThrow("LIVEKIT_API_URL");
  });

  it("allows only HTTPS or loopback LiveKit control in production", () => {
    const production = {
      NODE_ENV: "production",
      PUBLIC_BASE_URL: "https://share.test",
      SITE_ACCESS_PASSWORD: "host-password-12",
      STUN_URLS: "stun:stun.test:3478",
      PEER_ASSISTED_MEDIA: "true",
      LIVEKIT_URL: "wss://livekit.test",
      LIVEKIT_API_KEY: "test-key",
      LIVEKIT_API_SECRET: "s".repeat(32),
    };
    expect(() =>
      loadConfig({
        ...production,
        LIVEKIT_API_URL: "http://livekit-api.test:7880",
      }),
    ).toThrow("must use https or loopback");
    expect(
      loadConfig({
        ...production,
        LIVEKIT_API_URL: "http://127.0.0.1:7880",
      }).livekitFallback?.apiUrl,
    ).toBe("http://127.0.0.1:7880");
  });

  it("rejects a short LiveKit API secret", () => {
    const fallback = {
      LIVEKIT_URL: "wss://livekit.test",
      LIVEKIT_API_KEY: "test-key",
      LIVEKIT_API_SECRET: "s".repeat(32),
      ...liveKitAdmission,
    };

    expect(() =>
      loadConfig({ ...fallback, LIVEKIT_API_SECRET: "too-short" }),
    ).toThrow("LIVEKIT_API_SECRET must contain at least 32 bytes");
  });

  it.each([
    {
      SITE_ACCESS_PASSWORD: "x".repeat(32),
      PEER_ASSISTED_MEDIA: "true",
      LIVEKIT_URL: "wss://livekit.test",
      LIVEKIT_API_KEY: "test-key",
      LIVEKIT_API_SECRET: "x".repeat(32),
      ...liveKitAdmission,
    },
    {
      PEER_ASSISTED_MEDIA: "true",
      LIVEKIT_URL: "wss://livekit.test",
      LIVEKIT_API_KEY: "x".repeat(32),
      LIVEKIT_API_SECRET: "x".repeat(32),
      ...liveKitAdmission,
    },
  ])("rejects reused infrastructure secrets", (environment) => {
    expect(() => loadConfig(environment)).toThrow(
      "must use independent values",
    );
  });

  it("requires an explicit boolean to enable peer-assisted media", () => {
    expect(
      loadConfig({
        PEER_ASSISTED_MEDIA: "true",
      }).peerAssistedMedia,
    ).toBe(true);
    expect(loadConfig({ PEER_ASSISTED_MEDIA: "false" }).peerAssistedMedia).toBe(
      false,
    );
    expect(() => loadConfig({ PEER_ASSISTED_MEDIA: "1" })).toThrow(
      "PEER_ASSISTED_MEDIA must be true or false",
    );
  });

  it("keeps the peer-assisted room default at 8 and accepts the room ceiling", () => {
    expect(
      loadConfig({ PEER_ASSISTED_MEDIA: "true" }).maxViewersPerRoom,
    ).toBe(8);
    expect(
      loadConfig({
        PEER_ASSISTED_MEDIA: "true",
        MAX_VIEWERS_PER_ROOM: String(MAX_VIEWERS_PER_ROOM_LIMIT),
      }).maxViewersPerRoom,
    ).toBe(MAX_VIEWERS_PER_ROOM_LIMIT);
    expect(() =>
      loadConfig({
        PEER_ASSISTED_MEDIA: "true",
        MAX_VIEWERS_PER_ROOM: String(MAX_VIEWERS_PER_ROOM_LIMIT + 1),
      }),
    ).toThrow("MAX_VIEWERS_PER_ROOM");
  });

  it.each(["1", "2", "3"])(
    "accepts an endpoint media copy capacity of %s",
    (endpointMediaCopyCapacity) => {
      expect(
        loadConfig({
          ENDPOINT_MEDIA_COPY_CAPACITY: endpointMediaCopyCapacity,
        }).endpointMediaCopyCapacity,
      ).toBe(Number(endpointMediaCopyCapacity));
    },
  );

  it.each(["0", "4", "1.5"])(
    "rejects an invalid endpoint media copy capacity of %s",
    (endpointMediaCopyCapacity) => {
      expect(() =>
        loadConfig({
          ENDPOINT_MEDIA_COPY_CAPACITY: endpointMediaCopyCapacity,
        }),
      ).toThrow("ENDPOINT_MEDIA_COPY_CAPACITY");
    },
  );

  it("fails closed on the removed relay downstream setting", () => {
    expect(() =>
      loadConfig({ MAX_PEER_RELAY_DOWNSTREAM_EDGES: "2" }),
    ).toThrow(
      "MAX_PEER_RELAY_DOWNSTREAM_EDGES is no longer supported; use ENDPOINT_MEDIA_COPY_CAPACITY",
    );
  });

  it("enables the hybrid controller for every room when selected", () => {
    expect(loadConfig({ PEER_ASSISTED_MEDIA: "true" }).peerAssistedMedia).toBe(
      true,
    );
    expect(() =>
      loadConfig({ PEER_ASSISTED_ROOM_IDS: "1" }),
    ).toThrow("PEER_ASSISTED_ROOM_IDS is no longer supported");
  });

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

  it("requires STUN in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://share.test",
        SITE_ACCESS_PASSWORD: "host-password-12",
      }),
    ).toThrow("STUN is required in production");

    const config = loadConfig({
      NODE_ENV: "production",
      PUBLIC_BASE_URL: "https://share.test",
      SITE_ACCESS_PASSWORD: "easy-key",
      STUN_URLS: "stun:stun.test:3478",
    });
    expect(config.stunUrls).toEqual(["stun:stun.test:3478"]);
  });

  it("allows STUN-only production with LiveKit configured", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      PUBLIC_BASE_URL: "https://share.test",
      SITE_ACCESS_PASSWORD: "host-password-12",
      STUN_URLS: "stun:stun.test:3478",
      PEER_ASSISTED_MEDIA: "true",
      LIVEKIT_URL: "wss://livekit.test",
      LIVEKIT_API_KEY: "test-key",
      LIVEKIT_API_SECRET: "s".repeat(32),
      ...liveKitAdmission,
    });

    expect(config.livekitFallback?.url).toBe("wss://livekit.test");
  });

  it.each([1, MAX_VIEWERS_PER_ROOM_LIMIT])(
    "accepts a per-room viewer limit at boundary %i",
    (maxViewersPerRoom) => {
      expect(
        loadConfig({ MAX_VIEWERS_PER_ROOM: String(maxViewersPerRoom) })
          .maxViewersPerRoom,
      ).toBe(maxViewersPerRoom);
    },
  );

  it.each(["0", String(MAX_VIEWERS_PER_ROOM_LIMIT + 1), "1.5"])(
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
    "PEER_ICE_TURN_URLS",
    "PEER_ICE_TURN_SHARED_SECRET",
    "PEER_ICE_TURN_CREDENTIAL_TTL_SECONDS",
    "SELECTED_EDGE_TURN_URLS",
    "SELECTED_EDGE_TURN_SHARED_SECRET",
    "SELECTED_EDGE_TURN_CREDENTIAL_TTL_SECONDS",
    "SELECTED_EDGE_TURN_ALLOCATION_CAPACITY",
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

  it("requires and accepts a bounded production site access password", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://share.test",
        STUN_URLS: "stun:stun.test:3478",
      }),
    ).toThrow("SITE_ACCESS_PASSWORD is required in production");
    const config = loadConfig({
      NODE_ENV: "production",
      PUBLIC_BASE_URL: "https://share.test",
      SITE_ACCESS_PASSWORD: "easy-key",
      STUN_URLS: "stun:stun.test:3478",
    });
    expect(config.siteAccessPassword).toBe("easy-key");
  });

  it("defaults the room lease to 24 hours", () => {
    expect(loadConfig({}).roomLeaseMs).toBe(86_400_000);
    expect(loadConfig({ ROOM_LEASE_SECONDS: "3600" }).roomLeaseMs).toBe(
      3_600_000,
    );
    expect(() => loadConfig({ ROOM_LEASE_SECONDS: "0" })).toThrow(
      "ROOM_LEASE_SECONDS must be a positive integer",
    );
  });

  it("accepts optional file-backed room authority in development and production", () => {
    const developmentPath = resolve("state", "rooms.sqlite");
    expect(
      loadConfig({ ROOM_DATABASE_PATH: ` ${developmentPath} ` })
        .roomDatabasePath,
    ).toBe(developmentPath);
    expect(loadConfig({ ROOM_DATABASE_PATH: "" }).roomDatabasePath).toBeUndefined();
    const productionPath = resolve("production-state", "rooms.sqlite");
    expect(
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://share.test",
        SITE_ACCESS_PASSWORD: "host-password-12",
        STUN_URLS: "stun:stun.test:3478",
        ROOM_DATABASE_PATH: productionPath,
      }).roomDatabasePath,
    ).toBe(productionPath);
  });

  it.each([":memory:", "rooms\0.sqlite", "rooms.sqlite", "./state/rooms.sqlite"])(
    "rejects a non-absolute room database path",
    (roomDatabasePath) => {
      expect(() =>
        loadConfig({ ROOM_DATABASE_PATH: roomDatabasePath }),
      ).toThrow("ROOM_DATABASE_PATH must be an absolute file path");
    },
  );

  it("rejects the removed room TTL configuration", () => {
    expect(() => loadConfig({ ROOM_TTL_SECONDS: "" })).toThrow(
      "ROOM_TTL_SECONDS is no longer supported; use ROOM_LEASE_SECONDS",
    );
  });

  it.each(["x".repeat(7), "密码密码密码密码", "contains spaces", "x".repeat(129)])(
    "rejects a site access password outside the visible ASCII boundary",
    (siteAccessPassword) => {
      expect(() =>
        loadConfig({ SITE_ACCESS_PASSWORD: siteAccessPassword }),
      ).toThrow(
        "SITE_ACCESS_PASSWORD must contain 8 to 128 visible ASCII bytes",
      );
    },
  );

  it.each([undefined, "", "legacy-password"])(
    "rejects the removed ACCESS_PASSWORD configuration",
    (accessPassword) => {
      expect(() => loadConfig({ ACCESS_PASSWORD: accessPassword })).toThrow(
        "ACCESS_PASSWORD is no longer supported; use SITE_ACCESS_PASSWORD",
      );
    },
  );

  it.each([undefined, "", "legacy-password"])(
    "rejects the removed HOST_ADMISSION_PASSWORD configuration",
    (removedPassword) => {
      expect(() =>
        loadConfig({ HOST_ADMISSION_PASSWORD: removedPassword }),
      ).toThrow(
        "HOST_ADMISSION_PASSWORD is no longer supported; use SITE_ACCESS_PASSWORD",
      );
    },
  );
});
