import { describe, expect, it } from "vitest";

import {
  h264ProbeSustainsSource,
  type H264ProbeSample,
} from "../src/client/webrtc/video-codec-preflight.ts";

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
  it("accepts bounded pipeline lag against the same source", () => {
    const baseline = sample();
    const current = sample({
      timestamp: 2_000,
      framesEncoded: 39,
      sourceFrames: 40,
    });

    expect(h264ProbeSustainsSource(baseline, current)).toBe(true);
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

    expect(h264ProbeSustainsSource(baseline, current)).toBe(false);
  });

  it("waits for enough source progress before deciding", () => {
    const baseline = sample();
    const current = sample({
      timestamp: 1_400,
      framesEncoded: 20,
      sourceFrames: 20,
    });

    expect(h264ProbeSustainsSource(baseline, current)).toBeNull();
  });

  it("rejects CPU-limited or identity-mismatched samples", () => {
    const baseline = sample();

    expect(
      h264ProbeSustainsSource(
        baseline,
        sample({
          timestamp: 2_000,
          framesEncoded: 40,
          sourceFrames: 40,
          qualityLimitationReason: "cpu",
        }),
      ),
    ).toBe(false);
    expect(
      h264ProbeSustainsSource(
        baseline,
        sample({
          outboundId: "replacement",
          timestamp: 2_000,
          framesEncoded: 40,
          sourceFrames: 40,
        }),
      ),
    ).toBe(false);
  });

  it("uses reported cadence when cumulative source frames are unavailable", () => {
    const baseline = sample({ framesEncoded: null, sourceFrames: null });

    expect(
      h264ProbeSustainsSource(
        baseline,
        sample({
          timestamp: 2_000,
          framesEncoded: null,
          sourceFrames: null,
          encodedFramesPerSecond: 29,
          sourceFramesPerSecond: 30,
        }),
      ),
    ).toBe(true);
    expect(
      h264ProbeSustainsSource(
        baseline,
        sample({
          timestamp: 2_000,
          framesEncoded: null,
          sourceFrames: null,
          encodedFramesPerSecond: 12,
          sourceFramesPerSecond: 30,
        }),
      ),
    ).toBe(false);
    expect(
      h264ProbeSustainsSource(
        baseline,
        sample({
          timestamp: 1_500,
          framesEncoded: null,
          sourceFrames: null,
          encodedFramesPerSecond: 30,
          sourceFramesPerSecond: 30,
        }),
      ),
    ).toBeNull();
  });
});
