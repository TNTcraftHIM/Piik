import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";

import type { ConnectionMetrics } from "../types";
import { formatPacketLossPercent } from "./connection-details";

interface MetricValue {
  label: string;
  value: string;
  title?: string;
}

function readableNumber(value: number | null, digits = 0): string {
  return value === null || !Number.isFinite(value) ? "未知" : value.toFixed(digits);
}

function readableWithUnit(
  value: number | null,
  unit: string,
  digits = 0,
): string {
  const readable = readableNumber(value, digits);
  return readable === "未知" ? readable : `${readable} ${unit}`;
}

function qualityReason(value: string): string {
  const labels: Record<string, string> = {
    none: "正常",
    bandwidth: "带宽受限",
    cpu: "编码受限",
    other: "其他限制",
  };
  return labels[value] ?? "未分类限制";
}

function Metric({ label, value, title }: MetricValue) {
  return (
    <div className="metric" title={title}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function codecName(codec: string): string {
  return codec.split("/").at(-1) ?? codec;
}

export function codecContractWarnings(metrics: ConnectionMetrics): string[] {
  const warnings: string[] = [];
  if (
    metrics.codec &&
    !["video/h264", "video/vp8"].includes(metrics.codec.toLowerCase())
  ) {
    warnings.push(
      `视频编码为 ${codecName(metrics.codec)}，预期 H264 或 VP8`,
    );
  }
  if (metrics.audioCodec && metrics.audioCodec.toLowerCase() !== "audio/opus") {
    warnings.push(`音频编码为 ${codecName(metrics.audioCodec)}，预期 Opus`);
  }
  return warnings;
}

function secondaryMetrics(
  metrics: ConnectionMetrics,
  direction: "send" | "receive",
): MetricValue[] {
  const values: MetricValue[] = [];
  const addNumber = (
    label: string,
    value: number | null,
    unit: string,
    digits = 0,
    title?: string,
  ) => {
    if (value !== null && Number.isFinite(value)) {
      values.push({ label, value: readableWithUnit(value, unit, digits), title });
    }
  };

  addNumber("RTT", metrics.rttMs, "ms", 0, "网络往返时间");

  if (direction === "send") {
    addNumber("可用上行", metrics.availableOutgoingKbps, "kbps");
    if (metrics.qualityLimitationReason) {
      values.push({
        label: "质量状态",
        value: qualityReason(metrics.qualityLimitationReason),
      });
    }
    const captureParts: string[] = [];
    if (metrics.captureWidth !== null && metrics.captureHeight !== null) {
      captureParts.push(`${metrics.captureWidth}x${metrics.captureHeight}`);
    }
    if (metrics.captureFramesPerSecond !== null) {
      captureParts.push(readableWithUnit(metrics.captureFramesPerSecond, "fps", 1));
    }
    if (captureParts.length > 0) {
      values.push({
        label: "捕获设置",
        value: captureParts.join(" · "),
        title: "MediaStreamTrack 当前捕获设置",
      });
    }
    addNumber(
      "编码输入帧率",
      metrics.mediaSourceFramesPerSecond,
      "fps",
      1,
    );
    if (metrics.encoderImplementation) {
      values.push({
        label: "编码器",
        value: `${metrics.encoderImplementation}${
          metrics.powerEfficientEncoder === true
            ? " · 节能"
            : metrics.powerEfficientEncoder === false
              ? " · 非节能"
              : ""
        }`,
      });
    }
    addNumber("编码耗时/帧", metrics.intervalEncodeMs, "ms", 1);
  } else {
    addNumber("网络抖动", metrics.jitterMs, "ms", 1);
    addNumber("丢帧", metrics.framesDropped, "帧");
    addNumber("解码耗时/帧", metrics.intervalDecodeMs, "ms", 1);
    addNumber("画面冻结", metrics.intervalFreezeCount, "次");
    addNumber("冻结时长", metrics.intervalFreezeDurationMs, "ms", 1);
  }

  addNumber("音频码率", metrics.audioBitrateKbps, "kbps");
  if (metrics.audioPacketLossPercent !== null) {
    values.push({
      label: "音频丢包率",
      value: formatPacketLossPercent(metrics.audioPacketLossPercent),
    });
  }
  addNumber("音频抖动", metrics.audioJitterMs, "ms", 1);

  if (direction === "receive") {
    addNumber(
      "音视频播放差",
      metrics.audioVideoPlayoutDeltaMs,
      "ms",
      1,
      "音频 estimatedPlayoutTimestamp 减视频；正值表示音频时间线领先",
    );
    addNumber(
      "视频缓冲",
      metrics.videoJitterBufferDelayMs,
      "ms",
      1,
      "最近统计区间内已播放视频帧的平均抖动缓冲延迟",
    );
    addNumber(
      "音频缓冲",
      metrics.audioJitterBufferDelayMs,
      "ms",
      1,
      "最近统计区间内已播放音频样本的平均抖动缓冲延迟",
    );
    if (metrics.audioConcealedSamplesPercent !== null) {
      values.push({
        label: "音频补偿率",
        value: formatPacketLossPercent(metrics.audioConcealedSamplesPercent),
        title: "最近统计区间内由接收端合成补偿的音频样本比例",
      });
    }
    addNumber(
      "音频补偿",
      metrics.intervalAudioConcealmentEvents,
      "次",
      0,
      "最近统计区间内开始连续音频样本补偿的次数",
    );
  }

  return values;
}

export function StatsGrid({
  metrics,
  direction,
  progressive = false,
}: {
  metrics: ConnectionMetrics;
  direction: "send" | "receive";
  progressive?: boolean;
}) {
  const [secondaryExpanded, setSecondaryExpanded] = useState(false);
  const secondaryId = useId();
  const warnings = codecContractWarnings(metrics);
  const primary: MetricValue[] = [
    { label: "分辨率", value: metrics.resolution ?? "未知" },
    {
      label: "帧率",
      value: readableWithUnit(metrics.framesPerSecond, "fps", 1),
    },
    {
      label: "码率",
      value: readableWithUnit(metrics.bitrateKbps, "kbps"),
    },
    {
      label: "丢包率",
      value: formatPacketLossPercent(metrics.packetLossPercent),
    },
  ];
  const secondary = secondaryMetrics(metrics, direction);
  const summary = (
    <>
      <dl className="stats-grid">
        {primary.map((metric) => (
          <Metric key={metric.label} {...metric} />
        ))}
      </dl>
      {warnings.map((warning) => (
        <p className="stats-contract-warning" key={warning}>
          {warning}
        </p>
      ))}
    </>
  );

  if (!progressive) {
    return (
      <>
        <dl className="stats-grid">
          {[...primary, ...secondary].map((metric) => (
            <Metric key={metric.label} {...metric} />
          ))}
        </dl>
        {warnings.map((warning) => (
          <p className="stats-contract-warning" key={warning}>
            {warning}
          </p>
        ))}
      </>
    );
  }

  const toggleLabel = secondaryExpanded ? "收起详细指标" : "展开详细指标";
  return (
    <div className="stats-disclosure">
      {summary}
      {secondary.length > 0 && (
        <>
          <div className="stats-detail-actions">
            <span>详细指标</span>
            <button
              className={`icon-button stats-detail-toggle${secondaryExpanded ? " is-expanded" : ""}`}
              type="button"
              title={toggleLabel}
              aria-label={toggleLabel}
              aria-expanded={secondaryExpanded}
              aria-controls={secondaryId}
              onClick={() => setSecondaryExpanded((current) => !current)}
            >
              <ChevronDown size={16} aria-hidden="true" />
            </button>
          </div>
          <dl
            id={secondaryId}
            className="stats-grid stats-grid-secondary"
            hidden={!secondaryExpanded}
          >
            {secondary.map((metric) => (
              <Metric key={metric.label} {...metric} />
            ))}
          </dl>
        </>
      )}
    </div>
  );
}
