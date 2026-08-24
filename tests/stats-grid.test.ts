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
  selectedCandidatePairId: "candidate-pair-7",
  codec: "video/VP8",
  codecParameters: "max-fs=8160",
  captureWidth: 1_920,
  captureHeight: 1_080,
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
  it("keeps one-glance picture results above an accessible detail panel", () => {
    const html = renderToStaticMarkup(
      createElement(StatsGrid, {
        metrics,
        direction: "send",
        progressive: true,
      }),
    );

    for (const label of ["分辨率", "帧率", "码率", "丢包率"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('title="展开详细指标"');
    const controlId = html.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controlId).toBeTruthy();
    const panelStart = html.indexOf(`<dl id="${controlId}"`);
    expect(panelStart).toBeGreaterThan(0);
    expect(html.slice(panelStart, html.indexOf(">", panelStart))).toContain(
      'hidden=""',
    );
    for (const label of [
      "RTT",
      "可用上行",
      "质量状态",
      "捕获设置",
      "编码输入帧率",
      "编码器",
      "编码耗时/帧",
      "音频码率",
    ]) {
      expect(html.indexOf(label)).toBeGreaterThan(panelStart);
    }
    expect(html).toContain("58.5 fps");
  });

  it("omits fixed codecs and browser-internal transport details", () => {
    const html = renderToStaticMarkup(
      createElement(StatsGrid, { metrics, direction: "send" }),
    );

    for (const omitted of [
      "视频 Codec",
      "音频 Codec",
      "候选路径",
      "本地候选地址",
      "远端候选地址",
      "候选对 ID",
      "STUN 响应",
      "candidate-pair-7",
      "192.0.2.10",
      "当前 RID",
      "max-fs=8160",
      "请求 / 应用",
    ]) {
      expect(html).not.toContain(omitted);
    }
    expect(html).not.toContain("详细指标");
    expect(html).not.toContain("aria-expanded");
  });

  it("shows codecs only when the negotiated contract is unexpected", () => {
    const html = renderToStaticMarkup(
      createElement(StatsGrid, {
        metrics: {
          ...metrics,
          codec: "video/H264",
          audioCodec: "audio/PCMU",
        },
        direction: "receive",
      }),
    );

    expect(html).toContain("视频编码为 H264，预期 VP8");
    expect(html).toContain("音频编码为 PCMU，预期 Opus");
    expect(html).not.toContain("视频 Codec");
    expect(html).not.toContain("音频 Codec");
  });

  it("does not expose an unknown browser quality-limitation value", () => {
    const html = renderToStaticMarkup(
      createElement(StatsGrid, {
        metrics: {
          ...metrics,
          qualityLimitationReason: "browser-internal-sentinel",
        },
        direction: "send",
      }),
    );

    expect(html).toContain("未分类限制");
    expect(html).not.toContain("browser-internal-sentinel");
  });

  it("shows available inbound playback and repair evidence only for receivers", () => {
    const receiverMetrics = {
      ...metrics,
      jitterMs: 4.5,
      framesDropped: 2,
      intervalDecodeMs: 2.1,
      intervalFreezeCount: 1,
      intervalFreezeDurationMs: 120,
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

    for (const label of [
      "网络抖动",
      "丢帧",
      "解码耗时/帧",
      "画面冻结",
      "冻结时长",
      "音视频播放差",
      "视频缓冲",
      "音频缓冲",
      "音频补偿率",
      "音频补偿",
    ]) {
      expect(receiveHtml).toContain(label);
      expect(sendHtml).not.toContain(label);
    }
    expect(receiveHtml).toContain("-12.5 ms");
    expect(receiveHtml).toContain("1.3%");
  });

  it("does not render an empty second level", () => {
    const html = renderToStaticMarkup(
      createElement(StatsGrid, {
        metrics: EMPTY_METRICS,
        direction: "receive",
        progressive: true,
      }),
    );

    expect(html).not.toContain("详细指标");
    expect(html).not.toContain("aria-expanded");
  });
});
