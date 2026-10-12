import type { Fault, NatMode } from "./network";
import type { MediaSample } from "./page";
import type { ProbeResult } from "./udp";

export interface Scenario {
  id: string;
  host: "browser" | "app";
  viewer: "browser" | "app";
  nat: NatMode;
  fault: Fault;
  sfu: boolean;
  expected: "media" | "unavailable";
  duringShare?: boolean;
}

const baseline = { nat: "preserve", fault: "none", sfu: false, expected: "media" } as const;
export const scenarios: readonly Scenario[] = [
  { ...baseline, id: "browser-browser", host: "browser", viewer: "browser" },
  { ...baseline, id: "app-browser", host: "app", viewer: "browser" },
  { ...baseline, id: "browser-app", host: "browser", viewer: "app" },
  { ...baseline, id: "app-app", host: "app", viewer: "app" },
  { ...baseline, id: "delayed-browser", host: "browser", viewer: "browser", fault: "delay" },
  { ...baseline, id: "lossy-browser", host: "browser", viewer: "browser", fault: "loss" },
  { ...baseline, id: "stun-backup", host: "browser", viewer: "browser", fault: "stun-primary" },
  { ...baseline, id: "sfu-fallback", host: "browser", viewer: "browser", fault: "peer-block", sfu: true },
  { ...baseline, id: "blocked-media", host: "browser", viewer: "browser", fault: "udp-block", expected: "unavailable" },
  { ...baseline, id: "bandwidth-recovery", host: "browser", viewer: "browser", fault: "rate", duringShare: true },
  { ...baseline, id: "media-outage", host: "app", viewer: "app", fault: "udp-block", duringShare: true },
  { ...baseline, id: "signaling-outage", host: "browser", viewer: "browser", fault: "signaling", duringShare: true },
];

export function selectScenarios(suite: string, names?: string): Scenario[] {
  if (!["smoke", "full"].includes(suite)) throw new Error("Suite must be smoke or full");
  if (!names) return suite === "full" ? [...scenarios] : scenarios.slice(0, 4);
  const requested = names.split(",");
  if (new Set(requested).size !== requested.length) throw new Error("Duplicate case name");
  return requested.map(id => {
    const scenario = scenarios.find(value => value.id === id);
    if (!scenario) throw new Error(`Unknown case: ${id}`);
    return scenario;
  });
}

export function hasPicture(sample: MediaSample): boolean {
  return sample.width > 0 && sample.height > 0 && sample.frames >= 15 &&
    sample.stats.some(row => row.type === "inbound-rtp" && row.kind === "video" && Number(row.framesDecoded) >= 15);
}

export function checkFaultHit(fault: Fault, faultDrops: number): void {
  if (["peer-block", "udp-block", "stun-primary", "signaling"].includes(fault) && faultDrops < 1) {
    throw new Error(`No packets hit the ${fault} rule; outcome cannot validate this fault`);
  }
}

export function checkContinuity(before: MediaSample, after: MediaSample): void {
  if (after.frames - before.frames < 30) throw new Error("Decoded video did not continue");
  if (before.pictureHash === null || after.pictureHash === null || before.pictureHash === after.pictureHash) {
    throw new Error("Rendered synthetic picture did not change");
  }
  const audible = after.stats.some(row => {
    if (row.type !== "inbound-rtp" || row.kind !== "audio") return false;
    const previous = before.stats.find(other => other.id === row.id && other.peerId === row.peerId);
    return previous && Number(row.totalAudioEnergy) > Number(previous.totalAudioEnergy) &&
      Number(row.totalSamplesDuration) > Number(previous.totalSamplesDuration);
  });
  if (!audible) throw new Error("Decoded audio energy and sample duration did not advance");
}

export function checkCalibration(before: ProbeResult, after: ProbeResult, fault: Fault): void {
  if (before.received !== before.sent || before.mappings.length !== 3 ||
      before.mappings.some(mapping => !mapping.address.startsWith("198.51.100."))) {
    throw new Error("Baseline probe did not traverse the expected NAT and all three destinations");
  }
  if (fault === "udp-block") {
    if (after.received !== 0) throw new Error("Blocked UDP still reached the probe");
  } else if (fault === "delay") {
    if (after.received === 0 || Math.min(...after.rttMs) < 65) throw new Error("Configured delay was not observed");
  } else if (fault === "loss") {
    if (after.received === 0 || after.received >= after.sent) throw new Error("Configured loss was not observed");
  } else if (fault === "rate") {
    if (after.receivedBytes === 0 || after.receivedBytes * 8000 / after.durationMs > 900_000) {
      throw new Error("Configured rate ceiling was not observed");
    }
  } else if (after.received !== after.sent) throw new Error("Control path unexpectedly lost calibration packets");
}
