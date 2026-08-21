import {
  DEFAULT_QUALITY_SETTINGS,
  type DegradationPreference,
  type QualityProfileId,
  type QualityResolution,
  type QualitySettings,
} from "../../shared/protocol";
import { displayMediaOptions } from "./audio-capture";

export type {
  DegradationPreference,
  QualityProfileId,
  QualityResolution,
  QualitySettings,
} from "../../shared/protocol";

export type QualityProfile = QualitySettings;

export const QUALITY_PROFILES = {
  "1080p60": DEFAULT_QUALITY_SETTINGS,
  "1080p30": {
    resolution: "1080p",
    maxFramerate: 30,
    maxBitrate: 5_000_000,
    degradationPreference: "balanced",
  },
  "720p30": {
    resolution: "720p",
    maxFramerate: 30,
    maxBitrate: 3_000_000,
    degradationPreference: "balanced",
  },
} as const satisfies Record<QualityProfileId, QualitySettings>;

export const QUALITY_PROFILE_LABELS = {
  "1080p60": "1080p 60",
  "1080p30": "1080p 30",
  "720p30": "720p 30",
} as const satisfies Record<QualityProfileId, string>;

export const QUALITY_RESOLUTIONS = {
  "720p": { width: 1280, height: 720, label: "720p" },
  "1080p": { width: 1920, height: 1080, label: "1080p" },
  "1440p": { width: 2560, height: 1440, label: "1440p" },
} as const satisfies Record<
  QualityResolution,
  { width: number; height: number; label: string }
>;

export const DEGRADATION_PREFERENCE_LABELS = {
  "maintain-resolution": "清晰优先",
  balanced: "平衡",
  "maintain-framerate": "流畅优先",
} as const satisfies Record<DegradationPreference, string>;

export interface VideoSenderParameterValues {
  maxBitrate: number | null;
  maxFramerate: number | null;
  scaleResolutionDownBy: number | null;
  degradationPreference: RTCDegradationPreference | null;
  scalabilityMode: string | null;
}

export interface VideoSenderParameterReadback {
  requested: VideoSenderParameterValues;
  applied: VideoSenderParameterValues;
  mismatches: Array<keyof VideoSenderParameterValues>;
}

export interface TwoLayerVideoSenderParameterReadback {
  low: VideoSenderParameterReadback;
  high: VideoSenderParameterReadback;
}

export const SCREEN_SHARE_LOW_SCALE = 2;
export const SCREEN_AUDIO_MAX_BITRATE = 128_000;

export function screenShareLowBitrate(profile: QualityProfile): number {
  return Math.max(150_000, Math.floor(profile.maxBitrate / 4));
}

export function qualitySettingsEqual(
  left: QualitySettings,
  right: QualitySettings,
): boolean {
  return (
    left.resolution === right.resolution &&
    left.maxFramerate === right.maxFramerate &&
    left.maxBitrate === right.maxBitrate &&
    left.degradationPreference === right.degradationPreference
  );
}

export function matchingQualityProfileId(
  settings: QualitySettings,
): QualityProfileId | null {
  for (const id of Object.keys(QUALITY_PROFILES) as QualityProfileId[]) {
    if (qualitySettingsEqual(settings, QUALITY_PROFILES[id])) {
      return id;
    }
  }
  return null;
}

export function qualitySettingsLabel(settings: QualitySettings): string {
  const profileId = matchingQualityProfileId(settings);
  if (profileId) {
    return QUALITY_PROFILE_LABELS[profileId];
  }
  return `${QUALITY_RESOLUTIONS[settings.resolution].label} ${settings.maxFramerate} · ${(settings.maxBitrate / 1_000_000).toFixed(1)} Mbps · ${DEGRADATION_PREFERENCE_LABELS[settings.degradationPreference]}`;
}

function captureConstraints(profile: QualityProfile): MediaTrackConstraints {
  const resolution = QUALITY_RESOLUTIONS[profile.resolution];
  return {
    width: { ideal: resolution.width, max: resolution.width },
    height: { ideal: resolution.height, max: resolution.height },
    frameRate: {
      ideal: profile.maxFramerate,
      max: profile.maxFramerate,
    },
  };
}

export async function captureDisplay(
  profile: QualityProfile,
): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("当前浏览器不支持屏幕共享");
  }

  const stream = await navigator.mediaDevices.getDisplayMedia(
    displayMediaOptions(captureConstraints(profile)),
  );

  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("浏览器没有返回可分享的视频轨道");
  }
  videoTrack.contentHint = "motion";
  for (const audioTrack of stream.getAudioTracks()) {
    audioTrack.contentHint = "music";
  }
  return stream;
}

export async function applyCaptureProfile(
  stream: MediaStream,
  profile: QualityProfile,
): Promise<void> {
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    throw new Error("共享流缺少视频轨道");
  }
  await videoTrack.applyConstraints(captureConstraints(profile));
}

export function setMediaPaused(stream: MediaStream, paused: boolean): boolean {
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    return false;
  }
  for (const track of stream.getTracks()) {
    track.enabled = !paused;
  }
  return true;
}

function requestedScaleResolutionDownBy(
  sender: RTCRtpSender,
  profile: QualityProfile,
): number {
  const source =
    sender.track && typeof sender.track.getSettings === "function"
      ? sender.track.getSettings()
      : undefined;
  const ceiling = QUALITY_RESOLUTIONS[profile.resolution];
  if (!source?.width || !source.height) {
    return 1;
  }
  return Math.max(
    1,
    source.width / ceiling.width,
    source.height / ceiling.height,
  );
}

function readVideoSenderParameters(
  parameters: RTCRtpSendParameters,
  includeAppliedScalabilityMode: boolean,
  encodingIndex = 0,
): VideoSenderParameterValues {
  const encoding = parameters.encodings[encodingIndex];
  const scalabilityMode = (
    encoding as
      | (RTCRtpEncodingParameters & { scalabilityMode?: unknown })
      | undefined
  )?.scalabilityMode;
  return {
    maxBitrate: encoding?.maxBitrate ?? null,
    maxFramerate: encoding?.maxFramerate ?? null,
    scaleResolutionDownBy: encoding?.scaleResolutionDownBy ?? null,
    degradationPreference: parameters.degradationPreference ?? null,
    scalabilityMode:
      includeAppliedScalabilityMode &&
      parameters.encodings.length === 1 &&
      typeof scalabilityMode === "string" &&
      /^[A-Za-z0-9_-]{1,32}$/.test(scalabilityMode)
        ? scalabilityMode
        : null,
  };
}

function senderParameterReadback(
  requested: VideoSenderParameterValues,
  applied: VideoSenderParameterValues,
): VideoSenderParameterReadback {
  const mismatches = (
    Object.keys(requested) as Array<keyof VideoSenderParameterValues>
  ).filter((key) => !sameParameter(key, requested[key], applied[key]));
  return { requested, applied, mismatches };
}

function requiredTwoLayerEncodingIndexes(
  parameters: RTCRtpSendParameters,
): { low: number; high: number } {
  if (parameters.encodings.length !== 2) {
    throw new Error("SFU simulcast requires exactly two video encodings");
  }
  if (
    parameters.encodings[0]?.rid !== "q" ||
    parameters.encodings[1]?.rid !== "h"
  ) {
    throw new Error("SFU simulcast requires ordered q and h video encodings");
  }
  return { low: 0, high: 1 };
}

function sameParameter(
  key: keyof VideoSenderParameterValues,
  requested: number | string | null,
  applied: number | string | null,
): boolean {
  if (key === "scalabilityMode" && requested === null) {
    return true;
  }
  if (typeof requested === "number" && typeof applied === "number") {
    return key === "scaleResolutionDownBy"
      ? Math.abs(requested - applied) < 0.01
      : requested === applied;
  }
  return requested === applied;
}

export async function configureVideoSender(
  sender: RTCRtpSender,
  profile: QualityProfile,
): Promise<VideoSenderParameterReadback> {
  const parameters = sender.getParameters();
  if (parameters.encodings.length === 0) {
    parameters.encodings = [{}];
  }
  parameters.encodings[0]!.maxBitrate = profile.maxBitrate;
  parameters.encodings[0]!.maxFramerate = profile.maxFramerate;
  parameters.encodings[0]!.scaleResolutionDownBy =
    requestedScaleResolutionDownBy(sender, profile);
  parameters.degradationPreference = profile.degradationPreference;

  const requested = readVideoSenderParameters(parameters, false);
  await sender.setParameters(parameters);
  const applied = readVideoSenderParameters(sender.getParameters(), true);
  return senderParameterReadback(requested, applied);
}

export async function configureScreenAudioSender(
  sender: RTCRtpSender,
): Promise<number | null> {
  const parameters = sender.getParameters();
  if (parameters.encodings.length === 0) {
    parameters.encodings = [{}];
  }
  parameters.encodings[0]!.maxBitrate = SCREEN_AUDIO_MAX_BITRATE;
  await sender.setParameters(parameters);
  return sender.getParameters().encodings[0]?.maxBitrate ?? null;
}

export async function configureTwoLayerVideoSender(
  sender: RTCRtpSender,
  profile: QualityProfile,
): Promise<TwoLayerVideoSenderParameterReadback> {
  const parameters = sender.getParameters();
  const indexes = requiredTwoLayerEncodingIndexes(parameters);
  const highScale = requestedScaleResolutionDownBy(sender, profile);
  const lowEncoding = parameters.encodings[indexes.low]!;
  const highEncoding = parameters.encodings[indexes.high]!;

  lowEncoding.maxBitrate = screenShareLowBitrate(profile);
  lowEncoding.maxFramerate = profile.maxFramerate;
  lowEncoding.scaleResolutionDownBy = highScale * SCREEN_SHARE_LOW_SCALE;
  highEncoding.maxBitrate = profile.maxBitrate;
  highEncoding.maxFramerate = profile.maxFramerate;
  highEncoding.scaleResolutionDownBy = highScale;
  parameters.degradationPreference = profile.degradationPreference;

  const requestedLow = readVideoSenderParameters(parameters, false, indexes.low);
  const requestedHigh = readVideoSenderParameters(parameters, false, indexes.high);
  await sender.setParameters(parameters);

  const appliedParameters = sender.getParameters();
  const appliedIndexes = requiredTwoLayerEncodingIndexes(appliedParameters);
  const appliedLow = readVideoSenderParameters(
    appliedParameters,
    false,
    appliedIndexes.low,
  );
  const appliedHigh = readVideoSenderParameters(
    appliedParameters,
    false,
    appliedIndexes.high,
  );

  return {
    low: senderParameterReadback(requestedLow, appliedLow),
    high: senderParameterReadback(requestedHigh, appliedHigh),
  };
}

const PARAMETER_LABELS = {
  maxBitrate: "码率上限",
  maxFramerate: "帧率上限",
  scaleResolutionDownBy: "分辨率缩放",
  degradationPreference: "质量优先级",
  scalabilityMode: "伸缩模式",
} as const satisfies Record<keyof VideoSenderParameterValues, string>;

export function senderParameterWarning(
  readback: VideoSenderParameterReadback,
): string | null {
  return readback.mismatches.length > 0
    ? `浏览器未完整接受${readback.mismatches
        .map((key) => PARAMETER_LABELS[key])
        .join("、")}`
    : null;
}
