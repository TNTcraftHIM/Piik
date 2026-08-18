import { afterEach, describe, expect, it, vi } from "vitest";

import { getStableClientId } from "../src/client/lib/session.ts";
import { shouldReconnectSignaling } from "../src/client/lib/signaling.ts";
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

describe("client signaling recovery policy", () => {
  it("does not reconnect a session that another tab replaced", () => {
    expect(shouldReconnectSignaling(4001)).toBe(false);
    expect(shouldReconnectSignaling(1006)).toBe(true);
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
