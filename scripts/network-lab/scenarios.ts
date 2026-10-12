import type { Fault, NatMode } from "./network";
import type { MediaSample } from "./page";
import type { ProbeResult } from "./udp";

export interface Scenario {
  id: string;
  host: "browser" | "app";
  viewer: "browser" | "app";
  nat: readonly [NatMode, NatMode];
  fault: Fault;
  sfu: boolean;
  expected: "media" | "unavailable" | "observed";
  duringShare?: boolean;
  ipv6?: boolean;
  faultEndpoint?: 0 | 1;
  direction?: "uplink" | "downlink";
  sibling?: boolean;
  remap?: boolean;
}

export interface TrialSummary {
  scenario: Scenario;
  seed: number;
  prediction: boolean;
  passed: boolean;
  outcome?: "media" | "unavailable" | "timeout";
  firstPictureMs?: number | null;
  recoveryMs?: number | null;
}

export function summarizeTrials(trials: readonly TrialSummary[]) {
  const groups = new Map<string, TrialSummary[]>();
  for (const trial of trials) {
    const key = JSON.stringify([trial.scenario.id, trial.prediction]);
    const group = groups.get(key) ?? []; group.push(trial); groups.set(key, group);
  }
  const distribution = (values: number[]) => {
    values.sort((a, b) => a - b);
    return { count: values.length, min: values[0] ?? null, median: values[Math.ceil(values.length / 2) - 1] ?? null,
      p95: values[Math.ceil(values.length * 0.95) - 1] ?? null, max: values.at(-1) ?? null };
  };
  return [...groups.values()].map(group => ({
    scenario: group[0]!.scenario.id, prediction: group[0]!.prediction, trials: group.length,
    checksPassed: group.filter(trial => trial.passed).length,
    failures: group.filter(trial => !trial.passed).length,
    media: group.filter(trial => trial.passed && trial.outcome === "media").length,
    unavailable: group.filter(trial => trial.outcome === "unavailable").length,
    timeouts: group.filter(trial => trial.outcome === "timeout").length,
    firstPictureMs: distribution(group.flatMap(trial => trial.passed && typeof trial.firstPictureMs === "number" ? [trial.firstPictureMs] : [])),
    recoveryMs: distribution(group.flatMap(trial => trial.passed && typeof trial.recoveryMs === "number" ? [trial.recoveryMs] : [])),
  }));
}

const baseline = { nat: ["preserve", "preserve"], fault: "none", sfu: false, expected: "media" } as const;
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
  { ...baseline, id: "random-nat", host: "app", viewer: "app", nat: ["random", "random"], expected: "observed" },
  { ...baseline, id: "asymmetric-nat", host: "browser", viewer: "app", nat: ["random", "preserve"], expected: "observed" },
  { ...baseline, id: "ipv6-browser", host: "browser", viewer: "browser", ipv6: true, fault: "peer-block" },
  { ...baseline, id: "ipv6-app", host: "app", viewer: "app", ipv6: true, fault: "peer-block" },
  { ...baseline, id: "healthy-sibling", host: "browser", viewer: "browser", sibling: true,
    fault: "rate", faultEndpoint: 1, direction: "downlink", duringShare: true },
  { ...baseline, id: "remap-browser", host: "browser", viewer: "browser", fault: "udp-block", duringShare: true, remap: true },
  { ...baseline, id: "remap-app", host: "app", viewer: "app", fault: "udp-block", duringShare: true, remap: true },
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
  // Liveness is separate from quality: WebRTC may legitimately reduce cadence
  // under jitter/loss. Preserve the measured cadence rather than imposing a floor.
  if (after.frames <= before.frames) throw new Error("Decoded video did not continue");
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
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
    // Normal jitter has tails; its minimum is not the configured delay.
    if (after.received === 0 || median(after.rttMs) - median(before.rttMs) < 65) throw new Error("Configured delay was not observed");
  } else if (fault === "loss") {
    if (after.received === 0 || after.received >= after.sent) throw new Error("Configured loss was not observed");
  } else if (fault === "rate") {
    if (after.receivedBytes === 0 || after.receivedBytes * 8000 / after.durationMs > 900_000) {
      throw new Error("Configured rate ceiling was not observed");
    }
  } else if (after.received !== after.sent) throw new Error("Control path unexpectedly lost calibration packets");
}

export function checkMapping(probe: ProbeResult, mode: NatMode): void {
  const ports = new Set(probe.mappings.map(value => value.port));
  if (probe.mappings.length !== 3 || (mode === "preserve" ? ports.size !== 1 : ports.size < 2)) {
    throw new Error(`Observed mappings do not match the configured ${mode} SNAT behavior`);
  }
}
