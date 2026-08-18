import type { QualityProfileId } from "../../shared/protocol";

export type { QualityProfileId } from "../../shared/protocol";

export const QUALITY_PROFILES = {
  "1080p60": {
    label: "1080p 60",
    width: 1920,
    height: 1080,
    frameRate: 60,
    maxBitrate: 8_000_000,
  },
  "1080p30": {
    label: "1080p 30",
    width: 1920,
    height: 1080,
    frameRate: 30,
    maxBitrate: 5_000_000,
  },
  "720p30": {
    label: "720p 30",
    width: 1280,
    height: 720,
    frameRate: 30,
    maxBitrate: 3_000_000,
  },
} as const satisfies Record<
  QualityProfileId,
  {
    label: string;
    width: number;
    height: number;
    frameRate: number;
    maxBitrate: number;
  }
>;

export type QualityProfile = (typeof QUALITY_PROFILES)[QualityProfileId];

function captureConstraints(profile: QualityProfile): MediaTrackConstraints {
  return {
    width: { ideal: profile.width, max: profile.width },
    height: { ideal: profile.height, max: profile.height },
    frameRate: { ideal: profile.frameRate, max: profile.frameRate },
  };
}

export async function captureDisplay(
  profile: QualityProfile,
): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("当前浏览器不支持屏幕共享");
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: captureConstraints(profile),
    audio: true,
  });

  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("浏览器没有返回可分享的视频轨道");
  }
  videoTrack.contentHint = "motion";
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

export function setVideoPaused(stream: MediaStream, paused: boolean): boolean {
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    return false;
  }
  videoTrack.enabled = !paused;
  return true;
}

export async function configureVideoSender(
  sender: RTCRtpSender,
  profile: QualityProfile,
): Promise<void> {
  const parameters = sender.getParameters();
  if (parameters.encodings.length === 0) {
    parameters.encodings = [{}];
  }
  parameters.encodings[0].maxBitrate = profile.maxBitrate;
  parameters.encodings[0].maxFramerate = profile.frameRate;
  parameters.degradationPreference = "balanced";
  await sender.setParameters(parameters);
}
