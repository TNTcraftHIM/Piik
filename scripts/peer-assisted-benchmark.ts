import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import WebSocket from "ws";
import {
  MAX_VIEWERS_PER_ROOM_LIMIT,
  type ParticipantRouteAssignment,
  type RouteDiagnosticSnapshot,
} from "../src/shared/protocol";
import {
  DEFAULT_ENDPOINT_MEDIA_COPY_CAPACITY,
  MAX_ENDPOINT_MEDIA_COPY_CAPACITY,
} from "../src/shared/media-copy-accounting";
import {
  createScreenerServer,
  type ScreenerServer,
} from "../src/server/app";
import { loadConfig } from "../src/server/config";
import {
  RoomStore,
} from "../src/server/room-store";
import {
  QUALITY_PROFILES,
  QUALITY_RESOLUTIONS,
  qualitySettingsEqual,
  type QualityProfileId,
  type QualitySettings,
} from "../src/client/media/quality";
const PROFILE_SETTINGS = QUALITY_PROFILES;
type ProfileId = QualityProfileId;
type PageRole = "host" | "viewer";
export type BenchmarkCanaryMode = "none" | "viewer-mbb";

const ROUTE_TIMING_KEYS = [
  "queueWaitMs",
  "candidateStartMs",
  "firstDecodedFrameMs",
  "finalMs",
] as const satisfies readonly (keyof RouteDiagnosticSnapshot["children"][number])[];
type RouteTimingKey = (typeof ROUTE_TIMING_KEYS)[number];
interface RouteTimingDistribution {
  sampleCount: number;
  pendingCount: number;
  rawMs: number[];
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}
export type BenchmarkRouteTimingSamples = {
  [Key in RouteTimingKey]: Array<
    RouteDiagnosticSnapshot["children"][number][Key]
  >;
};
export type BenchmarkRouteTimingSummary = Record<
  RouteTimingKey,
  RouteTimingDistribution
>;

interface ViewerMbbCanaryResult {
  kind: "viewer-mbb";
  status: "passed" | "failed";
  assertions: Record<string, boolean>;
  counters: Record<string, number>;
  failureCode?: "topology-unavailable" | "probe-unavailable";
}

export interface BenchmarkConfig {
  chromePath: string;
  viewerCounts: number[];
  expectedEndpointCap: number;
  profileId: ProfileId;
  durationMs: number;
  settleMs: number;
  sampleIntervalMs: number;
  connectionTimeoutMs: number;
  recoveryViewerCount: number | null;
  recoveryTimeoutMs: number;
  outputPath: string | null;
  headless: boolean;
  noSandbox: boolean;
  qualityControlSmoke: boolean;
  canaryMode: BenchmarkCanaryMode;
}

interface MediaTotals {
  id: string;
  framesTotal: number | null;
  bytesTotal: number | null;
}

interface ConnectionObservation {
  index: number;
  createdAtEpochMs: number;
  connectionId: string | null;
  remotePeerId: string | null;
  connectionState: string;
  iceConnectionState: string;
  hasOutboundVideo: boolean;
  hasInboundVideo: boolean;
  send: Record<string, unknown> | null;
  receive: Record<string, unknown> | null;
  sendTotals: MediaTotals | null;
  receiveTotals: MediaTotals | null;
  error?: string;
}

interface PageObservation {
  label: string;
  role: PageRole;
  viewerIndex: number | null;
  roomId: string | null;
  peerId: string | null;
  authenticatedAtEpochMs: number | null;
  authenticateSentAtEpochMs: number | null;
  signalingConnected: boolean;
  qualitySettings: QualitySettings | null;
  routeRevision: number | null;
  routeAssignment: ParticipantRouteAssignment | null;
  maxActiveOutboundMediaEdges: number;
  maxAssignedChildren: number;
  firstDecodedAtEpochMs: number | null;
  firstRenderedAtEpochMs: number | null;
  renderedFrames: number;
  connections: ConnectionObservation[];
}

interface FailurePageEvidence {
  label: string;
  role: PageRole;
  authenticated: boolean;
  signalingConnected: boolean;
  routeRevision: number | null;
  upstreamKind: ParticipantRouteAssignment["upstream"]["kind"] | null;
  assignedChildCount: number;
  firstDecoded: boolean;
  firstRendered: boolean;
  connectionCount: number;
  connections: Array<{
    connectionState: string;
    iceConnectionState: string;
    identity: "peer" | "unidentified";
    hasOutboundVideo: boolean;
    hasInboundVideo: boolean;
    decoded: boolean;
  }>;
}

interface BenchmarkFailureEvidence {
  expectedPageCount: number;
  observedPageCount: number;
  pages: FailurePageEvidence[];
}

interface TimedSample {
  atEpochMs: number;
  elapsedMs: number;
  pages: PageObservation[];
  browserProcesses?: BrowserProcessSample | null;
}

interface BrowserProcessSample { processes: Array<{ type: string; id: number; cpuTimeSeconds: number }> }

interface RunCheck {
  name: string;
  passed: boolean;
  actual: number | boolean;
  expected: string;
}

export interface RecoveryResult {
  triggered: boolean;
  relayPeerId?: string;
  affectedPeerIds?: string[];
  failureAtEpochMs?: number;
  reassignedAtEpochMs?: number;
  recoveredAtEpochMs?: number;
  recoveryMs?: number;
  maxHostActiveMediaEdges?: number;
  maxHostAssignedChildren?: number;
  error?: string;
}

export interface RecoveryHostPeaks {
  maxHostActiveMediaEdges?: number;
  maxHostAssignedChildren?: number;
}

export interface RecoveryViewerBaseline {
  label: string;
  routeRevision: number;
  upstreamKind: "peer" | "sfu";
  parentPeerId: string | null;
  connectionId: string | null;
  connectionIndex: number;
  rtpId: string;
  framesTotal: number;
}

interface BenchmarkRun {
  viewerCount: number;
  startedAt: string;
  completedAt: string;
  status: "passed" | "failed";
  checks: RunCheck[];
  summary: ReturnType<typeof summarizeSamples> | null;
  routeTimingSummary: BenchmarkRouteTimingSummary | null;
  routeTimingStatus: "not-requested" | "captured" | "unavailable";
  samples: TimedSample[];
  recovery: RecoveryResult;
  failureEvidence?: BenchmarkFailureEvidence;
  error?: string;
}

interface BenchmarkReport {
  schemaVersion: 3;
  startedAt: string;
  completedAt: string | null;
  gitCommit: string | null;
  chromium: Record<string, unknown> | null;
  environment: {
    node: string;
    platform: NodeJS.Platform;
    arch: string;
    headless: boolean;
  };
  configuration: Omit<BenchmarkConfig, "chromePath" | "outputPath"> & {
    chromeExecutable: string;
    output: string;
  };
  capture: {
    kind: "deterministic-canvas";
    width: number;
    height: number;
    frameRate: number;
    audio: false;
  };
  limitations: string[];
  runs: BenchmarkRun[];
  fatalError?: string;
}

interface PageHandle {
  targetId: string;
  sessionId: string;
  label: string;
}

interface RuntimeEvaluation<T> {
  result: { value?: T };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

interface CdpResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ManagedProcess {
  child: ChildProcess;
  log: BoundedLog;
}

const MAX_VIEWERS = MAX_VIEWERS_PER_ROOM_LIMIT;
const MAX_FAILURE_CONNECTIONS_PER_PAGE =
  MAX_ENDPOINT_MEDIA_COPY_CAPACITY * 2;
const DEFAULT_VIEWER_COUNTS = [MAX_VIEWERS];
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

class BoundedLog {
  private text = "";

  append(chunk: Buffer | string): void {
    this.text += chunk.toString();
    if (this.text.length > 32_000) {
      this.text = this.text.slice(-32_000);
    }
  }

  tail(): string {
    return this.text.trim();
  }
}

class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private closed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (raw) => this.onMessage(raw.toString()));
    socket.on("close", () => this.onClose(new Error("CDP connection closed")));
    socket.on("error", (error) => this.onClose(error));
  }

  static async connect(url: string): Promise<CdpConnection> {
    const socket = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise<void>((resolveOpen, rejectOpen) => {
      socket.once("open", resolveOpen);
      socket.once("error", rejectOpen);
    });
    return new CdpConnection(socket);
  }

  call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`Cannot call ${method}: CDP is closed`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolveCall, rejectCall) => {
      this.pending.set(id, {
        resolve: (value) => resolveCall(value as T),
        reject: rejectCall,
      });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    await new Promise<void>((resolveClose) => {
      const timer = setTimeout(resolveClose, 1_000);
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolveClose();
      });
      this.socket.close();
    });
  }

  private onMessage(raw: string): void {
    let message: CdpResponse;
    try {
      message = JSON.parse(raw) as CdpResponse;
    } catch {
      return;
    }
    if (message.id === undefined) {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(
        new Error(`${message.error.message} (CDP ${message.error.code})`),
      );
      return;
    }
    pending.resolve(message.result ?? {});
  }

  private onClose(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function summarizeBenchmarkRouteTiming(
  samples: BenchmarkRouteTimingSamples,
): BenchmarkRouteTimingSummary {
  return Object.fromEntries(
    ROUTE_TIMING_KEYS.map((key) => [
      key,
      summarizeRouteTiming(samples[key]),
    ]),
  ) as BenchmarkRouteTimingSummary;
}

function summarizeRouteTiming(
  values: readonly (number | null)[],
): RouteTimingDistribution {
  const rawMs = values
    .filter((value): value is number => value !== null)
    .toSorted((left, right) => left - right);
  return {
    sampleCount: rawMs.length,
    pendingCount: values.length - rawMs.length,
    rawMs,
    p50Ms: nearestRank(rawMs, 0.5),
    p95Ms: nearestRank(rawMs, 0.95),
    maxMs: rawMs.at(-1) ?? null,
  };
}

function nearestRank(
  sortedValues: readonly number[],
  percentile: number,
): number | null {
  if (sortedValues.length === 0) return null;
  return sortedValues[Math.ceil(percentile * sortedValues.length) - 1] ?? null;
}

export function buildRouteTimingCheck(
  status: BenchmarkRun["routeTimingStatus"],
  summary: BenchmarkRouteTimingSummary | null,
  expectedChildCount = MAX_VIEWERS,
): RunCheck {
  const completeDistributionCount =
    status === "captured" && summary
      ? ROUTE_TIMING_KEYS.filter((key) => {
          const distribution = summary[key];
          return (
            distribution.sampleCount + distribution.pendingCount ===
            expectedChildCount
          );
        }).length
      : 0;
  return {
    name: "route-timing-current-children",
    passed: completeDistributionCount === ROUTE_TIMING_KEYS.length,
    actual: completeDistributionCount,
    expected:
      `${ROUTE_TIMING_KEYS.length} captured timing distributions with ` +
      `${expectedChildCount} current-child sample or pending values each`,
  };
}

export async function joinViewerBurst<T>(
  viewerCount: number,
  createViewer: (viewerIndex: number) => Promise<T>,
  waitForMedia: (viewer: T, viewerIndex: number) => Promise<unknown>,
): Promise<T[]> {
  const creations = await Promise.allSettled(
    Array.from({ length: viewerCount }, (_, index) =>
      createViewer(index + 1),
    ),
  );
  const creationFailure = creations.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (creationFailure) {
    throw creationFailure.reason;
  }
  const viewers = creations.map(
    (result) => (result as PromiseFulfilledResult<T>).value,
  );
  const media = await Promise.allSettled(
    viewers.map((viewer, index) => waitForMedia(viewer, index + 1)),
  );
  const mediaFailure = media.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (mediaFailure) {
    throw mediaFailure.reason;
  }
  return viewers;
}

export function parseViewerCounts(value: string | undefined): number[] {
  if (!value?.trim()) {
    return [...DEFAULT_VIEWER_COUNTS];
  }
  const result: number[] = [];
  for (const raw of value.split(",")) {
    const parsed = Number(raw.trim());
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_VIEWERS) {
      throw new Error(
        `BENCHMARK_VIEWERS must contain integers from 1 to ${MAX_VIEWERS}`,
      );
    }
    if (!result.includes(parsed)) {
      result.push(parsed);
    }
  }
  if (result.length === 0) {
    throw new Error("BENCHMARK_VIEWERS must not be empty");
  }
  return result;
}

function parseNumber(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (!value?.trim()) {
    return fallback;
  }
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  throw new Error(`${name} must be true, false, 1, or 0`);
}

export function parseBenchmarkCanaryMode(value: string | undefined): BenchmarkCanaryMode {
  const mode = value?.trim() || "none";
  if (mode === "none" || mode === "viewer-mbb") return mode;
  throw new Error("BENCHMARK_CANARY must be none or viewer-mbb");
}

export function parseExpectedEndpointCap(value: string | undefined): number {
  const parsed = value?.trim()
    ? Number(value)
    : DEFAULT_ENDPOINT_MEDIA_COPY_CAPACITY;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_ENDPOINT_MEDIA_COPY_CAPACITY
  ) {
    throw new Error(
      `BENCHMARK_EXPECTED_ENDPOINT_CAP must be an integer from 1 to ${MAX_ENDPOINT_MEDIA_COPY_CAPACITY}`,
    );
  }
  return parsed;
}

export function parseBenchmarkConfig(
  environment: NodeJS.ProcessEnv = process.env,
): BenchmarkConfig {
  const chromePath = environment.CHROME_PATH?.trim();
  if (!chromePath) {
    throw new Error("CHROME_PATH must point to a Chromium or Chrome executable");
  }
  const profileId = (environment.BENCHMARK_PROFILE?.trim() || "720p30") as ProfileId;
  if (!(profileId in PROFILE_SETTINGS)) {
    throw new Error("BENCHMARK_PROFILE must be 1080p60, 1080p30, or 720p30");
  }
  const viewerCounts = parseViewerCounts(environment.BENCHMARK_VIEWERS);
  const qualityControlSmoke = parseBoolean(
    environment.BENCHMARK_QUALITY_SMOKE,
    false,
    "BENCHMARK_QUALITY_SMOKE",
  );
  if (qualityControlSmoke && !viewerCounts.some((count) => count >= 3)) {
    throw new Error(
      "BENCHMARK_QUALITY_SMOKE requires a selected viewer count of at least 3",
    );
  }
  const canaryMode = parseBenchmarkCanaryMode(environment.BENCHMARK_CANARY);
  if (canaryMode === "viewer-mbb" && !viewerCounts.includes(3)) {
    throw new Error(
      "BENCHMARK_CANARY=viewer-mbb requires a selected viewer count of 3",
    );
  }
  const recoveryText = environment.BENCHMARK_RECOVERY_VIEWERS?.trim();
  const recoveryViewerCount = recoveryText ? Number(recoveryText) : null;
  if (
    recoveryViewerCount !== null &&
    (!Number.isInteger(recoveryViewerCount) ||
      recoveryViewerCount < 3 ||
      !viewerCounts.includes(recoveryViewerCount))
  ) {
    throw new Error(
      "BENCHMARK_RECOVERY_VIEWERS must be a selected viewer count of at least 3",
    );
  }
  return {
    chromePath,
    viewerCounts,
    expectedEndpointCap: parseExpectedEndpointCap(
      environment.BENCHMARK_EXPECTED_ENDPOINT_CAP,
    ),
    profileId,
    durationMs:
      parseNumber(
        environment.BENCHMARK_DURATION_SECONDS,
        30,
        "BENCHMARK_DURATION_SECONDS",
        2,
        7_200,
      ) * 1_000,
    settleMs:
      parseNumber(
        environment.BENCHMARK_SETTLE_SECONDS,
        5,
        "BENCHMARK_SETTLE_SECONDS",
        0,
        120,
      ) * 1_000,
    sampleIntervalMs: parseNumber(
      environment.BENCHMARK_SAMPLE_INTERVAL_MS,
      2_000,
      "BENCHMARK_SAMPLE_INTERVAL_MS",
      500,
      10_000,
    ),
    connectionTimeoutMs:
      parseNumber(
        environment.BENCHMARK_CONNECTION_TIMEOUT_SECONDS,
        20,
        "BENCHMARK_CONNECTION_TIMEOUT_SECONDS",
        3,
        120,
      ) * 1_000,
    recoveryViewerCount,
    recoveryTimeoutMs:
      parseNumber(
        environment.BENCHMARK_RECOVERY_TIMEOUT_SECONDS,
        20,
        "BENCHMARK_RECOVERY_TIMEOUT_SECONDS",
        8,
        120,
      ) * 1_000,
    outputPath:
      environment.BENCHMARK_OUTPUT?.trim() === "-"
        ? null
        : environment.BENCHMARK_OUTPUT?.trim() ||
          "benchmark-results/peer-assisted.json",
    headless: parseBoolean(environment.BENCHMARK_HEADLESS, true, "BENCHMARK_HEADLESS"),
    noSandbox: parseBoolean(
      environment.BENCHMARK_CHROME_NO_SANDBOX,
      false,
      "BENCHMARK_CHROME_NO_SANDBOX",
    ),
    qualityControlSmoke,
    canaryMode,
  };
}

export function activeVideoEdgeCount(
  page: PageObservation,
  direction: "send" | "receive",
): number {
  return page.connections.filter((connection) => {
    const hasVideo =
      direction === "send"
        ? connection.hasOutboundVideo
        : connection.hasInboundVideo;
    return (
      hasVideo &&
      connection.connectionState !== "closed" &&
      connection.connectionState !== "failed"
    );
  }).length;
}

export function sanitizeFailurePageEvidence(
  page: PageObservation,
): FailurePageEvidence {
  const connectionStates = new Set([
    "new",
    "connecting",
    "connected",
    "disconnected",
    "failed",
    "closed",
  ]);
  const iceConnectionStates = new Set([
    "new",
    "checking",
    "connected",
    "completed",
    "disconnected",
    "failed",
    "closed",
  ]);
  return {
    label: page.label,
    role: page.role,
    authenticated: page.peerId !== null,
    signalingConnected: page.signalingConnected,
    routeRevision: page.routeRevision,
    upstreamKind: page.routeAssignment?.upstream.kind ?? null,
    assignedChildCount: page.routeAssignment?.childPeerIds.length ?? 0,
    firstDecoded: page.firstDecodedAtEpochMs !== null,
    firstRendered: page.firstRenderedAtEpochMs !== null,
    connectionCount: page.connections.length,
    connections: page.connections
      .slice(-MAX_FAILURE_CONNECTIONS_PER_PAGE)
      .map((connection) => ({
        connectionState: connectionStates.has(connection.connectionState)
          ? connection.connectionState
          : "unknown",
        iceConnectionState: iceConnectionStates.has(
          connection.iceConnectionState,
        )
          ? connection.iceConnectionState
          : "unknown",
        identity:
          connection.connectionId !== null || connection.remotePeerId !== null
            ? "peer"
            : "unidentified",
        hasOutboundVideo: connection.hasOutboundVideo,
        hasInboundVideo: connection.hasInboundVideo,
        decoded: (connection.receiveTotals?.framesTotal ?? 0) > 0,
      })),
  };
}

function hasAuthoritativeMediaUpstream(page: PageObservation): boolean {
  return (
    page.routeRevision !== null &&
    (page.routeAssignment?.upstream.kind === "peer" ||
      page.routeAssignment?.upstream.kind === "sfu")
  );
}

function routeParentPeerId(page: PageObservation): string | null {
  return page.routeAssignment?.upstream.kind === "peer"
    ? page.routeAssignment.upstream.peerId
    : null;
}

function routeChildPeerIds(page: PageObservation): readonly string[] {
  return page.routeAssignment?.childPeerIds ?? [];
}

function inspectSfuPublication(pages: readonly PageObservation[]) {
  const sfuViewers = pages.filter(
    (page) =>
      page.role === "viewer" && page.routeAssignment?.upstream.kind === "sfu",
  );
  const publicationOwners = pages.filter(
    (page) =>
      page.role === "host" &&
      typeof page.routeAssignment?.sfuPublicationGeneration === "string",
  );
  if (sfuViewers.length === 0) {
    return {
      observed: false,
      rootCount: 0,
      coherent: publicationOwners.length === 0,
    };
  }

  if (publicationOwners.length !== 1) {
    return { observed: true, rootCount: sfuViewers.length, coherent: false };
  }
  const host = publicationOwners[0]!;
  const hostRevision = host.routeRevision;
  const hostGeneration = host.routeAssignment?.sfuPublicationGeneration ?? null;
  const hasExactSfuMedia = (
    page: PageObservation,
    direction: "send" | "receive",
  ): boolean =>
    page.connections.some((connection) => {
      const totals =
        direction === "send"
          ? connection.sendTotals
          : connection.receiveTotals;
      return (
        connection.connectionId === null &&
        connection.remotePeerId === null &&
        connection.connectionState === "connected" &&
        (direction === "send"
          ? connection.hasOutboundVideo
          : connection.hasInboundVideo) &&
        totals !== null &&
        typeof totals.framesTotal === "number" &&
        totals.framesTotal > 0
      );
    });
  const coherent =
    hostRevision !== null &&
    hostGeneration !== null &&
    pages.every((page) => page.routeRevision === hostRevision) &&
    hasExactSfuMedia(host, "send") &&
    sfuViewers.every(
      (viewer) =>
        viewer.routeAssignment?.sfuPublicationGeneration === hostGeneration &&
        hasExactSfuMedia(viewer, "receive"),
    );
  return { observed: true, rootCount: sfuViewers.length, coherent };
}

export function summarizeSamples(samples: TimedSample[], viewerCount: number) {
  let maxHostActiveMediaEdges = 0;
  let maxHostAssignedChildren = 0;
  let maxRelayActiveMediaEdges = 0;
  let everyViewerDecoded = false;
  for (const sample of samples) {
    const host = sample.pages.find((page) => page.role === "host");
    if (host) {
      maxHostActiveMediaEdges = Math.max(
        maxHostActiveMediaEdges,
        activeVideoEdgeCount(host, "send"),
        host.maxActiveOutboundMediaEdges,
      );
      maxHostAssignedChildren = Math.max(
        maxHostAssignedChildren,
        routeChildPeerIds(host).length,
        host.maxAssignedChildren,
      );
    }
    for (const page of sample.pages) {
      if (page.role === "viewer") {
        maxRelayActiveMediaEdges = Math.max(
          maxRelayActiveMediaEdges,
          activeVideoEdgeCount(page, "send"),
          page.maxActiveOutboundMediaEdges,
        );
      }
    }
  }
  const finalPages = samples.at(-1)?.pages ?? [];
  const sfuPublication = inspectSfuPublication(finalPages);
  const viewerContinuity = finalPages
    .filter((page) => page.role === "viewer")
    .map((page) => {
      const activeReceive = page.connections.find(
        (connection) =>
          connection.hasInboundVideo &&
          connection.connectionState === "connected" &&
          connection.receiveTotals?.id,
      );
      const series = activeReceive
        ? samples.flatMap((sample) => {
            const sampledPage = sample.pages.find(
              (candidate) => candidate.label === page.label,
            );
            const sampledConnection = sampledPage?.connections.find(
              (connection) =>
                connection.receiveTotals?.id === activeReceive.receiveTotals?.id &&
                (activeReceive.connectionId
                  ? connection.connectionId === activeReceive.connectionId
                  : connection.index === activeReceive.index),
            );
            const frames = sampledConnection?.receiveTotals?.framesTotal;
            return typeof frames === "number" ? [frames] : [];
          })
        : [];
      const statsClean = samples.every((sample) => {
        const sampledPage = sample.pages.find(
          (candidate) => candidate.label === page.label,
        );
        return sampledPage?.connections.every(
          (connection) => connection.error === undefined,
        );
      });
      return {
        label: page.label,
        assigned: hasAuthoritativeMediaUpstream(page),
        routeRevision: page.routeRevision,
        upstreamKind: page.routeAssignment?.upstream.kind ?? null,
        activeUpstream: activeReceive !== undefined,
        statsClean,
        framesIncreased:
          series.length >= 2 && series.at(-1)! > series[0]!,
        firstFramesTotal: series[0] ?? null,
        finalFramesTotal: series.at(-1) ?? null,
      };
    });
  everyViewerDecoded =
    sfuPublication.coherent &&
    viewerContinuity.length === viewerCount &&
    viewerContinuity.every(
      (viewer) =>
        viewer.assigned &&
        viewer.activeUpstream &&
        viewer.statsClean &&
        viewer.framesIncreased,
    );
  const firstFrames = finalPages
    .filter((page) => page.role === "viewer")
    .map((page) => ({
      viewerIndex: page.viewerIndex,
      peerId: page.peerId,
      authenticateSentAtEpochMs: page.authenticateSentAtEpochMs,
      firstDecodedAtEpochMs: page.firstDecodedAtEpochMs,
      firstRenderedAtEpochMs: page.firstRenderedAtEpochMs,
      decodedAfterAuthenticateMs:
        page.firstDecodedAtEpochMs !== null &&
        page.authenticateSentAtEpochMs !== null
          ? page.firstDecodedAtEpochMs - page.authenticateSentAtEpochMs
          : null,
      renderedAfterAuthenticateMs:
        page.firstRenderedAtEpochMs !== null &&
        page.authenticateSentAtEpochMs !== null
          ? page.firstRenderedAtEpochMs - page.authenticateSentAtEpochMs
          : null,
    }));
  const decodedDelays = firstFrames.flatMap((frame) =>
    frame.decodedAfterAuthenticateMs === null
      ? []
      : [frame.decodedAfterAuthenticateMs],
  );
  return {
    maxHostActiveMediaEdges,
    maxHostAssignedChildren,
    maxRelayActiveMediaEdges,
    everyViewerDecoded,
    sfuPublicationObserved: sfuPublication.observed,
    sfuRootCount: sfuPublication.rootCount,
    sfuPublicationCoherent: sfuPublication.coherent,
    viewerContinuity,
    firstFrames,
    maxFirstDecodedAfterAuthenticateMs:
      decodedDelays.length === viewerCount ? Math.max(...decodedDelays) : null,
    senderEvidence: {
      scope: "connected outbound video with stable page, connection, and RTP identities",
      host: summarizeSenderEvidence(samples, "host"),
      relay: summarizeSenderEvidence(samples, "viewer"),
    },
    browserProcessResources: summarizeBrowserProcessResources(samples),
    finalTopology: finalPages.map((page) => ({
      label: page.label,
      role: page.role,
      viewerIndex: page.viewerIndex,
      peerId: page.peerId,
      qualitySettings: page.qualitySettings,
      parentPeerId: routeParentPeerId(page),
      childPeerIds: routeChildPeerIds(page),
      routeRevision: page.routeRevision,
      routeUpstream: page.routeAssignment?.upstream ?? null,
      sfuPublicationGeneration:
        page.routeAssignment?.sfuPublicationGeneration ?? null,
    })),
    finalEdges: finalPages.flatMap((page) =>
      page.connections
        .filter(
          (connection) =>
            connection.hasOutboundVideo || connection.hasInboundVideo,
        )
        .map((connection) => ({
          page: page.label,
          pagePeerId: page.peerId,
          connectionIndex: connection.index,
          connectionId: connection.connectionId,
          remotePeerId: connection.remotePeerId,
          connectionState: connection.connectionState,
          iceConnectionState: connection.iceConnectionState,
          send: connection.send,
          receive: connection.receive,
          sendTotals: connection.sendTotals,
          receiveTotals: connection.receiveTotals,
        })),
    ),
  };
}

function numericSummary(values: number[]) {
  return {
    sampleCount: values.length,
    min: values.length > 0 ? Math.min(...values) : null,
    max: values.length > 0 ? Math.max(...values) : null,
    mean: values.length > 0
      ? values.reduce((total, value) => total + value, 0) / values.length
      : null,
  };
}

function summarizeSenderEvidence(samples: TimedSample[], role: PageRole) {
  const identities = new Set<string>();
  const bitrateKbps: number[] = [], framesPerSecond: number[] = [];
  const availableOutgoingKbps: number[] = [];
  const resolutions = new Set<string>();
  const qualityLimitationReasonSamples: Record<string, number> = {};
  let unknownIdentitySamples = 0;
  let unknownQualityLimitationSamples = 0;
  let encodeIntervalCount = 0, framesEncoded = 0, encodeTimeMs = 0;
  const finite = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);

  for (const sample of samples) {
    for (const page of sample.pages.filter((candidate) => candidate.role === role)) {
      for (const connection of page.connections) {
        if (!connection.hasOutboundVideo || connection.connectionState !== "connected" || !connection.send) continue;
        const rtpStatsId = connection.send.rtpStatsId;
        if (typeof rtpStatsId !== "string" || rtpStatsId.length === 0) {
          unknownIdentitySamples += 1;
          continue;
        }
        identities.add(`${page.label}:${connection.createdAtEpochMs}:${connection.connectionId ?? connection.index}:${rtpStatsId}`);
        if (finite(connection.send.bitrateKbps)) bitrateKbps.push(connection.send.bitrateKbps);
        if (finite(connection.send.framesPerSecond)) framesPerSecond.push(connection.send.framesPerSecond);
        if (finite(connection.send.availableOutgoingKbps)) availableOutgoingKbps.push(connection.send.availableOutgoingKbps);
        if (typeof connection.send.resolution === "string" && /^\d+x\d+$/.test(connection.send.resolution)) resolutions.add(connection.send.resolution);
        const reason = connection.send.qualityLimitationReason;
        if (typeof reason === "string" && reason.length > 0) {
          qualityLimitationReasonSamples[reason] = (qualityLimitationReasonSamples[reason] ?? 0) + 1;
        } else {
          unknownQualityLimitationSamples += 1;
        }
        const intervalFrames = connection.send.intervalFramesEncoded;
        const intervalTime = connection.send.intervalEncodeTimeMs;
        if (finite(intervalFrames) && intervalFrames >= 0 && finite(intervalTime) && intervalTime >= 0) {
          encodeIntervalCount += 1;
          framesEncoded += intervalFrames;
          encodeTimeMs += intervalTime;
        }
      }
    }
  }
  return {
    uniqueSenderCount: identities.size,
    unknownIdentitySamples,
    bitrateKbps: numericSummary(bitrateKbps),
    framesPerSecond: numericSummary(framesPerSecond),
    resolutions: resolutions.size > 0 ? [...resolutions].sort() : null,
    availableOutgoingKbps: numericSummary(availableOutgoingKbps),
    encodeIntervals: {
      sampleCount: encodeIntervalCount,
      framesEncoded: encodeIntervalCount > 0 ? framesEncoded : null,
      encodeTimeMs: encodeIntervalCount > 0 ? encodeTimeMs : null,
      meanEncodeMsPerFrame: framesEncoded > 0 ? encodeTimeMs / framesEncoded : null,
    },
    qualityLimitationReasonSamples: Object.keys(qualityLimitationReasonSamples).length > 0
      ? qualityLimitationReasonSamples : null,
    unknownQualityLimitationSamples,
  };
}

function summarizeBrowserProcessResources(samples: TimedSample[]) {
  let validCpuIntervals = 0, invalidCpuIntervals = 0;
  let measuredCpuTimeSeconds = 0, measuredWallTimeSeconds = 0;
  let peakIntervalCpuUtilizationPercent: number | null = null;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]!;
    const current = samples[index]!;
    const wallSeconds = (current.atEpochMs - previous.atEpochMs) / 1_000;
    const previousProcesses = previous.browserProcesses?.processes;
    const currentProcesses = current.browserProcesses?.processes;
    const previousByIdentity = new Map(previousProcesses?.map((process) => [`${process.type}:${process.id}`, process]));
    let cpuSeconds = 0;
    const valid = wallSeconds > 0 && previousProcesses && currentProcesses &&
      previousProcesses.length === currentProcesses.length && previousByIdentity.size === previousProcesses.length &&
      currentProcesses.every((process) => {
        const baseline = previousByIdentity.get(`${process.type}:${process.id}`);
        if (!baseline || process.cpuTimeSeconds < baseline.cpuTimeSeconds) return false;
        cpuSeconds += process.cpuTimeSeconds - baseline.cpuTimeSeconds;
        return true;
      });
    if (!valid) {
      invalidCpuIntervals += 1;
      continue;
    }
    validCpuIntervals += 1;
    measuredCpuTimeSeconds += cpuSeconds;
    measuredWallTimeSeconds += wallSeconds;
    const utilization = (cpuSeconds / wallSeconds) * 100;
    peakIntervalCpuUtilizationPercent = Math.max(peakIntervalCpuUtilizationPercent ?? 0, utilization);
  }
  return {
    source: "CDP SystemInfo.getProcessInfo",
    scope: "all CDP-reported processes in the isolated benchmark Chromium instance",
    validCpuIntervals,
    invalidCpuIntervals,
    measuredCpuTimeSeconds: validCpuIntervals ? measuredCpuTimeSeconds : null,
    measuredWallTimeSeconds: validCpuIntervals ? measuredWallTimeSeconds : null,
    averageCpuUtilizationPercent: measuredWallTimeSeconds > 0
      ? (measuredCpuTimeSeconds / measuredWallTimeSeconds) * 100 : null,
    peakIntervalCpuUtilizationPercent,
    peakResidentSetBytes: null,
  };
}

export function buildRunChecks(
  summary: NonNullable<BenchmarkRun["summary"]>,
  viewerCount: number,
  profileId: ProfileId,
  expectedEndpointCap = DEFAULT_ENDPOINT_MEDIA_COPY_CAPACITY,
): RunCheck[] {
  const sfuConsistencyCheck: RunCheck = summary.sfuPublicationObserved
    ? {
        name: "sfu-route-consistency",
        passed: summary.sfuPublicationCoherent,
        actual: summary.sfuRootCount,
        expected:
          "admitted SFU subscriptions, one Host publication, and one active revision across all participants",
      }
    : {
        name: "no-orphan-sfu-publication",
        passed: summary.sfuPublicationCoherent,
        actual: summary.sfuPublicationCoherent,
        expected: "no SFU publication generation when no SFU root is active",
      };
  return [
    {
      name: "host-active-media-edges",
      passed: summary.maxHostActiveMediaEdges <= expectedEndpointCap,
      actual: summary.maxHostActiveMediaEdges,
      expected: `<= ${expectedEndpointCap}`,
    },
    {
      name: "host-assigned-children",
      passed: summary.maxHostAssignedChildren <= expectedEndpointCap,
      actual: summary.maxHostAssignedChildren,
      expected: `<= ${expectedEndpointCap}`,
    },
    {
      name: "relay-active-media-edges",
      passed: summary.maxRelayActiveMediaEdges <= expectedEndpointCap,
      actual: summary.maxRelayActiveMediaEdges,
      expected: `<= ${expectedEndpointCap}`,
    },
    {
      name: "all-viewers-decoded",
      passed: summary.everyViewerDecoded,
      actual: summary.everyViewerDecoded,
      expected: `${viewerCount} viewers with a live upstream, clean stats, and increasing decoded frames`,
    },
    sfuConsistencyCheck,
    {
      name: "quality-settings-propagated",
      passed: summary.finalTopology.every(
        (participant) =>
          JSON.stringify(participant.qualitySettings) ===
          JSON.stringify(PROFILE_SETTINGS[profileId]),
      ),
      actual: summary.finalTopology.every(
        (participant) =>
          JSON.stringify(participant.qualitySettings) ===
          JSON.stringify(PROFILE_SETTINGS[profileId]),
      ),
      expected: `${profileId} quality settings on every participant`,
    },
  ];
}

export function buildRecoveryCheck(
  recovery: RecoveryResult,
  expectedEndpointCap = DEFAULT_ENDPOINT_MEDIA_COPY_CAPACITY,
): RunCheck {
  const passed =
    recovery.triggered &&
    recovery.error === undefined &&
    recovery.recoveredAtEpochMs !== undefined &&
    recovery.maxHostActiveMediaEdges !== undefined &&
    recovery.maxHostActiveMediaEdges <= expectedEndpointCap &&
    recovery.maxHostAssignedChildren !== undefined &&
    recovery.maxHostAssignedChildren <= expectedEndpointCap;
  return {
    name: "relay-recovery-correctness",
    passed,
    actual: passed,
    expected: `decoded frames resume with host media edges and assigned children <= ${expectedEndpointCap}`,
  };
}

export function buildBenchmarkInitScript(options: {
  label: string;
  role: PageRole;
  viewerIndex: number | null;
  clearHostRoom: boolean;
  width: number;
  height: number;
  frameRate: number;
  expectedEndpointCap: number;
}): string {
  const serialized = JSON.stringify(options);
  return `(() => {
    if (globalThis.__SCREENER_BENCHMARK__) return;
    const options = ${serialized};
    const expectedRoleCap = options.expectedEndpointCap;
    if (options.clearHostRoom) {
      try { localStorage.removeItem("screener:host-room:v1"); } catch {}
    }
    const state = {
      label: options.label,
      role: options.role,
      viewerIndex: options.viewerIndex,
      roomId: null,
      peerId: null,
      authenticatedAtEpochMs: null,
      authenticateSentAtEpochMs: null,
      signalingConnected: false,
      qualitySettings: null,
      routeRevision: null,
      routeAssignment: null,
      maxActiveOutboundMediaEdges: 0,
      maxAssignedChildren: 0,
      firstDecodedAtEpochMs: null,
      firstRenderedAtEpochMs: null,
      renderedFrames: 0,
    };
    const connections = [];
    const descriptions = [];
    const accumulators = new WeakMap();
    const statsModule = import("/src/client/webrtc/stats.ts");
    let signalingSocket = null;
    let peerAssisted = false;
    let transitionRevision = -1;
    let transitionPhase = null;
    let plannedRouteAssignment = null;
    const canary = { prepareUpdates: 0, activeUpdates: 0, routeFailed: 0 };
    const nativeSends = new WeakMap();
    const routeTimingKeys = ${JSON.stringify(ROUTE_TIMING_KEYS)};
    let routeDiagnosticRequested = false;
    let routeTimingSamples = null;

    function isOpaqueId(value) {
      return typeof value === "string" &&
        value.length >= 8 &&
        value.length <= 128 &&
        /^[A-Za-z0-9_-]+$/.test(value);
    }

    function cloneRouteAssignment(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const upstream = value.upstream;
      if (!upstream || typeof upstream !== "object" || Array.isArray(upstream)) return null;
      let clonedUpstream;
      if (upstream.kind === "peer" && isOpaqueId(upstream.peerId)) {
        clonedUpstream = { kind: "peer", peerId: upstream.peerId };
      } else if (upstream.kind === "none" || upstream.kind === "sfu") {
        clonedUpstream = { kind: upstream.kind };
      } else {
        return null;
      }
      if (
        !Array.isArray(value.childPeerIds) ||
        value.childPeerIds.length > expectedRoleCap ||
        !value.childPeerIds.every(isOpaqueId) ||
        new Set(value.childPeerIds).size !== value.childPeerIds.length ||
        (value.sfuPublicationGeneration !== null &&
          !isOpaqueId(value.sfuPublicationGeneration)) ||
        (clonedUpstream.kind === "sfu" &&
          value.sfuPublicationGeneration === null) ||
        (clonedUpstream.kind === "peer" &&
          value.sfuPublicationGeneration !== null)
      ) {
        return null;
      }
      return {
        upstream: clonedUpstream,
        childPeerIds: [...value.childPeerIds],
        sfuPublicationGeneration: value.sfuPublicationGeneration,
      };
    }

    function sameRouteAssignment(left, right) {
      return left.upstream.kind === right.upstream.kind &&
        (left.upstream.kind !== "peer" ||
          (right.upstream.kind === "peer" &&
            left.upstream.peerId === right.upstream.peerId)) &&
        left.sfuPublicationGeneration === right.sfuPublicationGeneration &&
        left.childPeerIds.length === right.childPeerIds.length &&
        left.childPeerIds.every((peerId, index) => peerId === right.childPeerIds[index]);
    }

    function resetRouteTransition() {
      transitionRevision = -1;
      transitionPhase = null;
      plannedRouteAssignment = null;
      state.routeRevision = null;
      state.routeAssignment = null;
    }

    function acceptRouteUpdate(revision, phase, value) {
      const assignment = cloneRouteAssignment(value);
      if (
        !Number.isSafeInteger(revision) ||
        revision < 0 ||
        (phase !== "prepare" && phase !== "active") ||
        !assignment
      ) {
        return false;
      }
      if (revision < transitionRevision) {
        return false;
      }
      if (revision === transitionRevision) {
        if (
          !plannedRouteAssignment ||
          !sameRouteAssignment(plannedRouteAssignment, assignment) ||
          (transitionPhase === "active" && phase === "prepare")
        ) {
          return false;
        }
        if (transitionPhase === phase) {
          return true;
        }
      }
      transitionRevision = revision;
      transitionPhase = phase;
      plannedRouteAssignment = assignment;
      if (phase === "prepare") canary.prepareUpdates += 1;
      else canary.activeUpdates += 1;
      if (phase === "active") {
        state.routeRevision = revision;
        state.routeAssignment = cloneRouteAssignment(assignment);
        state.maxAssignedChildren = Math.max(
          state.maxAssignedChildren,
          assignment.childPeerIds.length,
        );
      }
      return true;
    }

    function sdpKey(sdp) {
      if (typeof sdp !== "string") return null;
      return sdp.match(/^o=.*$/m)?.[0] || sdp;
    }

    function recordDescription(message, direction) {
      const payload = message && message.payload;
      if (!payload || payload.kind !== "description" || !payload.description) return;
      descriptions.push({
        peerId: direction === "out" ? message.targetPeerId : message.fromPeerId,
        connectionId: payload.connectionId,
        sdpKey: sdpKey(payload.description.sdp),
      });
      if (descriptions.length > 128) descriptions.shift();
    }

    function sanitizeRouteTimingSamples(value) {
      const children = value && typeof value === "object" &&
        !Array.isArray(value) && Array.isArray(value.children)
        ? value.children
        : null;
      if (!children || children.length > ${MAX_VIEWERS}) return null;
      const samples = Object.fromEntries(
        routeTimingKeys.map((key) => [key, []]),
      );
      for (const child of children) {
        if (!child || typeof child !== "object" || Array.isArray(child)) {
          return null;
        }
        for (const key of routeTimingKeys) {
          const duration = child[key];
          if (
            duration !== null &&
            (!Number.isSafeInteger(duration) || duration < 0)
          ) {
            return null;
          }
          samples[key].push(duration);
        }
      }
      return samples;
    }

    function handleSignalMessage(value, direction, socket) {
      if (typeof value !== "string") return;
      let message;
      try { message = JSON.parse(value); } catch { return; }
      if (!message || typeof message.type !== "string") return;
      if (direction === "out" && message.type === "authenticate") {
        signalingSocket = socket;
        peerAssisted = false;
        state.role = message.role;
        state.roomId = message.roomId;
        state.authenticateSentAtEpochMs = Date.now();
        state.signalingConnected = false;
      } else if (socket !== signalingSocket) {
        return;
      } else if (direction === "out" && message.type === "set-quality-settings") {
        state.qualitySettings = message.qualitySettings;
      } else if (direction === "out" && message.type === "route-failed") {
        canary.routeFailed += 1;
      }
      if (direction === "in" && message.type === "authenticated") {
        state.peerId = message.peerId;
        state.authenticatedAtEpochMs = Date.now();
        state.signalingConnected = true;
        peerAssisted = message.mediaMode === "peer-assisted";
        resetRouteTransition();
        if (message.mediaMode === "peer-assisted") {
          acceptRouteUpdate(
            message.routeRevision,
            "active",
            message.routeAssignment,
          );
          state.qualitySettings = message.qualitySettings;
        }
      } else if (
        direction === "in" &&
        message.type === "route-update" &&
        peerAssisted
      ) {
        acceptRouteUpdate(message.revision, message.phase, message.assignment);
      } else if (direction === "in" && message.type === "quality-settings") {
        state.qualitySettings = message.qualitySettings;
      } else if (
        direction === "in" &&
        message.type === "route-diagnostic-snapshot" &&
        state.role === "host" &&
        routeDiagnosticRequested &&
        routeTimingSamples === null
      ) {
        routeTimingSamples = sanitizeRouteTimingSamples(message.snapshot);
      }
      if (message.type === "signal") recordDescription(message, direction);
    }

    const NativeWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = new Proxy(NativeWebSocket, {
      construct(Target, args) {
        const socket = Reflect.construct(Target, args, Target);
        const nativeSend = socket.send;
        nativeSends.set(socket, nativeSend);
        socket.send = function(data) {
          let parsed = null;
          if (typeof data === "string") { try { parsed = JSON.parse(data); } catch {} }
          const result = nativeSend.call(socket, data);
          handleSignalMessage(data, "out", socket);
          return result;
        };
        socket.addEventListener("message", (event) => {
          handleSignalMessage(event.data, "in", socket);
        });
        socket.addEventListener("close", () => {
          if (socket === signalingSocket) state.signalingConnected = false;
        });
        return socket;
      },
    });

    function sendCanaryMessage(message) {
      const socket = signalingSocket;
      const nativeSend = socket ? nativeSends.get(socket) : null;
      if (!socket || typeof nativeSend !== "function") return false;
      try {
        nativeSend.call(socket, JSON.stringify(message));
        return true;
      } catch { return false; }
    }

    function requestRouteDiagnosticSnapshot() {
      if (
        state.role !== "host" ||
        !state.signalingConnected ||
        routeDiagnosticRequested
      ) {
        return false;
      }
      routeDiagnosticRequested = true;
      if (sendCanaryMessage({ type: "request-route-diagnostic" })) {
        return true;
      }
      routeDiagnosticRequested = false;
      return false;
    }

    function routeDiagnosticTimingSamples() {
      return routeTimingSamples
        ? Object.fromEntries(
            routeTimingKeys.map((key) => [key, [...routeTimingSamples[key]]]),
          )
        : null;
    }

    const NativePeerConnection = globalThis.RTCPeerConnection;
    function recordActiveOutboundEdges() {
      const active = connections.filter(({ connection }) =>
        connection.connectionState !== "closed" &&
        connection.connectionState !== "failed" &&
        connection.getSenders().some((sender) => sender.track && sender.track.kind === "video")
      ).length;
      state.maxActiveOutboundMediaEdges = Math.max(
        state.maxActiveOutboundMediaEdges,
        active,
      );
    }

    globalThis.RTCPeerConnection = new Proxy(NativePeerConnection, {
      construct(Target, args) {
        const connection = Reflect.construct(Target, args, Target);
        connections.push({
          connection,
          index: connections.length + 1,
          createdAtEpochMs: Date.now(),
        });
        connection.addEventListener("connectionstatechange", recordActiveOutboundEdges);
        for (const method of ["addTrack", "addTransceiver", "removeTrack", "close"]) {
          const nativeMethod = connection[method];
          if (typeof nativeMethod !== "function") continue;
          connection[method] = function(...methodArgs) {
            const result = nativeMethod.apply(connection, methodArgs);
            queueMicrotask(recordActiveOutboundEdges);
            return result;
          };
        }
        recordActiveOutboundEdges();
        return connection;
      },
    });

    let syntheticStream = null;
    function createSyntheticStream() {
      if (syntheticStream && syntheticStream.getVideoTracks().some((track) => track.readyState === "live")) {
        return syntheticStream;
      }
      const canvas = document.createElement("canvas");
      canvas.width = options.width;
      canvas.height = options.height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Canvas 2D is unavailable");
      let frame = 0;
      const columns = 24;
      const rows = 14;
      const tileWidth = Math.ceil(canvas.width / columns);
      const tileHeight = Math.ceil(canvas.height / rows);
      function draw() {
        frame += 1;
        for (let row = 0; row < rows; row += 1) {
          for (let column = 0; column < columns; column += 1) {
            const value = (frame * 29 + row * 71 + column * 43) % 360;
            context.fillStyle = \`hsl(\${value} 80% \${35 + ((frame + row + column) % 30)}%)\`;
            context.fillRect(column * tileWidth, row * tileHeight, tileWidth, tileHeight);
          }
        }
        const sweep = (frame * Math.max(8, Math.floor(canvas.width / 120))) % canvas.width;
        context.fillStyle = "#ffffff";
        context.fillRect(sweep, 0, Math.max(4, Math.floor(canvas.width / 180)), canvas.height);
        context.fillStyle = "#000000";
        context.font = \`\${Math.max(24, Math.floor(canvas.height / 18))}px monospace\`;
        context.fillText(String(frame).padStart(8, "0"), 24, Math.max(48, Math.floor(canvas.height / 12)));
      }
      draw();
      const timer = setInterval(draw, 1000 / options.frameRate);
      syntheticStream = canvas.captureStream(options.frameRate);
      const track = syntheticStream.getVideoTracks()[0];
      if (track) track.addEventListener("ended", () => clearInterval(timer), { once: true });
      return syntheticStream;
    }

    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", { value: {}, configurable: true });
    }
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
      configurable: true,
      value: async () => createSyntheticStream(),
    });

    const observedVideos = new WeakSet();
    const videoObserver = setInterval(() => {
      if (options.role !== "viewer") return;
      const video = document.querySelector(".remote-stage video");
      if (!video || observedVideos.has(video)) return;
      observedVideos.add(video);
      if (typeof video.requestVideoFrameCallback === "function") {
        const onFrame = (now) => {
          const at = performance.timeOrigin + now;
          if (state.firstRenderedAtEpochMs === null) state.firstRenderedAtEpochMs = at;
          state.renderedFrames += 1;
          video.requestVideoFrameCallback(onFrame);
        };
        video.requestVideoFrameCallback(onFrame);
      }
    }, 50);

    function identify(connection) {
      const localSdpKey = sdpKey(connection.localDescription && connection.localDescription.sdp);
      const remoteSdpKey = sdpKey(connection.remoteDescription && connection.remoteDescription.sdp);
      for (let index = descriptions.length - 1; index >= 0; index -= 1) {
        const item = descriptions[index];
        if (item.sdpKey === localSdpKey || item.sdpKey === remoteSdpKey) {
          return { connectionId: item.connectionId || null, remotePeerId: item.peerId || null };
        }
      }
      return { connectionId: null, remotePeerId: null };
    }

    function totals(report, type) {
      let selected = null;
      report.forEach((raw) => {
        if (raw.type === type && raw.kind === "video" && raw.isRemote !== true) selected = raw;
      });
      if (!selected) return null;
      const framesKey = type === "outbound-rtp" ? "framesEncoded" : "framesDecoded";
      const bytesKey = type === "outbound-rtp" ? "bytesSent" : "bytesReceived";
      return {
        id: selected.id,
        framesTotal: Number.isFinite(selected[framesKey]) ? selected[framesKey] : null,
        bytesTotal: Number.isFinite(selected[bytesKey]) ? selected[bytesKey] : null,
      };
    }

    async function connectionSample(record) {
      const connection = record.connection;
      const hasOutboundVideo = connection.getSenders().some((sender) => sender.track && sender.track.kind === "video");
      const hasInboundVideo = connection.getReceivers().some((receiver) => receiver.track && receiver.track.kind === "video");
      const identity = identify(connection);
      try {
        let accumulator = accumulators.get(connection);
        const module = await statsModule;
        if (!accumulator) {
          accumulator = { send: module.createStatsAccumulator(), receive: module.createStatsAccumulator() };
          accumulators.set(connection, accumulator);
        }
        const send = hasOutboundVideo
          ? await module.collectConnectionMetrics(connection, "send", accumulator.send)
          : null;
        const receive = hasInboundVideo
          ? await module.collectConnectionMetrics(connection, "receive", accumulator.receive)
          : null;
        const report = await connection.getStats();
        const sendTotals = totals(report, "outbound-rtp");
        const receiveTotals = totals(report, "inbound-rtp");
        if (receiveTotals && receiveTotals.framesTotal > 0 && state.firstDecodedAtEpochMs === null) {
          state.firstDecodedAtEpochMs = Date.now();
        }
        return {
          index: record.index,
          createdAtEpochMs: record.createdAtEpochMs,
          ...identity,
          connectionState: connection.connectionState,
          iceConnectionState: connection.iceConnectionState,
          hasOutboundVideo,
          hasInboundVideo,
          send,
          receive,
          sendTotals,
          receiveTotals,
        };
      } catch (error) {
        return {
          index: record.index,
          createdAtEpochMs: record.createdAtEpochMs,
          ...identity,
          connectionState: connection.connectionState,
          iceConnectionState: connection.iceConnectionState,
          hasOutboundVideo,
          hasInboundVideo,
          send: null,
          receive: null,
          sendTotals: null,
          receiveTotals: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    function baseSnapshot() {
      return {
        ...state,
        routeAssignment: cloneRouteAssignment(state.routeAssignment),
      };
    }

    async function sample() {
      const sampledConnections = await Promise.all(connections.map(connectionSample));
      return { ...baseSnapshot(), connections: sampledConnections };
    }

    async function progress() {
      const values = [];
      for (const record of connections) {
        const connection = record.connection;
        const hasOutboundVideo = connection.getSenders().some((sender) => sender.track && sender.track.kind === "video");
        const hasInboundVideo = connection.getReceivers().some((receiver) => receiver.track && receiver.track.kind === "video");
        try {
          const report = hasInboundVideo ? await connection.getStats() : null;
          const receiveTotals = report ? totals(report, "inbound-rtp") : null;
          if (receiveTotals && receiveTotals.framesTotal > 0 && state.firstDecodedAtEpochMs === null) {
            state.firstDecodedAtEpochMs = Date.now();
          }
          values.push({
            index: record.index,
            ...identify(connection),
            connectionState: connection.connectionState,
            iceConnectionState: connection.iceConnectionState,
            hasOutboundVideo,
            hasInboundVideo,
            receiveTotals,
          });
        } catch {}
      }
      return { ...baseSnapshot(), connections: values };
    }

    function snapshot() {
      return {
        ...baseSnapshot(),
        connections: connections.map((record) => ({
          index: record.index,
          ...identify(record.connection),
          connectionState: record.connection.connectionState,
          iceConnectionState: record.connection.iceConnectionState,
          hasOutboundVideo: record.connection.getSenders().some((sender) => sender.track && sender.track.kind === "video"),
          hasInboundVideo: record.connection.getReceivers().some((receiver) => receiver.track && receiver.track.kind === "video"),
        })),
      };
    }

    function canarySnapshot() {
      return { ...canary, connectionCount: connections.length, maxActiveOutboundMediaEdges: state.maxActiveOutboundMediaEdges };
    }
    function sendViewerQualityEvidence(message) {
      return message?.type === "viewer-quality-evidence" && sendCanaryMessage(message);
    }
    Object.defineProperty(globalThis, "__SCREENER_BENCHMARK__", {
      configurable: false,
      value: { sample, progress, snapshot, canarySnapshot, sendViewerQualityEvidence, requestRouteDiagnosticSnapshot, routeDiagnosticTimingSamples, stop: () => clearInterval(videoObserver) },
    });
  })();`;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a local TCP port");
  }
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  return address.port;
}

function startProcess(command: string, args: string[], environment?: NodeJS.ProcessEnv): ManagedProcess {
  const log = new BoundedLog();
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk: Buffer) => log.append(chunk));
  child.stderr?.on("data", (chunk: Buffer) => log.append(chunk));
  return { child, log };
}

async function waitForHttp(
  url: string,
  process: ManagedProcess,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process.child.exitCode !== null) {
      throw new Error(`Process exited before ${url} was ready\n${process.log.tail()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        return;
      }
    } catch {
      // Startup polling owns the retry.
    }
    await delay(100, signal);
  }
  throw new Error(`Timed out waiting for ${url}\n${process.log.tail()}`);
}

async function stopProcess(process: ManagedProcess | null): Promise<void> {
  if (!process || process.child.exitCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolveExit) => process.child.once("exit", () => resolveExit()));
  process.child.kill("SIGTERM");
  if (await promiseSettledWithin(exited, 3_000)) {
    return;
  }
  process.child.kill("SIGKILL");
  await promiseSettledWithin(exited, 2_000);
}

async function promiseSettledWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    if (signal?.aborted) {
      rejectDelay(new Error("Benchmark interrupted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      rejectDelay(new Error("Benchmark interrupted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function evaluate<T>(
  cdp: CdpConnection,
  page: PageHandle,
  expression: string,
): Promise<T> {
  const evaluation = await cdp.call<RuntimeEvaluation<T>>(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    },
    page.sessionId,
  );
  if (evaluation.exceptionDetails) {
    throw new Error(
      evaluation.exceptionDetails.exception?.description ??
        evaluation.exceptionDetails.text ??
        "Browser evaluation failed",
    );
  }
  return evaluation.result.value as T;
}

export async function createPage(
  cdp: CdpConnection,
  url: string,
  options: Parameters<typeof buildBenchmarkInitScript>[0],
  signal: AbortSignal,
): Promise<PageHandle> {
  const created = await cdp.call<{ targetId: string }>("Target.createTarget", {
    url: "about:blank",
    background: false,
  });
  try {
    const attached = await cdp.call<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId: created.targetId, flatten: true },
    );
    const page: PageHandle = {
      targetId: created.targetId,
      sessionId: attached.sessionId,
      label: options.label,
    };
    await Promise.all([
      cdp.call("Page.enable", {}, page.sessionId),
      cdp.call("Runtime.enable", {}, page.sessionId),
    ]);
    await cdp.call(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: buildBenchmarkInitScript(options) },
      page.sessionId,
    );
    const navigation = await cdp.call<{ errorText?: string }>(
      "Page.navigate",
      { url },
      page.sessionId,
    );
    if (navigation.errorText) {
      throw new Error(`Navigation failed: ${navigation.errorText}`);
    }
    await waitForPage(
      cdp,
      page,
      "document.readyState === 'complete' && Boolean(globalThis.__SCREENER_BENCHMARK__)",
      15_000,
      "page initialization",
      signal,
    );
    return page;
  } catch (error) {
    await closeTarget(cdp, created.targetId);
    throw error;
  }
}

async function closeTarget(cdp: CdpConnection, targetId: string): Promise<void> {
  try {
    await cdp.call("Target.closeTarget", { targetId });
  } catch {
    // Browser shutdown and a prior recovery close make target cleanup idempotent.
  }
}

async function closePage(cdp: CdpConnection, page: PageHandle): Promise<void> {
  await closeTarget(cdp, page.targetId);
}

async function waitForPage(
  cdp: CdpConnection,
  page: PageHandle,
  predicate: string,
  timeoutMs: number,
  description: string,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate<boolean>(cdp, page, `Boolean(${predicate})`)) {
        return;
      }
    } catch {
      // Navigation can transiently invalidate an execution context.
    }
    await delay(100, signal);
  }
  throw new Error(`Timed out waiting for ${description} in ${page.label}`);
}

async function quickSnapshot(
  cdp: CdpConnection,
  page: PageHandle,
): Promise<PageObservation> {
  return evaluate<PageObservation>(
    cdp,
    page,
    "globalThis.__SCREENER_BENCHMARK__.snapshot()",
  );
}

async function detailedSample(
  cdp: CdpConnection,
  page: PageHandle,
): Promise<PageObservation> {
  return evaluate<PageObservation>(
    cdp,
    page,
    "globalThis.__SCREENER_BENCHMARK__.sample()",
  );
}

async function progressSample(
  cdp: CdpConnection,
  page: PageHandle,
): Promise<PageObservation> {
  return evaluate<PageObservation>(
    cdp,
    page,
    "globalThis.__SCREENER_BENCHMARK__.progress()",
  );
}

export function buildBenchmarkFailureEvidence(
  pages: readonly PageObservation[],
  expectedPageCount: number,
): BenchmarkFailureEvidence {
  return {
    expectedPageCount,
    observedPageCount: pages.length,
    pages: pages.map(sanitizeFailurePageEvidence),
  };
}

async function captureFailureEvidence(
  cdp: CdpConnection,
  pages: readonly PageHandle[],
  expectedPageCount: number,
): Promise<BenchmarkFailureEvidence> {
  const observations = await Promise.allSettled(
    pages
      .slice(0, MAX_VIEWERS + 1)
      .map((page) => progressSample(cdp, page)),
  );
  return buildBenchmarkFailureEvidence(
    observations.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    ),
    expectedPageCount,
  );
}

async function startHost(
  cdp: CdpConnection,
  page: PageHandle,
  profileId: ProfileId,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<PageObservation> {
  const profileIndex = Object.keys(PROFILE_SETTINGS).indexOf(profileId);
  await waitForPage(
    cdp,
    page,
    "document.querySelector('.entry-actions button.entry-action')",
    15_000,
    "host controls",
    signal,
  );
  await evaluate(
    cdp,
    page,
    `(() => {
      const profiles = document.querySelectorAll('.quality-controls .segmented-control button');
      const profile = profiles[${profileIndex}];
      if (!(profile instanceof HTMLButtonElement)) throw new Error('Quality profile button missing');
      profile.click();
      const start = document.querySelector('.entry-actions button.entry-action');
      if (!(start instanceof HTMLButtonElement)) throw new Error('Start button missing');
      start.click();
      return true;
    })()`,
  );
  await waitForPage(
    cdp,
    page,
    "globalThis.__SCREENER_BENCHMARK__.snapshot().peerId !== null",
    timeoutMs,
    "host signaling authentication",
    signal,
  );
  const snapshot = await quickSnapshot(cdp, page);
  if (!snapshot.roomId) {
    throw new Error("Host authenticated without a recorded room ID");
  }
  return snapshot;
}

async function waitForViewerMedia(
  cdp: CdpConnection,
  page: PageHandle,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<PageObservation> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await progressSample(cdp, page);
    if (
      snapshot.peerId &&
      hasAuthoritativeMediaUpstream(snapshot) &&
      snapshot.connections.some(
        (connection) =>
          connection.connectionState === "connected" &&
          connection.receiveTotals !== null &&
          (connection.receiveTotals.framesTotal ?? 0) > 0,
      )
    ) {
      return snapshot;
    }
    await delay(100, signal);
  }
  throw new Error(`Timed out waiting for decoded media in ${page.label}`);
}

async function requestRouteTimingSummary(
  cdp: CdpConnection,
  hostPage: PageHandle,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<BenchmarkRouteTimingSummary> {
  const requested = await evaluate<boolean>(
    cdp,
    hostPage,
    "globalThis.__SCREENER_BENCHMARK__.requestRouteDiagnosticSnapshot()",
  );
  if (!requested) {
    throw new Error("Host route diagnostic request was unavailable");
  }
  await waitForPage(
    cdp,
    hostPage,
    "globalThis.__SCREENER_BENCHMARK__.routeDiagnosticTimingSamples() !== null",
    timeoutMs,
    "Host route diagnostic snapshot",
    signal,
  );
  const samples = await evaluate<BenchmarkRouteTimingSamples>(
    cdp,
    hostPage,
    "globalThis.__SCREENER_BENCHMARK__.routeDiagnosticTimingSamples()",
  );
  return summarizeBenchmarkRouteTiming(samples);
}

async function samplePages(
  cdp: CdpConnection,
  pages: PageHandle[],
  startedAtMs: number,
): Promise<TimedSample> {
  const atEpochMs = Date.now();
  const [observations, browserProcesses] = await Promise.all([
    Promise.all(pages.map((page) => detailedSample(cdp, page))),
    sampleBrowserProcesses(cdp),
  ]);
  return {
    atEpochMs,
    elapsedMs: atEpochMs - startedAtMs,
    pages: observations,
    browserProcesses,
  };
}

async function sampleBrowserProcesses(cdp: CdpConnection): Promise<BrowserProcessSample | null> {
  try {
    const result = await cdp.call<{ processInfo: unknown[] }>("SystemInfo.getProcessInfo");
    if (!Array.isArray(result.processInfo)) return null;
    const processes: BrowserProcessSample["processes"] = [];
    const identities = new Set<string>();
    for (const raw of result.processInfo) {
      if (!raw || typeof raw !== "object") return null;
      const { type, id, cpuTime } = raw as Record<string, unknown>;
      if (typeof type !== "string" || type.length === 0 || !Number.isSafeInteger(id) || Number(id) < 0 || typeof cpuTime !== "number" || !Number.isFinite(cpuTime) || cpuTime < 0) return null;
      const identity = `${type}:${id}`;
      if (identities.has(identity)) return null;
      identities.add(identity);
      processes.push({ type, id: Number(id), cpuTimeSeconds: cpuTime });
    }
    return { processes: processes.sort((left, right) => left.id - right.id || left.type.localeCompare(right.type)) };
  } catch {
    return null;
  }
}

function peerConnectionFingerprint(pages: PageObservation[]): string {
  return pages
    .map((page) =>
      [
        page.label,
        ...page.connections.map(
          (connection) =>
            `${connection.index}:${connection.connectionId ?? "?"}`,
        ),
      ].join("|"),
    )
    .sort()
    .join("\n");
}

async function applyQualityPreference(
  cdp: CdpConnection,
  hostPage: PageHandle,
  label: "平衡" | "清晰优先",
  signal: AbortSignal,
): Promise<void> {
  const serializedLabel = JSON.stringify(label);
  await evaluate(
    cdp,
    hostPage,
    `(() => {
      const details = document.querySelector('.advanced-quality');
      if (!(details instanceof HTMLDetailsElement)) return false;
      details.open = true;
      const button = Array.from(document.querySelectorAll('.quality-priority button'))
        .find((item) => item.textContent?.trim() === ${serializedLabel});
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`,
  );
  await waitForPage(
    cdp,
    hostPage,
    `Array.from(document.querySelectorAll('.quality-priority button.is-selected')).some((item) => item.textContent?.trim() === ${serializedLabel})`,
    5_000,
    `${label} advanced quality selection`,
    signal,
  );
  await evaluate(
    cdp,
    hostPage,
    `(() => {
      const button = Array.from(document.querySelectorAll('.advanced-quality-grid > button'))
        .find((item) => item.textContent?.includes('应用视频设置'));
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`,
  );
}

async function runQualityControlSmoke(
  cdp: CdpConnection,
  pages: PageHandle[],
  initialSettings: QualitySettings,
  signal: AbortSignal,
): Promise<{
  settingsPropagated: boolean;
  peerConnectionsStable: boolean;
  senderReadbacksMatched: boolean;
  viewersAdvanced: boolean;
}> {
  const hostPage = pages[0];
  if (!hostPage) {
    throw new Error("Quality control smoke requires a host page");
  }
  const baseline = await Promise.all(pages.map((page) => quickSnapshot(cdp, page)));
  const baselineFingerprint = peerConnectionFingerprint(baseline);
  const balanced = {
    ...initialSettings,
    degradationPreference: "balanced",
  } as const satisfies QualitySettings;

  const waitForSettings = async (settings: QualitySettings): Promise<boolean> => {
    const serializedSettings = JSON.stringify(JSON.stringify(settings));
    await Promise.all(
      pages.map((page) =>
        waitForPage(
          cdp,
          page,
          `JSON.stringify(globalThis.__SCREENER_BENCHMARK__.snapshot().qualitySettings) === ${serializedSettings}`,
          10_000,
          `${settings.degradationPreference} quality propagation`,
          signal,
        ),
      ),
    );
    const snapshots = await Promise.all(
      pages.map((page) => quickSnapshot(cdp, page)),
    );
    return snapshots.every(
      (page) =>
        page.qualitySettings !== null &&
        qualitySettingsEqual(page.qualitySettings, settings),
    );
  };
  const activeSenderCounts = new Map(
    baseline.map((page) => [page.label, activeVideoEdgeCount(page, "send")]),
  );
  const sendingPages = pages.filter(
    (page) => (activeSenderCounts.get(page.label) ?? 0) > 0,
  );
  await Promise.all(
    sendingPages.map((page) =>
      evaluate(
        cdp,
        page,
        `(() => {
          const toggle = document.querySelector('.connection-details-toggle input');
          if (!(toggle instanceof HTMLInputElement)) return false;
          if (!toggle.checked) toggle.click();
          return true;
        })()`,
      ),
    ),
  );
  const waitForReadback = async (
    label: "平衡" | "清晰",
  ): Promise<boolean> => {
    const matched = await Promise.all(
      sendingPages.map(async (page) => {
        const expectedCount = activeSenderCounts.get(page.label) ?? 0;
        const expected = JSON.stringify(`${label} / ${label}`);
        const predicate = `(() => {
          const values = Array.from(document.querySelectorAll('.metric'))
            .filter((metric) => metric.querySelector('dt')?.textContent?.trim() === '请求 / 应用优先级')
            .map((metric) => metric.querySelector('dd')?.textContent?.trim());
          return values.length === ${expectedCount} && values.every((value) => value === ${expected});
        })()`;
        await waitForPage(
          cdp,
          page,
          predicate,
          10_000,
          `${label} sender parameter readback`,
          signal,
        );
        return evaluate<boolean>(cdp, page, `Boolean(${predicate})`);
      }),
    );
    return (
      sendingPages.length > 0 &&
      matched.length === sendingPages.length &&
      matched.every(Boolean)
    );
  };
  const viewerPages = pages.slice(1);
  const waitForViewerProgress = async (): Promise<boolean> => {
    for (const page of viewerPages) {
      await cdp.call("Page.bringToFront", {}, page.sessionId);
      const before = [await progressSample(cdp, page)];
      const deadline = Date.now() + 10_000;
      let advanced = false;
      while (Date.now() < deadline) {
        const after = [await progressSample(cdp, page)];
        if (everyViewerAdvanced(before, after)) {
          advanced = true;
          break;
        }
        await delay(100, signal);
      }
      if (!advanced) {
        return false;
      }
    }
    return viewerPages.length > 0;
  };

  const runStep = async (
    label: "平衡" | "清晰优先",
    readbackLabel: "平衡" | "清晰",
    settings: QualitySettings,
  ): Promise<{
    settingsPropagated: boolean;
    senderReadbacksMatched: boolean;
    viewersAdvanced: boolean;
  }> => {
    await cdp.call("Page.bringToFront", {}, hostPage.sessionId);
    await applyQualityPreference(cdp, hostPage, label, signal);
    const settingsPropagated = await waitForSettings(settings);
    const senderReadbacksMatched = await waitForReadback(readbackLabel);
    const viewersAdvanced = await waitForViewerProgress();
    return {
      settingsPropagated,
      senderReadbacksMatched,
      viewersAdvanced,
    };
  };

  const balancedResult = await runStep("平衡", "平衡", balanced);
  const clarityResult = await runStep("清晰优先", "清晰", initialSettings);

  const final = await Promise.all(pages.map((page) => quickSnapshot(cdp, page)));

  return {
    settingsPropagated:
      balancedResult.settingsPropagated && clarityResult.settingsPropagated,
    peerConnectionsStable:
      peerConnectionFingerprint(final) === baselineFingerprint,
    senderReadbacksMatched:
      balancedResult.senderReadbacksMatched &&
      clarityResult.senderReadbacksMatched,
    viewersAdvanced:
      balancedResult.viewersAdvanced && clarityResult.viewersAdvanced,
  };
}

function totalDecodedFrames(page: PageObservation): number {
  return page.connections.reduce(
    (total, connection) => total + (connection.receiveTotals?.framesTotal ?? 0),
    0,
  );
}

export function everyViewerAdvanced(
  before: PageObservation[],
  after: PageObservation[],
): boolean {
  const baselineViewers = before.filter((page) => page.role === "viewer");
  const currentByLabel = new Map(after.map((page) => [page.label, page]));
  return (
    baselineViewers.length > 0 &&
    baselineViewers.every((baseline) => {
      const current = currentByLabel.get(baseline.label);
      return (
        current !== undefined &&
        totalDecodedFrames(current) > totalDecodedFrames(baseline) &&
        current.renderedFrames > baseline.renderedFrames
      );
    })
  );
}

function recoveryViewerBaseline(
  page: PageObservation,
): RecoveryViewerBaseline | null {
  const upstream = page.routeAssignment?.upstream;
  if (page.routeRevision === null || !upstream || upstream.kind === "none") {
    return null;
  }
  const parentPeerId = upstream.kind === "peer" ? upstream.peerId : null;
  const candidates = page.connections.filter((connection) => {
    const framesTotal = connection.receiveTotals?.framesTotal;
    return (
      connection.hasInboundVideo &&
      connection.connectionState === "connected" &&
      typeof connection.receiveTotals?.id === "string" &&
      connection.receiveTotals.id.length > 0 &&
      typeof framesTotal === "number" &&
      Number.isFinite(framesTotal) &&
      framesTotal >= 0 &&
      (parentPeerId === null || connection.remotePeerId === parentPeerId)
    );
  });
  if (candidates.length !== 1) {
    return null;
  }
  const connection = candidates[0]!;
  return {
    label: page.label,
    routeRevision: page.routeRevision,
    upstreamKind: upstream.kind,
    parentPeerId,
    connectionId: connection.connectionId,
    connectionIndex: connection.index,
    rtpId: connection.receiveTotals!.id,
    framesTotal: connection.receiveTotals!.framesTotal!,
  };
}

export function captureRecoveryViewerBaselines(
  pages: PageObservation[],
): RecoveryViewerBaseline[] | null {
  const viewers = pages.filter((page) => page.role === "viewer");
  const baselines = viewers.map(recoveryViewerBaseline);
  return viewers.length > 0 && baselines.every((baseline) => baseline !== null)
    ? baselines
    : null;
}

export function everyViewerRecoveredMedia(
  baselines: RecoveryViewerBaseline[] | null,
  after: PageObservation[],
): boolean {
  if (!baselines || baselines.length === 0) {
    return false;
  }
  const currentViewers = after.filter((page) => page.role === "viewer");
  const currentByLabel = new Map(currentViewers.map((page) => [page.label, page]));
  return (
    currentViewers.length === baselines.length &&
    currentByLabel.size === baselines.length &&
    baselines.every((baseline) => {
      const currentPage = currentByLabel.get(baseline.label);
      const current = currentPage ? recoveryViewerBaseline(currentPage) : null;
      return (
        current !== null &&
        current.routeRevision === baseline.routeRevision &&
        current.upstreamKind === baseline.upstreamKind &&
        current.parentPeerId === baseline.parentPeerId &&
        current.connectionId === baseline.connectionId &&
        current.connectionIndex === baseline.connectionIndex &&
        current.rtpId === baseline.rtpId &&
        current.framesTotal > baseline.framesTotal
      );
    })
  );
}

export function mergeRecoveryHostPeaks(
  peaks: RecoveryHostPeaks,
  host: PageObservation,
): RecoveryHostPeaks {
  if (
    !Number.isFinite(host.maxActiveOutboundMediaEdges) ||
    !Number.isFinite(host.maxAssignedChildren)
  ) {
    return peaks;
  }
  return {
    maxHostActiveMediaEdges: Math.max(
      peaks.maxHostActiveMediaEdges ?? 0,
      activeVideoEdgeCount(host, "send"),
      host.maxActiveOutboundMediaEdges,
    ),
    maxHostAssignedChildren: Math.max(
      peaks.maxHostAssignedChildren ?? 0,
      routeChildPeerIds(host).length,
      host.maxAssignedChildren,
    ),
  };
}

function descendantsOf(
  rootPeerId: string,
  pages: PageObservation[],
): string[] {
  const descendants: string[] = [];
  const queue = [rootPeerId];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const page of pages) {
      if (
        page.peerId &&
        routeParentPeerId(page) === parent &&
        !descendants.includes(page.peerId)
      ) {
        descendants.push(page.peerId);
        queue.push(page.peerId);
      }
    }
  }
  return descendants;
}

async function runRecovery(
  cdp: CdpConnection,
  pages: PageHandle[],
  finalPages: PageObservation[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<RecoveryResult> {
  const host = finalPages.find((page) => page.role === "host");
  if (!host?.peerId) {
    return { triggered: true, error: "Host topology was unavailable" };
  }
  const relay = finalPages.find(
    (page) =>
      page.role === "viewer" &&
      routeParentPeerId(page) === host.peerId &&
      routeChildPeerIds(page).length > 0,
  );
  if (!relay?.peerId) {
    return { triggered: true, error: "No first-level relay was available" };
  }
  const affectedPeerIds = descendantsOf(relay.peerId, finalPages);
  const relayHandle = pages.find((page) => page.label === relay.label);
  if (!relayHandle || affectedPeerIds.length === 0) {
    return { triggered: true, error: "Relay had no measurable descendant branch" };
  }
  const failureAtEpochMs = Date.now();
  await closePage(cdp, relayHandle);
  const remainingPages = pages.filter((page) => page !== relayHandle);
  const deadline = failureAtEpochMs + timeoutMs;
  let reassignedAtEpochMs: number | undefined;
  let remainingViewerBaselines: RecoveryViewerBaseline[] | null = null;
  let hostPeaks: RecoveryHostPeaks = {};

  while (Date.now() < deadline) {
    const observations = await Promise.all(
      remainingPages.map((page) => progressSample(cdp, page)),
    );
    const currentHost = observations.find((page) => page.role === "host");
    if (currentHost) {
      hostPeaks = mergeRecoveryHostPeaks(hostPeaks, currentHost);
    }
    const affected = observations.filter((page) =>
      page.peerId ? affectedPeerIds.includes(page.peerId) : false,
    );
    const branchReassigned =
      affected.length === affectedPeerIds.length &&
      affected.every(
        (page) =>
          routeParentPeerId(page) !== null &&
          routeParentPeerId(page) !== relay.peerId,
      );
    if (!reassignedAtEpochMs && branchReassigned) {
      reassignedAtEpochMs = Date.now();
    }
    if (
      reassignedAtEpochMs &&
      branchReassigned &&
      remainingViewerBaselines === null
    ) {
      const baselines = captureRecoveryViewerBaselines(observations);
      const remainingViewerCount = remainingPages.length - 1;
      if (baselines?.length === remainingViewerCount) {
        remainingViewerBaselines = baselines;
      }
    } else if (
      reassignedAtEpochMs &&
      everyViewerRecoveredMedia(remainingViewerBaselines, observations)
    ) {
      const recoveredAtEpochMs = Date.now();
      return {
        triggered: true,
        relayPeerId: relay.peerId,
        affectedPeerIds,
        failureAtEpochMs,
        reassignedAtEpochMs,
        recoveredAtEpochMs,
        recoveryMs: recoveredAtEpochMs - failureAtEpochMs,
        ...hostPeaks,
      };
    }
    await delay(100, signal);
  }
  return {
    triggered: true,
    relayPeerId: relay.peerId,
    affectedPeerIds,
    failureAtEpochMs,
    reassignedAtEpochMs,
    ...hostPeaks,
    error: "Recovery did not resume decoded frames before the timeout",
  };
}

async function runViewerMbbCanary(
  cdp: CdpConnection,
  pages: PageHandle[],
  signal: AbortSignal,
): Promise<ViewerMbbCanaryResult> {
  const failed = (failureCode: ViewerMbbCanaryResult["failureCode"]): ViewerMbbCanaryResult => ({
    kind: "viewer-mbb", status: "failed", assertions: {}, counters: {}, failureCode,
  });
  let parentHandle: PageHandle | null = null;
  try {
    const observations = await Promise.all(pages.map((page) => progressSample(cdp, page)));
    const byPeer = new Map(observations.flatMap((page) => page.peerId ? [[page.peerId, page] as const] : []));
    const viewers = observations.filter((page) => page.role === "viewer");
    const target = viewers.find((page) => {
      const upstream = page.routeAssignment?.upstream;
      const parent = upstream?.kind === "peer" ? byPeer.get(upstream.peerId) : null;
      return page.routeRevision !== null && upstream?.kind === "peer" &&
        parent?.role === "viewer" && page.routeAssignment?.childPeerIds.length === 0;
    });
    const candidate = viewers.find((page) => page !== target && page.peerId &&
      page.routeAssignment?.childPeerIds.length === 0 && hasAuthoritativeMediaUpstream(page) &&
      activeVideoEdgeCount(page, "send") === 0);
    if (!target || !candidate || target.routeAssignment?.upstream.kind !== "peer") return failed("topology-unavailable");
    const parent = byPeer.get(target.routeAssignment.upstream.peerId);
    if (!parent) return failed("topology-unavailable");
    const targetHandle = pages.find((page) => page.label === target.label);
    parentHandle = pages.find((page) => page.label === parent.label) ?? null;
    const candidateHandle = pages.find((page) => page.label === candidate.label);
    const old = target.connections.find((connection) =>
      connection.hasInboundVideo && connection.connectionState === "connected" &&
      connection.remotePeerId === parent.peerId && connection.connectionId,
    );
    if (!targetHandle || !parentHandle || !candidateHandle || !old || target.routeRevision === null || !target.peerId || !parent.peerId || !old.connectionId) return failed("probe-unavailable");
    const oldFrames = old.receiveTotals?.framesTotal ?? 0;
    const revision = target.routeRevision;
    const send = (page: PageHandle, method: string, message: unknown) =>
      evaluate<boolean>(cdp, page, `globalThis.__SCREENER_BENCHMARK__.${method}(${JSON.stringify(message)})`);
    let windows = 0;
    for (let sequence = 0; sequence < 3; sequence += 1) {
      const windowSent = await send(targetHandle, "sendViewerQualityEvidence", {
        type: "viewer-quality-evidence", guard: { connectionId: old.connectionId, routeRevision: revision },
        sequence, windowMs: 2_000,
        metrics: { width: null, height: null, framesPerSecond: 0, bitrateKbps: 0,
          packetsReceivedDelta: 100, packetsLostDelta: 0, jitterMs: 0, framesDecodedDelta: 0,
          framesDroppedDelta: 0, decodeMsPerFrame: 0, freezeCountDelta: 0, freezeDurationMsDelta: null,
          codec: null, codecProfile: null, codecParameters: null },
      });
      if (windowSent) windows += 1;
      if (sequence < 2) await delay(2_100, signal);
    }
    let retained = false, provisional = false, promoted = false, sameIdentity = false, framesAdvanced = false;
    let newId: string | null = null, newIndex: number | null = null;
    let targetTelemetry = await canary(cdp, targetHandle);
    let parentTelemetry = await canary(cdp, parentHandle);
    let candidateTelemetry = await canary(cdp, candidateHandle);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const current = await progressSample(cdp, targetHandle);
      targetTelemetry = await canary(cdp, targetHandle);
      parentTelemetry = await canary(cdp, parentHandle);
      candidateTelemetry = await canary(cdp, candidateHandle);
      const currentOld = current.connections.find((connection) => connection.connectionId === old.connectionId);
      const currentNew = current.connections.find((connection) => connection.hasInboundVideo && connection.index !== old.index && connection.connectionState === "connected" && connection.connectionId !== old.connectionId);
      if (currentOld?.connectionState === "connected" && currentNew) {
        retained = true; provisional = true; newId = currentNew.connectionId; newIndex = currentNew.index;
      }
      framesAdvanced ||= (currentOld?.receiveTotals?.framesTotal ?? oldFrames) > oldFrames;
      const upstream = current.routeAssignment?.upstream;
      const upstreamPeerId = upstream?.kind === "peer" ? upstream.peerId : null;
      promoted = current.routeRevision !== null && current.routeRevision !== revision && upstreamPeerId !== null && upstreamPeerId !== parent.peerId;
      if (promoted) {
        const active = current.connections.find((connection) => connection.hasInboundVideo && connection.connectionState === "connected" && connection.remotePeerId === upstreamPeerId);
        sameIdentity = Boolean(active && ((newId && active.connectionId === newId) || (!newId && active.index === newIndex)));
      }
      if (promoted && sameIdentity && retained && framesAdvanced) break;
      await delay(100, signal);
    }
    const assertions = {
      syntheticViewerEvidence: windows === 3,
      oldEdgeRetained: retained,
      provisionalPcObserved: provisional,
      promotedToViewerCandidate: promoted,
      provisionalIdentityPromoted: sameIdentity,
      oldMediaFramesAdvanced: framesAdvanced,
      endpointCapRespected: Math.max(targetTelemetry.maxActiveOutboundMediaEdges, parentTelemetry.maxActiveOutboundMediaEdges, candidateTelemetry.maxActiveOutboundMediaEdges) <= 1,
      noRouteFailed: targetTelemetry.routeFailed === 0 && parentTelemetry.routeFailed === 0 && candidateTelemetry.routeFailed === 0,
    };
    return { kind: "viewer-mbb", status: Object.values(assertions).every(Boolean) ? "passed" : "failed", assertions,
      counters: { pages: pages.length, evidenceWindows: windows,
        routePrepareUpdates: targetTelemetry.prepareUpdates + parentTelemetry.prepareUpdates + candidateTelemetry.prepareUpdates,
        routeActiveUpdates: targetTelemetry.activeUpdates + parentTelemetry.activeUpdates + candidateTelemetry.activeUpdates,
        maxActiveOutboundEdges: Math.max(targetTelemetry.maxActiveOutboundMediaEdges, parentTelemetry.maxActiveOutboundMediaEdges, candidateTelemetry.maxActiveOutboundMediaEdges),
        routeFailedMessages: targetTelemetry.routeFailed + parentTelemetry.routeFailed + candidateTelemetry.routeFailed },
      ...(Object.values(assertions).every(Boolean) ? {} : { failureCode: "probe-unavailable" as const }) };
  } catch {
    return failed("probe-unavailable");
  }
}

async function canary(cdp: CdpConnection, page: PageHandle): Promise<{
  prepareUpdates: number; activeUpdates: number; routeFailed: number;
  maxActiveOutboundMediaEdges: number;
}> {
  return evaluate(cdp, page, "globalThis.__SCREENER_BENCHMARK__.canarySnapshot()");
}

function canaryChecks(result: ViewerMbbCanaryResult): RunCheck[] {
  return [
    ...Object.entries(result.assertions).map(([name, passed]) => ({
      name: `viewer-mbb-${name}`, passed, actual: passed, expected: "true",
    })),
    ...Object.entries(result.counters).map(([name, actual]) => ({
      name: `viewer-mbb-counter-${name}`, passed: true, actual, expected: "sanitized counter",
    })),
  ];
}

async function runCase(
  cdp: CdpConnection,
  baseUrl: string,
  config: BenchmarkConfig,
  viewerCount: number,
  signal: AbortSignal,
): Promise<BenchmarkRun> {
  const startedAtMs = Date.now();
  const pages: PageHandle[] = [];
  const samples: TimedSample[] = [];
  let recovery: RecoveryResult = { triggered: false };
  let routeTimingSummary: BenchmarkRouteTimingSummary | null = null;
  let routeTimingStatus: BenchmarkRun["routeTimingStatus"] = "not-requested";
  try {
    const capture = PROFILE_SETTINGS[config.profileId];
    const captureResolution = QUALITY_RESOLUTIONS[capture.resolution];
    const commonInit = {
      width: captureResolution.width,
      height: captureResolution.height,
      frameRate: capture.maxFramerate,
      expectedEndpointCap: config.expectedEndpointCap,
    };
    const hostPage = await createPage(cdp, baseUrl, {
      ...commonInit,
      label: `host-${viewerCount}`,
      role: "host",
      viewerIndex: null,
      clearHostRoom: true,
    }, signal);
    pages.push(hostPage);
    const host = await startHost(
      cdp,
      hostPage,
      config.profileId,
      config.connectionTimeoutMs,
      signal,
    );
    const roomId = host.roomId!;
    const viewerUrl = await evaluate<string>(
      cdp,
      hostPage,
      `(() => {
        const grant = sessionStorage.getItem('screener:viewer-grant:${roomId}');
        return grant ? location.origin + '/r/${roomId}#v=' + grant : '';
      })()`,
    );
    if (!viewerUrl.startsWith(`${baseUrl}/r/${roomId}#v=`)) {
      throw new Error("Host private Viewer invite was unavailable");
    }
    const viewerPages = await joinViewerBurst(
      viewerCount,
      async (viewerIndex) => {
        const viewerPage = await createPage(cdp, viewerUrl, {
          ...commonInit,
          label: `viewer-${viewerIndex}`,
          role: "viewer",
          viewerIndex,
          clearHostRoom: false,
        }, signal);
        pages.push(viewerPage);
        return viewerPage;
      },
      (viewerPage) =>
        waitForViewerMedia(
          cdp,
          viewerPage,
          config.connectionTimeoutMs,
          signal,
        ),
    );
    pages.splice(1, pages.length - 1, ...viewerPages);
    if (viewerCount === MAX_VIEWERS) {
      routeTimingStatus = "unavailable";
      try {
        routeTimingSummary = await requestRouteTimingSummary(
          cdp,
          hostPage,
          config.connectionTimeoutMs,
          signal,
        );
        routeTimingStatus = "captured";
      } catch {
        routeTimingSummary = null;
      }
    }
    if (config.settleMs > 0) {
      await delay(config.settleMs, signal);
    }
    if (config.canaryMode === "viewer-mbb" && viewerCount === 3) {
      const canaryResult = await runViewerMbbCanary(cdp, pages, signal);
      return {
        viewerCount,
        startedAt: new Date(startedAtMs).toISOString(),
        completedAt: new Date().toISOString(),
        status: canaryResult.status,
        checks: canaryChecks(canaryResult),
        summary: null,
        routeTimingSummary,
        routeTimingStatus,
        samples: [],
        recovery: { triggered: false },
      };
    }
    const measurementStartedAt = Date.now();
    const deadline = measurementStartedAt + config.durationMs;
    do {
      samples.push(await samplePages(cdp, pages, measurementStartedAt));
      if (Date.now() < deadline) {
        await delay(
          Math.min(config.sampleIntervalMs, deadline - Date.now()),
          signal,
        );
      }
    } while (Date.now() < deadline);
    samples.push(await samplePages(cdp, pages, measurementStartedAt));

    const summary = summarizeSamples(samples, viewerCount);
    const checks = buildRunChecks(
      summary,
      viewerCount,
      config.profileId,
      config.expectedEndpointCap,
    );
    if (viewerCount === MAX_VIEWERS) {
      checks.push(
        buildRouteTimingCheck(routeTimingStatus, routeTimingSummary, viewerCount),
      );
    }
    if (config.qualityControlSmoke && viewerCount >= 3) {
      const qualityControl = await runQualityControlSmoke(
        cdp,
        pages,
        capture,
        signal,
      );
      checks.push({
        name: "quality-control-propagation",
        passed: qualityControl.settingsPropagated,
        actual: qualityControl.settingsPropagated,
        expected: "balanced and clarity settings reach every participant",
      });
      checks.push({
        name: "quality-control-no-peer-rebuild",
        passed: qualityControl.peerConnectionsStable,
        actual: qualityControl.peerConnectionsStable,
        expected: "peer connection identities stay unchanged",
      });
      checks.push({
        name: "quality-control-sender-readback",
        passed: qualityControl.senderReadbacksMatched,
        actual: qualityControl.senderReadbacksMatched,
        expected: "every baseline active video sender displays matching preference readback",
      });
      checks.push({
        name: "quality-control-viewer-progress",
        passed: qualityControl.viewersAdvanced,
        actual: qualityControl.viewersAdvanced,
        expected: "every viewer decodes and renders frames after both setting changes",
      });
    }
    if (config.recoveryViewerCount === viewerCount) {
      recovery = await runRecovery(
        cdp,
        pages,
        samples.at(-1)?.pages ?? [],
        config.recoveryTimeoutMs,
        signal,
      );
      checks.push(buildRecoveryCheck(recovery, config.expectedEndpointCap));
    }
    return {
      viewerCount,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date().toISOString(),
      status: checks.every((check) => check.passed) ? "passed" : "failed",
      checks,
      summary,
      routeTimingSummary,
      routeTimingStatus,
      samples,
      recovery,
    };
  } catch (error) {
    if (
      viewerCount === MAX_VIEWERS &&
      routeTimingStatus !== "captured" &&
      pages[0]
    ) {
      routeTimingStatus = "unavailable";
      try {
        routeTimingSummary = await requestRouteTimingSummary(
          cdp,
          pages[0],
          config.sampleIntervalMs,
          signal,
        );
        routeTimingStatus = "captured";
      } catch {
        routeTimingSummary = null;
      }
    }
    const failureEvidence = await captureFailureEvidence(
      cdp,
      pages,
      viewerCount + 1,
    ).catch(() => ({
      expectedPageCount: viewerCount + 1,
      observedPageCount: 0,
      pages: [],
    }));
    return {
      viewerCount,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date().toISOString(),
      status: "failed",
      checks:
        viewerCount === MAX_VIEWERS
          ? [
              buildRouteTimingCheck(
                routeTimingStatus,
                routeTimingSummary,
                viewerCount,
              ),
            ]
          : [],
      summary: samples.length > 0 ? summarizeSamples(samples, viewerCount) : null,
      routeTimingSummary,
      routeTimingStatus,
      samples,
      recovery,
      failureEvidence,
      error: errorMessage(error),
    };
  } finally {
    await Promise.allSettled(pages.map((page) => closePage(cdp, page)));
    await delay(250);
  }
}

async function gitCommit(): Promise<string | null> {
  const gitProcess = startProcess("git", ["rev-parse", "HEAD"], process.env);
  await new Promise<void>((resolveExit) =>
    gitProcess.child.once("exit", () => resolveExit()),
  );
  return gitProcess.child.exitCode === 0
    ? gitProcess.log.tail().split(/\r?\n/).at(-1) ?? null
    : null;
}

async function writeReport(report: BenchmarkReport, outputPath: string | null): Promise<void> {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (!outputPath) {
    process.stdout.write(json);
    return;
  }
  const resolved = isAbsolute(outputPath) ? outputPath : resolve(REPO_ROOT, outputPath);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, json, "utf8");
  console.error(`Peer topology loopback report: ${resolved}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function main(): Promise<number> {
  let config: BenchmarkConfig;
  try {
    config = parseBenchmarkConfig();
    await access(config.chromePath);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return 2;
  }

  const profile = PROFILE_SETTINGS[config.profileId];
  const profileResolution = QUALITY_RESOLUTIONS[profile.resolution];
  const report: BenchmarkReport = {
    schemaVersion: 3,
    startedAt: new Date().toISOString(),
    completedAt: null,
    gitCommit: await gitCommit(),
    chromium: null,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      headless: config.headless,
    },
    configuration: {
      viewerCounts: config.viewerCounts,
      expectedEndpointCap: config.expectedEndpointCap,
      profileId: config.profileId,
      durationMs: config.durationMs,
      settleMs: config.settleMs,
      sampleIntervalMs: config.sampleIntervalMs,
      connectionTimeoutMs: config.connectionTimeoutMs,
      recoveryViewerCount: config.recoveryViewerCount,
      recoveryTimeoutMs: config.recoveryTimeoutMs,
      headless: config.headless,
      noSandbox: config.noSandbox,
      qualityControlSmoke: config.qualityControlSmoke,
      canaryMode: config.canaryMode,
      chromeExecutable: basename(config.chromePath),
      output: config.outputPath ?? "stdout",
    },
    capture: {
      kind: "deterministic-canvas",
      width: profileResolution.width,
      height: profileResolution.height,
      frameRate: profile.maxFramerate,
      audio: false,
    },
    limitations: [
      "Synthetic canvas motion exercises real Chromium WebRTC but is not a game-capture quality claim.",
      "Headless runs are topology and transport evidence, not representative GPU or power evidence.",
      "Timing values never determine this loopback gate's status; the exact 20-Viewer route snapshot and four complete current-child distributions are required without a duration threshold.",
      "CDP process CPU covers the isolated Chromium instance, not a specific Host or relay page; identity changes or counter resets make that interval unknown, and multicore utilization may exceed 100%.",
      "CDP SystemInfo exposes no resident-set field, so peakResidentSetBytes is null; GPU, NIC, glass-to-glass latency, generational visual quality, mobile browsers, and SFU require other measurement.",
      "The local runner does not start LiveKit; SFU consistency is reported only when an SFU route is actually observed.",
      "The harness emits raw gate fields and simple invariants; it does not implement a route score or runtime policy.",
      "BENCHMARK_CANARY=viewer-mbb injects only sanitized control counters; it does not claim detector quality or network performance. Host-candidate and signaling-blackhole canaries remain deferred.",
    ],
    runs: [],
  };

  let server: ScreenerServer | null = null;
  let chrome: ManagedProcess | null = null;
  let cdp: CdpConnection | null = null;
  let profileDirectory: string | null = null;
  const abortController = new AbortController();
  const onSignal = () => {
    abortController.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const appPort = await reservePort();
    const debugPort = await reservePort();
    const baseUrl = `http://127.0.0.1:${appPort}`;
    profileDirectory = await mkdtemp(join(tmpdir(), "screener-peer-benchmark-"));
    const serverConfig = loadConfig({
      NODE_ENV: "development",
      PORT: String(appPort),
      LISTEN_HOST: "127.0.0.1",
      PUBLIC_BASE_URL: baseUrl,
      ALLOWED_ORIGINS: baseUrl,
      PEER_ASSISTED_MEDIA: "true",
      ENDPOINT_MEDIA_COPY_CAPACITY: String(config.expectedEndpointCap),
      MAX_VIEWERS_PER_ROOM: String(Math.max(
        ...config.viewerCounts,
        config.canaryMode === "viewer-mbb" ? 3 : 1,
      )),
      STUN_URLS: "",
    });
    server = await createScreenerServer({
      config: serverConfig,
      roomStore: new RoomStore({
        leaseMs: serverConfig.roomLeaseMs,
        maxRooms: serverConfig.maxRooms,
        maxViewersPerRoom: serverConfig.maxViewersPerRoom,
      }),
    });
    await server.listen(appPort, "127.0.0.1");

    const chromeArgs = [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--autoplay-policy=no-user-gesture-required",
      "--window-size=1920,1080",
      "about:blank",
    ];
    if (config.headless) {
      chromeArgs.unshift("--headless=new");
    }
    if (config.noSandbox) {
      chromeArgs.unshift("--no-sandbox");
    }
    chrome = startProcess(config.chromePath, chromeArgs, process.env);
    const versionUrl = `http://127.0.0.1:${debugPort}/json/version`;
    await waitForHttp(versionUrl, chrome, 20_000, abortController.signal);
    const version = (await (await fetch(versionUrl)).json()) as {
      webSocketDebuggerUrl: string;
      [key: string]: unknown;
    };
    cdp = await CdpConnection.connect(version.webSocketDebuggerUrl);
    report.chromium = await cdp.call("Browser.getVersion");

    const viewerCounts = config.canaryMode === "viewer-mbb" ? [3] : config.viewerCounts;
    for (const viewerCount of viewerCounts) {
      abortController.signal.throwIfAborted();
      console.error(`Running peer-topology loopback with ${viewerCount} viewer(s)`);
      report.runs.push(
        await runCase(
          cdp,
          baseUrl,
          config,
          viewerCount,
          abortController.signal,
        ),
      );
    }
  } catch (error) {
    report.fatalError = errorMessage(error);
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    report.completedAt = new Date().toISOString();
    const cleanupErrors: string[] = [];
    const cleanup = async (operation: Promise<unknown>): Promise<void> => {
      try {
        await operation;
      } catch (error) {
        cleanupErrors.push(errorMessage(error));
      }
    };
    await Promise.all([
      cleanup(
        (async () => {
          if (!cdp) return;
          try {
            await cdp.call("Browser.close");
          } finally {
            await cdp.close();
          }
        })(),
      ),
      cleanup(server?.close() ?? Promise.resolve()),
    ]);
    await cleanup(stopProcess(chrome));
    if (profileDirectory) {
      await cleanup(
        rm(profileDirectory, { recursive: true, force: true, maxRetries: 3 }),
      );
    }
    if (cleanupErrors.length > 0) {
      const cleanupError = `Cleanup failed: ${cleanupErrors.join("; ")}`;
      report.fatalError = report.fatalError
        ? `${report.fatalError}; ${cleanupError}`
        : cleanupError;
    }
  }

  await writeReport(report, config.outputPath);
  if (abortController.signal.aborted) {
    return 130;
  }
  return report.fatalError || report.runs.some((run) => run.status === "failed") ? 1 : 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  process.exitCode = await main();
}
