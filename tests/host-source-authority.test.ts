import { describe, expect, it, vi } from "vitest";

import { applyAuthoritativeHostPause } from "../src/client/media/host-source-authority.ts";

function createStream() {
  const videoTrack = { enabled: true } as MediaStreamTrack;
  const audioTrack = { enabled: true } as MediaStreamTrack;
  const stream = {
    getTracks: () => [videoTrack, audioTrack],
    getVideoTracks: () => [videoTrack],
  } as unknown as MediaStream;
  return { stream, videoTrack, audioTrack };
}

describe("Host source authority", () => {
  it("repause disables the current share after reconnect cleared local codec state", () => {
    const { stream, videoTrack, audioTrack } = createStream();
    const pauseSfuRoute = vi.fn();
    let hostPaused = false;

    const result = applyAuthoritativeHostPause({
      message: {
        type: "pause-sharing-source",
        shareGeneration: "share_generation_12345678",
        codecGeneration: 7,
        resumeAttempt: null,
      },
      currentShareGeneration: "share_generation_12345678",
      activeResumeAttempt: null,
      activeCodecGeneration: null,
      stream,
      pauseSfuRoute,
      markHostPaused: () => {
        hostPaused = true;
      },
    });

    expect(result).toEqual({ localCodecContextMatches: false });
    expect(videoTrack.enabled).toBe(false);
    expect(audioTrack.enabled).toBe(false);
    expect(pauseSfuRoute).toHaveBeenCalledOnce();
    expect(hostPaused).toBe(true);
  });

  it("rejects a stale share before touching its source or route", () => {
    const { stream, videoTrack, audioTrack } = createStream();
    const pauseSfuRoute = vi.fn();
    const markHostPaused = vi.fn();

    const result = applyAuthoritativeHostPause({
      message: {
        type: "pause-sharing-source",
        shareGeneration: "stale_share_generation_12345678",
        codecGeneration: 7,
        resumeAttempt: 3,
      },
      currentShareGeneration: "current_share_generation_12345678",
      activeResumeAttempt: 3,
      activeCodecGeneration: 7,
      stream,
      pauseSfuRoute,
      markHostPaused,
    });

    expect(result).toBeNull();
    expect(videoTrack.enabled).toBe(true);
    expect(audioTrack.enabled).toBe(true);
    expect(pauseSfuRoute).not.toHaveBeenCalled();
    expect(markHostPaused).not.toHaveBeenCalled();
  });
});
