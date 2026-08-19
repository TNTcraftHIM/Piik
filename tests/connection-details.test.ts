import { describe, expect, it } from "vitest";

import { qualityLimitationSummary } from "../src/client/components/connection-details.ts";
import { EMPTY_METRICS, type PeerSnapshot } from "../src/client/types.ts";

function snapshot(reason: string | null): PeerSnapshot {
  return {
    peerId: "viewer-1",
    connectionId: "connection-1",
    connectionState: "connected",
    iceConnectionState: "connected",
    metrics: { ...EMPTY_METRICS, qualityLimitationReason: reason },
    error: null,
  };
}

describe("progressive connection details", () => {
  it("keeps active quality limitations available outside the details panel", () => {
    expect(
      qualityLimitationSummary([
        snapshot("none"),
        snapshot("bandwidth"),
        snapshot("cpu"),
        snapshot("bandwidth"),
      ]),
    ).toBe("发送画质受限：带宽受限、编码性能受限");
    expect(qualityLimitationSummary([snapshot(null)])).toBeNull();
  });
});
