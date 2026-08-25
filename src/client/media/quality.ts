import {
  DEFAULT_QUALITY_SETTINGS,
  type DegradationPreference,
  type QualityProfileId,
  type QualityResolution,
  type QualitySettings,
  type ScreenAudioQuality,
} from "../../shared/protocol";
import { displayMediaOptions } from "./audio-capture";

export type {
  DegradationPreference,
  QualityProfileId,
  QualityResolution,
  QualitySettings,
  ScreenAudioQuality,
} from "../../shared/protocol";

export type QualityProfile = QualitySettings;

export const QUALITY_PROFILES = {
  "1080p60": {
    resolution: "1080p",
    maxFramerate: 60,
    maxBitrate: 8_000_000,
    degradationPreference: "balanced",
    screenAudioQuality: "music",
  },
  "1080p30": DEFAULT_QUALITY_SETTINGS,
  "720p30": {
    resolution: "720p",
    maxFramerate: 30,
    maxBitrate: 3_000_000,
    degradationPreference: "balanced",
    screenAudioQuality: "music",
  },
} as const satisfies Record<QualityProfileId, QualitySettings>;

export const QUALITY_PROFILE_LABELS = {
  "1080p60": "1080p · 60 帧",
  "1080p30": "1080p · 30 帧",
  "720p30": "720p · 30 帧",
} as const satisfies Record<QualityProfileId, string>;

export const QUALITY_RESOLUTIONS = {
  "480p": { width: 854, height: 480, label: "480p" },
  "720p": { width: 1280, height: 720, label: "720p" },
  "1080p": { width: 1920, height: 1080, label: "1080p" },
  "1440p": { width: 2560, height: 1440, label: "1440p" },
} as const satisfies Record<
  QualityResolution,
  { width: number; height: number; label: string }
>;

export const DEGRADATION_PREFERENCE_LABELS = {
  "maintain-resolution": "清晰",
  balanced: "均衡",
  "maintain-framerate": "流畅",
} as const satisfies Record<DegradationPreference, string>;

export const DEGRADATION_PREFERENCE_HINTS = {
  "maintain-resolution": "保留细节",
  balanced: "自动权衡",
  "maintain-framerate": "优先帧率",
} as const satisfies Record<DegradationPreference, string>;

export const SCREEN_AUDIO_QUALITY_LABELS = {
  saver: "清晰",
  music: "音乐",
  "very-high": "高质",
} as const satisfies Record<ScreenAudioQuality, string>;

export const DEFAULT_SCREEN_AUDIO_QUALITY: ScreenAudioQuality = "music";
export const SCREEN_AUDIO_BITRATES = {
  saver: 64_000,
  music: 128_000,
  "very-high": 256_000,
} as const satisfies Record<ScreenAudioQuality, number>;
export const SCREEN_AUDIO_RECEIVE_MAX_BITRATE =
  SCREEN_AUDIO_BITRATES["very-high"];

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

export interface AudioSenderParameterReadback {
  requestedMaxBitrate: number;
  appliedMaxBitrate: number | null;
  mismatch: boolean;
}

export function resolveScreenAudioQuality(
  quality: ScreenAudioQuality | undefined,
): ScreenAudioQuality {
  return quality ?? DEFAULT_SCREEN_AUDIO_QUALITY;
}

export function screenAudioBitrate(
  quality: ScreenAudioQuality | undefined,
): number {
  return SCREEN_AUDIO_BITRATES[resolveScreenAudioQuality(quality)];
}

export function qualitySettingsEqual(
  left: QualitySettings,
  right: QualitySettings,
): boolean {
  return (
    videoQualitySettingsEqual(left, right) &&
    screenAudioQualityEqual(left, right)
  );
}

export function videoQualitySettingsEqual(
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

export function screenAudioQualityEqual(
  left: QualitySettings,
  right: QualitySettings,
): boolean {
  return (
    resolveScreenAudioQuality(left.screenAudioQuality) ===
      resolveScreenAudioQuality(right.screenAudioQuality)
  );
}

export function matchingQualityProfileId(
  settings: QualitySettings,
): QualityProfileId | null {
  for (const id of Object.keys(QUALITY_PROFILES) as QualityProfileId[]) {
    const profile = QUALITY_PROFILES[id];
    if (
      settings.resolution === profile.resolution &&
      settings.maxFramerate === profile.maxFramerate &&
      settings.maxBitrate === profile.maxBitrate &&
      settings.degradationPreference === profile.degradationPreference
    ) {
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
  // Pinned LiveKit orders simulcast encodings by increasing spatial resolution.
  const encodingIndex = parameters.encodings.length - 1;
  parameters.encodings[encodingIndex]!.maxBitrate = profile.maxBitrate;
  parameters.encodings[encodingIndex]!.maxFramerate = profile.maxFramerate;
  if (parameters.encodings.length === 1) {
    parameters.encodings[encodingIndex]!.scaleResolutionDownBy =
      requestedScaleResolutionDownBy(sender, profile);
  }
  parameters.degradationPreference = profile.degradationPreference;

  const requested = readVideoSenderParameters(parameters, false, encodingIndex);
  await sender.setParameters(parameters);
  const applied = readVideoSenderParameters(
    sender.getParameters(),
    true,
    encodingIndex,
  );
  return senderParameterReadback(requested, applied);
}

export async function configureScreenAudioSender(
  sender: RTCRtpSender,
  quality?: ScreenAudioQuality,
): Promise<AudioSenderParameterReadback> {
  const current = sender.getParameters();
  const parameters = {
    ...current,
    encodings: current.encodings.map((encoding) => ({ ...encoding })),
  };
  if (parameters.encodings.length === 0) {
    parameters.encodings = [{}];
  }
  const requestedMaxBitrate = screenAudioBitrate(quality);
  parameters.encodings[0]!.maxBitrate = requestedMaxBitrate;
  await sender.setParameters(parameters);
  const appliedMaxBitrate =
    sender.getParameters().encodings[0]?.maxBitrate ?? null;
  return {
    requestedMaxBitrate,
    appliedMaxBitrate,
    mismatch: appliedMaxBitrate !== requestedMaxBitrate,
  };
}

export function audioSenderParameterWarning(
  readback: AudioSenderParameterReadback,
): string | null {
  if (!readback.mismatch) {
    return null;
  }
  return readback.appliedMaxBitrate === null
    ? "浏览器未读回音频码率上限"
    : `浏览器将音频码率上限改写为 ${Math.round(readback.appliedMaxBitrate / 1_000)} kbps`;
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
