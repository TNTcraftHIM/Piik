import { describe, expect, it } from "vitest";

import {
  collectConnectionMetricsFromReport,
  createStatsAccumulator,
} from "../src/client/webrtc/stats";
import { packetLossPercentFromDeltas } from "../src/shared/packet-loss";

function senderReport(
  mediaTimestamp: number,
  lossSourceId: string,
  lossTimestamp: number,
  fractionLost: number,
  packetsLost: number,
): RTCStatsReport {
  return new Map<string, unknown>([
    [
      "video",
      {
        id: "video",
        type: "outbound-rtp",
        timestamp: mediaTimestamp,
        kind: "video",
        ssrc: 101,
        remoteId: lossSourceId,
        packetsSent: mediaTimestamp,
        bytesSent: mediaTimestamp,
        framesEncoded: mediaTimestamp / 100,
      },
    ],
    [
      lossSourceId,
      {
        id: lossSourceId,
        type: "remote-inbound-rtp",
        timestamp: lossTimestamp,
        kind: "video",
        ssrc: 101,
        packetsLost,
        fractionLost,
        roundTripTime: 0.02,
      },
    ],
  ]) as unknown as RTCStatsReport;
}

describe("packet loss evidence", () => {
  it("uses each fresh sender RTCP fraction exactly once", () => {
    const accumulator = createStatsAccumulator();

    const first = collectConnectionMetricsFromReport(
      senderReport(1_000, "remote-a", 900, 0.25, 4),
      "send",
      accumulator,
    );
    const repeatedReport = collectConnectionMetricsFromReport(
      senderReport(3_000, "remote-a", 900, 0.25, 4),
      "send",
      accumulator,
    );
    const freshReport = collectConnectionMetricsFromReport(
      senderReport(5_000, "remote-a", 4_900, 0.125, 6),
      "send",
      accumulator,
    );

    expect(first.packetLossPercent).toBeNull();
    expect(repeatedReport.packetLossPercent).toBeNull();
    expect(freshReport.packetLossPercent).toBe(12.5);
  });

  it("rebaselines sender loss on source or report-time changes", () => {
    const accumulator = createStatsAccumulator();
    collectConnectionMetricsFromReport(
      senderReport(1_000, "remote-a", 900, 0.1, 2),
      "send",
      accumulator,
    );
    const sourceChanged = collectConnectionMetricsFromReport(
      senderReport(3_000, "remote-b", 2_900, 0.2, 3),
      "send",
      accumulator,
    );
    const stableSource = collectConnectionMetricsFromReport(
      senderReport(5_000, "remote-b", 4_900, 0.2, 4),
      "send",
      accumulator,
    );
    const timestampRollback = collectConnectionMetricsFromReport(
      senderReport(7_000, "remote-b", 4_000, 0.5, 1),
      "send",
      accumulator,
    );
    const invalidFraction = collectConnectionMetricsFromReport(
      senderReport(9_000, "remote-b", 8_900, 1.1, 5),
      "send",
      accumulator,
    );

    expect(sourceChanged.packetLossPercent).toBeNull();
    expect(stableSource.packetLossPercent).toBe(20);
    expect(timestampRollback.packetLossPercent).toBeNull();
    expect(invalidFraction.packetLossPercent).toBeNull();
  });

  it("keeps receive-side delta validation unchanged", () => {
    expect(packetLossPercentFromDeltas(90, 10)).toBe(10);
    expect(packetLossPercentFromDeltas(0, 0)).toBeNull();
    expect(packetLossPercentFromDeltas(null, 1)).toBeNull();
    expect(packetLossPercentFromDeltas(10, -1)).toBeNull();
  });
});
