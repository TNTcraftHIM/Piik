import { afterEach, describe, expect, it, vi } from "vitest";

import {
  audioSenderParameterWarning,
  applyCaptureProfile,
  captureDisplay,
  configureScreenAudioSender,
  configureTwoLayerVideoSender,
  configureVideoSender,
  matchingQualityProfileId,
  QUALITY_PROFILES,
  QUALITY_RESOLUTIONS,
  qualitySettingsEqual,
  SCREEN_AUDIO_BITRATES,
  screenShareLowBitrate,
  senderParameterWarning,
  setMediaPaused,
} from "../src/client/media/quality.ts";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("realtime quality controls", () => {
  it("keeps exactly three recommended profiles with 1080p30 as the default", () => {
    expect(Object.keys(QUALITY_PROFILES)).toEqual([
      "1080p60",
      "1080p30",
      "720p30",
    ]);
    expect(QUALITY_PROFILES["1080p30"]).toMatchObject({
      resolution: "1080p",
      maxFramerate: 30,
      maxBitrate: 5_000_000,
      videoCodec: "vp8",
    });
    expect(
      Object.values(QUALITY_PROFILES).every(
        (profile) => profile.videoCodec === "vp8",
      ),
    ).toBe(true);
  });

  it("offers 854x480 only through advanced resolution settings", () => {
    expect(QUALITY_RESOLUTIONS["480p"]).toEqual({
      width: 854,
      height: 480,
      label: "480p",
    });
    expect(
      Object.values(QUALITY_PROFILES).map((profile) => profile.resolution),
    ).not.toContain("480p");
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
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: 30, max: 30 },
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        voiceIsolation: false,
        channelCount: { ideal: 2 },
      },
      systemAudio: "include",
      windowAudio: "window",
    });
    expect(videoTrack.contentHint).toBe("motion");
    expect(audioTrack.contentHint).toBe("music");
  });

  it("changes custom capture ceilings without selecting the source again", async () => {
    const { stream, videoTrack } = createVideoStream();

    await applyCaptureProfile(stream, {
      resolution: "1440p",
      maxFramerate: 45,
      maxBitrate: 9_500_000,
      degradationPreference: "balanced",
    });

    expect(videoTrack.applyConstraints).toHaveBeenCalledWith({
      width: { ideal: 2560, max: 2560 },
      height: { ideal: 1440, max: 1440 },
      frameRate: { ideal: 45, max: 45 },
    });
  });

  it("defaults every recommended profile to balanced degradation", () => {
    expect(
      Object.values(QUALITY_PROFILES).every(
        (profile) =>
          profile.degradationPreference === "balanced",
      ),
    ).toBe(true);
  });

  it("keeps codec selection orthogonal to the recommended quality profile", () => {
    const h264 = { ...QUALITY_PROFILES["1080p60"], videoCodec: "h264" } as const;
    expect(matchingQualityProfileId(h264)).toBe("1080p60");
    expect(qualitySettingsEqual(h264, QUALITY_PROFILES["1080p60"])).toBe(false);
  });

  it("keeps audio selection orthogonal while defaulting old settings to music", () => {
    const saver = {
      ...QUALITY_PROFILES["1080p60"],
      screenAudioQuality: "saver",
    } as const;
    const {
      screenAudioQuality: _screenAudioQuality,
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

  it.each([
    ["saver", 64_000],
    ["music", 128_000],
    ["very-high", 256_000],
  ] as const)("applies and reads back the %s audio ceiling", async (quality, bitrate) => {
    let applied = { encodings: [] } as unknown as RTCRtpSendParameters;
    const sender = {
      getParameters: () => applied,
      setParameters: vi.fn(async (parameters: RTCRtpSendParameters) => {
        applied = parameters;
      }),
    } as unknown as RTCRtpSender;

    await expect(configureScreenAudioSender(sender, quality)).resolves.toEqual({
      requestedMaxBitrate: bitrate,
      appliedMaxBitrate: bitrate,
      mismatch: false,
    });
    expect(applied.encodings).toEqual([{ maxBitrate: bitrate }]);
    expect(SCREEN_AUDIO_BITRATES[quality]).toBe(bitrate);
  });

  it("uses the music ceiling for a legacy setting without an audio preset", async () => {
    let applied = { encodings: [] } as unknown as RTCRtpSendParameters;
    const sender = {
      getParameters: () => applied,
      setParameters: vi.fn(async (parameters: RTCRtpSendParameters) => {
        applied = parameters;
      }),
    } as unknown as RTCRtpSender;

    await expect(configureScreenAudioSender(sender)).resolves.toEqual({
      requestedMaxBitrate: 128_000,
      appliedMaxBitrate: 128_000,
      mismatch: false,
    });
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

    const readback = await configureScreenAudioSender(sender, "music");

    expect(readback).toEqual({
      requestedMaxBitrate: 128_000,
      appliedMaxBitrate: 96_000,
      mismatch: true,
    });
    expect(audioSenderParameterWarning(readback)).toBe(
      "浏览器将音频码率上限改写为 96 kbps",
    );
  });

  it("does not mutate prior audio parameters when setParameters fails", async () => {
    const applied = {
      encodings: [{ maxBitrate: 64_000 }],
    } as RTCRtpSendParameters;
    const sender = {
      getParameters: () => applied,
      setParameters: vi.fn(async () => {
        throw new Error("rejected");
      }),
    } as unknown as RTCRtpSender;

    await expect(
      configureScreenAudioSender(sender, "very-high"),
    ).rejects.toThrow("rejected");
    expect(applied.encodings[0]?.maxBitrate).toBe(64_000);
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
    expect(senderParameterWarning(readback)).toContain("帧率上限");
    expect(senderParameterWarning(readback)).toContain("分辨率缩放");
    expect(senderParameterWarning(readback)).toContain("质量优先级");
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

  it("configures ordered LOW and HIGH simulcast encodings without flattening LOW", async () => {
    let applied = {
      encodings: [{ rid: "q" }, { rid: "h" }],
    } as RTCRtpSendParameters;
    const sender = {
      track: {
        getSettings: () => ({ width: 2560, height: 1440 }),
      },
      getParameters: () => applied,
      setParameters: vi.fn(async (parameters: RTCRtpSendParameters) => {
        applied = parameters;
      }),
    } as unknown as RTCRtpSender;

    const readbacks = await configureTwoLayerVideoSender(
      sender,
      QUALITY_PROFILES["1080p60"],
    );

    expect(applied).toMatchObject({
      degradationPreference: "balanced",
      encodings: [
        {
          rid: "q",
          maxBitrate: 2_000_000,
          maxFramerate: 60,
          scaleResolutionDownBy: 8 / 3,
        },
        {
          rid: "h",
          maxBitrate: 8_000_000,
          maxFramerate: 60,
          scaleResolutionDownBy: 4 / 3,
        },
      ],
    });
    expect(readbacks.low.requested.maxBitrate).toBe(2_000_000);
    expect(readbacks.high.requested.maxBitrate).toBe(8_000_000);
    expect(readbacks.low.mismatches).toEqual([]);
    expect(readbacks.high.mismatches).toEqual([]);
  });

  it("keeps the standard LOW bitrate floor for small custom HIGH ceilings", () => {
    expect(
      screenShareLowBitrate({
        resolution: "720p",
        maxFramerate: 30,
        maxBitrate: 400_000,
        degradationPreference: "balanced",
      }),
    ).toBe(150_000);
  });

  it.each([
    {
      label: "drops HIGH",
      after: { encodings: [{ rid: "q" }] },
      message: "exactly two video encodings",
    },
    {
      label: "reorders the RIDs",
      after: { encodings: [{ rid: "h" }, { rid: "q" }] },
      message: "ordered q and h video encodings",
    },
    {
      label: "adds a third RID",
      after: { encodings: [{ rid: "q" }, { rid: "h" }, { rid: "f" }] },
      message: "exactly two video encodings",
    },
  ])("fails closed when sender readback $label", async ({ after, message }) => {
    const before = {
      encodings: [{ rid: "q" }, { rid: "h" }],
    } as RTCRtpSendParameters;
    const sender = {
      track: { getSettings: () => ({ width: 1920, height: 1080 }) },
      getParameters: vi
        .fn<() => RTCRtpSendParameters>()
        .mockReturnValueOnce(before)
        .mockReturnValue(after as RTCRtpSendParameters),
      setParameters: vi.fn(async () => undefined),
    } as unknown as RTCRtpSender;

    await expect(
      configureTwoLayerVideoSender(sender, QUALITY_PROFILES["1080p60"]),
    ).rejects.toThrow(message);
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
