import {
  codecProofEvidenceSchema,
  type ClientMessage,
  type CodecProofBinding,
  type ServerMessage,
} from "../../shared/protocol";
import type { ConnectionMetrics } from "../types";

type ProofRequest = Extract<
  ServerMessage,
  { type: "video-codec-proof-request" }
>;

export interface CodecProofRouteSample {
  routeRevision: number;
  binding: CodecProofBinding;
  metrics: ConnectionMetrics | null;
}

interface DecodedBaseline {
  sampleTimestampMs: number;
  rtpStatsId: string;
  rtpSsrc: number | null;
  rtpMid: string | null;
  rtpRid: string | null;
  trackIdentifier: string | null;
}

interface PendingProof {
  request: ProofRequest;
  baseline: DecodedBaseline | null;
}

export class CodecProofReporter {
  private pending: PendingProof | null = null;

  constructor(
    private readonly send: (message: ClientMessage) => boolean,
  ) {}

  request(request: ProofRequest): boolean {
    this.pending = {
      request,
      baseline: null,
    };
    return true;
  }

  offer(sample: CodecProofRouteSample): void {
    const pending = this.pending;
    if (!pending) return;
    if (!sameRequestRoute(pending.request, sample)) {
      return;
    }
    const current = decodedBaseline(sample.metrics);
    if (!current) return;
    if (!pending.baseline) {
      pending.baseline = current;
      return;
    }
    if (current.sampleTimestampMs <= pending.baseline.sampleTimestampMs) {
      return;
    }
    if (!sameRtpIdentity(pending.baseline, current)) {
      pending.baseline = current;
      return;
    }
    const framesDecodedDelta = sample.metrics?.intervalFramesDecoded;
    if (
      framesDecodedDelta === null ||
      framesDecodedDelta === undefined ||
      !Number.isSafeInteger(framesDecodedDelta) ||
      framesDecodedDelta <= 0
    ) {
      return;
    }
    const evidence = codecProofEvidenceSchema.safeParse({
      baselineSampleTimestampMs: pending.baseline.sampleTimestampMs,
      sampleTimestampMs: current.sampleTimestampMs,
      rtpStatsId: current.rtpStatsId,
      rtpSsrc: current.rtpSsrc,
      rtpMid: current.rtpMid,
      rtpRid: current.rtpRid,
      trackIdentifier: current.trackIdentifier,
      framesDecodedDelta,
      actualCodec: actualVideoCodec(sample.metrics?.codec ?? null),
    });
    if (!evidence.success) return;
    if (
      this.send({
        type: "video-codec-proof",
        shareGeneration: pending.request.shareGeneration,
        generation: pending.request.generation,
        resumeAttempt: pending.request.resumeAttempt,
        routeRevision: pending.request.routeRevision,
        binding: pending.request.binding,
        evidence: evidence.data,
      })
    ) {
      this.pending = null;
    }
  }

  clear(): void {
    this.pending = null;
  }
}

function sameRequestRoute(
  request: ProofRequest,
  sample: CodecProofRouteSample,
): boolean {
  return (
    request.routeRevision === sample.routeRevision &&
    sameProofBinding(request.binding, sample.binding)
  );
}

function sameProofBinding(
  left: CodecProofBinding,
  right: CodecProofBinding,
): boolean {
  return (
    left.kind === right.kind &&
    left.connectionId === right.connectionId &&
    (left.kind === "peer" ||
      (right.kind === "sfu" &&
        left.publicationGeneration === right.publicationGeneration))
  );
}

function decodedBaseline(
  metrics: ConnectionMetrics | null,
): DecodedBaseline | null {
  if (
    !metrics ||
    !Number.isFinite(metrics.sampleTimestampMs) ||
    metrics.sampleTimestampMs === null ||
    metrics.sampleTimestampMs < 0 ||
    !validIdentityString(metrics.rtpStatsId) ||
    !validOptionalIdentityString(metrics.rtpMid) ||
    !validOptionalIdentityString(metrics.rtpRid) ||
    !validOptionalIdentityString(metrics.trackIdentifier) ||
    (metrics.rtpSsrc !== null &&
      (!Number.isSafeInteger(metrics.rtpSsrc) ||
        metrics.rtpSsrc < 0 ||
        metrics.rtpSsrc > 0xffff_ffff))
  ) {
    return null;
  }
  return {
    sampleTimestampMs: metrics.sampleTimestampMs,
    rtpStatsId: metrics.rtpStatsId,
    rtpSsrc: metrics.rtpSsrc,
    rtpMid: metrics.rtpMid,
    rtpRid: metrics.rtpRid,
    trackIdentifier: metrics.trackIdentifier,
  };
}

function validIdentityString(value: string | null): value is string {
  return value !== null && value.length >= 1 && value.length <= 512;
}

function validOptionalIdentityString(value: string | null): boolean {
  return value === null || validIdentityString(value);
}

function sameRtpIdentity(
  left: DecodedBaseline,
  right: DecodedBaseline,
): boolean {
  return (
    left.rtpStatsId === right.rtpStatsId &&
    left.rtpSsrc === right.rtpSsrc &&
    left.rtpMid === right.rtpMid &&
    left.rtpRid === right.rtpRid &&
    left.trackIdentifier === right.trackIdentifier
  );
}

function actualVideoCodec(codec: string | null): "h264" | "vp8" | "other" {
  const normalized = codec?.toLowerCase() ?? "";
  if (normalized.includes("h264")) return "h264";
  if (normalized.includes("vp8")) return "vp8";
  return "other";
}
