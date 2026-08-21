import type { ConnectionMetrics } from "../types";
import type { VideoSenderParameterReadback } from "../media/quality";
import { formatPacketLossPercent } from "./connection-details";

function readableNumber(value: number | null, digits = 0): string {
  return value === null || !Number.isFinite(value) ? "未知" : value.toFixed(digits);
}

function qualityReason(value: string | null): string {
  const labels: Record<string, string> = {
    none: "正常",
    bandwidth: "带宽受限",
    cpu: "编码受限",
    other: "其他限制",
  };
  return value ? (labels[value] ?? value) : "未知";
}

function requestedApplied(
  requested: number | string | null,
  applied: number | string | null,
  format: (value: number | string) => string,
): string {
  const requestedText = requested === null ? "?" : format(requested);
  const appliedText = applied === null ? "未读回" : format(applied);
  return `${requestedText} / ${appliedText}`;
}

function preferenceLabel(value: number | string): string {
  const labels: Record<string, string> = {
    "maintain-resolution": "清晰",
    balanced: "平衡",
    "maintain-framerate": "流畅",
  };
  return labels[String(value)] ?? String(value);
}

function Metric({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="metric" title={title}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function StatsGrid({
  metrics,
  direction,
  senderParameters,
}: {
  metrics: ConnectionMetrics;
  direction: "send" | "receive";
  senderParameters?: VideoSenderParameterReadback | null;
}) {
  const encoder = metrics.encoderImplementation
    ? `${metrics.encoderImplementation}${
        metrics.powerEfficientEncoder === true
          ? " · 节能"
          : metrics.powerEfficientEncoder === false
            ? " · 非节能"
            : ""
      }`
    : "未知";

  return (
    <dl className="stats-grid">
      <Metric
        label={direction === "send" ? "发送码率" : "接收码率"}
        value={`${readableNumber(metrics.bitrateKbps)} kbps`}
      />
      <Metric label="帧率" value={`${readableNumber(metrics.framesPerSecond, 1)} fps`} />
      <Metric label="分辨率" value={metrics.resolution ?? "未知"} />
      <Metric label="RTT" value={`${readableNumber(metrics.rttMs)} ms`} title="网络往返时间" />
      <Metric
        label="视频丢包率"
        value={formatPacketLossPercent(metrics.packetLossPercent)}
      />
      <Metric
        label={direction === "send" ? "可用上行" : "抖动"}
        value={
          direction === "send"
            ? `${readableNumber(metrics.availableOutgoingKbps)} kbps`
            : `${readableNumber(metrics.jitterMs, 1)} ms`
        }
      />
      <Metric
        label="ICE 传输"
        value={metrics.iceProtocol?.toUpperCase() ?? "未知"}
      />
      {metrics.localCandidateType === "relay" && (
        <Metric
          label="本地 TURN"
          value={metrics.localRelayProtocol?.toUpperCase() ?? "未知"}
        />
      )}
      <Metric
        label="候选"
        value={`${metrics.localCandidateType ?? "?"} / ${metrics.remoteCandidateType ?? "?"}`}
        title="本地 / 远端候选类型"
      />
      <Metric label="视频 Codec" value={metrics.codec ?? "未知"} />
      {metrics.codecProfile && (
        <Metric label="视频 Codec profile token" value={metrics.codecProfile} />
      )}
      {metrics.codecParameters && (
        <Metric label="视频 Codec 协商参数" value={metrics.codecParameters} />
      )}
      <Metric
        label={direction === "send" ? "音频发送码率" : "音频接收码率"}
        value={`${readableNumber(metrics.audioBitrateKbps)} kbps`}
      />
      <Metric
        label="音频丢包率"
        value={formatPacketLossPercent(metrics.audioPacketLossPercent)}
      />
      <Metric
        label="音频抖动"
        value={`${readableNumber(metrics.audioJitterMs, 1)} ms`}
      />
      <Metric label="音频 Codec" value={metrics.audioCodec ?? "未知"} />
      {metrics.audioCodecClockRate !== null && (
        <Metric
          label="音频 RTP 时钟"
          value={`${metrics.audioCodecClockRate} Hz`}
          title="Codec 协商时钟，不代表采集源采样率"
        />
      )}
      {metrics.audioCodecChannels !== null && (
        <Metric
          label="音频 Codec 声道"
          value={String(metrics.audioCodecChannels)}
          title="Codec 协商声道字段，不证明音源或有效载荷为立体声"
        />
      )}
      {metrics.audioCodecParameters && (
        <Metric
          label="音频 Codec 协商参数"
          value={metrics.audioCodecParameters}
          title={`协商参数：${metrics.audioCodecParameters}；不证明编码器当前启用了对应模式`}
        />
      )}
      {direction === "send" ? (
        <>
          {metrics.scalabilityMode && (
            <Metric label="当前流伸缩模式" value={metrics.scalabilityMode} />
          )}
          <Metric label="编码器" value={encoder} />
          <Metric
            label="最近区间编码/帧"
            value={`${readableNumber(metrics.intervalEncodeMs, 1)} ms`}
          />
          <Metric label="质量状态" value={qualityReason(metrics.qualityLimitationReason)} />
          {senderParameters && (
            <>
              <Metric
                label="请求 / 应用码率"
                value={requestedApplied(
                  senderParameters.requested.maxBitrate,
                  senderParameters.applied.maxBitrate,
                  (value) => `${(Number(value) / 1_000_000).toFixed(1)} Mbps`,
                )}
              />
              <Metric
                label="请求 / 应用帧率"
                value={requestedApplied(
                  senderParameters.requested.maxFramerate,
                  senderParameters.applied.maxFramerate,
                  (value) => `${Number(value).toFixed(0)} fps`,
                )}
              />
              <Metric
                label="请求 / 应用缩放"
                value={requestedApplied(
                  senderParameters.requested.scaleResolutionDownBy,
                  senderParameters.applied.scaleResolutionDownBy,
                  (value) => `${Number(value).toFixed(2)}x`,
                )}
              />
              <Metric
                label="请求 / 应用优先级"
                value={requestedApplied(
                  senderParameters.requested.degradationPreference,
                  senderParameters.applied.degradationPreference,
                  preferenceLabel,
                )}
              />
              {(senderParameters.requested.scalabilityMode !== null ||
                senderParameters.applied.scalabilityMode !== null) && (
                <Metric
                  label="请求 / 应用伸缩模式"
                  value={requestedApplied(
                    senderParameters.requested.scalabilityMode,
                    senderParameters.applied.scalabilityMode,
                    String,
                  )}
                />
              )}
            </>
          )}
        </>
      ) : (
        <>
          <Metric label="丢帧" value={readableNumber(metrics.framesDropped)} />
          <Metric
            label="最近区间解码/帧"
            value={`${readableNumber(metrics.intervalDecodeMs, 1)} ms`}
          />
        </>
      )}
    </dl>
  );
}
