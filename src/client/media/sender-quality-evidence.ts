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

export function invalidateSenderQualityEvidence(): void {
  senderEvidenceGeneration += 1;
  connectionGenerations.clear();
  publicationGenerations.clear();
  unknownConnections.clear();
  unknownPublications.clear();
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
    routeRevision,
    state,
  });
  if (state === "unknown") {
    if (!emitUnknownOnce(unknownConnections, snapshot.connectionId)) {
      return null;
    }
  } else {
    unknownConnections.delete(snapshot.connectionId);
  }
  return parsed.success ? parsed.data : null;
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
  const state = ownsCurrentEvidenceGeneration(
    publicationGenerations,
    publicationGeneration,
  )
    ? evidence
    : "unknown";
  const parsed = sfuPublisherQualityEvidenceMessageSchema.safeParse({
    type: "sfu-publisher-quality-evidence",
    routeRevision,
    publicationGeneration,
    state,
  });
  if (state === "unknown") {
    if (!emitUnknownOnce(unknownPublications, publicationGeneration)) {
      return null;
    }
  } else {
    unknownPublications.delete(publicationGeneration);
  }
  return parsed.success ? parsed.data : null;
}
