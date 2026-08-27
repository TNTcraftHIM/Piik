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
        snapshot("此发送连接持续按带宽估计降低分辨率或帧率"),
        snapshot("此发送连接持续因编码性能降低分辨率或帧率"),
      ]),
    ).toBe("此发送连接持续按带宽估计降低分辨率或帧率");
    expect(qualityLimitationSummary([snapshot(null)])).toBeNull();
  });

  it("formats interval packet loss without inventing unknown values", () => {
    expect(formatPacketLossPercent(1.25)).toBe("1.3%");
    expect(formatPacketLossPercent(0)).toBe("0.0%");
    expect(formatPacketLossPercent(null)).toBe("未知");
    expect(formatPacketLossPercent(Number.NaN)).toBe("未知");
  });
});
