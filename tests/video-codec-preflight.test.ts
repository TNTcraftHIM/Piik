import { describe, expect, it } from "vitest";

import {
  h264ProbeTarget,
  h264ProbeSustainsTarget,
  type H264ProbeSample,
} from "../src/client/webrtc/video-codec-preflight.ts";
import { QUALITY_PROFILES } from "../src/client/media/quality.ts";

function sample(
  overrides: Partial<H264ProbeSample> = {},
): H264ProbeSample {
  return {
    outboundId: "outbound",
    sourceId: "source",
    timestamp: 1_000,
    codec: "video/H264",
    framesEncoded: 10,
    sourceFrames: 10,
    encodedFramesPerSecond: 30,
    sourceFramesPerSecond: 30,
    qualityLimitationReason: "none",
    ...overrides,
  };
}

describe("H264 sender preflight", () => {
  it("uses the selected target cadence instead of captured-content cadence", () => {
    expect(
      h264ProbeTarget(
        { width: 2_560, height: 1_440, frameRate: 1 },
        QUALITY_PROFILES["1080p30"],
      ),
    ).toEqual({ width: 1_920, height: 1_080, frameRate: 30 });
  });

  it("accepts bounded pipeline lag against the same source", () => {
    const baseline = sample();
    const current = sample({
      timestamp: 2_000,
      framesEncoded: 39,
      sourceFrames: 40,
    });

    expect(h264ProbeSustainsTarget(baseline, current, 30)).toBe(true);
  });

  it("rejects sustained encoder frame dropping", () => {
    const baseline = sample();
    const current = sample({
      timestamp: 2_000,
      framesEncoded: 22,
      sourceFrames: 40,
      encodedFramesPerSecond: 12,
      sourceFramesPerSecond: 30,
    });

    expect(h264ProbeSustainsTarget(baseline, current, 30)).toBe(false);
  });

  it("waits for enough source progress before deciding", () => {
    const baseline = sample();
    const current = sample({
      timestamp: 1_400,
      framesEncoded: 20,
      sourceFrames: 20,
    });

    expect(h264ProbeSustainsTarget(baseline, current, 30)).toBeNull();
  });

  it("rejects CPU-limited or identity-mismatched samples", () => {
    const baseline = sample();

    expect(
      h264ProbeSustainsTarget(
        baseline,
        sample({
          timestamp: 2_000,
          framesEncoded: 40,
          sourceFrames: 40,
          qualityLimitationReason: "cpu",
        }),
        30,
      ),
    ).toBe(false);
    expect(
      h264ProbeSustainsTarget(
        baseline,
        sample({
          outboundId: "replacement",
          timestamp: 2_000,
          framesEncoded: 40,
          sourceFrames: 40,
        }),
        30,
      ),
    ).toBe(false);
  });

  it("uses reported cadence when cumulative source frames are unavailable", () => {
    const baseline = sample({ framesEncoded: null, sourceFrames: null });

    expect(
      h264ProbeSustainsTarget(
        baseline,
        sample({
          timestamp: 2_000,
          framesEncoded: null,
          sourceFrames: null,
          encodedFramesPerSecond: 29,
          sourceFramesPerSecond: 30,
        }),
        30,
      ),
    ).toBe(true);
    expect(
      h264ProbeSustainsTarget(
        baseline,
        sample({
          timestamp: 2_000,
          framesEncoded: null,
          sourceFrames: null,
          encodedFramesPerSecond: 12,
          sourceFramesPerSecond: 30,
        }),
        30,
      ),
    ).toBe(false);
    expect(
      h264ProbeSustainsTarget(
        baseline,
        sample({
          timestamp: 1_500,
          framesEncoded: null,
          sourceFrames: null,
          encodedFramesPerSecond: 30,
          sourceFramesPerSecond: 30,
        }),
        30,
      ),
    ).toBeNull();
  });

  it("rejects a probe source that does not reach the selected cadence", () => {
    expect(
      h264ProbeSustainsTarget(
        sample(),
        sample({
          timestamp: 2_000,
          framesEncoded: 30,
          sourceFrames: 30,
          encodedFramesPerSecond: 20,
          sourceFramesPerSecond: 20,
        }),
        30,
      ),
    ).toBe(false);
  });
});
