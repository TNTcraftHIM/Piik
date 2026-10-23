import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectionDetails } from "../src/client/components/living/ConnectionDetails";
import { EMPTY_METRICS } from "../src/client/types";

import {
  formatPacketLossPercent,
  summarizeConnectionMetrics,
} from "../src/client/components/connection-details.ts";
describe("progressive connection details", () => {
  it("formats interval packet loss without inventing unknown values", () => {
    expect(formatPacketLossPercent(1.25, "未知")).toBe("1.3%");
    expect(formatPacketLossPercent(0, "未知")).toBe("0.0%");
    expect(formatPacketLossPercent(null, "未知")).toBe("未知");
    expect(formatPacketLossPercent(Number.NaN, "未知")).toBe("未知");
  });

  it("weights received packet loss by packets and counts a shared transport RTT once", () => {
    const samples = [
      { connectionId: "relay", metrics: { ...EMPTY_METRICS, bitrateKbps: 80, rttMs: 20, intervalPacketsReceived: 90, intervalPacketsLost: 10 } },
      { connectionId: "relay", metrics: { ...EMPTY_METRICS, bitrateKbps: 60, rttMs: 20, intervalPacketsReceived: 990, intervalPacketsLost: 10 } },
      { connectionId: "direct", metrics: { ...EMPTY_METRICS, bitrateKbps: 70, rttMs: 60 } },
    ];
    expect(summarizeConnectionMetrics(samples, "receive")).toMatchObject({ bitrateKbps: 210, rttMs: 40, packetLossPercent: 100 * 20 / 1100 });
  });

  it("keeps many physical connections within four media and direction summaries", () => {
    const rows = (["video", "audio"] as const).flatMap(media => (["receive", "send"] as const).flatMap(direction =>
      [1, 2, 3].map(index => ({ key: `${media}/${direction}/${index}`, media, direction, label: `Peer ${index}`,
        metrics: { ...EMPTY_METRICS, bitrateKbps: 64 } }))));
    const html = renderToStaticMarkup(createElement(ConnectionDetails, { rows }));
    expect(html.match(/class="lr-media-detail lr-connection-summary"/g)).toHaveLength(4);
    expect(renderToStaticMarkup(createElement(ConnectionDetails, { rows: [] }))).toBe("");
  });
});
