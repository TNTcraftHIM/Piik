import type { NativeConnectionMetrics } from "./app-link";
import { EMPTY_METRICS, type ConnectionMetrics } from "../types";
import type { ChannelConnectionSample } from "./types";

export type NativeMetricSamples = Map<string, { timestamp: number; bytes: number; metrics: ConnectionMetrics }>;

/** Native SDK samples retain their own physical-connection clock and counters. */
export function collectNativeConnectionMetrics(report: NativeConnectionMetrics, previous: NativeMetricSamples): ChannelConnectionSample[] {
  const retained = new Set<string>();
  const samples = report.connections.flatMap(connection => connection.streams.map(stream => {
    const key = JSON.stringify([report.sessionId, connection.connectionId, stream.flowId, stream.direction, stream.media, stream.mid, stream.rid]);
    retained.add(key);
    const prior = previous.get(key);
    const windowMs = prior && stream.sampleTimestampMs > prior.timestamp
      ? stream.sampleTimestampMs - prior.timestamp : null;
    const bitrate = windowMs !== null && stream.bytes >= prior!.bytes
      ? (stream.bytes - prior!.bytes) * 8 / windowMs
      : stream.sampleTimestampMs === prior?.timestamp ? prior.metrics.bitrateKbps : null;
    const metrics: ConnectionMetrics = {
      ...EMPTY_METRICS, sampleTimestampMs: stream.sampleTimestampMs, sampleWindowMs: windowMs,
      rtpStatsId: key, rtpMid: stream.mid, rtpRid: stream.rid,
      bitrateKbps: bitrate, rttMs: stream.rttMs ?? connection.rttMs,
      availableOutgoingKbps: connection.bweBps === null ? null : connection.bweBps / 1000,
      packetLossPercent: stream.lossFraction === null ? null : stream.lossFraction * 100,
      jitterMs: stream.jitterMs,
      ...(stream.media === "audio" ? { audioBitrateKbps: bitrate, audioCodec: stream.codec,
        audioPacketLossPercent: stream.lossFraction === null ? null : stream.lossFraction * 100,
        audioJitterMs: stream.jitterMs } : { codec: stream.codec }),
    };
    previous.set(key, { timestamp: stream.sampleTimestampMs, bytes: stream.bytes, metrics });
    return { ownerSessionId: report.sessionId, connectionId: connection.connectionId, selected: stream.selected,
      pairId: connection.pairId, peerId: connection.peerId, flowId: stream.flowId, publicationId: stream.publicationId,
      direction: stream.direction, media: stream.media, metrics };
  }));
  for (const key of previous.keys()) if (!retained.has(key)) previous.delete(key);
  return samples;
}
