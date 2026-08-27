import { describe, expect, it } from "vitest";

import {
  SfuQualityProbe,
  sfuCandidateDoesNotRegress,
} from "../src/client/media/sfu-quality-probe.ts";
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
  });

  it("requires three consecutive windows and resets after a regression", () => {
    const probe = new SfuQualityProbe();
    expect(probe.observe(metrics(1_000), metrics(1_100))).toBe(false);
    expect(probe.observe(metrics(3_000), metrics(3_100))).toBe(false);
    expect(
      probe.observe(metrics(5_000), metrics(5_100, { framesPerSecond: 30 })),
    ).toBe(false);
    expect(probe.observe(metrics(7_000), metrics(7_100))).toBe(false);
    expect(probe.observe(metrics(9_000), metrics(9_100))).toBe(false);
    expect(probe.observe(metrics(11_000), metrics(11_100))).toBe(true);
  });

  it("resets when either side lacks a new comparable window", () => {
    const probe = new SfuQualityProbe();
    expect(probe.observe(metrics(1_000), metrics(1_100))).toBe(false);
    expect(probe.observe(metrics(3_000), metrics(3_100))).toBe(false);
    expect(probe.observe(metrics(3_000), metrics(5_100))).toBe(false);
    expect(probe.observe(metrics(7_000), metrics(7_100))).toBe(false);
    expect(probe.observe(metrics(9_000), metrics(9_100))).toBe(false);
    expect(probe.observe(metrics(11_000), metrics(11_100))).toBe(true);

    probe.reset();
    expect(probe.observe(metrics(13_000), metrics(13_100))).toBe(false);
    expect(
      probe.observe(
        metrics(15_000),
        metrics(15_100, { intervalFreezeDurationMs: null }),
      ),
    ).toBe(false);
    expect(probe.observe(metrics(17_000), metrics(17_100))).toBe(false);
  });
});
