import { EMPTY_METRICS, type ConnectionMetrics } from "../types";

// Shared observations for the actual metric cells in developer previews.
export const PREVIEW_METRICS: ConnectionMetrics = {
  ...EMPTY_METRICS,
  resolution: "1920x1080", framesPerSecond: 59.8, bitrateKbps: 7200,
  packetLossPercent: .2, rttMs: 24, codec: "video/H264",
  availableOutgoingKbps: 12000, qualityLimitationReason: "none",
  captureWidth: 2560, captureHeight: 1440, captureFramesPerSecond: 60,
  mediaSourceFramesPerSecond: 60, encoderImplementation: "Sample encoder",
  powerEfficientEncoder: true, intervalEncodeMs: 2.4,
  jitterMs: 1.2, intervalFramesDropped: 2, intervalDecodeMs: 1.4,
  intervalFreezeCount: 1, intervalFreezeDurationMs: 120,
  audioBitrateKbps: 96, audioPacketLossPercent: .1, audioJitterMs: .8,
  audioVideoPlayoutDeltaMs: 3, videoJitterBufferDelayMs: 12,
  audioJitterBufferDelayMs: 15, audioConcealedSamplesPercent: .2,
  intervalAudioConcealmentEvents: 1, audioCodec: "audio/opus",
};
