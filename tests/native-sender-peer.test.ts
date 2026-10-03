import { describe, expect, it, vi } from "vitest";
import { DEFAULT_QUALITY_SETTINGS, type QualitySettings } from "../src/shared/protocol";

import {
  invalidateSenderQualityEvidence,
  senderQualityEvidenceFromSnapshot,
} from "../src/client/media/sender-quality-evidence";
import {
  NativeSenderPeer,
  shouldUseBrowserQualityCandidate,
} from "../src/client/native/native-sender-peer";
import type { NativeEdgeControl } from "../src/client/native/native-sender-edge";
import type { NativeClientEvent } from "../src/client/native/wire";
import type { PeerSnapshot } from "../src/client/types";

describe("native Host peer quality", () => {
  it.each(["h264", "vp8"] as const)("maps %s Pion quality windows into the existing sender evidence", async (codec) => {
    invalidateSenderQualityEvidence();
    let listener: (event: NativeClientEvent) => void = () => undefined;
    const control: NativeEdgeControl = {
      updateShare: vi.fn(async () => undefined),
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
    const peer = new NativeSenderPeer(
      "viewer_123456",
      "edge_12345678",
      "share_1234567",
      { iceServers: [], natPredictionStunUrls: [] },
      false,
      control,
      {
        sendSignal: () => true,
        onUpdate: (snapshot) => snapshots.push(snapshot),
      },
      codec,
    );
    expect(await peer.start()).toBe(true);
    expect(control.updateShare).not.toHaveBeenCalled();
    expect(shouldUseBrowserQualityCandidate(peer, {
      childPeerId: "viewer_123456",
      connectionId: "candidate_123456",
      transport: "direct",
      qualityProbe: true,
    })).toBe(true);
    expect(shouldUseBrowserQualityCandidate(peer, {
      childPeerId: "viewer_123456",
      connectionId: "candidate_123456",
      transport: "direct",
      qualityProbe: false,
    })).toBe(false);
    expect(shouldUseBrowserQualityCandidate(undefined, {
      childPeerId: "viewer_123456",
      connectionId: "candidate_123456",
      transport: "direct",
      qualityProbe: true,
    })).toBe(false);
    listener({
      version: 9,
      type: "edge-state",
      shareId: "share_1234567",
      connectionId: "edge_12345678",
      state: "connected",
    });

    const quality = {
      version: 9 as const,
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
    expect(snapshots.at(-1)?.metrics).toMatchObject({
      codec: `video/${codec.toUpperCase()}`,
      codecProfile: null,
      codecParameters: null,
      powerEfficientEncoder: codec === "h264",
    });
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

  it("applies the latest relay ceiling before preparing a child", async () => {
    let profile: QualitySettings = DEFAULT_QUALITY_SETTINGS;
    const control: NativeEdgeControl = {
      updateShare: vi.fn(async () => undefined),
      prepareEdge: vi.fn(async () => ({ type: "offer" as const, sdp: "v=0\r\n" })),
      acceptSignal: vi.fn(async () => undefined),
      closeEdge: vi.fn(async () => undefined),
      onEvent: () => () => undefined,
    };
    const peer = new NativeSenderPeer(
      "viewer_123456", "edge_12345678", "share_1234567",
      { iceServers: [] }, false, control,
      { sendSignal: () => true, onUpdate: () => undefined }, "h264",
      { connectionId: "upstream_123456", getProfile: () => profile },
    );
    profile = { ...DEFAULT_QUALITY_SETTINGS, maxFramerate: 60 };
    expect(await peer.start()).toBe(true);
    expect(control.updateShare).toHaveBeenCalledWith("share_1234567", profile);
    expect(vi.mocked(control.updateShare).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(control.prepareEdge).mock.invocationCallOrder[0]!);
    expect(await peer.updateCaptureProfile(DEFAULT_QUALITY_SETTINGS)).toBe(true);
    expect(control.updateShare).toHaveBeenLastCalledWith("share_1234567", DEFAULT_QUALITY_SETTINGS);
    peer.dispose();
  });
});
