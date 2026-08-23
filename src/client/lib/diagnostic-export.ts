import type { RouteDiagnosticSnapshot } from "../../shared/protocol";
import type { ConnectionMetrics } from "../types";

export const DIAGNOSTIC_SCHEMA_VERSION = 2;

const ROUTE_TIMING_KEYS = [
  "queueWaitMs",
  "candidateStartMs",
  "firstDecodedFrameMs",
  "finalMs",
] as const satisfies readonly (keyof RouteDiagnosticSnapshot["children"][number])[];

export interface RouteTimingDistribution {
  sampleCount: number;
  pendingCount: number;
  rawMs: number[];
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export function summarizeRouteTiming(
  values: readonly (number | null)[],
): RouteTimingDistribution {
  const rawMs = values
    .filter((value): value is number => value !== null)
    .toSorted((left, right) => left - right);
  return {
    sampleCount: rawMs.length,
    pendingCount: values.length - rawMs.length,
    rawMs,
    p50Ms: nearestRank(rawMs, 0.5),
    p95Ms: nearestRank(rawMs, 0.95),
    maxMs: rawMs.at(-1) ?? null,
  };
}

function nearestRank(
  sortedValues: readonly number[],
  percentile: number,
): number | null {
  if (sortedValues.length === 0) return null;
  return sortedValues[Math.ceil(percentile * sortedValues.length) - 1] ?? null;
}

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
  routeSnapshot: RouteDiagnosticSnapshot | null = null,
) {
  const route = role === "host" ? routeSnapshot : null;
  return {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    exportedAt: exportedAt.toISOString(),
    role,
    route,
    routeTimingSummary: route
      ? Object.fromEntries(
          ROUTE_TIMING_KEYS.map((key) => [
            key,
            summarizeRouteTiming(route.children.map((child) => child[key])),
          ]),
        )
      : null,
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
  routeSnapshot: RouteDiagnosticSnapshot | null = null,
): void {
  const exportedAt = new Date();
  const report = createDiagnosticReport(
    role,
    connections,
    exportedAt,
    routeSnapshot,
  );
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
