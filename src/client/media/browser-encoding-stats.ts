import { EMPTY_METRICS, type ConnectionMetrics } from "../types";
import type { BrowserEncodingOutput } from "./browser-encoding-output";
import type { QualityProfile } from "./quality";

export type Observation = { width: number; height: number; fps: number; bitrate: number; reason: string | null };
type Output = ReturnType<BrowserEncodingOutput["snapshot"]>;

const normalizeFmtp = (value = "") => value.split(";").map((part) => part.trim().toLowerCase()).filter(Boolean).sort().join(";");
export const codecIdentity = (codec: RTCRtpCodec) => `${codec.mimeType.toLowerCase()}/${codec.clockRate}/${normalizeFmtp(codec.sdpFmtpLine)}`;

export function videoOutbound(report: RTCStatsReport): RTCOutboundRtpStreamStats | undefined {
  const videos: RTCOutboundRtpStreamStats[] = [];
  report.forEach((row) => {
    if (row.type === "outbound-rtp" && row.kind === "video" && row.active !== false) videos.push(row);
  });
  return videos.length === 1 ? videos[0] : undefined;
}

export function negotiatedCodec(report: RTCStatsReport): RTCRtpCodec | undefined {
  const outbound = videoOutbound(report), codec = outbound?.codecId ? report.get(outbound.codecId) : undefined;
  if (!codec || !["video/vp8", "video/h264"].includes(codec.mimeType?.toLowerCase())) return;
  if (codec.mimeType.toLowerCase() === "video/h264" && !normalizeFmtp(codec.sdpFmtpLine).split(";").includes("packetization-mode=1")) return;
  return RTCRtpSender.getCapabilities("video")?.codecs.find((candidate) => codecIdentity(candidate) === codecIdentity(codec));
}

export function nativeVideoBudget(outbound: RTCOutboundRtpStreamStats | undefined, ceiling: number): number | undefined {
  // The carrier's native payload allocation accounts for audio, repair and
  // post-transform overhead. Do not build a second RTP-overhead estimator.
  const target = outbound?.targetBitrate;
  return target !== undefined && Number.isFinite(target) && target >= 0
    ? Math.floor(Math.min(ceiling, target)) : undefined;
}

export function observeVideo(video: RTCOutboundRtpStreamStats | undefined,
  previous: RTCOutboundRtpStreamStats | undefined): Observation | undefined {
  if (!video || !previous || video.id !== previous.id || video.timestamp <= previous.timestamp) return;
  const seconds = (video.timestamp - previous.timestamp) / 1_000;
  return { width: video.frameWidth ?? 0, height: video.frameHeight ?? 0,
    fps: Math.max(0, (video.framesEncoded ?? 0) - (previous.framesEncoded ?? 0)) / seconds,
    bitrate: Math.max(0, (video.bytesSent ?? 0) - (previous.bytesSent ?? 0)) * 8 / seconds,
    reason: video.qualityLimitationReason ?? null };
}

export function fits(output: Observation | undefined, budget: number | undefined): boolean {
  return !!output && budget !== undefined && output.bitrate > 0 && output.bitrate <= budget && output.fps > 0;
}

export function noRegression(output: Observation, width: number | null, height: number | null,
  fps: number | null, profile: QualityProfile): boolean {
  return width !== null && height !== null && fps !== null && output.width >= width && output.height >= height &&
    Math.round(output.fps) >= Math.round(Math.min(fps, profile.maxFramerate));
}

/** The caller proves membership and owns both sampling histories. */
export function projectEncodingMetrics(transport: ConnectionMetrics, encoder: ConnectionMetrics,
  sample: Output | undefined, previous: Output | undefined, qualityEligible: boolean): ConnectionMetrics {
  const window = sample && previous ? sample.timestamp - previous.timestamp : null;
  const frames = sample && previous ? Math.max(0, sample.frames - previous.frames) : null;
  const width = sample?.width ?? null, height = sample?.height ?? null;
  const quality = qualityEligible && frames !== null && frames > 0 ? encoder : EMPTY_METRICS;
  return { ...transport,
    sampleTimestampMs: quality.sampleTimestampMs, sampleWindowMs: quality.sampleWindowMs,
    captureWidth: encoder.captureWidth, captureHeight: encoder.captureHeight,
    captureFramesPerSecond: encoder.captureFramesPerSecond, mediaSourceFramesPerSecond: encoder.mediaSourceFramesPerSecond,
    frameWidth: width, frameHeight: height, resolution: width && height ? `${width}x${height}` : null,
    framesPerSecond: frames !== null && window ? frames * 1_000 / window : null,
    rtpStatsId: quality.rtpStatsId, rtpSsrc: quality.rtpSsrc, rtpMid: quality.rtpMid, rtpRid: quality.rtpRid,
    trackIdentifier: quality.trackIdentifier, scalabilityMode: encoder.scalabilityMode,
    encoderImplementation: encoder.encoderImplementation, powerEfficientEncoder: encoder.powerEfficientEncoder,
    intervalFramesEncoded: null, intervalEncodeTimeMs: null, intervalFramesSent: frames,
    intervalEncodeMs: encoder.intervalEncodeMs, qualityLimitationReason: quality.qualityLimitationReason,
    nativeEdgeQualityState: quality.nativeEdgeQualityState,
  };
}
