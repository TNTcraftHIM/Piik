import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  authenticate,
  createRoom,
  getSession,
} from "../src/client/lib/api.ts";
import {
  getStableClientId,
  isValidRoomId,
} from "../src/client/lib/session.ts";
import {
  shouldReconnectSignaling,
  SignalingClient,
} from "../src/client/lib/signaling.ts";
import { createStatsAccumulator, collectConnectionMetrics } from "../src/client/webrtc/stats.ts";

afterEach(() => {
  vi.unstubAllGlobals();
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
});

describe("site access API", () => {
  it("checks and authenticates a browser session without a request body", async () => {
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

    await expect(getSession()).resolves.toEqual({
      required: true,
      authenticated: false,
    });
    await expect(authenticate("  instance-password  ")).resolves.toEqual({
      required: true,
      authenticated: true,
    });

    expect(fetchMock.mock.calls[0]).toEqual([
      "/api/session",
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

    await expect(authenticate("wrong-password")).rejects.toMatchObject({
      status: 401,
      message: "访问密码不正确，请重试",
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

    await expect(createRoom()).rejects.toBeInstanceOf(ApiError);

    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.has("Authorization")).toBe(false);
  });
});

describe("room codes", () => {
  it("accepts exactly 12 decimal digits", () => {
    expect(isValidRoomId("123456789012")).toBe(true);
    expect(isValidRoomId("12345678901")).toBe(false);
    expect(isValidRoomId("12345678901a")).toBe(false);
  });
});

describe("client signaling recovery policy", () => {
  it("does not reconnect a session that another tab replaced", () => {
    expect(shouldReconnectSignaling(4001)).toBe(false);
    expect(shouldReconnectSignaling(1006)).toBe(true);
  });

  it("returns to the access gate after an unauthorized upgrade", async () => {
    const sockets: FakeWebSocket[] = [];
    class FakeWebSocket extends EventTarget {
      static readonly CLOSING = 2;
      readyState = 0;
      readonly send = vi.fn();
      readonly close = vi.fn();

      constructor(readonly url: string) {
        super();
        sockets.push(this);
      }
    }
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ required: true, authenticated: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", {
      location: new URL("https://share.test/r/123456789012"),
      setTimeout,
      clearTimeout,
    });
    const onAccessRequired = vi.fn();
    const statuses: string[] = [];
    const signal = new SignalingClient(
      {
        roomId: "123456789012",
        role: "viewer",
        clientId: "viewer-client",
      },
      {
        onMessage: () => undefined,
        onStatus: (status) => statuses.push(status),
        onProtocolError: () => undefined,
        onTerminated: () => undefined,
        onAccessRequired,
      },
    );

    signal.start();
    const closeEvent = new Event("close");
    Object.defineProperties(closeEvent, {
      code: { value: 1006 },
      reason: { value: "" },
    });
    sockets[0]!.dispatchEvent(closeEvent);

    await vi.waitFor(() => expect(onAccessRequired).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith("/api/session", {
      headers: { Accept: "application/json" },
    });
    expect(statuses.at(-1)).toBe("offline");
    expect(sockets).toHaveLength(1);
  });
});

describe("WebRTC stats parsing", () => {
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
          bytesReceived: 2_000,
          framesDecoded: 100,
          totalDecodeTime: 0.5,
        },
      ],
    ]);
    const connection = {
      getStats: async () => report as unknown as RTCStatsReport,
    } as unknown as RTCPeerConnection;

    const metrics = await collectConnectionMetrics(
      connection,
      "receive",
      createStatsAccumulator(),
    );

    expect(metrics).toMatchObject({
      path: "relay",
      iceProtocol: "udp",
      localRelayProtocol: "tls",
      localCandidateType: "relay",
      remoteCandidateType: "host",
      averageDecodeMs: 5,
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
});
