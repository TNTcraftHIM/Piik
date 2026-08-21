import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";

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

function candidateEndpoint(
  address: string | null,
  port: number | null,
): string | null {
  if (address === null || port === null) {
    return null;
  }
  const host =
    address.includes(":") &&
    !(address.startsWith("[") && address.endsWith("]"))
      ? `[${address}]`
      : address;
  return `${host}:${port}`;
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
  progressive = false,
}: {
  metrics: ConnectionMetrics;
  direction: "send" | "receive";
  senderParameters?: VideoSenderParameterReadback | null;
  progressive?: boolean;
}) {
  const [secondaryExpanded, setSecondaryExpanded] = useState(false);
  const secondaryId = useId();
  const encoder = metrics.encoderImplementation
    ? `${metrics.encoderImplementation}${
        metrics.powerEfficientEncoder === true
          ? " · 节能"
          : metrics.powerEfficientEncoder === false
            ? " · 非节能"
            : ""
      }`
    : "未知";
  const hasPlaybackEvidence = [
    metrics.audioVideoPlayoutDeltaMs,
    metrics.videoJitterBufferDelayMs,
    metrics.audioJitterBufferDelayMs,
    metrics.audioConcealedSamplesPercent,
    metrics.intervalAudioConcealmentEvents,
  ].some((value) => value !== null);
  const localCandidateEndpoint = candidateEndpoint(
    metrics.localCandidateAddress,
    metrics.localCandidatePort,
  );
  const remoteCandidateEndpoint = candidateEndpoint(
    metrics.remoteCandidateAddress,
    metrics.remoteCandidatePort,
  );

  const primaryMetrics = (
    <>
      <Metric
        label={direction === "send" ? "发送码率" : "接收码率"}
        value={`${readableNumber(metrics.bitrateKbps)} kbps`}
      />
      <Metric
        label={direction === "send" ? "发送帧率" : "接收帧率"}
        value={`${readableNumber(metrics.framesPerSecond, 1)} fps`}
      />
      <Metric
        label={direction === "send" ? "发送分辨率" : "接收分辨率"}
        value={metrics.resolution ?? "未知"}
      />
      <Metric label="RTT" value={`${readableNumber(metrics.rttMs)} ms`} title="网络往返时间" />
      <Metric
        label="视频丢包率"
        value={formatPacketLossPercent(metrics.packetLossPercent)}
      />
      <Metric
        label="传输协议"
        value={metrics.iceProtocol?.toUpperCase() ?? "未知"}
      />
      {metrics.localCandidateType === "relay" && (
        <Metric
          label="本地 TURN"
          value={metrics.localRelayProtocol?.toUpperCase() ?? "未知"}
        />
      )}
      <Metric
        label="候选路径"
        value={`${metrics.localCandidateType ?? "?"} / ${metrics.remoteCandidateType ?? "?"}`}
        title="本地 / 远端候选类型"
      />
      {direction === "send" && (
        <Metric label="质量状态" value={qualityReason(metrics.qualityLimitationReason)} />
      )}
    </>
  );

  const secondaryMetrics = (
    <>
      <Metric
        label={direction === "send" ? "可用上行" : "抖动"}
        value={
          direction === "send"
            ? `${readableNumber(metrics.availableOutgoingKbps)} kbps`
            : `${readableNumber(metrics.jitterMs, 1)} ms`
        }
      />
      {localCandidateEndpoint && (
        <Metric
          label="本地候选地址"
          value={localCandidateEndpoint}
          title={localCandidateEndpoint}
        />
      )}
      {remoteCandidateEndpoint && (
        <Metric
          label="远端候选地址"
          value={remoteCandidateEndpoint}
          title={remoteCandidateEndpoint}
        />
      )}
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
      {direction === "receive" && hasPlaybackEvidence && (
        <>
          <Metric
            label="音视频播放差"
            value={`${readableNumber(metrics.audioVideoPlayoutDeltaMs, 1)} ms`}
            title="音频 estimatedPlayoutTimestamp 减视频；正值表示音频时间线领先"
          />
          <Metric
            label="视频抖动缓冲"
            value={`${readableNumber(metrics.videoJitterBufferDelayMs, 1)} ms`}
            title="最近统计区间内已播放视频帧的平均 jitter-buffer delay"
          />
          <Metric
            label="音频抖动缓冲"
            value={`${readableNumber(metrics.audioJitterBufferDelayMs, 1)} ms`}
            title="最近统计区间内已播放音频样本的平均 jitter-buffer delay"
          />
          <Metric
            label="音频补偿样本率"
            value={formatPacketLossPercent(metrics.audioConcealedSamplesPercent)}
            title="最近统计区间内由接收端合成补偿的音频样本比例"
          />
          <Metric
            label="音频补偿事件"
            value={readableNumber(metrics.intervalAudioConcealmentEvents)}
            title="最近统计区间内开始连续音频样本补偿的次数"
          />
        </>
      )}
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
          <Metric
            label="捕获设置"
            value={
              metrics.captureWidth !== null && metrics.captureHeight !== null
                ? `${metrics.captureWidth}x${metrics.captureHeight} · ${readableNumber(
                    metrics.captureFramesPerSecond,
                    1,
                  )} fps`
                : "未知"
            }
            title="MediaStreamTrack 当前设置，不代表最近一秒实际输入帧率"
          />
          <Metric
            label="编码输入帧率"
            value={`${readableNumber(metrics.mediaSourceFramesPerSecond, 1)} fps`}
            title="media-source 最近一秒送入编码器的帧率"
          />
          {metrics.rtpRid && <Metric label="当前 RID" value={metrics.rtpRid} />}
          {metrics.scalabilityMode && (
            <Metric label="当前流伸缩模式" value={metrics.scalabilityMode} />
          )}
          <Metric label="编码器" value={encoder} />
          <Metric
            label="最近区间编码量"
            value={
              metrics.intervalFramesEncoded === null &&
              metrics.intervalEncodeTimeMs === null
                ? "未知"
                : `${readableNumber(metrics.intervalFramesEncoded)} 帧 · ${readableNumber(
                    metrics.intervalEncodeTimeMs,
                    1,
                  )} ms`
            }
            title="相邻样本间 framesEncoded 增量与 totalEncodeTime 增量"
          />
          <Metric
            label="最近区间编码/帧"
            value={`${readableNumber(metrics.intervalEncodeMs, 1)} ms`}
          />
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
    </>
  );

  if (!progressive) {
    return (
      <dl className="stats-grid">
        {primaryMetrics}
        {secondaryMetrics}
      </dl>
    );
  }

  const toggleLabel = secondaryExpanded ? "收起更多连接指标" : "展开更多连接指标";
  return (
    <div className="stats-disclosure">
      <dl className="stats-grid">{primaryMetrics}</dl>
      <div className="stats-detail-actions">
        <span>更多指标</span>
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
        {secondaryMetrics}
      </dl>
    </div>
  );
}
