import {
  MAX_PARENT_EDGE_QUALITY_EVIDENCE_BYTES,
  parentEdgeQualityEvidenceMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from "../../shared/protocol";
import type { PeerSnapshot } from "../types";

type ViewerQualityEvidence = Extract<
  ServerMessage,
  { type: "viewer-quality-evidence" }
>;

const PARENT_EDGE_QUALITY_MIN_LOSS_PACKETS = 100;
const PARENT_EDGE_QUALITY_HIGH_LOSS_RATIO = 0.3;

export function parentEdgeQualityEvidenceFromSnapshot(
  evidence: ViewerQualityEvidence,
  snapshot: PeerSnapshot | null,
): Extract<ClientMessage, { type: "parent-edge-quality-evidence" }> | null {
  if (
    snapshot === null ||
    snapshot.peerId !== evidence.viewerPeerId ||
    snapshot.connectionId !== evidence.guard.connectionId ||
    snapshot.connectionState !== "connected"
  ) {
    return null;
  }
  const { metrics } = snapshot;
  const packetsSentDelta = metrics.intervalPacketsSent;
  const sampleWindowMs = metrics.sampleWindowMs;
  const windowMs =
    sampleWindowMs !== null && Number.isFinite(sampleWindowMs)
      ? Math.round(sampleWindowMs)
      : null;
  if (
    !Number.isSafeInteger(packetsSentDelta) ||
    packetsSentDelta === null ||
    packetsSentDelta <= 0 ||
    windowMs === null ||
    !Number.isSafeInteger(windowMs) ||
    windowMs < 1_000 ||
    windowMs > 5_000
  ) {
    return null;
  }

  const remotePacketsLostDelta = metrics.intervalPacketsLost;
  const senderLimitation =
    metrics.qualityLimitationReason === "cpu" ||
    metrics.qualityLimitationReason === "bandwidth"
      ? metrics.qualityLimitationReason
      : null;
  const hasHighRemoteLoss =
    Number.isSafeInteger(remotePacketsLostDelta) &&
    remotePacketsLostDelta !== null &&
    remotePacketsLostDelta > 0 &&
    packetsSentDelta >= PARENT_EDGE_QUALITY_MIN_LOSS_PACKETS &&
    remotePacketsLostDelta / packetsSentDelta >=
      PARENT_EDGE_QUALITY_HIGH_LOSS_RATIO;
  const proof = senderLimitation
    ? {
        kind: "sender-limited" as const,
        packetsSentDelta,
        reason: senderLimitation,
      }
    : hasHighRemoteLoss
      ? {
          kind: "remote-loss" as const,
          packetsSentDelta,
          remotePacketsLostDelta,
        }
      : { kind: "sending" as const, packetsSentDelta };
  const parsed = parentEdgeQualityEvidenceMessageSchema.safeParse({
    type: "parent-edge-quality-evidence",
    viewerPeerId: evidence.viewerPeerId,
    guard: evidence.guard,
    viewerSequence: evidence.sequence,
    proof,
  });
  if (!parsed.success) {
    return null;
  }
  return JSON.stringify(parsed.data).length <=
    MAX_PARENT_EDGE_QUALITY_EVIDENCE_BYTES
    ? parsed.data
    : null;
}

export class ParentEdgeQualityEvidenceReporter {
  private readonly samplesByViewer = new Map<
    string,
    { connectionId: string; sampleTimestampMs: number }
  >();

  offer(
    evidence: ViewerQualityEvidence,
    snapshot: PeerSnapshot | null,
  ): Extract<ClientMessage, { type: "parent-edge-quality-evidence" }> | null {
    const sampleTimestampMs = snapshot?.metrics.sampleTimestampMs;
    if (
      snapshot === null ||
      typeof sampleTimestampMs !== "number" ||
      !Number.isFinite(sampleTimestampMs)
    ) {
      return null;
    }
    const previous = this.samplesByViewer.get(evidence.viewerPeerId);
    if (
      previous?.connectionId === evidence.guard.connectionId &&
      sampleTimestampMs <= previous.sampleTimestampMs
    ) {
      return null;
    }
    const message = parentEdgeQualityEvidenceFromSnapshot(evidence, snapshot);
    if (!message) {
      return null;
    }
    this.samplesByViewer.set(evidence.viewerPeerId, {
      connectionId: evidence.guard.connectionId,
      sampleTimestampMs,
    });
    return message;
  }

  forget(viewerPeerId: string): void {
    this.samplesByViewer.delete(viewerPeerId);
  }

  reset(): void {
    this.samplesByViewer.clear();
  }
}
