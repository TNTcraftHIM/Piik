import { describe, expect, it } from "vitest";
import { checkCalibration, hasPicture, selectScenarios } from "../scripts/network-lab/scenarios";
import type { MediaSample } from "../scripts/network-lab/page";
import type { ProbeResult } from "../scripts/network-lab/udp";

const baseline: ProbeResult = { sent: 12, received: 12, receivedBytes: 14400, durationMs: 850,
  rttMs: [1, 2, 1], mappings: ["198.51.100.1:41001", "198.51.100.1:41002", "198.51.100.2:41001"].map(destination =>
    ({ destination, address: "198.51.100.11", port: 45678 })) };

describe("network laboratory evidence", () => {
  it("rejects absent impairments rather than blessing an unaffected media path", () => {
    for (const fault of ["udp-block", "delay", "loss", "rate"] as const) {
      expect(() => checkCalibration(baseline, { ...baseline, durationMs: 20 }, fault)).toThrow();
    }
    expect(() => checkCalibration(baseline, { ...baseline, received: 0, receivedBytes: 0, rttMs: [] }, "udp-block")).not.toThrow();
    expect(() => checkCalibration(baseline, { ...baseline, rttMs: [100, 95, 120] }, "delay")).not.toThrow();
  });

  it("rejects a bypassed NAT or broken baseline", () => {
    expect(() => checkCalibration({ ...baseline, mappings: [] }, baseline, "none")).toThrow();
    expect(() => checkCalibration({ ...baseline, received: 11 }, baseline, "none")).toThrow();
    expect(() => checkCalibration({ ...baseline, mappings: baseline.mappings.map(value => ({ ...value, address: "10.71.1.2" })) }, baseline, "none")).toThrow();
  });

  it("does not confuse a connected transport or stale video dimensions with decoded media", () => {
    const sample = { width: 1280, height: 720, frames: 30, stats: [] } as unknown as MediaSample;
    expect(hasPicture(sample)).toBe(false);
    expect(hasPicture({ ...sample, stats: [{ type: "inbound-rtp", kind: "video", framesDecoded: 30 }] })).toBe(true);
    expect(hasPicture({ ...sample, stats: [{ type: "inbound-rtp", kind: "audio", framesDecoded: 30 }] })).toBe(false);
  });

  it("rejects misspelled or duplicated scenarios and lists every transport pairing", () => {
    expect(() => selectScenarios("all")).toThrow();
    expect(() => selectScenarios("full", "browser-brower")).toThrow();
    expect(() => selectScenarios("full", "app-app,app-app")).toThrow();
    expect(selectScenarios("smoke").map(value => `${value.host}/${value.viewer}`)).toEqual([
      "browser/browser", "app/browser", "browser/app", "app/app",
    ]);
  });
});
