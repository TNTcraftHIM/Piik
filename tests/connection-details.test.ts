import { describe, expect, it } from "vitest";

import {
  formatPacketLossPercent,
  qualityLimitationSummary,
} from "../src/client/components/connection-details.ts";
import { EMPTY_METRICS, type PeerSnapshot } from "../src/client/types.ts";

function snapshot(qualityWarning: string | null): PeerSnapshot {
  return {
    peerId: "viewer-1",
    connectionId: "connection-1",
    connectionState: "connected",
    iceConnectionState: "connected",
    metrics: { ...EMPTY_METRICS, qualityLimitationReason: "bandwidth" },
    error: null,
    qualityWarning,
  };
}

describe("progressive connection details", () => {
  it("keeps one debounced quality warning outside the details panel", () => {
    expect(
      qualityLimitationSummary([
        snapshot(null),
        snapshot("当前连接带宽受限，画质已自动降低"),
        snapshot("编码性能受限，画质已自动降低"),
      ]),
    ).toBe("当前连接带宽受限，画质已自动降低");
    expect(qualityLimitationSummary([snapshot(null)])).toBeNull();
  });

  it("formats interval packet loss without inventing unknown values", () => {
    expect(formatPacketLossPercent(1.25, "未知")).toBe("1.3%");
    expect(formatPacketLossPercent(0, "未知")).toBe("0.0%");
    expect(formatPacketLossPercent(null, "未知")).toBe("未知");
    expect(formatPacketLossPercent(Number.NaN, "未知")).toBe("未知");
  });
});
