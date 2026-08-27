import {
  PERSISTENT_NATIVE_EDGE_DEGRADED_WINDOWS,
  VIEWER_QUALITY_EVIDENCE_EXPIRY_MS,
} from "../../shared/protocol";
import type { ConnectionMetrics } from "../types";

interface DeliveredVideoSample {
  timestampMs: number;
  pixels: number;
  framesPerSecond: number;
  bitrateKbps: number;
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
    bitrateKbps === null ||
    intervalFramesDecoded === null ||
    !Number.isFinite(sampleTimestampMs) ||
    !Number.isFinite(sampleWindowMs) ||
    !Number.isFinite(frameWidth) ||
    !Number.isFinite(frameHeight) ||
    !Number.isFinite(framesPerSecond) ||
    !Number.isFinite(bitrateKbps) ||
    frameWidth <= 0 ||
    frameHeight <= 0 ||
    sampleWindowMs < 1_000 ||
    sampleWindowMs > 5_000 ||
    framesPerSecond <= 0 ||
    bitrateKbps <= 0 ||
    intervalFramesDecoded <= 0
  ) {
    return null;
  }
  return {
    timestampMs: sampleTimestampMs,
    pixels: frameWidth * frameHeight,
    framesPerSecond: Math.round(framesPerSecond),
    bitrateKbps,
  };
}

export function sfuCandidateDoesNotRegress(
  current: ConnectionMetrics,
  candidate: ConnectionMetrics,
): boolean | null {
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

export class SfuQualityProbe {
  private lastCandidateTimestampMs: number | null = null;
  private lastCurrentTimestampMs: number | null = null;
  private consecutiveNonRegressingWindows = 0;

  observe(
    current: ConnectionMetrics | null,
    candidate: ConnectionMetrics,
  ): boolean {
    if (
      candidate.sampleTimestampMs === null ||
      candidate.sampleTimestampMs === this.lastCandidateTimestampMs
    ) {
      return false;
    }
    this.lastCandidateTimestampMs = candidate.sampleTimestampMs;
    if (
      !current ||
      current.sampleTimestampMs === null ||
      (this.lastCurrentTimestampMs !== null &&
        current.sampleTimestampMs <= this.lastCurrentTimestampMs)
    ) {
      this.consecutiveNonRegressingWindows = 0;
      return false;
    }
    this.lastCurrentTimestampMs = current.sampleTimestampMs;
    const nonRegressing = sfuCandidateDoesNotRegress(current, candidate);
    if (nonRegressing === null) {
      this.consecutiveNonRegressingWindows = 0;
      return false;
    }
    this.consecutiveNonRegressingWindows = nonRegressing
      ? this.consecutiveNonRegressingWindows + 1
      : 0;
    return (
      this.consecutiveNonRegressingWindows >=
      PERSISTENT_NATIVE_EDGE_DEGRADED_WINDOWS
    );
  }

  reset(): void {
    this.lastCandidateTimestampMs = null;
    this.lastCurrentTimestampMs = null;
    this.consecutiveNonRegressingWindows = 0;
  }
}
