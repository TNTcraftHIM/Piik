import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  authenticateSiteAccess,
  createRoom,
  getSiteAccess,
} from "../src/client/lib/api.ts";
import {
  readDisplayName,
  saveDisplayName,
} from "../src/client/lib/display-name.ts";
import {
  clearHostRoom,
  getStableClientId,
  isValidRoomId,
  mergeAuthenticatedHostRoom,
  readHostRoom,
  readViewerGrant,
  readViewerRoute,
  replaceViewerInvite,
  roomRouteFromInput,
  writeHostRoom,
} from "../src/client/lib/session.ts";
import {
  shouldReconnectSignaling,
  SignalingClient,
} from "../src/client/lib/signaling.ts";
import { deriveParticipantTopology } from "../src/client/lib/participant-topology.ts";
import { labelViewerPresence } from "../src/client/lib/viewer-presence.ts";
import { qualityEvidenceWindowFromMetrics } from "../src/client/media/viewer-quality-evidence.ts";
import { createStatsAccumulator, collectConnectionMetrics } from "../src/client/webrtc/stats.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser-local display name", () => {
  it("stores only the canonical preference and falls back when cleared", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });

    expect(saveDisplayName("  Cafe\u0301\u00a0玩家 ")).toBe("Café 玩家");
    expect(readDisplayName()).toBe("Café 玩家");
    expect(saveDisplayName("\u202ehidden")).toBeNull();
    expect(saveDisplayName("\n")).toBeNull();
    expect(readDisplayName()).toBe("Café 玩家");
    expect(saveDisplayName("   ")).toBe("访客");
    expect(readDisplayName()).toBe("访客");
  });

  it("extends only colliding room-scoped peer ID suffixes", () => {
    const labeled = labelViewerPresence([
      {
        role: "viewer",
        peerId: "viewer_AAAAAAsuffix",
        displayName: "同名",
        upstream: { kind: "peer", peerId: "host_12345678" },
      },
      {
        role: "viewer",
        peerId: "viewer_BBBBBBsuffix",
        displayName: "同名",
        upstream: { kind: "peer", peerId: "viewer_AAAAAAsuffix" },
      },
      {
        role: "viewer",
        peerId: "viewer_independent",
        displayName: "朋友",
        upstream: { kind: "sfu" },
      },
    ]);

    expect(labeled[0].peerIdSuffix.length).toBeGreaterThan(6);
    expect(labeled[1].peerIdSuffix.length).toBeGreaterThan(6);
    expect(labeled[0].peerIdSuffix).not.toBe(labeled[1].peerIdSuffix);
    expect(labeled[2].peerIdSuffix).toHaveLength(6);
    expect(labeled[0].label).toContain("同名 (");
  });

  it("derives exact peer and SFU branches without guessing orphaned routes", () => {
    const viewer = (
      peerId: string,
      upstream:
        | { kind: "none" }
        | { kind: "sfu" }
        | { kind: "peer"; peerId: string },
    ) => ({ role: "viewer" as const, peerId, displayName: peerId, upstream });
    const topology = deriveParticipantTopology(
      "host_12345678",
      labelViewerPresence([
        viewer("viewer_root_1", { kind: "peer", peerId: "host_12345678" }),
        viewer("viewer_child_1", { kind: "peer", peerId: "viewer_root_1" }),
        viewer("viewer_sfu_1", { kind: "sfu" }),
        viewer("viewer_sfu_child", {
          kind: "peer",
          peerId: "viewer_sfu_1",
        }),
        viewer("viewer_pending", { kind: "none" }),
        viewer("viewer_orphan", { kind: "peer", peerId: "viewer_offline" }),
      ]),
    );

    expect(topology.peerRoots[0].viewer.peerId).toBe("viewer_root_1");
    expect(topology.peerRoots[0].children[0].viewer.peerId).toBe(
      "viewer_child_1",
    );
    expect(topology.sfuRoots[0].children[0].viewer.peerId).toBe(
      "viewer_sfu_child",
    );
    expect(topology.pending.map((entry) => entry.peerId)).toEqual([
      "viewer_pending",
      "viewer_orphan",
    ]);
  });
});

describe("client session identity", () => {
  it("works without secure-context-only crypto.randomUUID", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0xab);
        return bytes;
      },
    });

    const first = getStableClientId("viewer", "room-id-1234");

    expect(first).toBe("ab".repeat(16));
    expect(getStableClientId("viewer", "room-id-1234")).toBe(first);
  });

  it("persists one validated host room across browser sessions", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    const room = {
      roomId: "7",
      hostToken: "a".repeat(32),
      inviteUrl: `https://share.test/r/7#v=g1.7.1893456000.${"b".repeat(43)}`,
      viewerPolicy: "private-link" as const,
      viewerGrantExpiresAt: "2026-08-25T00:00:00.000Z",
      expiresAt: null,
    };

    writeHostRoom(room);

    expect(readHostRoom()).toEqual({
      roomId: "7",
      hostToken: "a".repeat(32),
      canonicalUrl: "https://share.test/r/7",
      expiresAt: null,
    });
    expect(values.get("screener:host-room:v1")).toBe(
      JSON.stringify({
        roomId: "7",
        hostToken: "a".repeat(32),
        expiresAt: null,
        inviteUrl: "https://share.test/r/7",
      }),
    );
    expect([...values.values()].join(" ")).not.toContain("g1.7.");
    clearHostRoom();
    expect(readHostRoom()).toBeNull();
  });

  it("reclaims a deployed Host ownership record through the stable shape", () => {
    const values = new Map<string, string>([
      [
        "screener:host-room:v1",
        JSON.stringify({
          roomId: "9",
          hostToken: "h".repeat(32),
          inviteUrl: "https://share.test/r/9",
          expiresAt: null,
        }),
      ],
    ]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });

    expect(readHostRoom()).toEqual({
      roomId: "9",
      hostToken: "h".repeat(32),
      canonicalUrl: "https://share.test/r/9",
      expiresAt: null,
    });
  });

  it("discards expired or malformed host room records", () => {
    const values = new Map<string, string>();
    const removeItem = vi.fn((key: string) => values.delete(key));
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem,
      },
    });
    const expired = {
      roomId: "12",
      hostToken: "b".repeat(32),
      canonicalUrl: "https://share.test/r/12",
      expiresAt: "2026-08-18T00:00:00.000Z",
    };

    writeHostRoom(expired);
    expect(readHostRoom(Date.parse(expired.expiresAt) + 1)).toBeNull();
    expect(removeItem).toHaveBeenCalledOnce();

    values.set("screener:host-room:v1", "not-json");
    expect(readHostRoom()).toBeNull();
    expect(removeItem).toHaveBeenCalledTimes(2);
  });

  it("consumes a Viewer grant fragment once into room-scoped session storage", () => {
    const values = new Map<string, string>();
    const replaceState = vi.fn();
    const grant = `g1.7.1893456000.${"c".repeat(43)}`;
    vi.stubGlobal("window", {
      location: new URL(`https://share.test/r/7#v=${grant}`),
      history: { state: { navigation: 1 }, replaceState },
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });

    expect(readViewerRoute()).toEqual({ roomId: "7", viewerGrant: grant });
    expect(values.get("screener:viewer-grant:7")).toBe(grant);
    expect(replaceState).toHaveBeenCalledWith(
      { navigation: 1 },
      "",
      "/r/7",
    );
    expect(readViewerGrant("8")).toBeNull();
  });

  it("fails malformed Viewer fragments closed without leaking across rooms", () => {
    const values = new Map<string, string>();
    const oldGrant = `g1.7.1893456000.${"d".repeat(43)}`;
    values.set("screener:viewer-grant:7", oldGrant);
    vi.stubGlobal("window", {
      location: new URL("https://share.test/r/7#v=malformed"),
      history: { state: null, replaceState: vi.fn() },
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });

    expect(readViewerRoute()).toEqual({ roomId: "7" });
    expect(readViewerGrant("7")).toBeNull();
    replaceViewerInvite(
      "8",
      `https://share.test/r/8#v=g1.7.1893456000.${"e".repeat(43)}`,
    );
    expect(readViewerGrant("7")).toBeNull();
    expect(readViewerGrant("8")).toBeNull();
  });

  it("persists a rotated Viewer invitation across reload and clears it on revoke", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    const firstGrant = `g1.7.1893456000.${"g".repeat(43)}`;
    const rotatedGrant = `g1.7.1893456000.${"h".repeat(43)}`;

    replaceViewerInvite("7", `https://share.test/r/7#v=${firstGrant}`);
    replaceViewerInvite("7", `https://share.test/r/7#v=${rotatedGrant}`);

    expect(readViewerGrant("7")).toBe(rotatedGrant);
    expect(readViewerGrant("7")).toBe(rotatedGrant);

    replaceViewerInvite("7", null);
    expect(readViewerGrant("7")).toBeNull();
  });

  it("keeps the latest rotated or revoked invite through Host re-authentication", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    const oldInvite = `https://share.test/r/7#v=g1.7.1893456000.${"i".repeat(43)}`;
    const rotatedInvite = `https://share.test/r/7#v=g1.7.1893456000.${"j".repeat(43)}`;
    replaceViewerInvite("7", oldInvite);
    const activeRoom = {
      roomId: "7",
      hostToken: "h".repeat(32),
      canonicalUrl: "https://share.test/r/7",
      expiresAt: null,
      viewerPolicy: "private-link" as const,
      inviteUrl: oldInvite,
    };

    expect(
      mergeAuthenticatedHostRoom(
        { ...activeRoom, inviteUrl: rotatedInvite },
        activeRoom.roomId,
        null,
        "private-link",
      )?.inviteUrl,
    ).toBe(rotatedInvite);
    expect(
      mergeAuthenticatedHostRoom(
        { ...activeRoom, inviteUrl: null },
        activeRoom.roomId,
        null,
        "private-link",
      )?.inviteUrl,
    ).toBeNull();
  });

  it("removes an expired Viewer grant from room-scoped session storage", () => {
    const values = new Map<string, string>([
      ["screener:viewer-grant:7", `g1.7.1.${"f".repeat(43)}`],
    ]);
    const removeItem = vi.fn((key: string) => values.delete(key));
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem,
      },
    });

    expect(readViewerGrant("7")).toBeNull();
    expect(removeItem).toHaveBeenCalledWith("screener:viewer-grant:7");
  });
});

describe("site access API", () => {
  it("checks and authenticates site access without a request body", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ required: true, authenticated: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ required: true, authenticated: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getSiteAccess()).resolves.toEqual({
      required: true,
      authenticated: false,
    });
    await expect(authenticateSiteAccess("  instance-password  ")).resolves.toEqual({
      required: true,
      authenticated: true,
    });

    expect(fetchMock.mock.calls[0]).toEqual([
      "/api/site-access",
      { headers: { Accept: "application/json" } },
    ]);
    const post = fetchMock.mock.calls[1][1];
    expect(post?.method).toBe("POST");
    expect(post?.body).toBeUndefined();
    expect(new Headers(post?.headers).get("Authorization")).toBe(
      "Bearer instance-password",
    );
  });

  it("uses a clear Chinese message for a rejected password", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(authenticateSiteAccess("wrong-password")).rejects.toMatchObject({
      status: 401,
      message: "站点口令不正确，请重试",
    });
  });

  it("does not send a raw bearer token when creating a room by default", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "test response" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(createRoom("private-link")).rejects.toBeInstanceOf(ApiError);

    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.has("Authorization")).toBe(false);
    expect(fetchMock.mock.calls[0][1]?.body).toBe(
      JSON.stringify({ viewerPolicy: "private-link" }),
    );
  });

  it("accepts a persistent room without an expiry", async () => {
    const room = {
      roomId: "42",
      hostToken: "c".repeat(32),
      inviteUrl: `https://share.test/r/42#v=g1.42.1893456000.${"f".repeat(43)}`,
      viewerPolicy: "private-link",
      viewerGrantExpiresAt: "2026-08-25T00:00:00.000Z",
      expiresAt: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify(room), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(createRoom("private-link")).resolves.toEqual(room);
  });
});

describe("room codes", () => {
  it("accepts one to twelve decimal digits without a leading zero", () => {
    expect(isValidRoomId("1")).toBe(true);
    expect(isValidRoomId("123456789012")).toBe(true);
    expect(isValidRoomId("12345678901")).toBe(true);
    expect(isValidRoomId("0")).toBe(false);
    expect(isValidRoomId("012345")).toBe(false);
    expect(isValidRoomId("1234567890123")).toBe(false);
    expect(isValidRoomId("12345678901a")).toBe(false);
    expect(roomRouteFromInput(" 42 ")).toBe("/r/42");
    expect(roomRouteFromInput("042")).toBeNull();
  });
});

describe("client signaling recovery policy", () => {
  it("does not reconnect a session that another tab replaced", () => {
    expect(shouldReconnectSignaling(4001)).toBe(false);
    expect(shouldReconnectSignaling(4004)).toBe(false);
    expect(shouldReconnectSignaling(1008)).toBe(false);
    expect(shouldReconnectSignaling(1006)).toBe(true);
  });

  it.each([
    JSON.stringify({
      type: "error",
      code: "INVALID_MESSAGE",
      message: "Message is invalid",
    }),
    JSON.stringify({
      type: "authenticated",
      role: "viewer",
      peerId: "viewer_12345678",
      roomExpiresAt: null,
      maxViewers: 8,
      hostOnline: true,
      connectionId: null,
      viewerPeerIds: [],
      iceConfig: { iceServers: [] },
    }),
  ])(
    "terminates once when a server payload is incompatible with v2",
    (payload) => {
      const sockets: FakeWebSocket[] = [];
      class FakeWebSocket extends EventTarget {
        static readonly CLOSING = 2;
        readyState = 1;
        readonly send = vi.fn();
        readonly close = vi.fn();

        constructor(readonly url: string) {
          super();
          sockets.push(this);
        }
      }
      vi.stubGlobal("WebSocket", FakeWebSocket);
      vi.stubGlobal("window", {
        location: new URL("https://share.test/r/123456789012"),
        setTimeout,
        clearTimeout,
      });
      const onTerminated = vi.fn();
      const signal = new SignalingClient(
        {
          roomId: "123456789012",
          role: "viewer",
          clientId: "viewer-client",
        },
        {
          onMessage: () => undefined,
          onStatus: () => undefined,
          onTerminated,
          onAccessRequired: () => undefined,
        },
      );

      signal.start();
      sockets[0]!.dispatchEvent(new Event("open"));
      expect(
        JSON.parse(String(sockets[0]!.send.mock.calls[0]![0])),
      ).toMatchObject({
        type: "authenticate",
        protocol: "screener-v3",
      });
      const message = new Event("message");
      Object.defineProperty(message, "data", { value: payload });
      sockets[0]!.dispatchEvent(message);
      const close = new Event("close");
      Object.defineProperties(close, {
        code: { value: 1008 },
        reason: { value: "Invalid message" },
      });
      sockets[0]!.dispatchEvent(close);

      expect(onTerminated).toHaveBeenCalledOnce();
      expect(onTerminated).toHaveBeenCalledWith(
        "页面版本已更新，请刷新后重试",
      );
      expect(sockets[0]!.close).toHaveBeenCalledOnce();
      expect(sockets).toHaveLength(1);
    },
  );

  it("returns only a Host to the admission gate after AUTH_REQUIRED", () => {
    const sockets: FakeWebSocket[] = [];
    class FakeWebSocket extends EventTarget {
      static readonly CLOSING = 2;
      readyState = 1;
      readonly send = vi.fn();
      readonly close = vi.fn();

      constructor(readonly url: string) {
        super();
        sockets.push(this);
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", {
      location: new URL("https://share.test/r/123456789012"),
      setTimeout,
      clearTimeout,
    });
    const onAccessRequired = vi.fn();
    const statuses: string[] = [];
    const onMessage = vi.fn();
    const signal = new SignalingClient(
      {
        roomId: "123456789012",
        role: "host",
        token: "h".repeat(43),
        clientId: "host-client",
      },
      {
        onMessage,
        onStatus: (status) => statuses.push(status),
        onTerminated: () => undefined,
        onAccessRequired,
      },
    );

    signal.start();
    sockets[0]!.dispatchEvent(new Event("open"));
    const message = new Event("message");
    Object.defineProperties(message, {
      data: {
        value: JSON.stringify({
          type: "error",
          code: "AUTH_REQUIRED",
          message: "Site access is required",
        }),
      },
    });
    sockets[0]!.dispatchEvent(message);

    expect(onAccessRequired).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith({
      type: "error",
      code: "AUTH_REQUIRED",
      message: "Site access is required",
    });
    expect(statuses.at(-1)).toBe("offline");
    expect(sockets).toHaveLength(1);
  });
});

describe("WebRTC stats parsing", () => {
  it("binds media, remote evidence, transport, and pair without guessing", async () => {
    const entry = (
      id: string,
      type: string,
      values: Record<string, unknown>,
    ): [string, Record<string, unknown>] => [
      id,
      { id, type, timestamp: 2_000, ...values },
    ];
    const report = new Map<string, Record<string, unknown>>([
      entry("transport-a", "transport", {
        selectedCandidatePairId: "pair-a",
      }),
      entry("transport-z", "transport", {
        selectedCandidatePairId: "pair-z",
      }),
      entry("pair-a", "candidate-pair", {
        transportId: "transport-a",
        localCandidateId: "local-a",
        remoteCandidateId: "remote-candidate-a",
        currentRoundTripTime: 0.02,
      }),
      entry("pair-z", "candidate-pair", {
        transportId: "transport-z",
        localCandidateId: "local-z",
        remoteCandidateId: "remote-candidate-z",
      }),
      entry("local-a", "local-candidate", {
        candidateType: "host",
        protocol: "udp",
      }),
      entry("remote-candidate-a", "remote-candidate", {
        candidateType: "srflx",
        protocol: "udp",
      }),
      entry("local-z", "local-candidate", {
        candidateType: "relay",
        protocol: "tcp",
      }),
      entry("remote-candidate-z", "remote-candidate", {
        candidateType: "relay",
        protocol: "tcp",
      }),
      entry("outbound-a", "outbound-rtp", {
        kind: "video",
        ssrc: 111,
        mid: "0",
        transportId: "transport-a",
        mediaSourceId: "source-a",
        remoteId: "remote-inbound-a",
        codecId: "codec-a",
        scalabilityMode: "L2T3_KEY",
        bytesSent: 2_000,
        framesEncoded: 60,
      }),
      entry("outbound-z", "outbound-rtp", {
        kind: "video",
        ssrc: 999,
        transportId: "transport-z",
        mediaSourceId: "source-z",
        remoteId: "remote-inbound-z",
        codecId: "codec-z",
        bytesSent: 99_000,
        framesEncoded: 99,
      }),
      entry("source-a", "media-source", {
        kind: "video",
        trackIdentifier: "capture-track-a",
      }),
      entry("source-z", "media-source", {
        kind: "video",
        trackIdentifier: "capture-track-z",
      }),
      entry("remote-inbound-a", "remote-inbound-rtp", {
        kind: "video",
        packetsLost: 2,
        jitter: 0.004,
      }),
      entry("remote-inbound-z", "remote-inbound-rtp", {
        kind: "video",
        packetsLost: 999,
        jitter: 0.9,
      }),
      entry("codec-a", "codec", {
        transportId: "transport-a",
        mimeType: "video/H264",
        sdpFmtpLine:
          "profile-level-id=42E01F; packetization-mode=1; " +
          "level-asymmetry-allowed=1; sprop-parameter-sets=do-not-expose; " +
          "x-google-start-bitrate=99999",
      }),
      entry("codec-z", "codec", {
        transportId: "transport-z",
        mimeType: "video/VP9",
        sdpFmtpLine: "profile-id=3; max-fr=15; max-fs=1200",
      }),
    ]);
    const connection = {
      getStats: async () => report as unknown as RTCStatsReport,
    } as unknown as RTCPeerConnection;

    const accumulator = createStatsAccumulator();
    const metrics = await collectConnectionMetrics(
      connection,
      "send",
      accumulator,
      { trackIdentifier: "capture-track-a" },
    );

    expect(metrics).toMatchObject({
      sampleTimestampMs: 2_000,
      sampleWindowMs: null,
      rtpStatsId: "outbound-a",
      rtpSsrc: 111,
      rtpMid: "0",
      trackIdentifier: "capture-track-a",
      selectedCandidatePairId: "pair-a",
      path: "direct",
      iceProtocol: "udp",
      packetsLost: 2,
      jitterMs: 4,
      rttMs: 20,
      codec: "video/H264",
      codecProfile: "profile-level-id=42e01f",
      codecParameters:
        "packetization-mode=1; level-asymmetry-allowed=1",
      scalabilityMode: "L2T3_KEY",
    });
    expect(JSON.stringify(metrics)).not.toContain("sprop-parameter-sets");
    expect(JSON.stringify(metrics)).not.toContain("x-google-start-bitrate");

    report.get("transport-a")!.selectedCandidatePairId = "pair-z";
    const wrongTransportPair = await collectConnectionMetrics(
      connection,
      "send",
      accumulator,
      { trackIdentifier: "capture-track-a" },
    );
    expect(wrongTransportPair).toMatchObject({
      rtpStatsId: "outbound-a",
      selectedCandidatePairId: null,
      path: "unknown",
    });

    report.get("transport-a")!.selectedCandidatePairId = "pair-a";
    report.get("codec-a")!.transportId = "transport-z";
    const wrongTransportCodec = await collectConnectionMetrics(
      connection,
      "send",
      accumulator,
      { trackIdentifier: "capture-track-a" },
    );
    expect(wrongTransportCodec).toMatchObject({
      rtpStatsId: "outbound-a",
      codec: null,
      codecProfile: null,
      codecParameters: null,
    });
    report.get("codec-a")!.transportId = "transport-a";

    report.get("local-a")!.type = "remote-candidate";
    report.get("remote-candidate-a")!.type = "local-candidate";
    const malformedCandidateReferences = await collectConnectionMetrics(
      connection,
      "send",
      accumulator,
      { trackIdentifier: "capture-track-a" },
    );
    expect(malformedCandidateReferences).toMatchObject({
      selectedCandidatePairId: null,
      path: "unknown",
      localCandidateType: null,
      remoteCandidateType: null,
    });
    report.get("local-a")!.type = "local-candidate";
    report.get("remote-candidate-a")!.type = "remote-candidate";

    delete report.get("outbound-a")!.transportId;
    const unboundTransport = await collectConnectionMetrics(
      connection,
      "send",
      accumulator,
      { trackIdentifier: "capture-track-a" },
    );
    expect(unboundTransport).toMatchObject({
      rtpStatsId: "outbound-a",
      selectedCandidatePairId: null,
      path: "unknown",
      codec: null,
      codecProfile: null,
      codecParameters: null,
    });
    report.get("outbound-a")!.transportId = "transport-a";

    report.set("outbound-a-layer-2", {
      id: "outbound-a-layer-2",
      type: "outbound-rtp",
      timestamp: 3_000,
      kind: "video",
      ssrc: 112,
      transportId: "transport-a",
      mediaSourceId: "source-a",
      bytesSent: 3_000,
      framesEncoded: 90,
    });
    const ambiguous = await collectConnectionMetrics(
      connection,
      "send",
      accumulator,
      { trackIdentifier: "capture-track-a" },
    );
    expect(ambiguous).toMatchObject({
      rtpStatsId: null,
      selectedCandidatePairId: null,
      packetsLost: null,
      codec: null,
      codecProfile: null,
      codecParameters: null,
      scalabilityMode: null,
    });
  });

  it.each([
    {
      mimeType: "video/VP8",
      fmtp: "max-fr=60; max-fs=3600",
      profile: null,
      parameters: "max-fr=60; max-fs=3600",
    },
    {
      mimeType: "video/VP9",
      fmtp: "profile-id=2; max-fr=60; max-fs=3600",
      profile: "profile-id=2",
      parameters: "max-fr=60; max-fs=3600",
    },
    {
      mimeType: "video/AV1",
      fmtp: "profile=1; level-idx=8; tier=0",
      profile: "profile=1",
      parameters: "level-idx=8; tier=0",
    },
    {
      mimeType: "video/H264",
      fmtp:
        "profile-level-id=42e01f; profile-level-id=invalid; " +
        "packetization-mode=1",
      profile: null,
      parameters: "packetization-mode=1",
    },
    {
      mimeType: "video/H264",
      fmtp: `profile-level-id=42e01f; ignored=${"x".repeat(2_048)}`,
      profile: null,
      parameters: null,
    },
    {
      mimeType: "video/H264",
      fmtp: [
        "profile-level-id=42e01f",
        ...Array.from({ length: 32 }, (_, index) => `ignored-${index}=1`),
      ].join(";"),
      profile: null,
      parameters: null,
    },
    {
      mimeType: "video/H265",
      fmtp: "profile-id=1; tier-flag=0; level-id=93",
      profile: null,
      parameters: null,
    },
  ])(
    "derives only allowlisted $mimeType format parameters",
    async ({ mimeType, fmtp, profile, parameters }) => {
      const report = new Map<string, unknown>([
        [
          "transport",
          { id: "transport", type: "transport", timestamp: 1_000 },
        ],
        [
          "outbound",
          {
            id: "outbound",
            type: "outbound-rtp",
            timestamp: 1_000,
            kind: "video",
            ssrc: 101,
            transportId: "transport",
            codecId: "codec",
            bytesSent: 1_000,
            framesEncoded: 30,
          },
        ],
        [
          "codec",
          {
            id: "codec",
            type: "codec",
            timestamp: 1_000,
            transportId: "transport",
            mimeType,
            sdpFmtpLine: fmtp,
          },
        ],
      ]) as unknown as RTCStatsReport;
      const connection = {
        getStats: async () => report,
      } as unknown as RTCPeerConnection;

      const metrics = await collectConnectionMetrics(
        connection,
        "send",
        createStatsAccumulator(),
      );
      expect(metrics).toMatchObject({
        codec: mimeType,
        codecProfile: profile,
        codecParameters: parameters,
        scalabilityMode: null,
      });
      expect(
        qualityEvidenceWindowFromMetrics({
          ...metrics,
          sampleWindowMs: 2_000,
        })?.metrics,
      ).toMatchObject({
        codec: mimeType,
        codecProfile: profile,
        codecParameters: parameters,
      });
    },
  );

  it("rebases sender retransmission deltas after counter rollback", async () => {
    const outbound = (
      timestamp: number,
      retransmittedPacketsSent: number,
      retransmittedBytesSent: number,
      packetsSent: number,
      packetsLost: number,
    ) =>
      new Map<string, unknown>([
        [
          "outbound",
          {
            id: "outbound",
            type: "outbound-rtp",
            timestamp,
            kind: "video",
            ssrc: 101,
            remoteId: "remote-inbound",
            bytesSent: timestamp * 10,
            framesEncoded: timestamp / 10,
            packetsSent,
            retransmittedPacketsSent,
            retransmittedBytesSent,
          },
        ],
        [
          "remote-inbound",
          {
            id: "remote-inbound",
            type: "remote-inbound-rtp",
            timestamp,
            kind: "video",
            packetsLost,
          },
        ],
      ]) as unknown as RTCStatsReport;
    const reports = [
      outbound(1_000, 2, 200, 100, 1),
      outbound(2_000, 5, 800, 400, 3),
      outbound(3_000, 1, 100, 50, 1),
      outbound(4_000, 4, 700, 350, 4),
    ];
    const connection = {
      getStats: async () => reports.shift()!,
    } as unknown as RTCPeerConnection;
    const accumulator = createStatsAccumulator();
    const sample = () =>
      collectConnectionMetrics(connection, "send", accumulator);
    const first = await sample();
    const stable = await sample();
    const reset = await sample();
    const afterReset = await sample();

    expect(first.intervalRetransmittedPackets).toBeNull();
    expect(stable).toMatchObject({
      intervalPacketsSent: 300,
      intervalPacketsLost: 2,
      intervalRetransmittedPackets: 3,
      intervalRetransmittedBytes: 600,
    });
    expect(reset).toMatchObject({
      intervalPacketsSent: null,
      intervalPacketsLost: null,
      intervalRetransmittedPackets: null,
      intervalRetransmittedBytes: null,
    });
    expect(afterReset).toMatchObject({
      intervalPacketsSent: 300,
      intervalPacketsLost: 3,
      intervalRetransmittedPackets: 3,
      intervalRetransmittedBytes: 600,
    });
  });

  it("separates the local TURN transport from the ICE protocol", async () => {
    const report = new Map<string, Record<string, unknown>>([
      [
        "transport",
        {
          id: "transport",
          type: "transport",
          timestamp: 2_000,
          selectedCandidatePairId: "pair",
        },
      ],
      [
        "pair",
        {
          id: "pair",
          type: "candidate-pair",
          timestamp: 2_000,
          transportId: "transport",
          state: "succeeded",
          nominated: true,
          localCandidateId: "local",
          remoteCandidateId: "remote",
        },
      ],
      [
        "local",
        {
          id: "local",
          type: "local-candidate",
          timestamp: 2_000,
          candidateType: "relay",
          protocol: "udp",
          relayProtocol: "tls",
        },
      ],
      [
        "remote",
        {
          id: "remote",
          type: "remote-candidate",
          timestamp: 2_000,
          candidateType: "host",
          protocol: "udp",
        },
      ],
      [
        "inbound",
        {
          id: "inbound",
          type: "inbound-rtp",
          timestamp: 2_000,
          kind: "video",
          transportId: "transport",
          bytesReceived: 2_000,
          framesDecoded: 100,
          totalDecodeTime: 0.5,
        },
      ],
    ]);
    const secondReport = new Map(report);
    secondReport.set("inbound", {
      id: "inbound",
      type: "inbound-rtp",
      timestamp: 4_000,
      kind: "video",
      transportId: "transport",
      bytesReceived: 4_000,
      framesDecoded: 150,
      totalDecodeTime: 1.5,
    });
    const reports = [report, secondReport];
    const connection = {
      getStats: async () =>
        reports.shift() as unknown as RTCStatsReport,
    } as unknown as RTCPeerConnection;
    const accumulator = createStatsAccumulator();

    const firstMetrics = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );
    const metrics = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );

    expect(firstMetrics.intervalDecodeMs).toBeNull();
    expect(metrics).toMatchObject({
      path: "relay",
      iceProtocol: "udp",
      localRelayProtocol: "tls",
      localCandidateType: "relay",
      remoteCandidateType: "host",
      intervalDecodeMs: 20,
    });
  });

  it("does not infer a remote TURN transport", async () => {
    const report = new Map<string, unknown>([
      [
        "transport",
        {
          id: "transport",
          type: "transport",
          timestamp: 1_000,
          selectedCandidatePairId: "pair",
        },
      ],
      [
        "pair",
        {
          id: "pair",
          type: "candidate-pair",
          timestamp: 1_000,
          transportId: "transport",
          localCandidateId: "local",
          remoteCandidateId: "remote",
          state: "succeeded",
          nominated: true,
        },
      ],
      [
        "local",
        {
          id: "local",
          type: "local-candidate",
          timestamp: 1_000,
          candidateType: "host",
          protocol: "udp",
        },
      ],
      [
        "remote",
        {
          id: "remote",
          type: "remote-candidate",
          timestamp: 1_000,
          candidateType: "relay",
          protocol: "udp",
        },
      ],
      [
        "inbound",
        {
          id: "inbound",
          type: "inbound-rtp",
          timestamp: 1_000,
          kind: "video",
          transportId: "transport",
          bytesReceived: 1_000,
          framesDecoded: 30,
        },
      ],
    ]) as unknown as RTCStatsReport;
    const connection = {
      getStats: async () => report,
    } as unknown as RTCPeerConnection;

    const metrics = await collectConnectionMetrics(
      connection,
      "receive",
      createStatsAccumulator(),
    );

    expect(metrics).toMatchObject({
      path: "relay",
      iceProtocol: "udp",
      localRelayProtocol: null,
      localCandidateType: "host",
      remoteCandidateType: "relay",
    });
  });

  it("rebases interval metrics when the RTP stream or its counters reset", async () => {
    const inbound = (
      id: string,
      timestamp: number,
      bytesReceived: number,
      framesDecoded: number,
      totalDecodeTime: number,
    ) =>
      new Map<string, unknown>([
        [
          id,
          {
            id,
            type: "inbound-rtp",
            timestamp,
            kind: "video",
            bytesReceived,
            framesDecoded,
            totalDecodeTime,
          },
        ],
      ]) as unknown as RTCStatsReport;
    const reports = [
      inbound("inbound-a", 1_000, 10_000, 100, 0.5),
      inbound("inbound-b", 2_000, 20_000, 150, 1.5),
      inbound("inbound-b", 3_000, 22_000, 160, 1.7),
      inbound("inbound-b", 4_000, 1_000, 10, 0.1),
      inbound("inbound-b", 5_000, 3_000, 20, 0.3),
    ];
    const connection = {
      getStats: async () => reports.shift()!,
    } as unknown as RTCPeerConnection;
    const accumulator = createStatsAccumulator();

    await collectConnectionMetrics(connection, "receive", accumulator);
    const streamChanged = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );
    const afterStreamChange = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );
    const countersReset = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );
    const afterCounterReset = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );

    expect(streamChanged).toMatchObject({
      bitrateKbps: null,
      framesPerSecond: null,
      intervalDecodeMs: null,
    });
    expect(afterStreamChange).toMatchObject({
      bitrateKbps: 16,
      framesPerSecond: 10,
    });
    expect(afterStreamChange.intervalDecodeMs).toBeCloseTo(20);
    expect(countersReset).toMatchObject({
      bitrateKbps: null,
      framesPerSecond: null,
      intervalDecodeMs: null,
    });
    expect(afterCounterReset).toMatchObject({
      bitrateKbps: 16,
      framesPerSecond: 10,
    });
    expect(afterCounterReset.intervalDecodeMs).toBeCloseTo(20);
  });

  it("rebases receiver event deltas on SSRC changes and counter resets", async () => {
    const inbound = (
      timestamp: number,
      ssrc: number,
      framesDropped: number,
      freezeCount: number,
      totalFreezesDuration: number,
      retransmittedPacketsReceived: number,
      retransmittedBytesReceived: number,
    ) =>
      new Map<string, unknown>([
        [
          "inbound",
          {
            id: "inbound",
            type: "inbound-rtp",
            timestamp,
            kind: "video",
            ssrc,
            bytesReceived: timestamp * 10,
            framesDecoded: timestamp / 10,
            framesDropped,
            freezeCount,
            totalFreezesDuration,
            retransmittedPacketsReceived,
            retransmittedBytesReceived,
          },
        ],
      ]) as unknown as RTCStatsReport;
    const reports = [
      inbound(1_000, 101, 2, 1, 0.25, 3, 300),
      inbound(2_000, 101, 5, 2, 0.75, 7, 900),
      inbound(3_000, 202, 20, 8, 4, 30, 4_000),
      inbound(4_000, 202, 22, 9, 4.25, 33, 4_600),
      inbound(5_000, 202, 1, 0, 0.25, 2, 200),
      inbound(6_000, 202, 4, 1, 0.5, 6, 1_000),
    ];
    const connection = {
      getStats: async () => reports.shift()!,
    } as unknown as RTCPeerConnection;
    const accumulator = createStatsAccumulator();
    const sample = () =>
      collectConnectionMetrics(connection, "receive", accumulator);
    const first = await sample();
    const stable = await sample();
    const changedSsrc = await sample();
    const afterSsrcChange = await sample();
    const reset = await sample();
    const afterReset = await sample();

    expect(first).toMatchObject({
      sampleWindowMs: null,
      intervalFramesDropped: null,
      intervalFreezeCount: null,
      intervalFreezeDurationMs: null,
      intervalRetransmittedPackets: null,
      intervalRetransmittedBytes: null,
    });
    expect(stable).toMatchObject({
      sampleWindowMs: 1_000,
      intervalFramesDropped: 3,
      intervalFreezeCount: 1,
      intervalFreezeDurationMs: 500,
      intervalRetransmittedPackets: 4,
      intervalRetransmittedBytes: 600,
    });
    expect(changedSsrc).toMatchObject({
      rtpSsrc: 202,
      sampleWindowMs: null,
      intervalFramesDropped: null,
      intervalFreezeCount: null,
      intervalFreezeDurationMs: null,
      intervalRetransmittedPackets: null,
      intervalRetransmittedBytes: null,
    });
    expect(afterSsrcChange).toMatchObject({
      sampleWindowMs: 1_000,
      intervalFramesDropped: 2,
      intervalFreezeCount: 1,
      intervalFreezeDurationMs: 250,
      intervalRetransmittedPackets: 3,
      intervalRetransmittedBytes: 600,
    });
    expect(reset).toMatchObject({
      sampleWindowMs: 1_000,
      intervalFramesDropped: null,
      intervalFreezeCount: null,
      intervalFreezeDurationMs: null,
      intervalRetransmittedPackets: null,
      intervalRetransmittedBytes: null,
    });
    expect(afterReset).toMatchObject({
      sampleWindowMs: 1_000,
      intervalFramesDropped: 3,
      intervalFreezeCount: 1,
      intervalFreezeDurationMs: 250,
      intervalRetransmittedPackets: 4,
      intervalRetransmittedBytes: 800,
    });
  });

  it("derives a bounded inbound C window from adjacent RTP counters", async () => {
    const inbound = (
      timestamp: number,
      packetsReceived: number,
      packetsLost: number,
      framesDecoded: number,
      totalDecodeTime: number,
    ) =>
      new Map<string, unknown>([
        [
          "transport",
          { id: "transport", type: "transport", timestamp },
        ],
        [
          "codec",
          {
            id: "codec",
            type: "codec",
            timestamp,
            transportId: "transport",
            mimeType: "video/H264",
            sdpFmtpLine:
              "profile-level-id=42e01f; packetization-mode=1; " +
              "sprop-parameter-sets=must-not-leave-stats",
          },
        ],
        [
          "inbound",
          {
            id: "inbound",
            type: "inbound-rtp",
            timestamp,
            kind: "video",
            ssrc: 101,
            transportId: "transport",
            codecId: "codec",
            bytesReceived: timestamp * 10,
            packetsReceived,
            packetsLost,
            framesDecoded,
            framesDropped: 3,
            freezeCount: 1,
            totalFreezesDuration: 0.25,
            totalDecodeTime,
            frameWidth: 1_920,
            frameHeight: 1_080,
            scalabilityMode: "L3T3_KEY",
          },
        ],
      ]) as unknown as RTCStatsReport;
    const reports = [
      inbound(1_000, 1_000, 10, 60, 0.12),
      inbound(3_000, 2_500, 12, 180, 0.42),
      inbound(5_000, 4_000, 11, 300, 0.72),
    ];
    const connection = {
      getStats: async () => reports.shift()!,
    } as unknown as RTCPeerConnection;
    const accumulator = createStatsAccumulator();

    await collectConnectionMetrics(connection, "receive", accumulator);
    const stable = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );
    const correctedLoss = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );

    expect(stable).toMatchObject({
      sampleWindowMs: 2_000,
      frameWidth: 1_920,
      frameHeight: 1_080,
      intervalPacketsReceived: 1_500,
      intervalPacketsLost: 2,
      packetLossPercent: (2 / 1_502) * 100,
      intervalFramesDecoded: 120,
      intervalDecodeMs: 2.5,
      codec: "video/H264",
      codecProfile: "profile-level-id=42e01f",
      codecParameters: "packetization-mode=1",
      scalabilityMode: null,
    });
    expect(JSON.stringify(stable)).not.toContain("sprop-parameter-sets");
    expect(correctedLoss).toMatchObject({
      intervalPacketsLost: null,
      packetLossPercent: null,
    });
  });

  it("reports verified inbound audio codec and interval transport facts", async () => {
    const report = (
      timestamp: number,
      videoPacketsReceived: number,
      videoPacketsLost: number,
      audioBytesReceived: number,
      audioPacketsReceived: number,
      audioPacketsLost: number,
      audioCodecTransportId = "transport",
    ) =>
      new Map<string, unknown>([
        [
          "transport",
          { id: "transport", type: "transport", timestamp },
        ],
        [
          "video-codec",
          {
            id: "video-codec",
            type: "codec",
            timestamp,
            transportId: "transport",
            mimeType: "video/VP8",
          },
        ],
        [
          "audio-codec",
          {
            id: "audio-codec",
            type: "codec",
            timestamp,
            transportId: audioCodecTransportId,
            mimeType: "audio/opus",
            clockRate: 48_000,
            channels: 2,
            sdpFmtpLine: "minptime=10;useinbandfec=1",
          },
        ],
        [
          "video-inbound",
          {
            id: "video-inbound",
            type: "inbound-rtp",
            timestamp,
            kind: "video",
            ssrc: 101,
            transportId: "transport",
            codecId: "video-codec",
            bytesReceived: timestamp * 10,
            packetsReceived: videoPacketsReceived,
            packetsLost: videoPacketsLost,
            framesDecoded: timestamp / 20,
          },
        ],
        [
          "audio-inbound",
          {
            id: "audio-inbound",
            type: "inbound-rtp",
            timestamp,
            kind: "audio",
            ssrc: 202,
            trackIdentifier: "shared-audio",
            transportId: "transport",
            codecId: "audio-codec",
            bytesReceived: audioBytesReceived,
            packetsReceived: audioPacketsReceived,
            packetsLost: audioPacketsLost,
            jitter: 0.003,
          },
        ],
      ]) as unknown as RTCStatsReport;
    const reports = [
      report(1_000, 100, 5, 10_000, 1_000, 5),
      report(3_000, 190, 15, 50_000, 1_180, 10),
      report(5_000, 190, 15, 50_000, 1_180, 10, "other-transport"),
    ];
    const connection = {
      getStats: async () => reports.shift()!,
    } as unknown as RTCPeerConnection;
    const accumulator = createStatsAccumulator();

    const first = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );
    const stable = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );
    const zeroDenominator = await collectConnectionMetrics(
      connection,
      "receive",
      accumulator,
    );

    expect(first).toMatchObject({
      packetLossPercent: null,
      audioBitrateKbps: null,
      audioPacketLossPercent: null,
      audioJitterMs: 3,
      audioCodec: "audio/opus",
      audioCodecClockRate: 48_000,
      audioCodecChannels: 2,
      audioCodecParameters: "minptime=10;useinbandfec=1",
    });
    expect(stable.packetLossPercent).toBeCloseTo(10);
    expect(stable.audioBitrateKbps).toBeCloseTo(160);
    expect(stable.audioPacketLossPercent).toBeCloseTo((5 / 185) * 100);
    expect(zeroDenominator).toMatchObject({
      packetLossPercent: null,
      audioBitrateKbps: 0,
      audioPacketLossPercent: null,
      audioCodec: null,
      audioCodecClockRate: null,
      audioCodecChannels: null,
      audioCodecParameters: null,
    });
  });

  it("uses linked remote inbound counters for outbound audio loss", async () => {
    const report = (
      timestamp: number,
      audioBytesSent: number,
      packetsReceived: number | undefined,
      packetsLost: number | undefined,
    ) =>
      new Map<string, unknown>([
        [
          "transport",
          { id: "transport", type: "transport", timestamp },
        ],
        [
          "video-outbound",
          {
            id: "video-outbound",
            type: "outbound-rtp",
            timestamp,
            kind: "video",
            ssrc: 101,
            bytesSent: timestamp * 10,
            packetsSent: timestamp / 10,
            framesEncoded: timestamp / 20,
          },
        ],
        [
          "audio-codec",
          {
            id: "audio-codec",
            type: "codec",
            timestamp,
            transportId: "transport",
            mimeType: "audio/opus",
            clockRate: 48_000,
            channels: 2,
          },
        ],
        [
          "audio-outbound",
          {
            id: "audio-outbound",
            type: "outbound-rtp",
            timestamp,
            kind: "audio",
            ssrc: 202,
            transportId: "transport",
            codecId: "audio-codec",
            remoteId: "audio-remote-inbound",
            bytesSent: audioBytesSent,
          },
        ],
        [
          "audio-remote-inbound",
          {
            id: "audio-remote-inbound",
            type: "remote-inbound-rtp",
            timestamp,
            kind: "audio",
            packetsReceived,
            packetsLost,
            jitter: 0.004,
          },
        ],
      ]) as unknown as RTCStatsReport;
    const firstReport = report(1_000, 20_000, 500, 1);
    (firstReport as unknown as Map<string, unknown>).delete(
      "audio-remote-inbound",
    );
    const reports = [
      firstReport,
      report(3_000, 50_000, 500, 1),
      report(5_000, 80_000, 650, 4),
      report(7_000, 110_000, 50, 1),
      report(9_000, 140_000, 200, undefined),
    ];
    const connection = {
      getStats: async () => reports.shift()!,
    } as unknown as RTCPeerConnection;
    const accumulator = createStatsAccumulator();

    await collectConnectionMetrics(connection, "send", accumulator);
    const remoteAppeared = await collectConnectionMetrics(
      connection,
      "send",
      accumulator,
    );
    const stable = await collectConnectionMetrics(
      connection,
      "send",
      accumulator,
    );
    const reset = await collectConnectionMetrics(
      connection,
      "send",
      accumulator,
    );
    const missing = await collectConnectionMetrics(
      connection,
      "send",
      accumulator,
    );

    expect(remoteAppeared).toMatchObject({
      audioBitrateKbps: 120,
      audioPacketLossPercent: null,
    });
    expect(stable).toMatchObject({
      audioBitrateKbps: 120,
      audioJitterMs: 4,
      audioCodec: "audio/opus",
      audioCodecClockRate: 48_000,
      audioCodecChannels: 2,
    });
    expect(stable.audioPacketLossPercent).toBeCloseTo((3 / 153) * 100);
    expect(reset.audioPacketLossPercent).toBeNull();
    expect(missing.audioPacketLossPercent).toBeNull();
  });
});
