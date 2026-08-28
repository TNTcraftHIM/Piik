import { describe, expect, it } from "vitest";

import {
  P2pQualityProbe,
  SfuQualityProbe,
  p2pCandidateStrictlyImproves,
  sfuCandidateDoesNotRegress,
} from "../src/client/media/candidate-quality-probe.ts";
import {
  EMPTY_METRICS,
  type ConnectionMetrics,
} from "../src/client/types.ts";

function metrics(
  timestampMs: number,
  overrides: Partial<ConnectionMetrics> = {},
): ConnectionMetrics {
  return {
    ...EMPTY_METRICS,
    sampleTimestampMs: timestampMs,
    sampleWindowMs: 2_000,
    frameWidth: 1920,
    frameHeight: 1080,
    framesPerSecond: 60,
    bitrateKbps: 5_000,
    intervalFramesDecoded: 120,
    intervalFreezeCount: 0,
    intervalFreezeDurationMs: 0,
    intervalPauseCount: 0,
    intervalPauseDurationMs: 0,
    ...overrides,
  };
}

describe("SFU quality probe", () => {
  it("accepts only complete same-Viewer non-regressing windows", () => {
    const current = metrics(2_000);
    expect(sfuCandidateDoesNotRegress(current, metrics(2_100))).toBe(true);
    expect(
      sfuCandidateDoesNotRegress(
        current,
        metrics(2_100, { bitrateKbps: 4_999 }),
      ),
    ).toBe(false);
    expect(
      sfuCandidateDoesNotRegress(
        current,
        metrics(2_100, { frameHeight: 720 }),
      ),
    ).toBe(false);
    expect(
      sfuCandidateDoesNotRegress(
        current,
        metrics(2_100, { intervalFreezeCount: 1 }),
      ),
    ).toBe(false);
    expect(
      sfuCandidateDoesNotRegress(
        current,
        metrics(8_000),
      ),
    ).toBeNull();
    expect(
      sfuCandidateDoesNotRegress(
        current,
        metrics(2_100, { bitrateKbps: null }),
      ),
    ).toBeNull();
  });

  it("requires a strict P2P receive improvement without a tradeoff", () => {
    const current = metrics(2_000, {
      frameWidth: 320,
      frameHeight: 180,
      framesPerSecond: 10,
      bitrateKbps: 200,
    });
    expect(
      p2pCandidateStrictlyImproves(
        current,
        metrics(2_100, {
          frameWidth: 1_280,
          frameHeight: 720,
          framesPerSecond: 30,
          bitrateKbps: 150,
        }),
      ),
    ).toBe(true);
    expect(
      p2pCandidateStrictlyImproves(
        { ...current, bitrateKbps: null },
        metrics(2_100, {
          frameWidth: 1_280,
          frameHeight: 720,
          framesPerSecond: 30,
          bitrateKbps: null,
        }),
      ),
    ).toBe(true);
    expect(p2pCandidateStrictlyImproves(current, { ...current })).toBe(false);
    expect(
      p2pCandidateStrictlyImproves(
        current,
        metrics(2_100, {
          frameWidth: 1_280,
          frameHeight: 720,
          framesPerSecond: 5,
        }),
      ),
    ).toBe(false);
    expect(
      p2pCandidateStrictlyImproves(
        current,
        metrics(2_100, { intervalFreezeCount: 1 }),
      ),
    ).toBe(false);
  });

  it("requires three consecutive strict P2P improvements", () => {
    const probe = new P2pQualityProbe();
    const current = (timestampMs: number) =>
      metrics(timestampMs, {
        frameWidth: 320,
        frameHeight: 180,
        framesPerSecond: 10,
      });
    const candidate = (timestampMs: number) =>
      metrics(timestampMs, {
        frameWidth: 1_280,
        frameHeight: 720,
        framesPerSecond: 30,
      });
    expect(probe.observe(current(1_000), candidate(1_100))).toBe("pending");
    expect(probe.observe(current(3_000), candidate(3_100))).toBe("pending");
    expect(probe.observe(current(5_000), candidate(5_100))).toBe("approved");
    probe.reset();
    expect(probe.observe(current(7_000), candidate(7_100))).toBe("pending");
  });

  it("rejects after three comparable non-improving P2P windows", () => {
    const probe = new P2pQualityProbe();
    expect(probe.observe(metrics(1_000), metrics(1_100))).toBe("pending");
    expect(probe.observe(metrics(3_000), metrics(3_100))).toBe("pending");
    expect(probe.observe(metrics(5_000), metrics(5_100))).toBe("rejected");
  });

  it("keeps unknown evidence pending instead of counting it as rejection", () => {
    const probe = new P2pQualityProbe();
    expect(probe.observe(metrics(1_000), metrics(1_100))).toBe("pending");
    expect(probe.observe(metrics(3_000), metrics(3_100))).toBe("pending");
    expect(
      probe.observe(
        metrics(5_000),
        metrics(5_100, { intervalFreezeCount: null }),
      ),
    ).toBe("pending");
    expect(probe.observe(metrics(7_000), metrics(7_100))).toBe("pending");
  });

  it("requires three consecutive windows and resets after a regression", () => {
    const probe = new SfuQualityProbe();
    expect(probe.observe(metrics(1_000), metrics(1_100))).toBe("pending");
    expect(probe.observe(metrics(3_000), metrics(3_100))).toBe("pending");
    expect(
      probe.observe(metrics(5_000), metrics(5_100, { framesPerSecond: 30 })),
    ).toBe("pending");
    expect(probe.observe(metrics(7_000), metrics(7_100))).toBe("pending");
    expect(probe.observe(metrics(9_000), metrics(9_100))).toBe("pending");
    expect(probe.observe(metrics(11_000), metrics(11_100))).toBe("approved");
  });

  it("resets when either side lacks a new comparable window", () => {
    const probe = new SfuQualityProbe();
    expect(probe.observe(metrics(1_000), metrics(1_100))).toBe("pending");
    expect(probe.observe(metrics(3_000), metrics(3_100))).toBe("pending");
    expect(probe.observe(metrics(3_000), metrics(5_100))).toBe("pending");
    expect(probe.observe(metrics(7_000), metrics(7_100))).toBe("pending");
    expect(probe.observe(metrics(9_000), metrics(9_100))).toBe("pending");
    expect(probe.observe(metrics(11_000), metrics(11_100))).toBe("approved");

    probe.reset();
    expect(probe.observe(metrics(13_000), metrics(13_100))).toBe("pending");
    expect(
      probe.observe(
        metrics(15_000),
        metrics(15_100, { intervalFreezeDurationMs: null }),
      ),
    ).toBe("pending");
    expect(probe.observe(metrics(17_000), metrics(17_100))).toBe("pending");
  });
});
