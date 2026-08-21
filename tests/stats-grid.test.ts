import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StatsGrid } from "../src/client/components/StatsGrid.tsx";
import {
  EMPTY_METRICS,
  type ConnectionMetrics,
} from "../src/client/types.ts";

const metrics = {
  ...EMPTY_METRICS,
  bitrateKbps: 4_200,
  framesPerSecond: 59.8,
  resolution: "1920x1080",
  rttMs: 21,
  packetLossPercent: 0.4,
  availableOutgoingKbps: 8_100,
  iceProtocol: "udp",
  localCandidateType: "srflx",
  remoteCandidateType: "host",
  codec: "video/VP8",
  codecParameters: "max-fs=8160",
  audioBitrateKbps: 128,
  audioCodec: "audio/opus",
  encoderImplementation: "ExternalEncoder",
  intervalEncodeMs: 3.2,
  qualityLimitationReason: "bandwidth",
} satisfies ConnectionMetrics;

describe("StatsGrid progressive disclosure", () => {
  it("keeps route-critical metrics above an accessible collapsed deep panel", () => {
    const html = renderToStaticMarkup(
      createElement(StatsGrid, {
        metrics,
        direction: "send",
        progressive: true,
      }),
    );

    for (const label of [
      "发送码率",
      "帧率",
      "分辨率",
      "RTT",
      "视频丢包率",
      "传输协议",
      "候选路径",
      "质量状态",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('title="展开更多连接指标"');
    const controlId = html.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controlId).toBeTruthy();
    const panelStart = html.indexOf(`<dl id="${controlId}"`);
    expect(panelStart).toBeGreaterThan(0);
    expect(html.slice(panelStart, html.indexOf(">", panelStart))).toContain(
      'hidden=""',
    );
    expect(html.indexOf("质量状态")).toBeLessThan(panelStart);
    expect(html.indexOf("视频 Codec")).toBeGreaterThan(panelStart);
    expect(html.indexOf("音频发送码率")).toBeGreaterThan(panelStart);
    expect(html.indexOf("最近区间编码/帧")).toBeGreaterThan(panelStart);
  });

  it("keeps the existing full grid when progressive disclosure is not requested", () => {
    const html = renderToStaticMarkup(
      createElement(StatsGrid, { metrics, direction: "send" }),
    );

    expect(html).toContain("视频 Codec");
    expect(html).toContain("音频发送码率");
    expect(html).not.toContain("更多指标");
    expect(html).not.toContain("aria-expanded");
  });
});
