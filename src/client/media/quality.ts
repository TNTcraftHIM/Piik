export const QUALITY_PROFILES = {
  "1080p60": {
    label: "1080p 60",
    width: 1920,
    height: 1080,
    frameRate: 60,
    maxBitrate: 8_000_000,
  },
  "720p60": {
    label: "720p 60",
    width: 1280,
    height: 720,
    frameRate: 60,
    maxBitrate: 5_000_000,
  },
  "720p30": {
    label: "720p 30",
    width: 1280,
    height: 720,
    frameRate: 30,
    maxBitrate: 3_000_000,
  },
} as const;

export type QualityProfileId = keyof typeof QUALITY_PROFILES;
export type QualityProfile = (typeof QUALITY_PROFILES)[QualityProfileId];

export async function captureDisplay(
  profile: QualityProfile,
): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("当前浏览器不支持屏幕共享");
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: profile.width },
      height: { ideal: profile.height },
      frameRate: { ideal: profile.frameRate, max: profile.frameRate },
    },
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
  parameters.degradationPreference = "maintain-framerate";
  await sender.setParameters(parameters);
}
