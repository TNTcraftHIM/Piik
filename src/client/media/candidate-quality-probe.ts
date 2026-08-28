import {
  PERSISTENT_NATIVE_EDGE_DEGRADED_WINDOWS,
  VIEWER_QUALITY_EVIDENCE_EXPIRY_MS,
} from "../../shared/protocol";
import type { ConnectionMetrics } from "../types";

interface DeliveredVideoSample {
  timestampMs: number;
  pixels: number;
  framesPerSecond: number;
  bitrateKbps: number | null;
}

function deliveredVideoSample(
  metrics: ConnectionMetrics,
): DeliveredVideoSample | null {
  const {
    sampleTimestampMs,
    sampleWindowMs,
    frameWidth,
    frameHeight,
    framesPerSecond,
    bitrateKbps,
    intervalFramesDecoded,
  } = metrics;
  if (
    sampleTimestampMs === null ||
    sampleWindowMs === null ||
    frameWidth === null ||
    frameHeight === null ||
    framesPerSecond === null ||
    intervalFramesDecoded === null ||
    !Number.isFinite(sampleTimestampMs) ||
    !Number.isFinite(sampleWindowMs) ||
    !Number.isFinite(frameWidth) ||
    !Number.isFinite(frameHeight) ||
    !Number.isFinite(framesPerSecond) ||
    frameWidth <= 0 ||
    frameHeight <= 0 ||
    sampleWindowMs < 1_000 ||
    sampleWindowMs > 5_000 ||
    framesPerSecond <= 0 ||
    intervalFramesDecoded <= 0
  ) {
    return null;
  }
  return {
    timestampMs: sampleTimestampMs,
    pixels: frameWidth * frameHeight,
    framesPerSecond: Math.round(framesPerSecond),
    bitrateKbps:
      typeof bitrateKbps === "number" &&
      Number.isFinite(bitrateKbps) &&
      bitrateKbps > 0
        ? bitrateKbps
        : null,
  };
}

function comparableSamples(
  current: ConnectionMetrics,
  candidate: ConnectionMetrics,
): [DeliveredVideoSample, DeliveredVideoSample] | null {
  const currentVideo = deliveredVideoSample(current);
  const candidateVideo = deliveredVideoSample(candidate);
  if (
    !currentVideo ||
    !candidateVideo ||
    Math.abs(candidateVideo.timestampMs - currentVideo.timestampMs) >
      VIEWER_QUALITY_EVIDENCE_EXPIRY_MS ||
    candidate.intervalFreezeCount === null ||
    candidate.intervalFreezeDurationMs === null ||
    candidate.intervalPauseCount === null ||
    candidate.intervalPauseDurationMs === null
  ) {
    return null;
  }
  return [currentVideo, candidateVideo];
}

export function sfuCandidateDoesNotRegress(
  current: ConnectionMetrics,
  candidate: ConnectionMetrics,
): boolean | null {
  const samples = comparableSamples(current, candidate);
  if (!samples) return null;
  const [currentVideo, candidateVideo] = samples;
  if (
    currentVideo.bitrateKbps === null ||
    candidateVideo.bitrateKbps === null
  ) {
    return null;
  }
  return (
    candidate.intervalFreezeCount === 0 &&
    candidate.intervalFreezeDurationMs === 0 &&
    candidate.intervalPauseCount === 0 &&
    candidate.intervalPauseDurationMs === 0 &&
    candidateVideo.pixels >= currentVideo.pixels &&
    candidateVideo.framesPerSecond >= currentVideo.framesPerSecond &&
    candidateVideo.bitrateKbps >= currentVideo.bitrateKbps
  );
}

export function p2pCandidateStrictlyImproves(
  current: ConnectionMetrics,
  candidate: ConnectionMetrics,
): boolean | null {
  const samples = comparableSamples(current, candidate);
  if (!samples) return null;
  const [currentVideo, candidateVideo] = samples;
  return (
    candidate.intervalFreezeCount === 0 &&
    candidate.intervalFreezeDurationMs === 0 &&
    candidate.intervalPauseCount === 0 &&
    candidate.intervalPauseDurationMs === 0 &&
    candidateVideo.pixels >= currentVideo.pixels &&
    candidateVideo.framesPerSecond >= currentVideo.framesPerSecond &&
    (candidateVideo.pixels > currentVideo.pixels ||
      candidateVideo.framesPerSecond > currentVideo.framesPerSecond)
  );
}

class ConsecutiveCandidateQualityProbe {
  private lastCandidateTimestampMs: number | null = null;
  private lastCurrentTimestampMs: number | null = null;
  private consecutiveApprovedWindows = 0;
  private consecutiveRejectedWindows = 0;

  constructor(
    private readonly compare: (
      current: ConnectionMetrics,
      candidate: ConnectionMetrics,
    ) => boolean | null,
  ) {}

  observe(
    current: ConnectionMetrics | null,
    candidate: ConnectionMetrics,
  ): CandidateQualityProbeResult {
    if (
      candidate.sampleTimestampMs === null ||
      candidate.sampleTimestampMs === this.lastCandidateTimestampMs
    ) {
      return "pending";
    }
    this.lastCandidateTimestampMs = candidate.sampleTimestampMs;
    if (
      !current ||
      current.sampleTimestampMs === null ||
      (this.lastCurrentTimestampMs !== null &&
        current.sampleTimestampMs <= this.lastCurrentTimestampMs)
    ) {
      this.resetRuns();
      return "pending";
    }
    this.lastCurrentTimestampMs = current.sampleTimestampMs;
    const approved = this.compare(current, candidate);
    if (approved === null) {
      this.resetRuns();
      return "pending";
    }
    if (approved) {
      this.consecutiveApprovedWindows += 1;
      this.consecutiveRejectedWindows = 0;
      return this.consecutiveApprovedWindows >=
        PERSISTENT_NATIVE_EDGE_DEGRADED_WINDOWS
        ? "approved"
        : "pending";
    }
    this.consecutiveApprovedWindows = 0;
    this.consecutiveRejectedWindows += 1;
    return this.consecutiveRejectedWindows >=
      PERSISTENT_NATIVE_EDGE_DEGRADED_WINDOWS
      ? "rejected"
      : "pending";
  }

  reset(): void {
    this.lastCandidateTimestampMs = null;
    this.lastCurrentTimestampMs = null;
    this.resetRuns();
  }

  private resetRuns(): void {
    this.consecutiveApprovedWindows = 0;
    this.consecutiveRejectedWindows = 0;
  }
}

export type CandidateQualityProbeResult =
  | "pending"
  | "approved"
  | "rejected";

export class SfuQualityProbe extends ConsecutiveCandidateQualityProbe {
  constructor() {
    super(sfuCandidateDoesNotRegress);
  }
}

export class P2pQualityProbe extends ConsecutiveCandidateQualityProbe {
  constructor() {
    super(p2pCandidateStrictlyImproves);
  }
}
