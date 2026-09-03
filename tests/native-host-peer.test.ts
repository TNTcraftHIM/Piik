import { describe, expect, it, vi } from "vitest";

import {
  invalidateSenderQualityEvidence,
  senderQualityEvidenceFromSnapshot,
} from "../src/client/media/sender-quality-evidence";
import { NativeHostPeer } from "../src/client/native/native-host-peer";
import type { NativeEdgeControl } from "../src/client/native/host-edge";
import type { NativeClientEvent } from "../src/client/native/wire";
import type { PeerSnapshot } from "../src/client/types";

describe("native Host peer quality", () => {
  it("maps exact Pion quality windows into the existing sender evidence", async () => {
    invalidateSenderQualityEvidence();
    let listener: (event: NativeClientEvent) => void = () => undefined;
    const control: NativeEdgeControl = {
      prepareEdge: vi.fn<NativeEdgeControl["prepareEdge"]>(async () => ({
        type: "offer",
        sdp: "v=0\r\n",
      })),
      acceptSignal: vi.fn(async () => undefined),
      closeEdge: vi.fn(async () => undefined),
      onEvent: vi.fn((next) => {
        listener = next;
        return () => {
          listener = () => undefined;
        };
      }),
    };
    const snapshots: PeerSnapshot[] = [];
    const peer = new NativeHostPeer(
      "viewer_123456",
      "edge_12345678",
      "share_1234567",
      { iceServers: [], natPredictionStunUrls: [] },
      control,
      {
        sendSignal: () => true,
        onUpdate: (snapshot) => snapshots.push(snapshot),
      },
    );
    expect(await peer.start()).toBe(true);
    listener({
      version: 5,
      type: "edge-state",
      shareId: "share_1234567",
      connectionId: "edge_12345678",
      state: "connected",
    });

    const quality = {
      version: 5 as const,
      type: "edge-quality" as const,
      shareId: "share_1234567",
      connectionId: "edge_12345678",
      sampleTimestampMs: 10_000,
      sampleWindowMs: 2_000,
      rtpStatsId: "pc_12345678",
      trackIdentifier: "screen",
      state: "degraded" as const,
      reason: "bandwidth" as const,
      intervalFramesEncoded: 60,
      framesPerSecond: 30,
      bitrateKbps: 3_000,
      availableOutgoingKbps: 1_000,
      width: 1280,
      height: 720,
    };
    listener(quality);
    expect(senderQualityEvidenceFromSnapshot(snapshots.at(-1)!, 7)?.state).toBe(
      "unknown",
    );
    listener({ ...quality, sampleTimestampMs: 12_000 });
    expect(senderQualityEvidenceFromSnapshot(snapshots.at(-1)!, 7)).toMatchObject({
      state: "degraded",
      diagnostics: {
        reason: "bandwidth",
        bitrateKbps: 3_000,
        availableOutgoingKbps: 1_000,
      },
    });
    peer.dispose();
  });
});
