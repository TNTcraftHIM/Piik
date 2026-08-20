import { describe, expect, it } from "vitest";

import type { ClientMessage, ServerMessage } from "../src/shared/protocol.ts";
import {
  metricsFromQualityEvidence,
  qualityEvidenceMatchesSnapshot,
  qualityEvidenceWindowFromMetrics,
  ViewerQualityEvidenceReporter,
} from "../src/client/media/viewer-quality-evidence.ts";
import {
  ParentEdgeQualityEvidenceReporter,
  parentEdgeQualityEvidenceFromSnapshot,
} from "../src/client/media/parent-edge-quality-evidence.ts";
import {
  EMPTY_METRICS,
  type ConnectionMetrics,
  type PeerSnapshot,
} from "../src/client/types.ts";

function receiveMetrics(
  overrides: Partial<ConnectionMetrics> = {},
): ConnectionMetrics {
    return {
      ...EMPTY_METRICS,
      sampleTimestampMs: 10_000,
      sampleWindowMs: 2_000,
    framesPerSecond: 60,
    frameWidth: 1_920,
    frameHeight: 1_080,
    resolution: "1920x1080",
    bitrateKbps: 7_500,
    intervalPacketsReceived: 1_500,
    intervalPacketsLost: 2,
    jitterMs: 3.5,
    intervalFramesDecoded: 120,
    intervalFramesDropped: 1,
    intervalDecodeMs: 2.4,
    intervalFreezeCount: 0,
    intervalFreezeDurationMs: 0,
    codec: "video/H264",
    codecProfile: "profile-level-id=42e01f",
    codecParameters:
      "packetization-mode=1; level-asymmetry-allowed=1",
    scalabilityMode: "L3T3_KEY",
    ...overrides,
  };
}

function snapshot(
  connectionId: string,
  metrics = receiveMetrics(),
): PeerSnapshot {
  return {
    peerId: "host_12345678",
    connectionId,
    connectionState: "connected",
    iceConnectionState: "connected",
    metrics,
    error: null,
  };
}

describe("viewer quality evidence", () => {
  it("normalizes only bounded adjacent receive evidence", () => {
    expect(qualityEvidenceWindowFromMetrics(receiveMetrics())).toEqual({
      windowMs: 2_000,
      metrics: {
        width: 1_920,
        height: 1_080,
        framesPerSecond: 60,
        bitrateKbps: 7_500,
        packetsReceivedDelta: 1_500,
        packetsLostDelta: 2,
        jitterMs: 3.5,
        framesDecodedDelta: 120,
        framesDroppedDelta: 1,
        decodeMsPerFrame: 2.4,
        freezeCountDelta: 0,
        freezeDurationMsDelta: 0,
        codec: "video/H264",
        codecProfile: "profile-level-id=42e01f",
        codecParameters:
          "packetization-mode=1; level-asymmetry-allowed=1",
      },
    });

    expect(
      qualityEvidenceWindowFromMetrics(
        receiveMetrics({
          sampleWindowMs: 9_000,
          rtpStatsId: "must-not-leave-the-client",
        }),
      ),
    ).toBeNull();
    const bounded = qualityEvidenceWindowFromMetrics(
        receiveMetrics({
          frameWidth: 0,
          frameHeight: 0,
        bitrateKbps: 200_000,
        intervalPacketsLost: -1,
        codecParameters: "raw fmtp; secret=value/with/slash",
      }),
    );
    expect(bounded?.metrics).toMatchObject({
      width: null,
      height: null,
      bitrateKbps: null,
      packetsLostDelta: null,
      codecParameters: null,
    });
    expect(JSON.stringify(bounded)).not.toContain("rtpStatsId");
    expect(JSON.stringify(bounded)).not.toContain("must-not-leave-the-client");
    expect(JSON.stringify(bounded)).not.toContain("scalabilityMode");
    expect(JSON.stringify(bounded)).not.toContain("L3T3_KEY");
  });

  it("rate-limits, deduplicates, and resets sequence per connection", () => {
    let now = 10_000;
    const sent: ClientMessage[] = [];
    const reporter = new ViewerQualityEvidenceReporter(
      (message) => {
        sent.push(message);
        return true;
      },
      () => now,
    );
    const first = snapshot("connection_first_12345678");

    expect(reporter.offer(first, 0)).toBe(true);
    expect(reporter.offer(first, 0)).toBe(false);
    now += 1_000;
    expect(
      reporter.offer(
        snapshot(
          first.connectionId,
          receiveMetrics({ sampleTimestampMs: 11_000, bitrateKbps: 7_000 }),
        ),
        0,
      ),
    ).toBe(false);
    now += 1_000;
    expect(
      reporter.offer(
        snapshot(
          first.connectionId,
          receiveMetrics({ sampleTimestampMs: 12_000, bitrateKbps: 6_500 }),
        ),
        0,
      ),
    ).toBe(true);
    expect(
      reporter.offer(
        snapshot(
          first.connectionId,
          receiveMetrics({ sampleTimestampMs: 12_000, bitrateKbps: 6_000 }),
        ),
        2,
      ),
    ).toBe(true);
    expect(
      reporter.offer(snapshot("connection_second_12345678"), 2),
    ).toBe(true);
    now += 2_000;
    expect(
      reporter.offer(
        snapshot(
          "connection_second_12345678",
          receiveMetrics({ sampleTimestampMs: 14_000 }),
        ),
        2,
      ),
    ).toBe(true);

    expect(
      sent.map((message) =>
        message.type === "viewer-quality-evidence"
          ? {
              connectionId: message.guard.connectionId,
              revision: message.guard.routeRevision,
              sequence: message.sequence,
            }
          : null,
      ),
    ).toEqual([
      {
        connectionId: "connection_first_12345678",
        revision: 0,
        sequence: 0,
      },
      {
        connectionId: "connection_first_12345678",
        revision: 0,
        sequence: 1,
      },
      {
        connectionId: "connection_first_12345678",
        revision: 2,
        sequence: 2,
      },
      {
        connectionId: "connection_second_12345678",
        revision: 2,
        sequence: 0,
      },
      {
        connectionId: "connection_second_12345678",
        revision: 2,
        sequence: 1,
      },
    ]);
  });

  it("pairs and renders only the current parent connection", () => {
    const evidence = {
      type: "viewer-quality-evidence",
      viewerPeerId: "viewer_12345678",
      parentPeerId: "host_12345678",
      guard: {
        connectionId: "connection_12345678",
        routeRevision: 0,
      },
      sequence: 3,
      ...qualityEvidenceWindowFromMetrics(receiveMetrics())!,
    } as Extract<ServerMessage, { type: "viewer-quality-evidence" }>;
    const current = {
      ...snapshot(evidence.guard.connectionId),
      peerId: evidence.viewerPeerId,
    };

    expect(qualityEvidenceMatchesSnapshot(evidence, current)).toBe(true);
    expect(
      qualityEvidenceMatchesSnapshot(evidence, {
        ...current,
        connectionId: "connection_replaced_12345678",
      }),
    ).toBe(false);
    expect(metricsFromQualityEvidence(evidence)).toMatchObject({
      sampleWindowMs: 2_000,
      frameWidth: 1_920,
      frameHeight: 1_080,
      resolution: "1920x1080",
      bitrateKbps: 7_500,
      packetsLost: 2,
      framesDropped: 1,
      intervalFramesDecoded: 120,
      intervalFramesDropped: 1,
      intervalFreezeCount: 0,
      codec: "video/H264",
    });
  });

  it("builds parent proof only from a current connected send interval", () => {
    const evidence = {
      type: "viewer-quality-evidence",
      viewerPeerId: "viewer_12345678",
      parentPeerId: "host_12345678",
      guard: {
        connectionId: "connection_12345678",
        routeRevision: 4,
      },
      sequence: 7,
      ...qualityEvidenceWindowFromMetrics(receiveMetrics())!,
    } as Extract<ServerMessage, { type: "viewer-quality-evidence" }>;
    const current = {
      ...snapshot(
        evidence.guard.connectionId,
        receiveMetrics({
          sampleWindowMs: 2_000.25,
          intervalPacketsSent: 1_200,
          intervalPacketsLost: 12,
        }),
      ),
      peerId: evidence.viewerPeerId,
    };
    const reporter = new ParentEdgeQualityEvidenceReporter();

    expect(reporter.offer(evidence, current)).toEqual({
      type: "parent-edge-quality-evidence",
      viewerPeerId: evidence.viewerPeerId,
      guard: evidence.guard,
      viewerSequence: evidence.sequence,
      proof: {
        kind: "sending",
        packetsSentDelta: 1_200,
      },
    });
    expect(
      reporter.offer({ ...evidence, sequence: evidence.sequence + 1 }, current),
    ).toBeNull();
    expect(
      reporter.offer(
        { ...evidence, sequence: evidence.sequence + 1 },
        {
          ...current,
          metrics: {
            ...current.metrics,
            sampleTimestampMs: current.metrics.sampleTimestampMs! + 0.25,
          },
        },
      ),
    ).toMatchObject({ viewerSequence: evidence.sequence + 1 });
    expect(
      parentEdgeQualityEvidenceFromSnapshot(evidence, {
        ...current,
        metrics: {
          ...current.metrics,
          intervalPacketsSent: 100,
          intervalPacketsLost: 30,
        },
      }),
    ).toMatchObject({
      proof: {
        kind: "remote-loss",
        packetsSentDelta: 100,
        remotePacketsLostDelta: 30,
      },
    });
    for (const reason of ["cpu", "bandwidth"] as const) {
      expect(
        parentEdgeQualityEvidenceFromSnapshot(evidence, {
          ...current,
          metrics: {
            ...current.metrics,
            qualityLimitationReason: reason,
          },
        }),
      ).toMatchObject({
        proof: { kind: "sender-limited", packetsSentDelta: 1_200, reason },
      });
    }
    expect(
      parentEdgeQualityEvidenceFromSnapshot(evidence, {
        ...current,
        connectionId: "connection_replaced_12345678",
      }),
    ).toBeNull();
    expect(
      parentEdgeQualityEvidenceFromSnapshot(evidence, {
        ...current,
        metrics: { ...current.metrics, intervalPacketsSent: null },
      }),
    ).toBeNull();
  });
});
