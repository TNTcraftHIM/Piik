import { describe, expect, it } from "vitest";

import {
  invalidateSenderQualityEvidence,
  senderQualityEvidenceFromSnapshot,
  sfuPublisherQualityEvidenceFromMetrics,
} from "../src/client/media/sender-quality-evidence.ts";
import type { PeerSnapshot } from "../src/client/types.ts";
import {
  collectConnectionMetricsFromReport,
  collectNativeSenderQualityFromReport,
  createNativeSenderQualityAccumulator,
  createStatsAccumulator,
} from "../src/client/webrtc/stats.ts";

function report(
  timestamp: number,
  reason: "none" | "bandwidth" | "cpu",
  durations: Record<"none" | "bandwidth" | "cpu" | "other", number>,
): RTCStatsReport {
  return new Map([
    [
      "video",
      {
        id: "video",
        type: "outbound-rtp",
        kind: "video",
        timestamp,
        ssrc: 1,
        bytesSent: timestamp * 100,
        framesEncoded: timestamp / 20,
        qualityLimitationReason: reason,
        qualityLimitationDurations: durations,
      },
    ],
  ]) as unknown as RTCStatsReport;
}

describe("native sender quality evidence", () => {
  it("conservatively combines every active SFU publication encoding", () => {
    const accumulator = createNativeSenderQualityAccumulator();
    const multi = (
      timestamp: number,
      reasons: readonly ["none" | "bandwidth", "none" | "bandwidth"],
    ) => {
      const entries: Array<[string, Record<string, unknown>]> = [
        [
          "source",
          {
            id: "source",
            type: "media-source",
            timestamp,
            trackIdentifier: "track",
          },
        ],
      ];
      reasons.forEach((reason, index) =>
        entries.push([
          `video-${index}`,
          {
            id: `video-${index}`,
            type: "outbound-rtp",
            kind: "video",
            timestamp,
            framesEncoded: timestamp / 20 + index,
            mediaSourceId: "source",
            qualityLimitationReason: reason,
            qualityLimitationDurations: {
              none: reason === "none" ? timestamp / 1_000 : 3,
              bandwidth:
                reason === "bandwidth" ? timestamp / 1_000 - 3 : 0,
              cpu: 0,
              other: 0,
            },
          },
        ]),
      );
      return new Map(entries) as unknown as RTCStatsReport;
    };

    expect(
      collectNativeSenderQualityFromReport(
        multi(1_000, ["none", "none"]),
        "track",
        accumulator,
      ).nativeEdgeQualityState,
    ).toBe("unknown");
    expect(
      collectNativeSenderQualityFromReport(
        multi(3_000, ["none", "none"]),
        "track",
        accumulator,
      ).nativeEdgeQualityState,
    ).toBe("healthy");
    expect(
      collectNativeSenderQualityFromReport(
        multi(5_000, ["bandwidth", "none"]),
        "track",
        accumulator,
      ).nativeEdgeQualityState,
    ).toBe("degraded");
  });

  it("derives categorical state only from one complete native duration delta", () => {
    const accumulator = createStatsAccumulator();
    const first = collectConnectionMetricsFromReport(
      report(1_000, "none", { none: 1, bandwidth: 0, cpu: 0, other: 0 }),
      "send",
      accumulator,
    );
    expect(first.nativeEdgeQualityState).toBe("unknown");

    const healthy = collectConnectionMetricsFromReport(
      report(3_000, "none", { none: 3, bandwidth: 0, cpu: 0, other: 0 }),
      "send",
      accumulator,
    );
    expect(healthy.nativeEdgeQualityState).toBe("healthy");

    const degraded = collectConnectionMetricsFromReport(
      report(5_000, "bandwidth", {
        none: 3,
        bandwidth: 2,
        cpu: 0,
        other: 0,
      }),
      "send",
      accumulator,
    );
    expect(degraded.nativeEdgeQualityState).toBe("degraded");

    const mixed = collectConnectionMetricsFromReport(
      report(7_000, "none", {
        none: 4,
        bandwidth: 3,
        cpu: 0,
        other: 0,
      }),
      "send",
      accumulator,
    );
    expect(mixed.nativeEdgeQualityState).toBe("unknown");
  });

  it("serializes only exact healthy or degraded sender snapshots", () => {
    const metrics = collectConnectionMetricsFromReport(
      report(1_000, "none", { none: 1, bandwidth: 0, cpu: 0, other: 0 }),
      "send",
      createStatsAccumulator(),
    );
    const snapshot: PeerSnapshot = {
      peerId: "viewer_12345678",
      connectionId: "connection_12345678",
      connectionState: "connected",
      iceConnectionState: "connected",
      metrics: {
        ...metrics,
        rtpStatsId: "rtp-stats-1",
        trackIdentifier: "track-1",
        sampleWindowMs: 2_000,
        intervalFramesEncoded: 100,
        qualityLimitationReason: "none",
        nativeEdgeQualityState: "healthy",
      },
      error: null,
    };
    expect(senderQualityEvidenceFromSnapshot(snapshot, 7)).toMatchObject({
      state: "unknown",
    });
    expect(senderQualityEvidenceFromSnapshot(snapshot, 7)).toBeNull();
    const nextSnapshot = {
      ...snapshot,
      metrics: {
        ...snapshot.metrics,
        sampleTimestampMs: 2_000,
      },
    };
    expect(senderQualityEvidenceFromSnapshot(nextSnapshot, 7)).toMatchObject({
      type: "sender-quality-evidence",
      childPeerId: snapshot.peerId,
      connectionId: snapshot.connectionId,
      routeRevision: 7,
      state: "healthy",
      sampleTimestampMs: 2_000,
      diagnostics: { natTraversalPath: "unknown" },
    });
    invalidateSenderQualityEvidence();
    expect(senderQualityEvidenceFromSnapshot(nextSnapshot, 7)).toMatchObject({
      state: "unknown",
    });
    expect(senderQualityEvidenceFromSnapshot(nextSnapshot, 7)).toBeNull();
  });

  it("waits for a new SFU publisher stats window after rebaseline", () => {
    invalidateSenderQualityEvidence();
    const metrics = {
      ...collectConnectionMetricsFromReport(
        report(1_000, "none", {
          none: 1,
          bandwidth: 0,
          cpu: 0,
          other: 0,
        }),
        "send",
        createStatsAccumulator(),
      ),
      sampleTimestampMs: 1_000,
      sampleWindowMs: 2_000,
      intervalFramesEncoded: 100,
      qualityLimitationReason: "none",
      nativeEdgeQualityState: "healthy" as const,
    };
    const generation = "publication_generation_12345678";
    expect(
      sfuPublisherQualityEvidenceFromMetrics(metrics, 3, generation),
    ).toMatchObject({ state: "unknown" });
    expect(
      sfuPublisherQualityEvidenceFromMetrics(metrics, 3, generation),
    ).toBeNull();
    expect(
      sfuPublisherQualityEvidenceFromMetrics(
        { ...metrics, sampleTimestampMs: 3_000 },
        3,
        generation,
      ),
    ).toMatchObject({ state: "healthy", sampleTimestampMs: 3_000 });
  });
});
