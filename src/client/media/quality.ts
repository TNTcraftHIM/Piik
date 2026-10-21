import {
  DEFAULT_QUALITY_SETTINGS,
  MIN_AUDIO_BITRATE,
  MAX_AUDIO_BITRATE,
  qualitySettingsSchema,
  type DegradationPreference,
  type QualityResolution,
  type QualitySettings,
} from "../../shared/protocol";
import { say, type CopyKey } from "../ui/copy";
import type { MediaFailure } from "../ui/media-failure";
import { displayMediaOptions } from "./audio-capture";
import { browserDebugEnabled, debugOperation } from "../lib/debug";
import { debugTrack } from "../lib/debug-webrtc";
import { applySenderCaptureConstraints, senderCaptureTrack } from "./sender-video-track";
import { cameraCaptureConstraints } from "./capture-devices";

export type {
  DegradationPreference,
  QualityResolution,
  QualitySettings,
} from "../../shared/protocol";

export type QualityProfile = QualitySettings;
export const STARTUP_VIDEO_ENCODED_FRAMES = 5;
export const MIN_VIDEO_FRAMERATE = 1;
export const MIN_VIDEO_BITRATE = 100_000;
export interface VideoCaptureLimits {
  maxVideoResolution: QualityResolution;
  maxVideoPixels: number;
  maxVideoMacroblocksPerSecond: number;
  maxVideoFramerate: number;
  maxVideoBitrate: number;
}

// Current output boundary, independent of descriptive wire bounds and UI presets.
// H.264 Level 5.2 bounds frame area, processing rate and bitrate independently.
// Keep a finite 240 fps scheduling budget; ultrawide/high-refresh inputs need
// not fit a named preset. Actual output still depends on the source and encoder.
export const VIDEO_CAPTURE_LIMITS: VideoCaptureLimits = {
  maxVideoResolution: { width: 8192, height: 8192 },
  maxVideoPixels: 36_864 * 16 * 16,
  maxVideoMacroblocksPerSecond: 2_073_600,
  maxVideoFramerate: 240,
  maxVideoBitrate: 240_000_000,
};

export function videoCaptureLimits(advertised?: Partial<VideoCaptureLimits>): VideoCaptureLimits {
  const local = VIDEO_CAPTURE_LIMITS;
  return {
    maxVideoResolution: {
      width: Math.min(local.maxVideoResolution.width, advertised?.maxVideoResolution?.width ?? local.maxVideoResolution.width),
      height: Math.min(local.maxVideoResolution.height, advertised?.maxVideoResolution?.height ?? local.maxVideoResolution.height),
    },
    maxVideoPixels: Math.min(local.maxVideoPixels, advertised?.maxVideoPixels ?? local.maxVideoPixels),
    maxVideoMacroblocksPerSecond: Math.min(local.maxVideoMacroblocksPerSecond,
      advertised?.maxVideoMacroblocksPerSecond ?? local.maxVideoMacroblocksPerSecond),
    maxVideoFramerate: Math.min(local.maxVideoFramerate, advertised?.maxVideoFramerate ?? local.maxVideoFramerate),
    maxVideoBitrate: Math.min(local.maxVideoBitrate, advertised?.maxVideoBitrate ?? local.maxVideoBitrate),
  };
}

export function captureFramerateCeiling(size: QualityResolution, limits = VIDEO_CAPTURE_LIMITS): number {
  if (![size.width, size.height].every(value => Number.isInteger(value) && value >= 4 && value % 2 === 0)
    || size.width > limits.maxVideoResolution.width || size.height > limits.maxVideoResolution.height
    || size.width * size.height > limits.maxVideoPixels
    || Math.ceil(size.width / 16) * Math.ceil(size.height / 16) * 256 > VIDEO_CAPTURE_LIMITS.maxVideoPixels) return 0;
  return Math.floor(Math.min(limits.maxVideoFramerate, limits.maxVideoMacroblocksPerSecond /
    (Math.ceil(size.width / 16) * Math.ceil(size.height / 16))));
}

export function supportsCaptureProfile(profile: QualityProfile, limits = VIDEO_CAPTURE_LIMITS,
  maxAudioBitrate = MAX_AUDIO_SEND_BITRATE): boolean {
  return qualitySettingsSchema.safeParse(profile).success &&
    Number.isInteger(profile.maxFramerate) && profile.maxFramerate >= MIN_VIDEO_FRAMERATE &&
    profile.maxFramerate <= captureFramerateCeiling(profile.resolution, limits) &&
    profile.maxBitrate >= MIN_VIDEO_BITRATE && profile.maxBitrate <= limits.maxVideoBitrate &&
    screenAudioBitrate(profile.maxAudioBitrate) <= maxAudioBitrate;
}

function requireCaptureProfile(profile: QualityProfile): void {
  if (!supportsCaptureProfile(profile)) throw new Error("Capture quality is not supported by this implementation");
}

export const QUALITY_PROFILES = {
  "720p30": {
    resolution: { width: 1280, height: 720 },
    maxFramerate: 30,
    maxBitrate: 3_000_000,
    degradationPreference: "balanced",
    maxAudioBitrate: 128000,
  },
  "1080p30": DEFAULT_QUALITY_SETTINGS,
  "1080p60": {
    resolution: { width: 1920, height: 1080 },
    maxFramerate: 60,
    maxBitrate: 8_000_000,
    degradationPreference: "balanced",
    maxAudioBitrate: 128000,
  },
} as const satisfies Record<string, QualitySettings>;
export type QualityProfileId = keyof typeof QUALITY_PROFILES;

export const QUALITY_PROFILE_KEYS = {
  "720p30": "host.quality.720p30",
  "1080p30": "host.quality.1080p30",
  "1080p60": "host.quality.1080p60",
} as const satisfies Record<QualityProfileId, CopyKey>;

export const QUALITY_RESOLUTIONS = {
  "480p": { width: 854, height: 480 },
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
  "1440p": { width: 2560, height: 1440 },
  "4K": { width: 3840, height: 2160 },
} as const satisfies Record<string, QualityResolution>;

export function qualityResolutionEqual(left: QualityResolution, right: QualityResolution): boolean {
  return left.width === right.width && left.height === right.height;
}

export function qualityResolutionLabel(resolution: QualityResolution): string {
  return Object.entries(QUALITY_RESOLUTIONS).find(([, size]) => qualityResolutionEqual(size, resolution))?.[0]
    ?? `${resolution.width}×${resolution.height}`;
}

export const DEGRADATION_PREFERENCE_KEYS = {
  "maintain-resolution": "host.advanced.preference.resolution",
  balanced: "host.advanced.preference.balanced",
  "maintain-framerate": "host.advanced.preference.framerate",
} as const satisfies Record<DegradationPreference, CopyKey>;

export const SCREEN_AUDIO_BITRATES = {
  saver: 64_000,
  music: 128_000,
  "very-high": 192_000,
} as const;
export type ScreenAudioPreset = keyof typeof SCREEN_AUDIO_BITRATES;
// Current 20 ms output leaves room for RTP/SRTP overhead within a 1200-byte packet.
export const MAX_AUDIO_SEND_BITRATE = 320_000;
export const OPUS_RECEIVE_MAX_BITRATE = MAX_AUDIO_BITRATE;

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

export function screenAudioBitrate(
  bitrate: number | undefined,
): number {
  return bitrate ?? DEFAULT_QUALITY_SETTINGS.maxAudioBitrate;
}

export function qualitySettingsEqual(
  left: QualitySettings,
  right: QualitySettings,
): boolean {
  return (
    videoQualitySettingsEqual(left, right) &&
    audioQualitySettingsEqual(left, right)
  );
}

export function videoQualitySettingsEqual(
  left: QualitySettings,
  right: QualitySettings,
): boolean {
  return (
    qualityResolutionEqual(left.resolution, right.resolution) &&
    left.maxFramerate === right.maxFramerate &&
    left.maxBitrate === right.maxBitrate &&
    left.degradationPreference === right.degradationPreference
  );
}

export function audioQualitySettingsEqual(
  left: QualitySettings,
  right: QualitySettings,
): boolean {
  return (
    screenAudioBitrate(left.maxAudioBitrate) ===
      screenAudioBitrate(right.maxAudioBitrate)
  );
}

export function matchingQualityProfileId(
  settings: QualitySettings,
): QualityProfileId | null {
  for (const id of Object.keys(QUALITY_PROFILES) as QualityProfileId[]) {
    const profile = QUALITY_PROFILES[id];
    if (
      qualityResolutionEqual(settings.resolution, profile.resolution) &&
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
  return `${qualityResolutionLabel(settings.resolution)} ${settings.maxFramerate} fps · ${(settings.maxBitrate / 1_000_000).toFixed(1)} Mbps · ${say(DEGRADATION_PREFERENCE_KEYS[settings.degradationPreference])}`;
}

function captureConstraints(profile: QualityProfile): MediaTrackConstraints {
  requireCaptureProfile(profile);
  const resolution = profile.resolution;
  return {
    // A ceiling must not ask the Browser to fill both axes by cropping a source.
    width: { max: resolution.width },
    height: { max: resolution.height },
    frameRate: {
      ideal: profile.maxFramerate,
      max: profile.maxFramerate,
    },
  };
}

export async function captureDisplay(profile: QualityProfile): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("getDisplayMedia unavailable");
  }

  const complete = debugOperation("capture", "display", { requested: profile });
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions({
      ...captureConstraints(profile),
    }));
  } catch (error) {
    complete("failed", {}, error);
    throw error;
  }

  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    stream.getTracks().forEach((track) => track.stop());
    complete("failed", { reason: "no-video-track" });
    throw new Error("display capture produced no video track");
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

export type BrowserCaptureSource = "browser" | "camera";

export async function captureBrowserSource(profile: QualityProfile, source: BrowserCaptureSource, deviceId = ""): Promise<MediaStream> {
  if (source !== "camera") return captureDisplay(profile);
  requireCaptureProfile(profile);
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false,
    video: cameraCaptureConstraints(profile.resolution, profile.maxFramerate, deviceId) });
  const track = stream.getVideoTracks()[0];
  if (!track || track.readyState === "ended") {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("Camera capture produced no live video track");
  }
  track.contentHint = "motion";
  return stream;
}

export async function applyCaptureProfile(
  stream: MediaStream,
  profile: QualityProfile,
): Promise<void> {
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    throw new Error("capture stream has no video track");
  }
  await applyVideoCaptureProfile(videoTrack, profile);
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
    await applySenderCaptureConstraints(track, captureConstraints(profile));
    complete("applied", { trackId: track.id });
    debugTrack(track, { event: "profile-applied" });
  } catch (error) {
    complete("failed", { trackId: track.id }, error);
    throw error;
  }
}

function videoTrackOwnsCaptureConstraints(track: MediaStreamTrack): boolean {
  track = senderCaptureTrack(track);
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
      ? senderCaptureTrack(sender.track).getSettings()
      : undefined;
  const ceiling = profile.resolution;
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
  carrierScale?: number,
): Promise<VideoSenderParameterReadback> {
  const parameters = sender.getParameters();
  if (parameters.encodings.length === 0) {
    parameters.encodings = [{}];
  }
  // Pinned LiveKit orders simulcast encodings by increasing spatial resolution.
  const encodingIndex = parameters.encodings.length - 1;
  const encoding = parameters.encodings[encodingIndex]!;
  encoding.maxBitrate = profile.maxBitrate;
  // The producer owns picture cadence. A second limit on its synthetic clock
  // can discard ticks and strand already-encoded frames when delivery is uneven.
  if (carrierScale === undefined) encoding.maxFramerate = profile.maxFramerate;
  else delete encoding.maxFramerate;
  if (parameters.encodings.length === 1) {
    encoding.scaleResolutionDownBy = carrierScale ?? requestedScaleResolutionDownBy(sender, profile);
  }
  // The carrier transports already-adapted frames. Native FPS adaptation on
  // that clock would discard them a second time and repeatedly break the queue.
  parameters.degradationPreference = carrierScale === undefined
    ? profile.degradationPreference : "maintain-framerate";

  const requested = readVideoSenderParameters(parameters, false, encodingIndex);
  await sender.setParameters(parameters);
  const applied = readVideoSenderParameters(
    sender.getParameters(),
    true,
    encodingIndex,
  );
  return senderParameterReadback(requested, applied);
}

export function audioSenderCeiling(current: RTCRtpSendParameters, requestedMaxBitrate: number): number {
  // Some Browsers accept setParameters above the negotiated Opus receive limit.
  // Keep that limit on this sender, never on the shared capture or sibling edges.
  let ceiling = Math.min(requestedMaxBitrate, MAX_AUDIO_SEND_BITRATE);
  for (const codec of current.codecs ?? []) {
    if (codec.mimeType.toLowerCase() !== "audio/opus") continue;
    let receiveLimit: number | undefined;
    let playbackRate = 48_000;
    let channels = 1;
    for (const parameter of (codec.sdpFmtpLine ?? "").split(";")) {
      const [name, value] = parameter.trim().split("=");
      const key = name?.trim().toLowerCase();
      const number = Number(value);
      if (key === "stereo") channels = value?.trim() === "1" ? 2 : 1;
      if (key === "maxplaybackrate" && Number.isInteger(number) && number >= 8_000 && number <= 48_000) {
        playbackRate = number;
      }
      // RFC 7587 ignores out-of-range receive preferences.
      if (key === "maxaveragebitrate" && Number.isInteger(number) && number >= MIN_AUDIO_BITRATE && number <= MAX_AUDIO_BITRATE) {
        receiveLimit = Math.min(receiveLimit ?? MAX_AUDIO_BITRATE, number);
      }
    }
    // Match libwebrtc's default when the peer omits a valid explicit ceiling;
    // omission must not let setParameters override the default with a higher rate.
    const defaultBitrate = (playbackRate <= 8_000 ? 12_000 : playbackRate <= 16_000 ? 20_000 : 32_000) * channels;
    ceiling = Math.min(ceiling, receiveLimit ?? defaultBitrate);
  }
  return ceiling;
}

export async function configureAudioSender(
  sender: RTCRtpSender,
  requestedMaxBitrate: number,
): Promise<AudioSenderParameterReadback> {
  const current = sender.getParameters();
  const parameters = {
    ...current,
    encodings: current.encodings.map((encoding) => ({ ...encoding })),
  };
  if (parameters.encodings.length === 0) {
    parameters.encodings = [{}];
  }
  parameters.encodings[0]!.maxBitrate = audioSenderCeiling(current, requestedMaxBitrate);
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
): MediaFailure | null {
  if (!readback.mismatch) {
    return null;
  }
  return readback.appliedMaxBitrate === null
    ? { key: "host.warn.audioUnread" }
    : {
        key: "host.warn.audioRewritten",
        vars: { kbps: String(Math.round(readback.appliedMaxBitrate / 1_000)) },
      };
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
): MediaFailure | null {
  return readback.mismatches.length > 0
    ? {
        key: "host.warn.senderPartial",
        paramKeys: readback.mismatches.map((key) => PARAMETER_KEYS[key]),
      }
    : null;
}
