import type { ConnectionMetrics } from "../types";

export const DIAGNOSTIC_SCHEMA_VERSION = 1;

const DIAGNOSTIC_METRIC_KEYS = [
  "sampleWindowMs", "captureWidth", "captureHeight",
  "candidatePairResponsesReceived", "intervalCandidatePairResponsesReceived",
  "candidatePairSampleWindowMs",
  "captureFramesPerSecond", "mediaSourceFramesPerSecond", "path",
  "iceProtocol", "localCandidateType",
  "remoteCandidateType", "rttMs", "bitrateKbps", "availableOutgoingKbps",
  "framesPerSecond", "frameWidth", "frameHeight", "resolution",
  "packetsLost", "intervalPacketsSent", "intervalPacketsReceived",
  "intervalPacketsLost", "packetLossPercent", "jitterMs", "framesDropped",
  "intervalFramesDecoded", "intervalFramesDropped", "intervalFreezeCount",
  "intervalFreezeDurationMs", "intervalRetransmittedPackets",
  "intervalRetransmittedBytes", "codec", "codecProfile", "codecParameters",
  "audioBitrateKbps", "audioPacketLossPercent", "audioJitterMs",
  "audioVideoPlayoutDeltaMs", "videoJitterBufferDelayMs",
  "audioJitterBufferDelayMs", "audioConcealedSamplesPercent",
  "intervalAudioConcealmentEvents", "audioCodec", "audioCodecClockRate",
  "audioCodecChannels", "audioCodecParameters", "scalabilityMode",
  "encoderImplementation", "powerEfficientEncoder", "intervalFramesEncoded",
  "intervalEncodeTimeMs", "intervalEncodeMs", "intervalDecodeMs",
  "qualityLimitationReason",
] as const satisfies readonly (keyof ConnectionMetrics)[];

export interface DiagnosticConnectionInput {
  scope: "host-sfu" | "upstream" | "viewer-edge" | "relay-edge";
  route: "p2p" | "sfu";
  direction: "send" | "receive";
  connectionState?: RTCPeerConnectionState | "reconnecting" | null;
  iceConnectionState?: RTCIceConnectionState | null;
  metrics: ConnectionMetrics;
}

export function createDiagnosticReport(
  role: "host" | "viewer",
  connections: readonly DiagnosticConnectionInput[],
  exportedAt = new Date(),
) {
  return {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    exportedAt: exportedAt.toISOString(),
    role,
    connections: connections.map((connection) => ({
      scope: connection.scope,
      route: connection.route,
      direction: connection.direction,
      connectionState: connection.connectionState ?? null,
      iceConnectionState: connection.iceConnectionState ?? null,
      metrics: Object.fromEntries(
        DIAGNOSTIC_METRIC_KEYS.map((key) => [
          key,
          connection.metrics[key] ?? null,
        ]),
      ),
    })),
  };
}

export function downloadDiagnosticReport(
  role: "host" | "viewer",
  connections: readonly DiagnosticConnectionInput[],
): void {
  const exportedAt = new Date();
  const report = createDiagnosticReport(role, connections, exportedAt);
  const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `screener-diagnostics-${role}-${exportedAt
    .toISOString()
    .replace(/[:.]/g, "-")}.json`;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
