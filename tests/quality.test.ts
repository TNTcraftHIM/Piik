import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  audioSenderParameterWarning,
  applyCaptureProfile,
  applyVideoCaptureProfile,
  captureDisplay,
  captureFramerateCeiling,
  videoCaptureLimits,
  supportsCaptureProfile,
  configureAudioSender,
  configureVideoSender,
  matchingQualityProfileId,
  needsStartupVideoProfile,
  QUALITY_PROFILES,
  QUALITY_RESOLUTIONS,
  qualitySettingsEqual,
  qualityResolutionLabel,
  videoQualitySettingsEqual,
  screenAudioBitrate,
  audioSenderCeiling,
  senderParameterWarning,
  setMediaPaused,
  startupVideoProfile,
} from "../src/client/media/quality.ts";
import { setCopy } from "../src/client/ui/copy.ts";

function createVideoStream() {
  const videoTrack = {
    contentHint: "",
    enabled: true,
    applyConstraints: vi.fn(async () => undefined),
    getSettings: () => ({ width: 1920, height: 1080, frameRate: 60 }),
  } as unknown as MediaStreamTrack;
  const audioTrack = {
    contentHint: "",
    enabled: true,
  } as unknown as MediaStreamTrack;
  const stream = {
    getTracks: () => [videoTrack, audioTrack],
    getVideoTracks: () => [videoTrack],
    getAudioTracks: () => [audioTrack],
  } as unknown as MediaStream;
  return { stream, videoTrack, audioTrack };
}

beforeEach(() => {
  setCopy({ lang: "zh", vis: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("realtime quality controls", () => {
  it("bounds custom size, orientation and frame rate together before capture", () => {
    expect(captureFramerateCeiling(QUALITY_RESOLUTIONS["2160p"])).toBe(64);
    expect(captureFramerateCeiling({ width: 2160, height: 3840 })).toBe(64);
    expect(captureFramerateCeiling(QUALITY_RESOLUTIONS["1440p"])).toBe(144);
    expect(captureFramerateCeiling({ width: 1440, height: 2560 })).toBe(144);
    expect(captureFramerateCeiling({ width: 3840, height: 2100 })).toBe(65);
    expect(captureFramerateCeiling({ width: 5120, height: 1440 })).toBe(72);
    expect(captureFramerateCeiling({ width: 1920, height: 1080 })).toBe(240);
    const level51 = videoCaptureLimits({ maxVideoMacroblocksPerSecond: 983_040 });
    expect(captureFramerateCeiling(QUALITY_RESOLUTIONS["2160p"], level51)).toBe(30);
    expect(captureFramerateCeiling({ width: 2160, height: 3840 }, level51)).toBe(30);
    for (const size of [{ width: 3840, height: 3840 }, { width: 1921, height: 1080 },
      { width: 8194, height: 100 }, { width: 6562, height: 1438 },
      { width: 4.5, height: 4 }, { width: Infinity, height: 4 }, { width: 2, height: 4 }]) {
      expect(captureFramerateCeiling(size)).toBe(0);
    }
    const limited = videoCaptureLimits({ maxVideoResolution: { width: 1920, height: 1080 },
      maxVideoPixels: 1920 * 1080, maxVideoMacroblocksPerSecond: 245_760 });
    expect(captureFramerateCeiling(QUALITY_RESOLUTIONS["2160p"], limited)).toBe(0);
    expect(captureFramerateCeiling(QUALITY_RESOLUTIONS["1080p"], limited)).toBe(30);
    expect(captureFramerateCeiling(QUALITY_RESOLUTIONS["720p"], limited)).toBe(68);
    expect(videoCaptureLimits({ maxVideoResolution: { width: 8192, height: 8192 },
      maxVideoPixels: 8192 * 8192, maxVideoMacroblocksPerSecond: 9_000_000,
      maxVideoFramerate: 480, maxVideoBitrate: 1_000_000_000 })).toEqual(videoCaptureLimits());
    const slower = videoCaptureLimits({ maxVideoFramerate: 30, maxVideoBitrate: 5_000_000 });
    expect(supportsCaptureProfile(QUALITY_PROFILES["1080p30"], slower)).toBe(true);
    expect(supportsCaptureProfile(QUALITY_PROFILES["1080p60"], slower)).toBe(false);
  });

  it("rejects unsupported requests before changing capture or asking for permission", async () => {
    const { stream, videoTrack } = createVideoStream();
    const getDisplayMedia = vi.fn(async () => stream);
    vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });
    for (const change of [{ maxFramerate: 241 }, { maxFramerate: 30.5 }, { maxFramerate: 0 },
      { maxBitrate: 99_999 }, { maxBitrate: 240_000_001 },
      { resolution: { width: 32768, height: 32768 } }, { maxAudioBitrate: 510_000 }]) {
      const requested = { ...QUALITY_PROFILES["1080p30"], ...change };
      expect(supportsCaptureProfile(requested)).toBe(false);
      await expect(captureDisplay(requested)).rejects.toThrow("not supported");
      await expect(applyCaptureProfile(stream, requested)).rejects.toThrow("not supported");
    }
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(videoTrack.applyConstraints).not.toHaveBeenCalled();
  });

  it("admits useful low-rate and high-rate requests without changing presets", async () => {
    const { stream, videoTrack } = createVideoStream();
    for (const [maxFramerate, maxBitrate] of [[1, 100_000], [5, 800_000], [60, 50_000_000],
      [120, 80_000_000], [144, 100_000_000], [240, 240_000_000]]) {
      const profile = { ...QUALITY_PROFILES["1080p30"], maxFramerate, maxBitrate };
      expect(supportsCaptureProfile(profile)).toBe(true);
      await applyCaptureProfile(stream, profile);
      expect(videoTrack.applyConstraints).toHaveBeenLastCalledWith(expect.objectContaining({
        frameRate: { ideal: maxFramerate, max: maxFramerate },
      }));
    }
  });

  it("requests 4K60 in either orientation through the existing capture controls", async () => {
    const { stream, videoTrack } = createVideoStream();
    const getDisplayMedia = vi.fn(async () => stream);
    vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });
    for (const resolution of [QUALITY_RESOLUTIONS["2160p"], { width: 2160, height: 3840 }]) {
      const profile = { ...QUALITY_PROFILES["1080p60"], resolution, maxBitrate: 50_000_000 };
      expect(supportsCaptureProfile(profile)).toBe(true);
      await captureDisplay(profile);
      expect(getDisplayMedia).toHaveBeenLastCalledWith(expect.objectContaining({
        video: expect.objectContaining({
          width: expect.objectContaining({ max: resolution.width }),
          height: expect.objectContaining({ max: resolution.height }),
          frameRate: expect.objectContaining({ max: 60 }),
        }),
      }));
      await applyCaptureProfile(stream, profile);
      expect(videoTrack.applyConstraints).toHaveBeenCalled();
    }
  });

  it("keeps exactly three recommended profiles with 1080p30 as the default", () => {
    expect(Object.keys(QUALITY_PROFILES)).toEqual([
      "720p30",
      "1080p30",
      "1080p60",
    ]);
    expect(QUALITY_PROFILES["1080p30"]).toMatchObject({
      resolution: { width: 1920, height: 1080 },
      maxFramerate: 30,
      maxBitrate: 5_000_000,
    });
  });

  it("offers 854x480 only through advanced resolution settings", () => {
    expect(QUALITY_RESOLUTIONS["480p"]).toEqual({
      width: 854,
      height: 480,
    });
    expect(
      Object.values(QUALITY_PROFILES).map((profile) => profile.resolution),
    ).not.toContainEqual(QUALITY_RESOLUTIONS["480p"]);
  });

  it("bounds initial capture to the selected profile", async () => {
    const { stream, videoTrack, audioTrack } = createVideoStream();
    const getDisplayMedia = vi.fn(async () => stream);
    vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });

    await expect(captureDisplay(QUALITY_PROFILES["1080p30"])).resolves.toBe(
      stream,
    );

    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: {
        width: { max: 1920 },
        height: { max: 1080 },
        frameRate: { ideal: 30, max: 30 },
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        voiceIsolation: false,
        channelCount: { ideal: 2 },
        restrictOwnAudio: true,
      },
      systemAudio: "include",
      windowAudio: "window",
    });
    expect(videoTrack.contentHint).toBe("motion");
    expect(audioTrack.contentHint).toBe("music");
  });

  it("changes capture ceilings without requesting a crop or locking source orientation", async () => {
    const { stream, videoTrack } = createVideoStream();
    videoTrack.getSettings = () => ({ width: 540, height: 960, aspectRatio: 9 / 16 });

    await applyCaptureProfile(stream, {
      resolution: { width: 1280, height: 720 },
      maxFramerate: 45,
      maxBitrate: 9_500_000,
      degradationPreference: "balanced",
    });

    expect(videoTrack.applyConstraints).toHaveBeenCalledWith({
      width: { max: 1280 },
      height: { max: 720 },
      frameRate: { ideal: 45, max: 45 },
    });
  });

  it("compares deserialized size values without treating audio edits as new video", () => {
    const profile = QUALITY_PROFILES["1080p30"];
    const restored = JSON.parse(JSON.stringify(profile));
    expect(qualitySettingsEqual(profile, restored)).toBe(true);
    expect(videoQualitySettingsEqual(profile, { ...restored, maxAudioBitrate: 256_000 })).toBe(true);
    expect(videoQualitySettingsEqual(profile, { ...restored, resolution: { width: 1920, height: 1200 } })).toBe(false);
    expect(qualityResolutionLabel(restored.resolution)).toBe("1080p");
    expect(qualityResolutionLabel({ width: 1920, height: 1200 })).toBe("1920×1200");
  });

  it("leaves capture constraints with the owner of a remote track", async () => {
    const { videoTrack } = createVideoStream();
    videoTrack.getCapabilities = vi.fn(() => ({}));

    await applyVideoCaptureProfile(videoTrack, QUALITY_PROFILES["1080p30"]);

    expect(videoTrack.applyConstraints).not.toHaveBeenCalled();
  });

  it("defaults every recommended profile to balanced", () => {
    expect(QUALITY_PROFILES["1080p30"].degradationPreference).toBe("balanced");
    expect(QUALITY_PROFILES["1080p60"].degradationPreference).toBe("balanced");
    expect(QUALITY_PROFILES["720p30"].degradationPreference).toBe("balanced");
  });

  it("holds resolution only while a scaling preference starts", () => {
    expect(needsStartupVideoProfile(QUALITY_PROFILES["1080p30"])).toBe(true);
    expect(startupVideoProfile(QUALITY_PROFILES["1080p30"])).toMatchObject({
      degradationPreference: "maintain-resolution",
      maxBitrate: 5_000_000,
      maxFramerate: 30,
    });
    const clarity = {
      ...QUALITY_PROFILES["1080p30"],
      degradationPreference: "maintain-resolution",
    } as const;
    expect(needsStartupVideoProfile(clarity)).toBe(false);
    expect(startupVideoProfile(clarity)).toBe(clarity);
  });

  it("keeps audio selection orthogonal while defaulting missing settings to music", () => {
    const saver = {
      ...QUALITY_PROFILES["1080p60"],
      maxAudioBitrate: 64000,
    } as const;
    const {
      maxAudioBitrate: _maxAudioBitrate,
      ...legacySettings
    } = QUALITY_PROFILES["1080p60"];

    expect(matchingQualityProfileId(saver)).toBe("1080p60");
    expect(qualitySettingsEqual(saver, QUALITY_PROFILES["1080p60"])).toBe(false);
    expect(
      qualitySettingsEqual(legacySettings, QUALITY_PROFILES["1080p60"]),
    ).toBe(true);
  });

  it("reads back every requested sender control after setParameters", async () => {
    let applied = { encodings: [] } as unknown as RTCRtpSendParameters;
    const setParameters = vi.fn(async (parameters: RTCRtpSendParameters) => {
      applied = parameters;
    });
    const sender = {
      track: {
        getSettings: () => ({ width: 2560, height: 1440 }),
      },
      getParameters: () => applied,
      setParameters,
    } as unknown as RTCRtpSender;

    const readback = await configureVideoSender(
      sender,
      QUALITY_PROFILES["1080p60"],
    );

    expect(readback).toEqual({
      requested: {
        maxBitrate: 8_000_000,
        maxFramerate: 60,
        scaleResolutionDownBy: 4 / 3,
        degradationPreference: "balanced",
        scalabilityMode: null,
      },
      applied: {
        maxBitrate: 8_000_000,
        maxFramerate: 60,
        scaleResolutionDownBy: 4 / 3,
        degradationPreference: "balanced",
        scalabilityMode: null,
      },
      mismatches: [],
    });
    expect(senderParameterWarning(readback)).toBeNull();
    expect(setParameters).toHaveBeenCalledOnce();
  });

  it("applies a profile to the highest-resolution simulcast encoding", async () => {
    let applied = {
      encodings: [
        {
          rid: "q",
          maxBitrate: 1_250_000,
          maxFramerate: 30,
          scaleResolutionDownBy: 2,
        },
        {
          rid: "h",
          maxBitrate: 5_000_000,
          maxFramerate: 30,
          scaleResolutionDownBy: 1,
        },
      ],
    } as unknown as RTCRtpSendParameters;
    const sender = {
      track: {
        getSettings: () => ({ width: 1920, height: 1080 }),
      },
      getParameters: () => applied,
      setParameters: vi.fn(async (parameters: RTCRtpSendParameters) => {
        applied = parameters;
      }),
    } as unknown as RTCRtpSender;

    await expect(
      configureVideoSender(sender, QUALITY_PROFILES["1080p60"]),
    ).resolves.toMatchObject({
      requested: { maxBitrate: 8_000_000, maxFramerate: 60 },
      applied: { maxBitrate: 8_000_000, maxFramerate: 60 },
      mismatches: [],
    });
    expect(applied.encodings).toEqual([
      {
        rid: "q",
        maxBitrate: 1_250_000,
        maxFramerate: 30,
        scaleResolutionDownBy: 2,
      },
      {
        rid: "h",
        maxBitrate: 8_000_000,
        maxFramerate: 60,
        scaleResolutionDownBy: 1,
      },
    ]);
  });

  it("leaves picture cadence with the producer and restores ordinary sender adaptation", async () => {
    let applied = { encodings: [{ maxFramerate: 30 }] } as RTCRtpSendParameters;
    const sender = {
      getParameters: () => applied,
      setParameters: async (parameters: RTCRtpSendParameters) => { applied = parameters; },
    } as unknown as RTCRtpSender;
    const carrier = await configureVideoSender(sender, QUALITY_PROFILES["1080p60"], 1);
    expect(applied.encodings[0]).not.toHaveProperty("maxFramerate");
    expect(carrier).toMatchObject({ requested: { maxFramerate: null, maxBitrate: 8_000_000,
      degradationPreference: "maintain-framerate" }, mismatches: [] });
    for (const id of ["720p30", "1080p60"] as const) {
      const readback = await configureVideoSender(sender, QUALITY_PROFILES[id]);
      expect(applied.encodings[0]!.maxFramerate).toBe(QUALITY_PROFILES[id].maxFramerate);
      expect(applied.degradationPreference).toBe(QUALITY_PROFILES[id].degradationPreference);
      expect(readback.mismatches).toEqual([]);
    }
  });

  it("does not scale a remote source that already owns the room profile", async () => {
    let applied = { encodings: [{}] } as unknown as RTCRtpSendParameters;
    const sender = {
      track: {
        getCapabilities: () => ({}),
        getSettings: () => ({ width: 2560, height: 1440 }),
      },
      getParameters: () => applied,
      setParameters: vi.fn(async (parameters: RTCRtpSendParameters) => {
        applied = parameters;
      }),
    } as unknown as RTCRtpSender;

    const readback = await configureVideoSender(
      sender,
      QUALITY_PROFILES["720p30"],
    );

    expect(readback.requested.scaleResolutionDownBy).toBe(1);
    expect(applied.encodings[0]?.scaleResolutionDownBy).toBe(1);
  });

  it.each([
    [undefined, 128_000],
    [64_000, 64_000],
    [128_000, 128_000],
    [192_000, 192_000],
  ] as const)("applies and reads back the %s audio ceiling", async (quality, bitrate) => {
    let applied = { encodings: [] } as unknown as RTCRtpSendParameters;
    const sender = {
      getParameters: () => applied,
      setParameters: vi.fn(async (parameters: RTCRtpSendParameters) => {
        applied = parameters;
      }),
    } as unknown as RTCRtpSender;

    await expect(configureAudioSender(sender, screenAudioBitrate(quality))).resolves.toEqual({
      requestedMaxBitrate: bitrate,
      appliedMaxBitrate: bitrate,
      mismatch: false,
    });
    expect(applied.encodings).toEqual([{ maxBitrate: bitrate }]);
  });

  it.each([96_000, 256_000, 320_000])("applies a numeric %i audio ceiling without a preset", async (bitrate) => {
    let applied = { encodings: [] } as unknown as RTCRtpSendParameters;
    const sender = {
      getParameters: () => applied,
      setParameters: vi.fn(async (parameters: RTCRtpSendParameters) => {
        applied = parameters;
      }),
    } as unknown as RTCRtpSender;

    await expect(configureAudioSender(sender, bitrate)).resolves.toEqual({
      requestedMaxBitrate: bitrate,
      appliedMaxBitrate: bitrate,
      mismatch: false,
    });
  });

  it.each([192_000, 510_000])("honors the receiver's %i Opus limit on every live update", async (limit) => {
    let applied = {
      codecs: [{ mimeType: "audio/opus", sdpFmtpLine: `stereo=1;maxaveragebitrate=${limit}` }],
      encodings: [{}],
    } as RTCRtpSendParameters;
    const sender = {
      getParameters: () => applied,
      setParameters: async (value: RTCRtpSendParameters) => { applied = value; },
    } as RTCRtpSender;
    for (const bitrate of [128_000, 320_000, 96_000, 510_000]) {
      const ceiling = Math.min(bitrate, limit, 320_000);
      await expect(configureAudioSender(sender, bitrate)).resolves.toEqual({
        requestedMaxBitrate: bitrate, appliedMaxBitrate: ceiling, mismatch: ceiling !== bitrate,
      });
      expect(applied.encodings[0]?.maxBitrate).toBe(ceiling);
    }
  });

  it.each([
    ["", 32_000],
    ["stereo=1", 64_000],
    ["stereo=1;maxaveragebitrate=invalid", 64_000],
    ["stereo=1;maxaveragebitrate=510001", 64_000],
    ["maxplaybackrate=8000", 12_000],
    ["stereo=1;maxplaybackrate=16000", 40_000],
    ["maxaveragebitrate=510000;maxaveragebitrate=96000", 96_000],
  ] as const)("keeps omitted/invalid Opus limits bounded: %s", (sdpFmtpLine, expected) => {
    const parameters = { codecs: [{ mimeType: "audio/opus", sdpFmtpLine }] } as RTCRtpSendParameters;
    expect(audioSenderCeiling(parameters, 320_000)).toBe(expected);
    expect(audioSenderCeiling(parameters, 6_000)).toBe(6_000);
  });

  it("reports an audio ceiling the browser rewrites", async () => {
    const sender = {
      getParameters: vi
        .fn<() => RTCRtpSendParameters>()
        .mockReturnValueOnce({ encodings: [{}] } as RTCRtpSendParameters)
        .mockReturnValue({
          encodings: [{ maxBitrate: 96_000 }],
        } as RTCRtpSendParameters),
      setParameters: vi.fn(async () => undefined),
    } as unknown as RTCRtpSender;

    const readback = await configureAudioSender(sender, 128_000);

    expect(readback).toEqual({
      requestedMaxBitrate: 128_000,
      appliedMaxBitrate: 96_000,
      mismatch: true,
    });
    expect(audioSenderParameterWarning(readback)).toEqual({
      key: "host.warn.audioRewritten",
      vars: { kbps: "96" },
    });
  });

  it("does not mutate prior audio parameters when setParameters fails", async () => {
    const applied = {
      encodings: [{ maxBitrate: 128_000 }],
    } as RTCRtpSendParameters;
    const sender = {
      getParameters: () => applied,
      setParameters: vi.fn(async () => {
        throw new Error("rejected");
      }),
    } as unknown as RTCRtpSender;

    await expect(
      configureAudioSender(sender, 192_000),
    ).rejects.toThrow("rejected");
    expect(applied.encodings[0]?.maxBitrate).toBe(128_000);
  });

  it("reports fields the browser does not retain", async () => {
    const before = { encodings: [{}] } as RTCRtpSendParameters;
    const after = {
      encodings: [{ maxBitrate: 8_000_000 }],
      degradationPreference: "maintain-resolution",
    } as unknown as RTCRtpSendParameters;
    const getParameters = vi
      .fn<() => RTCRtpSendParameters>()
      .mockReturnValueOnce(before)
      .mockReturnValue(after);
    const sender = {
      track: { getSettings: () => ({ width: 1920, height: 1080 }) },
      getParameters,
      setParameters: vi.fn(async () => undefined),
    } as unknown as RTCRtpSender;

    const readback = await configureVideoSender(
      sender,
      QUALITY_PROFILES["1080p60"],
    );

    expect(readback.mismatches).toEqual([
      "maxFramerate",
      "scaleResolutionDownBy",
      "degradationPreference",
    ]);
    expect(senderParameterWarning(readback)).toEqual({
      key: "host.warn.senderPartial",
      paramKeys: [
        "host.warn.param.maxFramerate",
        "host.warn.param.scaleResolutionDownBy",
        "host.warn.param.degradationPreference",
      ],
    });
  });

  it("reports an applied default scalability mode without claiming a request", async () => {
    const before = {
      encodings: [{}],
    } as unknown as RTCRtpSendParameters;
    const after = {
      encodings: [
        {
          maxBitrate: 8_000_000,
          maxFramerate: 60,
          scaleResolutionDownBy: 1,
          scalabilityMode: "L1T2",
        },
      ],
      degradationPreference: "balanced",
    } as unknown as RTCRtpSendParameters;
    const sender = {
      track: { getSettings: () => ({ width: 1920, height: 1080 }) },
      getParameters: vi
        .fn<() => RTCRtpSendParameters>()
        .mockReturnValueOnce(before)
        .mockReturnValue(after),
      setParameters: vi.fn(async () => undefined),
    } as unknown as RTCRtpSender;

    const readback = await configureVideoSender(
      sender,
      QUALITY_PROFILES["1080p60"],
    );

    expect(readback.requested.scalabilityMode).toBeNull();
    expect(readback.applied.scalabilityMode).toBe("L1T2");
    expect(readback.mismatches).not.toContain("scalabilityMode");
    expect(senderParameterWarning(readback)).toBeNull();
  });

  it("keeps scalability mode unknown when sender encodings are ambiguous", async () => {
    const before = { encodings: [{}] } as RTCRtpSendParameters;
    const after = {
      encodings: [
        {
          rid: "low",
          maxBitrate: 8_000_000,
          maxFramerate: 60,
          scaleResolutionDownBy: 1,
          scalabilityMode: "L1T1",
        },
        { rid: "high", scalabilityMode: "L1T2" },
      ],
      degradationPreference: "balanced",
    } as unknown as RTCRtpSendParameters;
    const sender = {
      track: { getSettings: () => ({ width: 1920, height: 1080 }) },
      getParameters: vi
        .fn<() => RTCRtpSendParameters>()
        .mockReturnValueOnce(before)
        .mockReturnValue(after),
      setParameters: vi.fn(async () => undefined),
    } as unknown as RTCRtpSender;

    const readback = await configureVideoSender(
      sender,
      QUALITY_PROFILES["1080p60"],
    );

    expect(readback.applied.scalabilityMode).toBeNull();
    expect(readback.mismatches).not.toContain("scalabilityMode");
  });

  it("pauses and resumes the shared video and audio tracks together", () => {
    const { stream, videoTrack, audioTrack } = createVideoStream();

    expect(setMediaPaused(stream, true)).toBe(true);
    expect(videoTrack.enabled).toBe(false);
    expect(audioTrack.enabled).toBe(false);
    expect(setMediaPaused(stream, false)).toBe(true);
    expect(videoTrack.enabled).toBe(true);
    expect(audioTrack.enabled).toBe(true);
  });
});
