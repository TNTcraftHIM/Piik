import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/server/config.ts";

const liveKitAdmission = {
  LIVEKIT_API_URL: "https://livekit-api.test",
  SFU_INGRESS_CAPACITY: "4",
  SFU_EGRESS_CAPACITY: "16",
} as const;

describe("server configuration", () => {
  it("allows local development without STUN and defaults the origin", () => {
    const config = loadConfig({ NODE_ENV: "development", PORT: "9123" });

    expect(config.listenHost).toBe("0.0.0.0");
    expect(config.publicBaseUrl.href).toBe("http://localhost:9123/");
    expect(config.allowedOrigins).toEqual(new Set(["http://localhost:9123"]));
    expect(config.stunUrls).toEqual([]);
    expect(config.maxViewersPerRoom).toBe(8);
    expect(config.peerAssistedMedia).toBe(false);
    expect(config.endpointMediaCopyCapacity).toBe(2);
    expect(config.livekitFallback).toBeUndefined();
    expect(config.selectedEdgeTurn).toBeUndefined();
  });

  it("enables selected-edge TURN only from its complete post-SFU tuple", () => {
    const base = {
      PEER_ASSISTED_MEDIA: "true",
      LIVEKIT_URL: "wss://livekit.test",
      LIVEKIT_API_KEY: "test-key",
      LIVEKIT_API_SECRET: "s".repeat(32),
      ...liveKitAdmission,
    };
    const turn = {
      SELECTED_EDGE_TURN_URLS: "turn:turn.test:3478?transport=udp",
      SELECTED_EDGE_TURN_SHARED_SECRET: "t".repeat(32),
      SELECTED_EDGE_TURN_CREDENTIAL_TTL_SECONDS: "120",
      SELECTED_EDGE_TURN_ALLOCATION_CAPACITY: "4",
    };
    expect(loadConfig({ ...base, ...turn }).selectedEdgeTurn).toEqual({
      urls: [turn.SELECTED_EDGE_TURN_URLS],
      sharedSecret: turn.SELECTED_EDGE_TURN_SHARED_SECRET,
      credentialTtlSeconds: 120,
      allocationCapacity: 4,
    });
    expect(loadConfig({ ...base, ...turn }).stunUrls).toEqual([]);
    for (const name of Object.keys(turn)) {
      const partial = { ...base, ...turn };
      delete partial[name as keyof typeof partial];
      expect(() => loadConfig(partial)).toThrow("must be configured together");
    }
  });

  it.each([
    "turn:turn.test:3478",
    "turns:turn.test:5349?transport=udp",
    "turn:user@turn.test:3478?transport=udp",
    "turn:turn.test:3478?transport=tcp",
  ])("rejects a non-canonical selected-edge TURN URL: %s", (url) => {
    expect(() =>
      loadConfig({
        PEER_ASSISTED_MEDIA: "true",
        LIVEKIT_URL: "wss://livekit.test",
        LIVEKIT_API_KEY: "test-key",
        LIVEKIT_API_SECRET: "s".repeat(32),
        ...liveKitAdmission,
        SELECTED_EDGE_TURN_URLS: url,
        SELECTED_EDGE_TURN_SHARED_SECRET: "t".repeat(32),
        SELECTED_EDGE_TURN_CREDENTIAL_TTL_SECONDS: "120",
        SELECTED_EDGE_TURN_ALLOCATION_CAPACITY: "4",
      }),
    ).toThrow("one UDP TURN URL");
  });

  it.each(["0", "-1", "1.5", "9007199254740992"])(
    "rejects an invalid selected-edge TURN allocation capacity of %s",
    (capacity) => {
      expect(() =>
        loadConfig({
          PEER_ASSISTED_MEDIA: "true",
          LIVEKIT_URL: "wss://livekit.test",
          LIVEKIT_API_KEY: "test-key",
          LIVEKIT_API_SECRET: "s".repeat(32),
          ...liveKitAdmission,
          SELECTED_EDGE_TURN_URLS:
            "turn:turn.test:3478?transport=udp",
          SELECTED_EDGE_TURN_SHARED_SECRET: "t".repeat(32),
          SELECTED_EDGE_TURN_CREDENTIAL_TTL_SECONDS: "120",
          SELECTED_EDGE_TURN_ALLOCATION_CAPACITY: capacity,
        }),
      ).toThrow("SELECTED_EDGE_TURN_ALLOCATION_CAPACITY must be a positive integer");
    },
  );

  it("enables LiveKit fallback only for a complete credential tuple", () => {
    const config = loadConfig({
      PEER_ASSISTED_MEDIA: "true",
      LIVEKIT_URL: " ws://livekit.test:7880 ",
      LIVEKIT_API_URL: " http://livekit.test:7880 ",
      LIVEKIT_API_KEY: " test-key ",
      LIVEKIT_API_SECRET: ` ${"s".repeat(32)} `,
      SFU_INGRESS_CAPACITY: " 4 ",
      SFU_EGRESS_CAPACITY: " 16 ",
    });

    expect(config.livekitFallback).toEqual({
      url: "ws://livekit.test:7880",
      apiUrl: "http://livekit.test:7880",
      apiKey: "test-key",
      apiSecret: "s".repeat(32),
      ingressCapacity: 4,
      egressCapacity: 16,
    });
  });

  it.each(["1", "9007199254740991"])(
    "accepts an explicit positive safe SFU capacity of %s",
    (capacity) => {
      const config = loadConfig({
        PEER_ASSISTED_MEDIA: "true",
        LIVEKIT_URL: "wss://livekit.test",
        LIVEKIT_API_URL: "https://livekit-api.test",
        LIVEKIT_API_KEY: "test-key",
        LIVEKIT_API_SECRET: "s".repeat(32),
        SFU_INGRESS_CAPACITY: capacity,
        SFU_EGRESS_CAPACITY: capacity,
      });

      expect(config.livekitFallback?.ingressCapacity).toBe(Number(capacity));
      expect(config.livekitFallback?.egressCapacity).toBe(Number(capacity));
    },
  );

  it("rejects SFU capacity without the LiveKit credential tuple", () => {
    expect(() => loadConfig({ SFU_INGRESS_CAPACITY: "2" })).toThrow(
      "require LiveKit fallback",
    );
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
        SFU_INGRESS_CAPACITY: "4",
        SFU_EGRESS_CAPACITY: "16",
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
      SFU_INGRESS_CAPACITY: "4",
      SFU_EGRESS_CAPACITY: "16",
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

  it("rejects a short LiveKit API secret and invalid SFU capacities", () => {
    const fallback = {
      LIVEKIT_URL: "wss://livekit.test",
      LIVEKIT_API_KEY: "test-key",
      LIVEKIT_API_SECRET: "s".repeat(32),
      ...liveKitAdmission,
    };

    expect(() =>
      loadConfig({ ...fallback, LIVEKIT_API_SECRET: "too-short" }),
    ).toThrow("LIVEKIT_API_SECRET must contain at least 32 bytes");
    for (const capacity of ["0", "1.5", "9007199254740992"]) {
      expect(() =>
        loadConfig({
          ...fallback,
          SFU_EGRESS_CAPACITY: capacity,
        }),
      ).toThrow("SFU_EGRESS_CAPACITY");
    }
  });

  it("requires both SFU capacities with LiveKit and rejects the removed root key", () => {
    const fallback = {
      LIVEKIT_URL: "wss://livekit.test",
      LIVEKIT_API_URL: "https://livekit-api.test",
      LIVEKIT_API_KEY: "test-key",
      LIVEKIT_API_SECRET: "s".repeat(32),
    };
    expect(() => loadConfig(fallback)).toThrow(
      "must be configured with LiveKit fallback",
    );
    expect(() =>
      loadConfig({ ...fallback, SFU_INGRESS_CAPACITY: "2" }),
    ).toThrow("must be configured with LiveKit fallback");
    expect(() => loadConfig({ MAX_SFU_ROOTS_PER_ROOM: "" })).toThrow(
      "MAX_SFU_ROOTS_PER_ROOM is no longer supported",
    );
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

  it("keeps the peer-assisted room default at 8 and accepts explicit 16", () => {
    expect(
      loadConfig({ PEER_ASSISTED_MEDIA: "true" }).maxViewersPerRoom,
    ).toBe(8);
    expect(
      loadConfig({
        PEER_ASSISTED_MEDIA: "true",
        MAX_VIEWERS_PER_ROOM: "16",
      }).maxViewersPerRoom,
    ).toBe(16);
    expect(() =>
      loadConfig({
        PEER_ASSISTED_MEDIA: "true",
        MAX_VIEWERS_PER_ROOM: "17",
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

  it("requires STUN but not TURN in production", () => {
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
    "PEER_ICE_TURN_URLS",
    "PEER_ICE_TURN_SHARED_SECRET",
    "PEER_ICE_TURN_CREDENTIAL_TTL_SECONDS",
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

  it("requires site access protection for a persistent room database", () => {
    expect(() => loadConfig({ ROOM_DATABASE_PATH: "rooms.sqlite" })).toThrow(
      "ROOM_DATABASE_PATH requires SITE_ACCESS_PASSWORD",
    );

    const config = loadConfig({
      SITE_ACCESS_PASSWORD: "host-password-12",
      ROOM_DATABASE_PATH: "rooms.sqlite",
    });
    expect(config.roomDatabasePath).toBe("rooms.sqlite");
  });

  it("rejects an in-memory room database in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://share.test",
        SITE_ACCESS_PASSWORD: "host-password-12",
        ROOM_DATABASE_PATH: ":memory:",
        STUN_URLS: "stun:stun.test:3478",
      }),
    ).toThrow("ROOM_DATABASE_PATH must be file-backed in production");
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
