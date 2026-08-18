import type { ConnectionMetrics } from "../types";

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
}: {
  metrics: ConnectionMetrics;
  direction: "send" | "receive";
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
      <Metric label="丢包" value={readableNumber(metrics.packetsLost)} />
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
      <Metric label="Codec" value={metrics.codec ?? "未知"} />
      {direction === "send" ? (
        <>
          <Metric label="编码器" value={encoder} />
          <Metric
            label="平均编码"
            value={`${readableNumber(metrics.averageEncodeMs, 1)} ms`}
          />
          <Metric label="质量状态" value={qualityReason(metrics.qualityLimitationReason)} />
        </>
      ) : (
        <>
          <Metric label="丢帧" value={readableNumber(metrics.framesDropped)} />
          <Metric
            label="平均解码"
            value={`${readableNumber(metrics.averageDecodeMs, 1)} ms`}
          />
        </>
      )}
    </dl>
  );
}
