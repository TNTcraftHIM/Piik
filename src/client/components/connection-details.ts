import type { ConnectionMetrics } from "../types";
import { packetLossPercentFromDeltas } from "../../shared/packet-loss";

export interface ConnectionMetricSample {
  connectionId: string;
  metrics: ConnectionMetrics;
}

// Presentation-only totals. Receive loss uses packet counts; send loss retains
// RTCP's report interval instead of weighting it with unrelated local counters.
export function summarizeConnectionMetrics(samples: readonly ConnectionMetricSample[], direction: "send" | "receive") {
  const metrics = samples.map(sample => sample.metrics);
  const numbers = (values: (number | null)[]) => values.filter((value): value is number => value !== null);
  const sum = (values: number[]) => values.length ? values.reduce((total, value) => total + value, 0) : null;
  const mean = (values: number[]) => values.length ? sum(values)! / values.length : null;
  const rtts = new Map<string, number>();
  for (const sample of samples) {
    if (sample.metrics.rttMs !== null && !rtts.has(sample.connectionId)) rtts.set(sample.connectionId, sample.metrics.rttMs);
  }
  const packetSamples = metrics.filter(metric => metric.intervalPacketsReceived !== null && metric.intervalPacketsLost !== null);
  const resolutions = [...new Set(metrics.map(metric => metric.resolution).filter((value): value is string => value !== null))]
    .sort((a, b) => a.split("x").reduce((area, value) => area * Number(value), 1) - b.split("x").reduce((area, value) => area * Number(value), 1));
  const frames = numbers(metrics.map(metric => metric.framesPerSecond));
  return {
    bitrateKbps: sum(numbers(metrics.map(metric => metric.bitrateKbps))),
    rttMs: mean([...rtts.values()]),
    jitterMs: mean(numbers(metrics.map(metric => metric.jitterMs))),
    packetLossPercent: metrics.length === 1 ? metrics[0]!.packetLossPercent
      : direction === "send" ? mean(numbers(metrics.map(metric => metric.packetLossPercent)))
      : packetLossPercentFromDeltas(sum(packetSamples.map(metric => metric.intervalPacketsReceived!)), sum(packetSamples.map(metric => metric.intervalPacketsLost!))),
    resolution: resolutions.length ? [resolutions[0]!, resolutions.at(-1)!] as const : null,
    framesPerSecond: frames.length ? [Math.min(...frames), Math.max(...frames)] as const : null,
  };
}

export function formatPacketLossPercent(
  value: number | null,
  unknownLabel: string,
): string {
  return value === null || !Number.isFinite(value)
    ? unknownLabel
    : `${value.toFixed(1)}%`;
}
