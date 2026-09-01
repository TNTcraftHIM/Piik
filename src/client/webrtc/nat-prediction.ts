import {
  MAX_NAT_PREDICTION_STUN_URLS,
  type SignalPayload,
} from "../../shared/protocol";

export type SignalCandidate = Extract<
  SignalPayload,
  { kind: "candidate" }
>["candidate"];
type ConcreteSignalCandidate = NonNullable<SignalCandidate>;

const BASE_STUN_PORT = 3478;
const AUXILIARY_STUN_PORTS = [3479, 3480] as const;
const MIN_PREDICTABLE_PORT = 1;
const MAX_PREDICTABLE_PORT = 65_535;

/** Keep the experiment bounded so normal ICE candidates retain their budget. */
export const NAT_PREDICTION_STEPS = 4;
export const MAX_NAT_PREDICTION_CANDIDATES = NAT_PREDICTION_STEPS * 2;

interface SrflxObservation {
  candidate: SignalCandidate;
  fields: string[];
  address: string;
  port: number;
  groupKey: string;
}

function urlsOf(server: RTCIceServer): readonly string[] {
  return Array.isArray(server.urls) ? server.urls : [server.urls];
}

function cloneIceServer(server: RTCIceServer): RTCIceServer {
  return {
    ...server,
    urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
  };
}

function auxiliaryUrlsFor(url: string): readonly string[] {
  if (!/^stun:/i.test(url)) {
    return [];
  }
  const authority = url.slice(url.indexOf(":") + 1);
  let parsed: URL;
  try {
    parsed = new URL(`http://${authority}`);
  } catch {
    return [];
  }
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    return [];
  }
  const port = parsed.port ? Number(parsed.port) : BASE_STUN_PORT;
  if (port !== BASE_STUN_PORT) {
    return [];
  }
  const hostname = parsed.hostname.startsWith("[")
    ? parsed.hostname
    : parsed.hostname.includes(":")
      ? `[${parsed.hostname}]`
      : parsed.hostname;
  return AUXILIARY_STUN_PORTS.map(
    (auxiliaryPort) => `stun:${hostname}:${auxiliaryPort}`,
  );
}

function normalizedStunUrl(url: string): string | null {
  if (!/^stun:/i.test(url)) {
    return null;
  }
  const authority = url.slice(url.indexOf(":") + 1);
  let parsed: URL;
  try {
    parsed = new URL(`http://${authority}`);
  } catch {
    return null;
  }
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }
  const hostname = parsed.hostname.startsWith("[")
    ? parsed.hostname.toLowerCase()
    : parsed.hostname.includes(":")
      ? `[${parsed.hostname.toLowerCase()}]`
      : parsed.hostname.toLowerCase();
  return `stun:${hostname}:${parsed.port || BASE_STUN_PORT}`;
}

/** URLs whose same-socket observations may form the controlled port sequence. */
export function natPredictionSurveyUrls(
  iceServers: readonly RTCIceServer[] | undefined,
): ReadonlySet<string> {
  for (const server of iceServers ?? []) {
    for (const url of urlsOf(server)) {
      const auxiliaryUrls = auxiliaryUrlsFor(url);
      const baseUrl = normalizedStunUrl(url);
      if (baseUrl && auxiliaryUrls.length > 0) {
        return new Set([
          baseUrl,
          ...auxiliaryUrls.flatMap((entry) => {
            const normalized = normalizedStunUrl(entry);
            return normalized ? [normalized] : [];
          }),
        ]);
      }
    }
  }
  return new Set();
}

/**
 * Add the two optional same-host survey listeners without changing the
 * server-provided STUN list. The caller opts into this per connection.
 */
export function iceServersWithNatPrediction(
  iceServers: readonly RTCIceServer[] | undefined,
  enabled: boolean,
  externalStunUrls: readonly string[] = [],
): RTCIceServer[] {
  const base = (iceServers ?? []).map(cloneIceServer);
  if (!enabled) {
    return base;
  }

  const additions = new Set<string>();
  const existing = new Set(
    (iceServers ?? [])
      .flatMap((server) => urlsOf(server))
      .map((url) => normalizedStunUrl(url) ?? url),
  );
  for (const server of iceServers ?? []) {
    for (const url of urlsOf(server)) {
      for (const auxiliaryUrl of auxiliaryUrlsFor(url)) {
        const normalized = normalizedStunUrl(auxiliaryUrl) ?? auxiliaryUrl;
        if (!existing.has(normalized)) {
          additions.add(auxiliaryUrl);
          existing.add(normalized);
        }
      }
      if (additions.size >= AUXILIARY_STUN_PORTS.length) {
        break;
      }
    }
    if (additions.size >= AUXILIARY_STUN_PORTS.length) {
      break;
    }
  }

  for (const url of externalStunUrls.slice(0, MAX_NAT_PREDICTION_STUN_URLS)) {
    const normalized = normalizedStunUrl(url);
    if (normalized && !existing.has(normalized)) {
      additions.add(url);
      existing.add(normalized);
    }
  }

  return [
    ...base,
    ...Array.from(additions, (url) => ({ urls: url })),
  ];
}

function parseSrflxCandidate(
  candidate: SignalCandidate,
): SrflxObservation | null {
  if (!candidate || !candidate.candidate.trim()) {
    return null;
  }
  const fields = candidate.candidate.trim().split(/\s+/);
  const typeIndex = fields.findIndex(
    (field) => field.toLowerCase() === "typ",
  );
  if (
    fields.length < 8 ||
    !fields[0]?.toLowerCase().startsWith("candidate:") ||
    fields[2]?.toLowerCase() !== "udp" ||
    typeIndex < 0 ||
    fields[typeIndex + 1]?.toLowerCase() !== "srflx"
  ) {
    return null;
  }
  const address = fields[4];
  const port = Number(fields[5]);
  if (
    !address ||
    !Number.isInteger(port) ||
    port < MIN_PREDICTABLE_PORT ||
    port > MAX_PREDICTABLE_PORT
  ) {
    return null;
  }
  const groupKey = [
    candidate.sdpMid ?? "",
    candidate.sdpMLineIndex ?? "",
    address,
  ].join("/");
  return { candidate, fields, address, port, groupKey };
}

function distinctObservations(
  observations: readonly SrflxObservation[],
): SrflxObservation[] {
  const seen = new Set<string>();
  return observations.filter((observation) => {
    const key = `${observation.groupKey}/${observation.port}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function stableStep(observations: readonly SrflxObservation[]): number | null {
  if (observations.length < 3) {
    return null;
  }
  const sorted = [...observations].sort((left, right) => left.port - right.port);
  const step = sorted[1]!.port - sorted[0]!.port;
  if (
    step <= 0 ||
    sorted.some(
      (observation, index) =>
        index > 0 && observation.port - sorted[index - 1]!.port !== step,
    )
  ) {
    return null;
  }
  return step;
}

function predictedFrom(
  anchor: SrflxObservation,
  step: number,
  occupiedPorts: ReadonlySet<number>,
): SignalCandidate[] {
  const predicted: SignalCandidate[] = [];
  const seenPorts = new Set(occupiedPorts);
  for (const direction of [1, -1] as const) {
    for (let index = 1; index <= NAT_PREDICTION_STEPS; index += 1) {
      const port = anchor.port + direction * step * index;
      if (port < MIN_PREDICTABLE_PORT || port > MAX_PREDICTABLE_PORT) {
        continue;
      }
      if (seenPorts.has(port)) {
        continue;
      }
      seenPorts.add(port);
      const fields = [...anchor.fields];
      fields[0] = `candidate:s${direction > 0 ? "p" : "m"}${index}`;
      fields[5] = String(port);
      predicted.push({
        ...anchor.candidate,
        candidate: fields.join(" "),
      });
    }
  }
  return predicted;
}

/**
 * Return a bounded, connection-local prediction only for a clear arithmetic
 * srflx shape. No participant classification or candidate rejection happens
 * here; callers append the result to the ordinary ICE candidate set.
 */
export function predictSrflxCandidates(
  candidates: readonly SignalCandidate[],
): SignalCandidate[] {
  const groups = new Map<string, SrflxObservation[]>();
  for (const candidate of candidates) {
    const observation = parseSrflxCandidate(candidate);
    if (!observation) {
      continue;
    }
    const group = groups.get(observation.groupKey) ?? [];
    group.push(observation);
    groups.set(observation.groupKey, group);
  }

  for (const group of groups.values()) {
    const distinct = distinctObservations(group);
    const step = stableStep(distinct);
    if (step === null) {
      continue;
    }
    const anchor = distinct.reduce((latest, observation) =>
      observation.port > latest.port ? observation : latest,
    );
    return predictedFrom(
      anchor,
      step,
      new Set(distinct.map((observation) => observation.port)),
    ).slice(0, MAX_NAT_PREDICTION_CANDIDATES);
  }
  return [];
}

/**
 * Emits every ordinary candidate at normal trickle timing. Once one ICE
 * generation proves a predictable srflx shape, the bounded predictions are
 * appended without delaying or replacing stock ICE.
 */
export class NatPredictionCandidateBatch {
  private readonly observedSrflx: SignalCandidate[] = [];
  private predictionsSent = false;
  private completed = false;

  constructor(private readonly send: (candidate: SignalCandidate | null) => void) {}

  add(candidate: SignalCandidate, predictionEligible = true): void {
    if (this.completed) {
      return;
    }
    if (!parseSrflxCandidate(candidate)) {
      this.send(candidate);
      return;
    }
    if (predictionEligible) {
      this.observedSrflx.push(candidate);
      this.trySendPredictions();
    }
    this.send(candidate);
  }

  complete(): void {
    if (this.completed) {
      return;
    }
    this.trySendPredictions();
    this.send(null);
    this.completed = true;
  }

  discard(): void {
    this.completed = true;
    this.observedSrflx.length = 0;
  }

  private trySendPredictions(): void {
    if (this.predictionsSent) {
      return;
    }
    const predictions = predictSrflxCandidates(this.observedSrflx);
    if (predictions.length === 0) {
      return;
    }
    for (const candidate of predictions) {
      this.send(candidate);
    }
    this.predictionsSent = true;
  }
}

function signalCandidate(candidate: RTCIceCandidate): ConcreteSignalCandidate {
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    usernameFragment: candidate.usernameFragment,
  };
}

/** Own one local ICE candidate generation for any Browser P2P role. */
export class NatPredictionCandidateEmitter {
  private batch: NatPredictionCandidateBatch | null = null;
  private usernameFragment: string | null = null;
  private endSent = false;
  private surveyUrls = new Set<string>();

  constructor(
    private readonly enabled: boolean,
    private readonly send: (candidate: SignalCandidate | null) => void,
    surveyUrls: ReadonlySet<string> = new Set(),
  ) {
    this.setSurveyUrls(surveyUrls);
  }

  setSurveyUrls(urls: ReadonlySet<string>): void {
    this.surveyUrls = new Set(
      [...urls].flatMap((url) => {
        const normalized = normalizedStunUrl(url);
        return normalized ? [normalized] : [];
      }),
    );
  }

  add(candidate: RTCIceCandidate | null): void {
    if (!this.enabled) {
      this.send(candidate ? signalCandidate(candidate) : null);
      return;
    }
    if (!candidate) {
      this.completeBatch();
      if (!this.endSent) {
        this.send(null);
        this.endSent = true;
      }
      return;
    }

    const next = signalCandidate(candidate);
    if (
      this.batch &&
      this.usernameFragment &&
      next.usernameFragment &&
      next.usernameFragment !== this.usernameFragment
    ) {
      this.completeBatch();
    }
    if (!this.batch) {
      this.usernameFragment = next.usernameFragment ?? null;
      this.endSent = false;
      this.batch = new NatPredictionCandidateBatch(this.send);
    }
    const serverUrl = (
      candidate as RTCIceCandidate & { readonly url?: string | null }
    ).url;
    const candidateUrl = serverUrl
      ? normalizedStunUrl(serverUrl)
      : null;
    this.batch.add(
      next,
      candidateUrl !== null && this.surveyUrls.has(candidateUrl),
    );
  }

  gatheringComplete(): void {
    if (this.enabled) {
      this.completeBatch();
    }
  }

  discard(): void {
    this.batch?.discard();
    this.batch = null;
    this.usernameFragment = null;
    this.endSent = false;
  }

  private completeBatch(): void {
    if (!this.batch) {
      return;
    }
    this.batch.complete();
    this.batch = null;
    this.usernameFragment = null;
    this.endSent = true;
  }
}
