import { describe, expect, it } from "vitest";
import { checkAppPath, checkCalibration, checkContinuity, checkFaultHit, checkMapping, checkQualityRecovery, hasPicture, selectScenarios, summarizeTrials } from "../scripts/network-lab/scenarios";
import { checkMediaFeedback, checkMediaPath, packetFlows, type PacketFlow } from "../scripts/network-lab/packets";
import type { MediaSample } from "../scripts/network-lab/page";
import type { ProbeResult } from "../scripts/network-lab/udp";

const baseline: ProbeResult = { sent: 12, received: 12, receivedBytes: 14400, durationMs: 850, sendDurationMs: 250,
  rttMs: [1, 2, 1], mappings: ["198.51.100.1:41001", "198.51.100.1:41002", "198.51.100.2:41001"].map(destination =>
    ({ destination, address: "198.51.100.11", port: 45678 })) };

describe("network laboratory evidence", () => {
  it("keeps failed trials in counts without treating missing latency as zero", () => {
    const scenario = selectScenarios("smoke")[0]!;
    const trial = { scenario, prediction: true, seed: 1, passed: true, outcome: "media" as const };
    const summary = summarizeTrials([
      { ...trial, firstPictureMs: 200 }, { ...trial, firstPictureMs: 400 },
      { ...trial, passed: false, outcome: "timeout", firstPictureMs: null },
      { ...trial, prediction: false, passed: false, outcome: "unavailable" },
    ]);
    expect(summary[0]).toMatchObject({ trials: 3, checksPassed: 2, failures: 1, timeouts: 1,
      firstPictureMs: { count: 2, min: 200, median: 200, p95: 400, max: 400 }, recoveryMs: { count: 0, median: null } });
    expect(summary[1]).toMatchObject({ trials: 1, checksPassed: 0, failures: 1, unavailable: 1, firstPictureMs: { count: 0, min: null } });
  });
  it("rejects absent impairments rather than blessing an unaffected media path", () => {
    for (const fault of ["udp-block", "ipv4-block", "delay", "loss", "rate"] as const) {
      expect(() => checkCalibration(baseline, { ...baseline, durationMs: 20 }, fault)).toThrow();
    }
    expect(() => checkCalibration(baseline, { ...baseline, received: 0, receivedBytes: 0, rttMs: [] }, "udp-block")).not.toThrow();
    expect(() => checkCalibration(baseline, { ...baseline, received: 0, receivedBytes: 0, rttMs: [] }, "ipv4-block")).not.toThrow();
    expect(() => checkCalibration(baseline, { ...baseline, rttMs: [100, 95, 120] }, "delay")).not.toThrow();
  });

  it("rejects a bypassed NAT or broken baseline", () => {
    expect(() => checkCalibration({ ...baseline, mappings: [] }, baseline, "none")).toThrow();
    expect(() => checkCalibration({ ...baseline, received: 11 }, baseline, "none")).toThrow();
    expect(() => checkCalibration({ ...baseline, mappings: baseline.mappings.map(value => ({ ...value, address: "10.71.1.2" })) }, baseline, "none")).toThrow();
  });

  it("does not mistake a slow calibration sender for network shaping", () => {
    const slow = { ...baseline, sent: 1000, received: 1000, receivedBytes: 1_200_000, sendDurationMs: 10_000, durationMs: 11_000 };
    expect(() => checkCalibration(baseline, slow, "rate")).toThrow("sender");
    expect(() => checkCalibration(baseline, { ...slow, received: 120, receivedBytes: 144_000, sendDurationMs: 1000, durationMs: 2000 }, "rate")).not.toThrow();
  });

  it("requires a current Native receiver and the actual playback bridge", () => {
    const sample = { controlOpen: true, playbackPeerId: 0,
      controls: [{ type: "receive-offer", connectionId: "current" }],
      events: [{ scope: "app", type: "edge-state", connectionId: "current", state: "connected" }],
      stats: [{ type: "selected-pair", peerId: 0, remoteAddress: "127.0.0.1" }],
    } as unknown as MediaSample;
    expect(() => checkAppPath(sample, "receive-offer", ["10.71.2.2"])).not.toThrow();
    expect(() => checkAppPath({ ...sample, events: [...sample.events, { ...sample.events[0]!, state: "failed" }] }, "receive-offer", ["10.71.2.2"])).toThrow();
    expect(() => checkAppPath({ ...sample, controls: [...sample.controls, { type: "close-receiver", connectionId: "current" }] }, "receive-offer", ["10.71.2.2"])).toThrow();
    expect(() => checkAppPath({ ...sample, playbackPeerId: 1 }, "receive-offer", ["10.71.2.2"])).toThrow();
    expect(() => checkAppPath({ ...sample, stats: [{ ...sample.stats[0]!, remoteAddress: "198.51.100.11" }] }, "receive-offer", ["10.71.2.2"])).toThrow();
  });

  it("checks mapping observations rather than trusting a NAT configuration name", () => {
    expect(() => checkMapping(baseline, "preserve")).not.toThrow();
    expect(() => checkMapping(baseline, "random")).toThrow();
    const random = { ...baseline, mappings: baseline.mappings.map((value, index) => ({ ...value, port: value.port + index })) };
    expect(() => checkMapping(random, "random")).not.toThrow();
    expect(() => checkMapping(random, "preserve")).toThrow();
    const sequential = { ...baseline, mappings: baseline.mappings.map((value, index) => ({ ...value, port: 40000 + index })) };
    expect(() => checkMapping(sequential, "sequential")).not.toThrow();
    expect(() => checkMapping(baseline, "sequential")).toThrow();
    expect(() => checkMapping({ ...sequential, mappings: sequential.mappings.map((value, index) => ({ ...value, port: value.port + index })) }, "sequential")).toThrow();
    expect(() => checkMapping({ ...random, mappings: random.mappings.map((value, index) => ({ ...value, port: 1024 + index })) }, "sequential")).toThrow();
  });

  it("does not confuse a connected transport or stale video dimensions with decoded media", () => {
    const sample = { width: 1280, height: 720, frames: 30, playbackPeerId: 0, stats: [] } as unknown as MediaSample;
    expect(hasPicture(sample)).toBe(false);
    expect(hasPicture({ ...sample, stats: [{ type: "inbound-rtp", kind: "video", peerId: 0, framesDecoded: 30 }] })).toBe(true);
    expect(hasPicture({ ...sample, stats: [{ type: "inbound-rtp", kind: "audio", peerId: 0, framesDecoded: 30 }] })).toBe(false);
    expect(hasPicture({ ...sample, stats: [{ type: "inbound-rtp", kind: "video", peerId: 1, framesDecoded: 30 }] })).toBe(false);
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
    for (const fault of ["peer-block", "udp-block", "ipv4-block", "stun-primary", "signaling"] as const) {
      expect(() => checkFaultHit(fault, 0)).toThrow();
      expect(() => checkFaultHit(fault, 3)).not.toThrow();
    }
  });

  it("rejects frozen/silent media and counter resets on replacement peers", () => {
    const before = { frames: 50, pictureHash: 100, playbackPeerId: 0, stats: [{ id: "audio", peerId: 0, type: "inbound-rtp", kind: "audio",
      totalAudioEnergy: 1, totalSamplesDuration: 2 }] } as unknown as MediaSample;
    expect(() => checkContinuity(before, { ...before, frames: 100 })).toThrow();
    const after = { ...before, frames: 100, pictureHash: 200, stats: [{ ...before.stats[0]!, totalAudioEnergy: 2, totalSamplesDuration: 5 }] };
    expect(() => checkContinuity(before, after)).not.toThrow();
    expect(() => checkContinuity(before, { ...after, frames: 51 })).not.toThrow();
    expect(() => checkContinuity(before, { ...after, stats: [{ ...after.stats[0]!, peerId: 1 }] })).toThrow();
    expect(() => checkContinuity(before, { ...after, frames: 50 })).toThrow();
    expect(() => checkContinuity(before, { ...after, pictureHash: 100 })).toThrow();
  });

  it("requires sustained source resolution on the retained path, not one good frame or a refreshed connection", () => {
    const baseline = { width: 1280, height: 720, at: 0, route: "sfu", playbackPeerId: 0 } as MediaSample;
    const samples = Array.from({ length: 12 }, (_, index) => ({ ...baseline, at: index * 1000,
      frames: 50 + index * 30, pictureHash: index, stats: [{ id: "audio", peerId: 0, type: "inbound-rtp", kind: "audio",
        totalAudioEnergy: index, totalSamplesDuration: index }] }));
    expect(() => checkQualityRecovery(baseline, samples)).not.toThrow();
    expect(() => checkQualityRecovery(baseline, samples.slice(-2))).toThrow("sustained");
    expect(() => checkQualityRecovery({ ...baseline, height: 360 }, samples)).toThrow("baseline");
    for (const change of [{ height: 360 }, { playbackPeerId: 1 }, { route: "peer" }]) {
      expect(() => checkQualityRecovery(baseline, samples.map((sample, index) => index === 5 ? { ...sample, ...change } : sample)))
        .toThrow("retained");
    }
    expect(() => checkQualityRecovery(baseline, samples.map(sample => ({ ...sample, pictureHash: 0 })))).toThrow("picture");
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
    const onward = { ...media, source: media.destination, destination: "198.51.100.13" };
    const reverse = { ...feedback, source: onward.destination, destination: onward.source };
    expect(checkMediaPath([media, feedback, onward, reverse], media.source, onward.destination, [media.destination])).toEqual([
      media.source, media.destination, onward.destination,
    ]);
    expect(() => checkMediaPath([media, feedback, onward], media.source, onward.destination, [media.destination])).toThrow();
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
    expect(packetFlows(capture, { startMs: 2000, endMs: 5000 })).toEqual([]);
    expect(packetFlows(capture, { startMs: 500, endMs: 1500 })).toHaveLength(1);
    expect(() => packetFlows(capture.subarray(0, -1))).toThrow();
  });
});
