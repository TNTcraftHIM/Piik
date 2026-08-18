import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyCaptureProfile,
  captureDisplay,
  configureVideoSender,
  QUALITY_PROFILES,
  setVideoPaused,
} from "../src/client/media/quality.ts";

function createVideoStream() {
  const videoTrack = {
    contentHint: "",
    enabled: true,
    applyConstraints: vi.fn(async () => undefined),
  } as unknown as MediaStreamTrack;
  const stream = {
    getTracks: () => [videoTrack],
    getVideoTracks: () => [videoTrack],
    getAudioTracks: () => [],
  } as unknown as MediaStream;
  return { stream, videoTrack };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("realtime quality controls", () => {
  it("bounds initial capture to the selected profile", async () => {
    const { stream, videoTrack } = createVideoStream();
    const getDisplayMedia = vi.fn(async () => stream);
    vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });

    await expect(captureDisplay(QUALITY_PROFILES["1080p30"])).resolves.toBe(
      stream,
    );

    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: {
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: 30, max: 30 },
      },
      audio: true,
    });
    expect(videoTrack.contentHint).toBe("motion");
  });

  it("changes capture constraints without selecting the source again", async () => {
    const { stream, videoTrack } = createVideoStream();

    await applyCaptureProfile(stream, QUALITY_PROFILES["720p30"]);

    expect(videoTrack.applyConstraints).toHaveBeenCalledWith({
      width: { ideal: 1280, max: 1280 },
      height: { ideal: 720, max: 720 },
      frameRate: { ideal: 30, max: 30 },
    });
  });

  it("sets the screen-share sender degradation preference", async () => {
    const parameters = {
      encodings: [],
    } as unknown as RTCRtpSendParameters;
    const setParameters = vi.fn(async () => undefined);
    const sender = {
      getParameters: () => parameters,
      setParameters,
    } as unknown as RTCRtpSender;

    await configureVideoSender(sender, QUALITY_PROFILES["1080p60"]);

    expect(parameters.encodings[0]).toMatchObject({
      maxBitrate: 8_000_000,
      maxFramerate: 60,
    });
    expect(parameters.degradationPreference).toBe("balanced");
    expect(setParameters).toHaveBeenCalledWith(parameters);
  });

  it("pauses only the video track and can resume it", () => {
    const { stream, videoTrack } = createVideoStream();

    expect(setVideoPaused(stream, true)).toBe(true);
    expect(videoTrack.enabled).toBe(false);
    expect(setVideoPaused(stream, false)).toBe(true);
    expect(videoTrack.enabled).toBe(true);
  });
});
