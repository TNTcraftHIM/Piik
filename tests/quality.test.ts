import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyCaptureProfile,
  captureDisplay,
  configureTwoLayerVideoSender,
  configureVideoSender,
  QUALITY_PROFILES,
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
      audio: true,
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

  it("defaults every recommended profile to clarity-first degradation", () => {
    expect(
      Object.values(QUALITY_PROFILES).every(
        (profile) =>
          profile.degradationPreference === "maintain-resolution",
      ),
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
        degradationPreference: "maintain-resolution",
        scalabilityMode: null,
      },
      applied: {
        maxBitrate: 8_000_000,
        maxFramerate: 60,
        scaleResolutionDownBy: 4 / 3,
        degradationPreference: "maintain-resolution",
        scalabilityMode: null,
      },
      mismatches: [],
    });
    expect(senderParameterWarning(readback)).toBeNull();
    expect(setParameters).toHaveBeenCalledOnce();
  });

  it("reports fields the browser does not retain", async () => {
    const before = { encodings: [{}] } as RTCRtpSendParameters;
    const after = {
      encodings: [{ maxBitrate: 8_000_000 }],
      degradationPreference: "balanced",
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
      degradationPreference: "maintain-resolution",
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
      degradationPreference: "maintain-resolution",
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
      degradationPreference: "maintain-resolution",
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
