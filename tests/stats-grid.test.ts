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
  localCandidateAddress: "192.0.2.10",
  localCandidatePort: 50_000,
  remoteCandidateAddress: "2001:db8::10",
  remoteCandidatePort: 50_001,
  codec: "video/VP8",
  codecParameters: "max-fs=8160",
  captureWidth: 1920,
  captureHeight: 1080,
  captureFramesPerSecond: 60,
  mediaSourceFramesPerSecond: 58.5,
  rtpRid: "h",
  audioBitrateKbps: 128,
  audioCodec: "audio/opus",
  encoderImplementation: "ExternalEncoder",
  intervalFramesEncoded: 116,
  intervalEncodeTimeMs: 371.2,
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
    expect(html.indexOf("本地候选地址")).toBeGreaterThan(panelStart);
    expect(html.indexOf("远端候选地址")).toBeGreaterThan(panelStart);
    expect(html).toContain("192.0.2.10:50000");
    expect(html).toContain("[2001:db8::10]:50001");
    expect(html.indexOf("视频 Codec")).toBeGreaterThan(panelStart);
    expect(html.indexOf("音频发送码率")).toBeGreaterThan(panelStart);
    expect(html.indexOf("编码输入帧率")).toBeGreaterThan(panelStart);
    expect(html.indexOf("最近区间编码量")).toBeGreaterThan(panelStart);
    expect(html.indexOf("最近区间编码/帧")).toBeGreaterThan(panelStart);
    expect(html).toContain("58.5 fps");
    expect(html).toContain("116 帧 · 371.2 ms");
    expect(html).toContain("当前 RID");
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

  it("shows local inbound playout and repair evidence only for receivers", () => {
    const receiverMetrics = {
      ...metrics,
      audioVideoPlayoutDeltaMs: -12.5,
      videoJitterBufferDelayMs: 24.5,
      audioJitterBufferDelayMs: 18.5,
      audioConcealedSamplesPercent: 1.25,
      intervalAudioConcealmentEvents: 3,
    } satisfies ConnectionMetrics;
    const receiveHtml = renderToStaticMarkup(
      createElement(StatsGrid, {
        metrics: receiverMetrics,
        direction: "receive",
      }),
    );
    const sendHtml = renderToStaticMarkup(
      createElement(StatsGrid, {
        metrics: receiverMetrics,
        direction: "send",
      }),
    );
    const unavailableReceiveHtml = renderToStaticMarkup(
      createElement(StatsGrid, {
        metrics,
        direction: "receive",
      }),
    );

    for (const label of [
      "音视频播放差",
      "视频抖动缓冲",
      "音频抖动缓冲",
      "音频补偿样本率",
      "音频补偿事件",
    ]) {
      expect(receiveHtml).toContain(label);
      expect(sendHtml).not.toContain(label);
      expect(unavailableReceiveHtml).not.toContain(label);
    }
    expect(receiveHtml).toContain("-12.5 ms");
    expect(receiveHtml).toContain("1.3%");
  });

  it("omits candidate endpoints when the browser withholds either field", () => {
    const html = renderToStaticMarkup(
      createElement(StatsGrid, {
        metrics: {
          ...metrics,
          localCandidatePort: null,
          remoteCandidateAddress: null,
        },
        direction: "receive",
      }),
    );

    expect(html).not.toContain("本地候选地址");
    expect(html).not.toContain("远端候选地址");
  });
});
