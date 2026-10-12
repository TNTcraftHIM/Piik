import { describe, expect, it } from "vitest";
import { checkCalibration, checkContinuity, checkFaultHit, hasPicture, selectScenarios } from "../scripts/network-lab/scenarios";
import { checkMediaFeedback, packetFlows, type PacketFlow } from "../scripts/network-lab/packets";
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

  it("requires the actual blackhole rule to see traffic", () => {
    for (const fault of ["peer-block", "udp-block", "stun-primary", "signaling"] as const) {
      expect(() => checkFaultHit(fault, 0)).toThrow();
      expect(() => checkFaultHit(fault, 3)).not.toThrow();
    }
  });

  it("rejects frozen/silent media and counter resets on replacement peers", () => {
    const before = { frames: 50, stats: [{ id: "audio", peerId: 0, type: "inbound-rtp", kind: "audio",
      totalAudioEnergy: 1, totalSamplesDuration: 2 }] } as unknown as MediaSample;
    expect(() => checkContinuity(before, { ...before, frames: 100 })).toThrow();
    const after = { ...before, frames: 100, stats: [{ ...before.stats[0]!, totalAudioEnergy: 2, totalSamplesDuration: 5 }] };
    expect(() => checkContinuity(before, after)).not.toThrow();
    expect(() => checkContinuity(before, { ...after, stats: [{ ...after.stats[0]!, peerId: 1 }] })).toThrow();
    expect(() => checkContinuity(before, { ...after, frames: 50 })).toThrow();
  });

  it("requires feedback on the same WAN transport, not a healthy loopback or sibling", () => {
    const media: PacketFlow = { source: "198.51.100.11", destination: "198.51.100.12", sourcePort: 5000,
      destinationPort: 6000, kind: "rtp", packets: 50, bytes: 50_000, firstMs: 1, lastMs: 5000 };
    const feedback: PacketFlow = { ...media, source: media.destination, destination: media.source, sourcePort: 6000,
      destinationPort: 5000, kind: "rtcp", packets: 10 };
    expect(() => checkMediaFeedback([media], media.source, media.destination)).toThrow();
    expect(() => checkMediaFeedback([media, { ...feedback, source: "127.0.0.1" }], media.source, media.destination)).toThrow();
    expect(() => checkMediaFeedback([media, { ...feedback, destinationPort: 5001 }], media.source, media.destination)).toThrow();
    expect(() => checkMediaFeedback([media, feedback], media.source, media.destination)).not.toThrow();
  });

  it("reads clear RTP/RTCP headers from a bounded capture and rejects truncation", () => {
    const header = Buffer.alloc(24); header.writeUInt32LE(0xa1b2c3d4, 0); header.writeUInt16LE(2, 4);
    header.writeUInt16LE(4, 6); header.writeUInt32LE(96, 16); header.writeUInt32LE(1, 20);
    const frame = Buffer.from("00000000000000000000000008004500002c0000000040110000c633640bc633640c138817700018000080600001000000010000000100000000", "hex");
    const record = Buffer.alloc(16); record.writeUInt32LE(1, 0); record.writeUInt32LE(frame.length, 8); record.writeUInt32LE(frame.length, 12);
    const capture = Buffer.concat([header, record, frame]);
    expect(packetFlows(capture)[0]).toMatchObject({ source: "198.51.100.11", destination: "198.51.100.12", sourcePort: 5000, destinationPort: 6000, kind: "rtp" });
    capture[24 + 16 + 43] = 201;
    expect(packetFlows(capture)[0]?.kind).toBe("rtcp");
    expect(() => packetFlows(capture.subarray(0, -1))).toThrow();
  });
});
