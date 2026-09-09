import {
  DEFAULT_QUALITY_SETTINGS,
  type DegradationPreference,
  type QualityProfileId,
  type QualityResolution,
  type QualitySettings,
  type ScreenAudioQuality,
} from "../../shared/protocol";
import { joinItems, say, type CopyKey } from "../ui/copy";
import { displayMediaOptions } from "./audio-capture";
import { browserDebugEnabled, debugOperation } from "../lib/debug";
import { debugTrack } from "../lib/debug-webrtc";

export type {
  DegradationPreference,
  QualityProfileId,
  QualityResolution,
  QualitySettings,
  ScreenAudioQuality,
} from "../../shared/protocol";

export type QualityProfile = QualitySettings;
export const STARTUP_VIDEO_ENCODED_FRAMES = 5;

export const QUALITY_PROFILES = {
  "720p30": {
    resolution: "720p",
    maxFramerate: 30,
    maxBitrate: 3_000_000,
    degradationPreference: "balanced",
    screenAudioQuality: "music",
  },
  "1080p30": DEFAULT_QUALITY_SETTINGS,
  "1080p60": {
    resolution: "1080p",
    maxFramerate: 60,
    maxBitrate: 8_000_000,
    degradationPreference: "balanced",
    screenAudioQuality: "music",
  },
} as const satisfies Record<QualityProfileId, QualitySettings>;

const QUALITY_PROFILE_KEYS = {
  "720p30": "host.quality.720p30",
  "1080p30": "host.quality.1080p30",
  "1080p60": "host.quality.1080p60",
} as const satisfies Record<QualityProfileId, CopyKey>;

export const QUALITY_RESOLUTIONS = {
  "480p": { width: 854, height: 480, label: "480p" },
  "720p": { width: 1280, height: 720, label: "720p" },
  "1080p": { width: 1920, height: 1080, label: "1080p" },
  "1440p": { width: 2560, height: 1440, label: "1440p" },
} as const satisfies Record<
  QualityResolution,
  { width: number; height: number; label: string }
>;

const DEGRADATION_PREFERENCE_KEYS = {
  "maintain-resolution": "host.advanced.preference.resolution",
  balanced: "host.advanced.preference.balanced",
  "maintain-framerate": "host.advanced.preference.framerate",
} as const satisfies Record<DegradationPreference, CopyKey>;

export const DEFAULT_SCREEN_AUDIO_QUALITY: ScreenAudioQuality = "music";
export const SCREEN_AUDIO_BITRATES = {
  saver: 64_000,
  music: 128_000,
  "very-high": 192_000,
} as const satisfies Record<ScreenAudioQuality, number>;
export const SCREEN_AUDIO_RECEIVE_MAX_BITRATE =
  SCREEN_AUDIO_BITRATES["very-high"];

export function startupVideoProfile(
  profile: QualityProfile,
): QualityProfile {
  return profile.degradationPreference === "maintain-resolution"
    ? profile
    : { ...profile, degradationPreference: "maintain-resolution" };
}

export function needsStartupVideoProfile(profile: QualityProfile): boolean {
  return profile.degradationPreference !== "maintain-resolution";
}

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
    return say(QUALITY_PROFILE_KEYS[profileId]);
  }
  return `${QUALITY_RESOLUTIONS[settings.resolution].label} ${settings.maxFramerate} · ${(settings.maxBitrate / 1_000_000).toFixed(1)} Mbps · ${say(DEGRADATION_PREFERENCE_KEYS[settings.degradationPreference])}`;
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
    throw new Error(say("host.capture.unavailable"));
  }

  const complete = debugOperation("capture", "display", { requested: profile });
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions(captureConstraints(profile)));
  } catch (error) {
    complete("failed", {}, error);
    throw error;
  }

  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    stream.getTracks().forEach((track) => track.stop());
    complete("failed", { reason: "no-video-track" });
    throw new Error(say("host.capture.noSource"));
  }
  videoTrack.contentHint = "motion";
  for (const audioTrack of stream.getAudioTracks()) {
    audioTrack.contentHint = "music";
  }
  complete("applied", { audio: stream.getAudioTracks().length > 0, trackId: videoTrack.id });
  if (browserDebugEnabled) for (const track of stream.getTracks()) {
    debugTrack(track, { event: "started" });
    for (const event of ["mute", "unmute", "ended"]) track.addEventListener(event, () => debugTrack(track, { event }));
  }
  return stream;
}

export async function applyCaptureProfile(
  stream: MediaStream,
  profile: QualityProfile,
): Promise<void> {
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    throw new Error(say("host.capture.noSource"));
  }
  await applyVideoCaptureProfile(videoTrack, profile);
}

export function cloneSenderVideoTrack(
  source: MediaStreamTrack,
): MediaStreamTrack {
  const clone = source.clone();
  clone.contentHint = source.contentHint || "motion";
  clone.enabled = source.enabled;
  return clone;
}

export async function applyVideoCaptureProfile(
  track: MediaStreamTrack,
  profile: QualityProfile,
): Promise<void> {
  if (!videoTrackOwnsCaptureConstraints(track)) {
    return;
  }
  const complete = debugOperation("quality", "capture", { requested: profile, trackId: track.id });
  try {
    await track.applyConstraints(captureConstraints(profile));
    complete("applied", { trackId: track.id });
    debugTrack(track, { event: "profile-applied" });
  } catch (error) {
    complete("failed", { trackId: track.id }, error);
    throw error;
  }
}

function videoTrackOwnsCaptureConstraints(track: MediaStreamTrack): boolean {
  const capabilities = track.getCapabilities?.();
  return !capabilities ||
    "width" in capabilities ||
    "height" in capabilities ||
    "frameRate" in capabilities;
}

export function setMediaPaused(stream: MediaStream, paused: boolean): boolean {
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    return false;
  }
  for (const track of stream.getTracks()) {
    track.enabled = !paused;
    debugTrack(track, { event: "pause", paused });
  }
  return true;
}

function requestedScaleResolutionDownBy(
  sender: RTCRtpSender,
  profile: QualityProfile,
): number {
  if (sender.track && !videoTrackOwnsCaptureConstraints(sender.track)) {
    return 1;
  }
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
  scaleResolutionDownBy?: number,
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
      scaleResolutionDownBy ?? requestedScaleResolutionDownBy(sender, profile);
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
    ? say("host.warn.audioUnread")
    : say("host.warn.audioRewritten", { kbps: String(Math.round(readback.appliedMaxBitrate / 1_000)) });
}

const PARAMETER_KEYS = {
  maxBitrate: "host.warn.param.maxBitrate",
  maxFramerate: "host.warn.param.maxFramerate",
  scaleResolutionDownBy: "host.warn.param.scaleResolutionDownBy",
  degradationPreference: "host.warn.param.degradationPreference",
  scalabilityMode: "host.warn.param.scalabilityMode",
} as const satisfies Record<keyof VideoSenderParameterValues, CopyKey>;

export function senderParameterWarning(
  readback: VideoSenderParameterReadback,
): string | null {
  return readback.mismatches.length > 0
    ? say("host.warn.senderPartial", {
        params: joinItems(
          readback.mismatches.map((key) => say(PARAMETER_KEYS[key])),
        ),
      })
    : null;
}
