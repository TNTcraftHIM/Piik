import { describe, expect, it } from "vitest";

import { qualityLimitationSummary } from "../src/client/components/connection-details.ts";
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
        snapshot("持续受带宽限制，浏览器正在降低画面质量"),
        snapshot("持续受编码性能限制，浏览器正在降低画面质量"),
      ]),
    ).toBe("持续受带宽限制，浏览器正在降低画面质量");
    expect(qualityLimitationSummary([snapshot(null)])).toBeNull();
  });
});
