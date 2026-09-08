import { describe, expect, it, vi } from "vitest";

import type { SignalPayload } from "../src/shared/protocol";
import {
  NativeSenderEdge,
  type NativeEdgeControl,
} from "../src/client/native/native-sender-edge";
import type { NativeClientEvent } from "../src/client/native/wire";

function fixture(natPrediction = false) {
  let listener: ((event: NativeClientEvent) => void) | null = null;
  const prepareEdge = vi.fn<NativeEdgeControl["prepareEdge"]>(async () => ({
    type: "offer",
    sdp: "v=0\r\n",
  }));
  const control: NativeEdgeControl = {
    updateShare: vi.fn(async () => undefined),
    prepareEdge,
    acceptSignal: vi.fn(async () => undefined),
    closeEdge: vi.fn(async () => undefined),
    onEvent: vi.fn((next) => {
      listener = next;
      return () => {
        listener = null;
      };
    }),
  };
  const sent: SignalPayload[] = [];
  const states: RTCPeerConnectionState[] = [];
  const edge = new NativeSenderEdge(
    "viewer_123456",
    "edge_12345678",
    "share_1234567",
    natPrediction
      ? {
          iceServers: [{ urls: "stun:share.example.test:3478" }],
          natPredictionStunUrls: [
            "stun:share.example.test:3479",
            "stun:share.example.test:3480",
          ],
        }
      : { iceServers: [], natPredictionStunUrls: [] },
    natPrediction,
    control,
    {
      sendSignal: (_peerId, payload) => {
        sent.push(payload);
        return true;
      },
      onState: (state) => states.push(state),
    },
  );
  return {
    edge,
    control,
    sent,
    states,
    emit: (event: NativeClientEvent) => listener?.(event),
  };
}

describe("native sender edge adapter", () => {
  it("sends the offer before candidates gathered during preparation", async () => {
    const current = fixture();
    const prepare = vi.mocked(current.control.prepareEdge);
    prepare.mockImplementationOnce(async () => {
      current.emit({
        version: 9,
        type: "edge-candidate",
        shareId: "share_1234567",
        connectionId: "edge_12345678",
        candidate: {
          candidate: "candidate:1 1 udp 1 127.0.0.1 9 typ host",
        },
      });
      return { type: "offer", sdp: "v=0\r\n" };
    });
    expect(await current.edge.start()).toBe(true);
    expect(current.sent.map((payload) => payload.kind)).toEqual([
      "description",
      "candidate",
    ]);
  });

  it("forwards only exact-generation signals and state", async () => {
    const current = fixture();
    expect(await current.edge.start()).toBe(true);
    current.emit({
      version: 9,
      type: "edge-state",
      shareId: "share_1234567",
      connectionId: "edge_12345678",
      state: "connected",
    });
    expect(current.edge.isConnected()).toBe(true);
    await current.edge.acceptSignal({
      kind: "candidate",
      connectionId: "other_123456",
      candidate: null,
    });
    expect(current.control.acceptSignal).not.toHaveBeenCalled();
    await current.edge.acceptSignal({
      kind: "candidate",
      connectionId: "edge_12345678",
      candidate: null,
    });
    expect(current.control.acceptSignal).toHaveBeenCalledOnce();
  });

  it("reuses the Site survey for Native candidate prediction", async () => {
    const current = fixture(true);
    expect(await current.edge.start()).toBe(true);
    expect(vi.mocked(current.control.prepareEdge).mock.calls[0]?.[2].iceServers)
      .toHaveLength(3);
    for (const [index, port] of [40_000, 40_003, 40_006].entries()) {
      current.emit({
        version: 9,
        type: "edge-candidate",
        shareId: "share_1234567",
        connectionId: "edge_12345678",
        candidate: {
          candidate: `candidate:ns${index + 1} 1 udp 1 203.0.113.7 ${port} typ srflx`,
        },
      });
    }
    const candidates = current.sent.flatMap((payload) =>
      payload.kind === "candidate" && payload.candidate
        ? [payload.candidate.candidate]
        : [],
    );
    expect(candidates.filter((candidate) => /^candidate:s[pm]\d+ /.test(candidate)))
      .toHaveLength(8);
  });
});
