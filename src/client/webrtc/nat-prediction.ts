import type { SignalPayload } from "../../shared/protocol";
import { candidateSignalOrigin } from "../../shared/nat-candidate";
import { debugError } from "../lib/debug";

export type SignalCandidate = Extract<
  SignalPayload,
  { kind: "candidate" }
>["candidate"];
type ConcreteSignalCandidate = NonNullable<SignalCandidate>;

export function isNativeNatSurveyCandidate(
  candidate: SignalCandidate,
  iceServers: readonly RTCIceServer[] | undefined,
  auxiliaryStunUrls: readonly string[] = [],
): boolean {
  const index = candidate && /^candidate:ns([1-9]\d*)\s/i.exec(candidate.candidate)?.[1];
  if (!index) return false;
  // App identifies the requested destination, never its response order. Extra
  // ordinary STUN servers remain useful candidates but are not survey evidence.
  const urls = iceServersWithNatPrediction(iceServers, true, auxiliaryStunUrls)
    .flatMap(urlsOf).filter(url => /^stun:/i.test(url));
  const url = urls[Number(index) - 1];
  const normalized = url ? normalizedStunUrl(url) : null;
  return normalized !== null && natPredictionSurveyUrls(iceServers, auxiliaryStunUrls).has(normalized);
}

const DEFAULT_STUN_PORT = 3478;
const MIN_PREDICTABLE_PORT = 1;
const MAX_PREDICTABLE_PORT = 65_535;

/** Keep the experiment bounded so normal ICE candidates retain their budget. */
export const NAT_PREDICTION_STEPS = 4;
export const MAX_NAT_PREDICTION_CANDIDATES = NAT_PREDICTION_STEPS * 2;

export async function addRemoteIceCandidate(
  connection: RTCPeerConnection,
  candidate: SignalCandidate,
): Promise<void> {
  try {
    await connection.addIceCandidate(candidate);
  } catch (error) {
    // A stale/rejected candidate is disposable input, not failed SDP or a dead
    // transport. Keep draining this generation; ICE state owns route failure.
    if (
      !(error instanceof DOMException && error.name === "OperationError") &&
      candidateSignalOrigin(candidate?.candidate ?? null) !== "predicted"
    ) {
      throw error;
    }
    debugError("webrtc", "remote-candidate-rejected", error, {
      origin: candidateSignalOrigin(candidate?.candidate ?? null),
    });
  }
}

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
  // The HTTP parser normalizes the host but drops an explicit :80. STUN
  // defaults to 3478 only when its authority omits the port (RFC 7064).
  const explicitPort = /:(\d+)$/.exec(authority)?.[1];
  const port = explicitPort === undefined ? DEFAULT_STUN_PORT : Number(explicitPort);
  return `stun:${hostname}:${port}`;
}

/** URLs whose same-socket observations may form the controlled port sequence. */
export function natPredictionSurveyUrls(
  iceServers: readonly RTCIceServer[] | undefined,
  auxiliaryStunUrls: readonly string[] = [],
): ReadonlySet<string> {
  const configuredAuxiliaryUrls = new Set(
    auxiliaryStunUrls.flatMap((url) => {
      const normalized = normalizedStunUrl(url);
      return normalized ? [normalized] : [];
    }),
  );
  if (configuredAuxiliaryUrls.size !== 2) {
    return new Set();
  }
  const ordinary = (iceServers ?? []).flatMap(urlsOf)
    .map(normalizedStunUrl)
    .filter((url): url is string => url !== null && !configuredAuxiliaryUrls.has(url));
  // Keep the published Hosted base choice, independent of discovery order.
  // Explicit App surveys may also use a non-default port.
  const base = ordinary.find(url => url.endsWith(`:${DEFAULT_STUN_PORT}`)) ?? ordinary[0];
  return base ? new Set([base, ...configuredAuxiliaryUrls]) : new Set();
}

/**
 * Add two optional survey destinations without changing the server-provided
 * ordinary STUN list. The caller opts into this per connection.
 */
export function iceServersWithNatPrediction(
  iceServers: readonly RTCIceServer[] | undefined,
  enabled: boolean,
  auxiliaryStunUrls: readonly string[] = [],
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
  for (const url of auxiliaryStunUrls) {
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
  const related = (name: string): string => {
    const index = fields.findIndex(field => field.toLowerCase() === name);
    return index < 0 ? "" : fields[index + 1] ?? "";
  };
  // One public IP can cover multiple local sockets. Do not spend this
  // generation's prediction budget on a sequence mixed across their bases.
  // Redacted/missing related fields retain the bounded Browser hypothesis.
  const groupKey = [
    candidate.sdpMid ?? "",
    candidate.sdpMLineIndex ?? "",
    fields[1],
    related("raddr"),
    related("rport"),
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

function predictedAround(
  low: SrflxObservation,
  high: SrflxObservation,
  step: number,
): SignalCandidate[] {
  const predicted: SignalCandidate[] = [];
  for (const [anchor, direction] of [
    [high, 1],
    [low, -1],
  ] as const) {
    for (let index = 1; index <= NAT_PREDICTION_STEPS; index += 1) {
      const port = anchor.port + direction * step * index;
      if (port < MIN_PREDICTABLE_PORT || port > MAX_PREDICTABLE_PORT) {
        continue;
      }
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
    const ordered = [...distinct].sort((left, right) => left.port - right.port);
    return predictedAround(ordered[0]!, ordered.at(-1)!, step).slice(
      0,
      MAX_NAT_PREDICTION_CANDIDATES,
    );
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

  complete(end: SignalCandidate = null): void {
    if (this.completed) {
      return;
    }
    this.trySendPredictions();
    this.send(end);
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

/** Own local ICE generations across Browser and Native trickle delivery. */
export class NatPredictionCandidateEmitter {
  private batch: NatPredictionCandidateBatch | null = null;
  private generation: ConcreteSignalCandidate | null = null;
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
    const serverUrl = (
      candidate as (RTCIceCandidate & { readonly url?: string | null }) | null
    )?.url;
    const candidateUrl = serverUrl ? normalizedStunUrl(serverUrl) : null;
    this.addSignal(candidate ? signalCandidate(candidate) : null,
      candidateUrl !== null && this.surveyUrls.has(candidateUrl));
  }

  /** Native trickle shares the same ICE-generation owner as Browser trickle. */
  addSignal(next: SignalCandidate, predictionEligible: boolean): void {
    if (!next || next.candidate === "") {
      // A scoped end can arrive after a newer generation started. Forward it
      // without completing that generation's prediction observations.
      if (next?.usernameFragment && this.generation?.usernameFragment &&
        next.usernameFragment !== this.generation.usernameFragment) {
        this.send(next);
      } else this.completeBatch(next);
      return;
    }

    if (
      this.batch &&
      this.generation?.usernameFragment &&
      next.usernameFragment &&
      next.usernameFragment !== this.generation.usernameFragment
    ) {
      // An ICE restart retires old observations; an unscoped end marker here
      // would end the new remote generation before its candidates arrive.
      this.discard();
    }
    if (!this.batch) {
      this.generation = next;
      this.endSent = false;
      this.batch = new NatPredictionCandidateBatch(this.send);
    }
    this.batch.add(next, this.enabled && predictionEligible);
  }

  gatheringComplete(): void {
    this.completeBatch();
  }

  discard(): void {
    this.batch?.discard();
    this.batch = null;
    this.generation = null;
    this.endSent = false;
  }

  private completeBatch(end: SignalCandidate = null): void {
    if (!this.batch) {
      if (!this.endSent && end?.usernameFragment) {
        this.send(end);
        this.generation = end;
        this.endSent = true;
      }
      return;
    }
    // An unscoped null applies to the latest remote ICE generation. Keep a
    // delayed end attached to the candidates that actually finished gathering.
    const marker = end?.usernameFragment ? end : this.generation?.usernameFragment
      ? { ...this.generation, candidate: "" } : null;
    this.batch.complete(marker);
    this.batch = null;
    this.endSent = true;
  }
}
