import {
  senderQualityEvidenceMessageSchema,
  sfuPublisherQualityEvidenceMessageSchema,
  type ClientMessage,
} from "../../shared/protocol";
import type { PeerSnapshot } from "../types";
import type { ConnectionMetrics } from "../types";

let senderEvidenceGeneration = 0;
const connectionGenerations = new Map<string, number>();
const publicationGenerations = new Map<string, number>();
const unknownConnections = new Set<string>();
const unknownPublications = new Set<string>();
const connectionSampleTimestamps = new Map<string, number>();
const publicationSampleTimestamps = new Map<string, number>();

export function invalidateSenderQualityEvidence(): void {
  senderEvidenceGeneration += 1;
  connectionGenerations.clear();
  publicationGenerations.clear();
  unknownConnections.clear();
  unknownPublications.clear();
  connectionSampleTimestamps.clear();
  publicationSampleTimestamps.clear();
}

function ownsCurrentEvidenceGeneration(
  identities: Map<string, number>,
  identity: string,
): boolean {
  if (identities.get(identity) === senderEvidenceGeneration) {
    return true;
  }
  identities.set(identity, senderEvidenceGeneration);
  return false;
}

function emitUnknownOnce(identities: Set<string>, identity: string): boolean {
  if (identities.has(identity)) {
    return false;
  }
  identities.add(identity);
  return true;
}

function nativeQualityState(
  metrics: ConnectionMetrics,
): "unknown" | "healthy" | "degraded" {
  if (
    (metrics.nativeEdgeQualityState !== "healthy" &&
      metrics.nativeEdgeQualityState !== "degraded") ||
    metrics.sampleWindowMs === null ||
    metrics.sampleTimestampMs === null ||
    metrics.intervalFramesEncoded === null ||
    metrics.intervalFramesEncoded <= 0
  ) {
    return "unknown";
  }
  const reason = metrics.qualityLimitationReason;
  if (reason !== "none" && reason !== "bandwidth" && reason !== "cpu") {
    return "unknown";
  }
  return metrics.nativeEdgeQualityState;
}

export function senderQualityEvidenceFromSnapshot(
  snapshot: PeerSnapshot,
  routeRevision: number,
): Extract<ClientMessage, { type: "sender-quality-evidence" }> | null {
  const evidence = nativeQualityState(snapshot.metrics);
  const rawSampleTimestampMs = snapshot.metrics.sampleTimestampMs;
  const hasIdentity =
    snapshot.metrics.rtpStatsId !== null &&
    snapshot.metrics.trackIdentifier !== null;
  const state =
    ownsCurrentEvidenceGeneration(
      connectionGenerations,
      snapshot.connectionId,
    ) && hasIdentity
      ? evidence
      : "unknown";
  const sampleTimestampMs =
    state === "unknown" ? null : snapshot.metrics.sampleTimestampMs;
  if (
    sampleTimestampMs !== null &&
    (connectionSampleTimestamps.get(snapshot.connectionId) ?? -1) >=
      sampleTimestampMs
  ) {
    return null;
  }
  const parsed = senderQualityEvidenceMessageSchema.safeParse({
    type: "sender-quality-evidence",
    childPeerId: snapshot.peerId,
    connectionId: snapshot.connectionId,
    rtpStatsId:
      state === "unknown" ? null : snapshot.metrics.rtpStatsId,
    trackIdentifier:
      state === "unknown"
        ? null
        : snapshot.metrics.trackIdentifier,
    sampleTimestampMs,
    routeRevision,
    state,
    diagnostics: {
      reason: state === "unknown" ? null : snapshot.metrics.qualityLimitationReason,
      framesPerSecond: snapshot.metrics.framesPerSecond,
      bitrateKbps: snapshot.metrics.bitrateKbps,
      captureFramesPerSecond: snapshot.metrics.captureFramesPerSecond,
      mediaSourceFramesPerSecond: snapshot.metrics.mediaSourceFramesPerSecond,
      width: snapshot.metrics.frameWidth,
      height: snapshot.metrics.frameHeight,
      availableOutgoingKbps: snapshot.metrics.availableOutgoingKbps,
      rttMs: snapshot.metrics.rttMs,
      packetLossPercent: snapshot.metrics.packetLossPercent,
    },
  });
  if (!parsed.success) {
    return null;
  }
  if (state === "unknown") {
    if (!emitUnknownOnce(unknownConnections, snapshot.connectionId)) {
      return null;
    }
    if (rawSampleTimestampMs !== null) {
      connectionSampleTimestamps.set(
        snapshot.connectionId,
        rawSampleTimestampMs,
      );
    }
  } else {
    unknownConnections.delete(snapshot.connectionId);
    connectionSampleTimestamps.set(snapshot.connectionId, sampleTimestampMs!);
  }
  return parsed.data;
}

export function sfuPublisherQualityEvidenceFromMetrics(
  metrics: ConnectionMetrics,
  routeRevision: number,
  publicationGeneration: string,
): Extract<
  ClientMessage,
  { type: "sfu-publisher-quality-evidence" }
> | null {
  const evidence = nativeQualityState(metrics);
  const rawSampleTimestampMs = metrics.sampleTimestampMs;
  const state = ownsCurrentEvidenceGeneration(
    publicationGenerations,
    publicationGeneration,
  )
    ? evidence
    : "unknown";
  const sampleTimestampMs =
    state === "unknown" ? null : metrics.sampleTimestampMs;
  if (
    sampleTimestampMs !== null &&
    (publicationSampleTimestamps.get(publicationGeneration) ?? -1) >=
      sampleTimestampMs
  ) {
    return null;
  }
  const parsed = sfuPublisherQualityEvidenceMessageSchema.safeParse({
    type: "sfu-publisher-quality-evidence",
    routeRevision,
    publicationGeneration,
    state,
    sampleTimestampMs,
    diagnostics: {
      reason: state === "unknown" ? null : metrics.qualityLimitationReason,
      framesPerSecond: metrics.framesPerSecond,
      bitrateKbps: metrics.bitrateKbps,
      captureFramesPerSecond: metrics.captureFramesPerSecond,
      mediaSourceFramesPerSecond: metrics.mediaSourceFramesPerSecond,
      width: metrics.frameWidth,
      height: metrics.frameHeight,
      videoEncodingCount: metrics.videoEncodingCount,
      activeVideoEncodingCount: metrics.activeVideoEncodingCount,
      availableOutgoingKbps: metrics.availableOutgoingKbps,
      rttMs: metrics.rttMs,
      packetLossPercent: metrics.packetLossPercent,
    },
  });
  if (!parsed.success) {
    return null;
  }
  if (state === "unknown") {
    if (!emitUnknownOnce(unknownPublications, publicationGeneration)) {
      return null;
    }
    if (rawSampleTimestampMs !== null) {
      publicationSampleTimestamps.set(
        publicationGeneration,
        rawSampleTimestampMs,
      );
    }
  } else {
    unknownPublications.delete(publicationGeneration);
    publicationSampleTimestamps.set(publicationGeneration, sampleTimestampMs!);
  }
  return parsed.data;
}
