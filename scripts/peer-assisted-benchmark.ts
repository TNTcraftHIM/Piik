import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import WebSocket from "ws";
import {
  createScreenerServer,
  type ScreenerServer,
} from "../src/server/app";
import { loadConfig } from "../src/server/config";
import {
  QUALITY_PROFILES,
  QUALITY_RESOLUTIONS,
  type QualityProfileId,
  type QualitySettings,
} from "../src/client/media/quality";

const PROFILE_SETTINGS = QUALITY_PROFILES;
type ProfileId = QualityProfileId;
type PageRole = "host" | "viewer";

export interface BenchmarkConfig {
  chromePath: string;
  viewerCounts: number[];
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

interface MediaAssignmentObservation {
  parentPeerId: string | null;
  childPeerIds: string[];
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
  assignment: MediaAssignmentObservation;
  maxActiveOutboundMediaEdges: number;
  maxAssignedChildren: number;
  firstDecodedAtEpochMs: number | null;
  firstRenderedAtEpochMs: number | null;
  connections: ConnectionObservation[];
}

interface TimedSample {
  atEpochMs: number;
  elapsedMs: number;
  pages: PageObservation[];
}

interface RunCheck {
  name: string;
  passed: boolean;
  actual: number | boolean;
  expected: string;
}

interface RecoveryResult {
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

interface BenchmarkRun {
  viewerCount: number;
  startedAt: string;
  completedAt: string;
  status: "passed" | "failed";
  checks: RunCheck[];
  summary: ReturnType<typeof summarizeSamples> | null;
  samples: TimedSample[];
  recovery: RecoveryResult;
  error?: string;
}

interface BenchmarkReport {
  schemaVersion: 1;
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

const DEFAULT_VIEWER_COUNTS = [1, 3, 5, 8];
const MAX_VIEWERS = 8;
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
        host.assignment.childPeerIds.length,
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
        assigned: page.assignment.parentPeerId !== null,
        activeUpstream: activeReceive !== undefined,
        statsClean,
        framesIncreased:
          series.length >= 2 && series.at(-1)! > series[0]!,
        firstFramesTotal: series[0] ?? null,
        finalFramesTotal: series.at(-1) ?? null,
      };
    });
  everyViewerDecoded =
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
    viewerContinuity,
    firstFrames,
    maxFirstDecodedAfterAuthenticateMs:
      decodedDelays.length === viewerCount ? Math.max(...decodedDelays) : null,
    finalTopology: finalPages.map((page) => ({
      label: page.label,
      role: page.role,
      viewerIndex: page.viewerIndex,
      peerId: page.peerId,
      qualitySettings: page.qualitySettings,
      parentPeerId: page.assignment.parentPeerId,
      childPeerIds: page.assignment.childPeerIds,
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

function buildRunChecks(
  summary: NonNullable<BenchmarkRun["summary"]>,
  viewerCount: number,
  profileId: ProfileId,
): RunCheck[] {
  return [
    {
      name: "host-active-media-edges",
      passed: summary.maxHostActiveMediaEdges <= 2,
      actual: summary.maxHostActiveMediaEdges,
      expected: "<= 2",
    },
    {
      name: "host-assigned-children",
      passed: summary.maxHostAssignedChildren <= 2,
      actual: summary.maxHostAssignedChildren,
      expected: "<= 2",
    },
    {
      name: "relay-active-media-edges",
      passed: summary.maxRelayActiveMediaEdges <= 1,
      actual: summary.maxRelayActiveMediaEdges,
      expected: "<= 1",
    },
    {
      name: "all-viewers-decoded",
      passed: summary.everyViewerDecoded,
      actual: summary.everyViewerDecoded,
      expected: `${viewerCount} viewers with a live upstream, clean stats, and increasing decoded frames`,
    },
    {
      name: "first-decoded-frame",
      passed:
        summary.maxFirstDecodedAfterAuthenticateMs !== null &&
        summary.maxFirstDecodedAfterAuthenticateMs <= 3_000,
      actual: summary.maxFirstDecodedAfterAuthenticateMs ?? false,
      expected: "<= 3000 ms after signaling authentication starts",
    },
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

export function buildBenchmarkInitScript(options: {
  label: string;
  role: PageRole;
  viewerIndex: number | null;
  clearHostRoom: boolean;
  width: number;
  height: number;
  frameRate: number;
}): string {
  const serialized = JSON.stringify(options);
  return `(() => {
    if (globalThis.__SCREENER_BENCHMARK__) return;
    const options = ${serialized};
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
      assignment: { parentPeerId: null, childPeerIds: [] },
      maxActiveOutboundMediaEdges: 0,
      maxAssignedChildren: 0,
      firstDecodedAtEpochMs: null,
      firstRenderedAtEpochMs: null,
    };
    const connections = [];
    const descriptions = [];
    const accumulators = new WeakMap();
    const statsModule = import("/src/client/webrtc/stats.ts");

    function cloneAssignment(value) {
      if (!value || !Array.isArray(value.childPeerIds)) {
        return { parentPeerId: null, childPeerIds: [] };
      }
      return {
        parentPeerId: typeof value.parentPeerId === "string" ? value.parentPeerId : null,
        childPeerIds: value.childPeerIds.filter((item) => typeof item === "string"),
      };
    }

    function setAssignment(value) {
      state.assignment = cloneAssignment(value);
      state.maxAssignedChildren = Math.max(
        state.maxAssignedChildren,
        state.assignment.childPeerIds.length,
      );
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

    function handleSignalMessage(value, direction, socket) {
      if (typeof value !== "string") return;
      let message;
      try { message = JSON.parse(value); } catch { return; }
      if (!message || typeof message.type !== "string") return;
      if (direction === "out" && message.type === "authenticate") {
        socket.__screenerBenchmarkSignal = true;
        state.role = message.role;
        state.roomId = message.roomId;
        state.authenticateSentAtEpochMs = Date.now();
      } else if (direction === "out" && message.type === "set-quality-settings") {
        state.qualitySettings = message.qualitySettings;
      }
      if (direction === "in" && message.type === "authenticated") {
        socket.__screenerBenchmarkSignal = true;
        state.peerId = message.peerId;
        state.authenticatedAtEpochMs = Date.now();
        state.signalingConnected = true;
        if (message.mediaMode === "peer-assisted") {
          setAssignment(message.mediaAssignment);
          state.qualitySettings = message.qualitySettings;
        }
      } else if (direction === "in" && message.type === "media-assignment") {
        setAssignment(message.mediaAssignment);
      } else if (direction === "in" && message.type === "quality-settings") {
        state.qualitySettings = message.qualitySettings;
      }
      if (message.type === "signal") recordDescription(message, direction);
    }

    const NativeWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = new Proxy(NativeWebSocket, {
      construct(Target, args) {
        const socket = Reflect.construct(Target, args, Target);
        const nativeSend = socket.send;
        socket.send = function(data) {
          handleSignalMessage(data, "out", socket);
          return nativeSend.call(socket, data);
        };
        socket.addEventListener("message", (event) => {
          handleSignalMessage(event.data, "in", socket);
        });
        socket.addEventListener("close", () => {
          if (socket.__screenerBenchmarkSignal) state.signalingConnected = false;
        });
        return socket;
      },
    });

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
        assignment: cloneAssignment(state.assignment),
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

    Object.defineProperty(globalThis, "__SCREENER_BENCHMARK__", {
      configurable: false,
      value: { sample, progress, snapshot, stop: () => clearInterval(videoObserver) },
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

async function createPage(
  cdp: CdpConnection,
  url: string,
  options: Parameters<typeof buildBenchmarkInitScript>[0],
  signal: AbortSignal,
): Promise<PageHandle> {
  const created = await cdp.call<{ targetId: string }>("Target.createTarget", {
    url: "about:blank",
    background: false,
  });
  const attached = await cdp.call<{ sessionId: string }>("Target.attachToTarget", {
    targetId: created.targetId,
    flatten: true,
  });
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
}

async function closePage(cdp: CdpConnection, page: PageHandle): Promise<void> {
  try {
    await cdp.call("Target.closeTarget", { targetId: page.targetId });
  } catch {
    // Browser shutdown and a prior recovery close make target cleanup idempotent.
  }
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
    "document.querySelector('.start-button')",
    15_000,
    "host controls",
    signal,
  );
  await evaluate(
    cdp,
    page,
    `(() => {
      const profiles = document.querySelectorAll('.segmented-control button');
      const profile = profiles[${profileIndex}];
      if (!(profile instanceof HTMLButtonElement)) throw new Error('Quality profile button missing');
      profile.click();
      const start = document.querySelector('.start-button');
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
      snapshot.assignment.parentPeerId &&
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

async function samplePages(
  cdp: CdpConnection,
  pages: PageHandle[],
  startedAtMs: number,
): Promise<TimedSample> {
  const atEpochMs = Date.now();
  const observations = await Promise.all(pages.map((page) => detailedSample(cdp, page)));
  return {
    atEpochMs,
    elapsedMs: atEpochMs - startedAtMs,
    pages: observations,
  };
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
  peerConnectionsStable: boolean;
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

  const waitForSettings = async (settings: QualitySettings): Promise<void> => {
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
  };
  const sendingLabels = new Set(
    baseline
      .filter((page) => page.assignment.childPeerIds.length > 0)
      .map((page) => page.label),
  );
  const sendingPages = pages.filter((page) => sendingLabels.has(page.label));
  const waitForReadback = async (label: "平衡" | "清晰"): Promise<void> => {
    const expected = JSON.stringify(`${label} / ${label}`);
    await Promise.all(
      sendingPages.map((page) =>
        waitForPage(
          cdp,
          page,
          `Array.from(document.querySelectorAll('.metric')).some((metric) =>
            metric.querySelector('dt')?.textContent?.trim() === '请求 / 应用优先级' &&
            metric.querySelector('dd')?.textContent?.trim() === ${expected}
          )`,
          10_000,
          `${label} sender parameter readback`,
          signal,
        ),
      ),
    );
  };

  await applyQualityPreference(cdp, hostPage, "平衡", signal);
  await waitForSettings(balanced);
  await waitForReadback("平衡");
  await applyQualityPreference(cdp, hostPage, "清晰优先", signal);
  await waitForSettings(initialSettings);
  await waitForReadback("清晰");

  const final = await Promise.all(pages.map((page) => quickSnapshot(cdp, page)));

  return {
    peerConnectionsStable:
      peerConnectionFingerprint(final) === baselineFingerprint,
  };
}

function totalDecodedFrames(page: PageObservation): number {
  return page.connections.reduce(
    (total, connection) => total + (connection.receiveTotals?.framesTotal ?? 0),
    0,
  );
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
        page.assignment.parentPeerId === parent &&
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
      page.assignment.parentPeerId === host.peerId &&
      page.assignment.childPeerIds.length > 0,
  );
  if (!relay?.peerId) {
    return { triggered: true, error: "No first-level relay was available" };
  }
  const affectedPeerIds = descendantsOf(relay.peerId, finalPages);
  const relayHandle = pages.find((page) => page.label === relay.label);
  if (!relayHandle || affectedPeerIds.length === 0) {
    return { triggered: true, error: "Relay had no measurable descendant branch" };
  }
  const affectedHandles = pages.filter((page) => {
    const observation = finalPages.find((item) => item.label === page.label);
    return observation?.peerId ? affectedPeerIds.includes(observation.peerId) : false;
  });
  const failureAtEpochMs = Date.now();
  await closePage(cdp, relayHandle);
  const remainingPages = pages.filter((page) => page !== relayHandle);
  const deadline = failureAtEpochMs + timeoutMs;
  let reassignedAtEpochMs: number | undefined;
  let baselines = new Map<string, number>();
  let maxHostActiveMediaEdges = 0;
  let maxHostAssignedChildren = 0;

  while (Date.now() < deadline) {
    const observations = await Promise.all(
      remainingPages.map((page) => progressSample(cdp, page)),
    );
    const currentHost = observations.find((page) => page.role === "host");
    if (currentHost) {
      maxHostActiveMediaEdges = Math.max(
        maxHostActiveMediaEdges,
        activeVideoEdgeCount(currentHost, "send"),
      );
      maxHostAssignedChildren = Math.max(
        maxHostAssignedChildren,
        currentHost.assignment.childPeerIds.length,
      );
    }
    const affected = observations.filter((page) =>
      page.peerId ? affectedPeerIds.includes(page.peerId) : false,
    );
    const branchRoot = affected.find(
      (page) =>
        page.assignment.parentPeerId !== null &&
        page.assignment.parentPeerId !== relay.peerId,
    );
    if (!reassignedAtEpochMs && branchRoot) {
      reassignedAtEpochMs = Date.now();
      baselines = new Map(
        affected.map((page) => [page.label, totalDecodedFrames(page)]),
      );
    } else if (
      reassignedAtEpochMs &&
      affected.length === affectedHandles.length &&
      affected.every(
        (page) =>
          totalDecodedFrames(page) > (baselines.get(page.label) ?? 0) &&
          page.connections.some(
            (connection) =>
              connection.connectionState === "connected" &&
              connection.receiveTotals !== null,
          ),
      )
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
        maxHostActiveMediaEdges,
        maxHostAssignedChildren,
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
    maxHostActiveMediaEdges,
    maxHostAssignedChildren,
    error: "Recovery did not resume decoded frames before the timeout",
  };
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
  try {
    const capture = PROFILE_SETTINGS[config.profileId];
    const captureResolution = QUALITY_RESOLUTIONS[capture.resolution];
    const commonInit = {
      width: captureResolution.width,
      height: captureResolution.height,
      frameRate: capture.maxFramerate,
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
    for (let viewerIndex = 1; viewerIndex <= viewerCount; viewerIndex += 1) {
      const viewerPage = await createPage(cdp, `${baseUrl}/r/${roomId}`, {
        ...commonInit,
        label: `viewer-${viewerIndex}`,
        role: "viewer",
        viewerIndex,
        clearHostRoom: false,
      }, signal);
      pages.push(viewerPage);
      await waitForViewerMedia(
        cdp,
        viewerPage,
        config.connectionTimeoutMs,
        signal,
      );
    }
    if (config.settleMs > 0) {
      await delay(config.settleMs, signal);
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
    const checks = buildRunChecks(summary, viewerCount, config.profileId);
    if (config.qualityControlSmoke && viewerCount >= 3) {
      const qualityControl = await runQualityControlSmoke(
        cdp,
        pages,
        capture,
        signal,
      );
      checks.push({
        name: "quality-control-propagation",
        passed: true,
        actual: true,
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
        passed: true,
        actual: true,
        expected: "host and active relay display both sender preference readbacks",
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
      checks.push({
        name: "relay-recovery",
        passed:
          recovery.error === undefined &&
          (recovery.recoveryMs ?? Infinity) <= 8_000 &&
          (recovery.maxHostActiveMediaEdges ?? 0) <= 2 &&
          (recovery.maxHostAssignedChildren ?? 0) <= 2,
        actual: recovery.recoveryMs ?? false,
        expected: "decoded frames resume within 8000 ms with host fanout <= 2",
      });
    }
    return {
      viewerCount,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date().toISOString(),
      status: checks.every((check) => check.passed) ? "passed" : "failed",
      checks,
      summary,
      samples,
      recovery,
    };
  } catch (error) {
    return {
      viewerCount,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date().toISOString(),
      status: "failed",
      checks: [],
      summary: samples.length > 0 ? summarizeSamples(samples, viewerCount) : null,
      samples,
      recovery,
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
  console.error(`Benchmark report: ${resolved}`);
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
    schemaVersion: 1,
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
      "CPU, GPU, NIC totals, glass-to-glass latency, generational visual quality, mobile browsers, and TURN require external or device-specific measurement.",
      "The harness emits raw gate fields and simple invariants; it does not implement a route score or runtime policy.",
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
    server = await createScreenerServer({
      config: loadConfig({
        NODE_ENV: "development",
        PORT: String(appPort),
        LISTEN_HOST: "127.0.0.1",
        PUBLIC_BASE_URL: baseUrl,
        ALLOWED_ORIGINS: baseUrl,
        ACCESS_PASSWORD: "",
        ROOM_DATABASE_PATH: "",
        PEER_ASSISTED_MEDIA: "true",
        MAX_VIEWERS_PER_ROOM: String(Math.max(...config.viewerCounts)),
        STUN_URLS: "",
        TURN_URLS: "",
        TURN_SHARED_SECRET: "",
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

    for (const viewerCount of config.viewerCounts) {
      abortController.signal.throwIfAborted();
      console.error(`Running peer-assisted benchmark with ${viewerCount} viewer(s)`);
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
