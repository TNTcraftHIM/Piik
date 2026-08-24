import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

import {
  activeVideoEdgeCount,
  buildBenchmarkFailureEvidence,
  buildBenchmarkInitScript,
  buildRecoveryCheck,
  buildRouteTimingCheck,
  buildRunChecks,
  captureRecoveryViewerBaselines,
  createPage,
  everyViewerAdvanced,
  everyViewerRecoveredMedia,
  joinViewerBurst,
  mergeRecoveryHostPeaks,
  parseBenchmarkCanaryMode,
  parseBenchmarkConfig,
  parseExpectedEndpointCap,
  parseViewerCounts,
  sanitizeFailurePageEvidence,
  summarizeBenchmarkRouteTiming,
  summarizeSamples,
} from "../scripts/peer-assisted-benchmark";
import { MAX_VIEWERS_PER_ROOM_LIMIT } from "../src/shared/protocol";
import type {
  MediaRouteUpstream,
  ParticipantRouteAssignment,
} from "../src/shared/protocol";

const lowQualitySettings = {
  resolution: "720p",
  maxFramerate: 30,
  maxBitrate: 3_000_000,
  degradationPreference: "maintain-resolution",
} as const;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function page(
  role: "host" | "viewer",
  label: string,
  sendEdges: number,
  receiveEdges: number,
) {
  return {
    label,
    role,
    viewerIndex: role === "viewer" ? Number(label.split("-")[1]) : null,
    roomId: "1",
    peerId: `${label}-peer`,
    authenticatedAtEpochMs: 1_000,
    authenticateSentAtEpochMs: 900,
    signalingConnected: true,
    qualitySettings: lowQualitySettings,
    maxActiveOutboundMediaEdges: sendEdges,
    maxAssignedChildren: sendEdges,
    routeRevision: 1 as number | null,
    routeAssignment: {
      upstream:
        role === "viewer"
          ? ({ kind: "peer", peerId: "parent-peer" } as MediaRouteUpstream)
          : ({ kind: "none" } as MediaRouteUpstream),
      childPeerIds: Array.from(
        { length: sendEdges },
        (_, index) => `child-peer-${index}`,
      ),
      sfuPublicationGeneration: null as string | null,
    },
    firstDecodedAtEpochMs: role === "viewer" ? 1_500 : null,
    firstRenderedAtEpochMs: role === "viewer" ? 1_550 : null,
    renderedFrames: role === "viewer" ? 10 : 0,
    connections: [
      ...Array.from({ length: sendEdges }, (_, index) => ({
        index,
        createdAtEpochMs: 1_000,
        connectionId: `send-${index}` as string | null,
        remotePeerId: `child-${index}` as string | null,
        connectionState: "connected",
        iceConnectionState: "connected",
        hasOutboundVideo: true,
        hasInboundVideo: false,
        send: {},
        receive: null,
        sendTotals: { id: `send-${index}`, framesTotal: 10, bytesTotal: 100 },
        receiveTotals: null,
        error: undefined as string | undefined,
      })),
      ...Array.from({ length: receiveEdges }, (_, index) => ({
        index: sendEdges + index,
        createdAtEpochMs: 1_000,
        connectionId: `receive-${index}` as string | null,
        remotePeerId: "parent-peer",
        connectionState: "connected",
        iceConnectionState: "connected",
        hasOutboundVideo: false,
        hasInboundVideo: true,
        send: null,
        receive: {},
        sendTotals: null,
        receiveTotals: { id: `receive-${index}`, framesTotal: 10, bytesTotal: 100 },
        error: undefined as string | undefined,
      })),
    ],
  };
}

class FakeWebSocket {
  readonly sent: string[] = [];
  private readonly listeners = new Map<
    string,
    Array<(event: { data?: string }) => void>
  >();

  send(data: string): void {
    this.sent.push(data);
  }

  addEventListener(
    type: string,
    listener: (event: { data?: string }) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emitMessage(message: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: JSON.stringify(message) });
    }
  }

  emitClose(): void {
    for (const listener of this.listeners.get("close") ?? []) {
      listener({});
    }
  }
}

interface ObserverSnapshot {
  peerId: string | null;
  signalingConnected: boolean;
  routeRevision: number | null;
  routeAssignment: ParticipantRouteAssignment | null;
  maxAssignedChildren: number;
}

function createObserverHarness(
  expectedEndpointCap = 2,
  role: "host" | "viewer" = "host",
) {
  const context: Record<string, unknown> = {
    WebSocket: FakeWebSocket,
    RTCPeerConnection: class FakePeerConnection {},
    navigator: { mediaDevices: {} },
    document: { querySelector: () => null },
    localStorage: { removeItem: () => undefined },
    performance: { timeOrigin: 0 },
    setInterval: () => 1,
    clearInterval: () => undefined,
    queueMicrotask,
  };
  const source = buildBenchmarkInitScript({
    label: role === "host" ? "host-1" : "viewer-1",
    role,
    viewerIndex: role === "viewer" ? 1 : null,
    clearHostRoom: false,
    width: 1280,
    height: 720,
    frameRate: 30,
    expectedEndpointCap,
  }).replace(
    'const statsModule = import("/src/client/webrtc/stats.ts");',
    "const statsModule = new Promise(() => undefined);",
  );
  runInNewContext(source, context);
  const WebSocketConstructor = context.WebSocket as new () => FakeWebSocket;
  const api = context.__SCREENER_BENCHMARK__ as {
    snapshot: () => ObserverSnapshot;
    canarySnapshot: () => Record<string, unknown>;
    requestRouteDiagnosticSnapshot: () => boolean;
    routeDiagnosticTimingSamples: () => Record<
      string,
      Array<number | null>
    > | null;
  };
  return {
    socket: () => new WebSocketConstructor(),
    snapshot: () => structuredClone(api.snapshot()),
    canarySnapshot: () => structuredClone(api.canarySnapshot()),
    requestRouteDiagnosticSnapshot: () =>
      api.requestRouteDiagnosticSnapshot(),
    routeDiagnosticTimingSamples: () =>
      structuredClone(api.routeDiagnosticTimingSamples()),
  };
}

function authenticate(
  socket: FakeWebSocket,
  role: "host" | "viewer" = "host",
): void {
  socket.send(
    JSON.stringify({
      type: "authenticate",
      roomId: "1",
      role,
    }),
  );
}

function routeAssignment(
  childPeerIds: string[],
  generation: string | null = null,
): ParticipantRouteAssignment {
  return {
    upstream: { kind: "none" },
    childPeerIds,
    sfuPublicationGeneration: generation,
  };
}

function markSfuMedia(observation: ReturnType<typeof page>): void {
  const connection = observation.connections.find((candidate) =>
    observation.role === "host"
      ? candidate.hasOutboundVideo
      : candidate.hasInboundVideo,
  );
  if (!connection) {
    throw new Error("An SFU media connection is required");
  }
  connection.connectionId = null;
  connection.remotePeerId = null;
}

describe("peer topology loopback configuration", () => {
  it("keeps the real-relay canary opt-in", () => {
    expect(parseBenchmarkCanaryMode(undefined)).toBe("none");
    expect(parseBenchmarkCanaryMode("viewer-mbb")).toBe("viewer-mbb");
    expect(parseBenchmarkConfig({
      CHROME_PATH: "chrome",
      BENCHMARK_CANARY: "viewer-mbb",
      BENCHMARK_VIEWERS: "3",
    }).canaryMode).toBe("viewer-mbb");
    expect(() => parseBenchmarkConfig({
      CHROME_PATH: "chrome",
      BENCHMARK_CANARY: "viewer-mbb",
    })).toThrow(/selected viewer count of 3/);
    expect(() => parseBenchmarkCanaryMode("signaling")).toThrow(/BENCHMARK_CANARY/);
  });

  it("runs the exact 20-Viewer acceptance case by default", () => {
    expect(parseViewerCounts(undefined)).toEqual([
      MAX_VIEWERS_PER_ROOM_LIMIT,
    ]);
  });

  it("deduplicates configured viewer counts without changing their order", () => {
    expect(parseViewerCounts("8, 3,3,1")).toEqual([8, 3, 1]);
  });

  it("accepts the room viewer ceiling and rejects values above it", () => {
    expect(parseViewerCounts(String(MAX_VIEWERS_PER_ROOM_LIMIT))).toEqual([
      MAX_VIEWERS_PER_ROOM_LIMIT,
    ]);
    expect(() =>
      parseViewerCounts(String(MAX_VIEWERS_PER_ROOM_LIMIT + 1)),
    ).toThrow(
      new RegExp(`1 to ${MAX_VIEWERS_PER_ROOM_LIMIT}`),
    );
  });

  it("starts every Viewer join before waiting for burst media", async () => {
    const creations = Array.from({ length: 3 }, () =>
      createDeferred<string>(),
    );
    const media = Array.from({ length: 3 }, () => createDeferred<void>());
    const creationStarts: number[] = [];
    const mediaStarts: number[] = [];

    const burst = joinViewerBurst(
      3,
      (viewerIndex) => {
        creationStarts.push(viewerIndex);
        return creations[viewerIndex - 1]!.promise;
      },
      (_viewer, viewerIndex) => {
        mediaStarts.push(viewerIndex);
        return media[viewerIndex - 1]!.promise;
      },
    );
    expect(creationStarts).toEqual([1, 2, 3]);
    expect(mediaStarts).toEqual([]);

    creations[0]!.resolve("viewer-1");
    creations[1]!.resolve("viewer-2");
    await Promise.resolve();
    expect(mediaStarts).toEqual([]);
    creations[2]!.resolve("viewer-3");
    await vi.waitFor(() => expect(mediaStarts).toEqual([1, 2, 3]));

    media[2]!.resolve();
    media[0]!.resolve();
    media[1]!.resolve();
    await expect(burst).resolves.toEqual([
      "viewer-1",
      "viewer-2",
      "viewer-3",
    ]);
  });

  it("summarizes all four route timing keys without a pass threshold", () => {
    const values = Array.from({ length: 20 }, (_, index) =>
      index % 5 === 0 ? null : (20 - index) * 10,
    );
    const summary = summarizeBenchmarkRouteTiming({
      queueWaitMs: values,
      candidateStartMs: values,
      firstDecodedFrameMs: values,
      finalMs: values,
    });

    for (const timing of Object.values(summary)) {
      expect(timing).toEqual({
        sampleCount: 16,
        pendingCount: 4,
        rawMs: [
          10, 20, 30, 40, 60, 70, 80, 90, 110, 120, 130, 140, 160,
          170, 180, 190,
        ],
        p50Ms: 90,
        p95Ms: 190,
        maxMs: 190,
      });
      expect(Object.keys(timing)).not.toContain("passed");
    }
    expect(buildRouteTimingCheck("captured", summary)).toMatchObject({
      passed: true,
      actual: 4,
    });
    expect(buildRouteTimingCheck("unavailable", summary).passed).toBe(false);

    const incomplete = {
      ...summary,
      finalMs: { ...summary.finalMs, pendingCount: 3 },
    };
    expect(buildRouteTimingCheck("captured", incomplete)).toMatchObject({
      passed: false,
      actual: 3,
    });
  });

  it("closes the exact CDP target when page initialization fails", async () => {
    const call = vi.fn(
      async (method: string): Promise<Record<string, unknown>> => {
        if (method === "Target.createTarget") {
          return { targetId: "target-viewer-17" };
        }
        if (method === "Target.attachToTarget") {
          return { sessionId: "session-viewer-17" };
        }
        if (method === "Page.navigate") {
          return { errorText: "navigation rejected" };
        }
        return {};
      },
    );

    await expect(
      createPage(
        { call } as unknown as Parameters<typeof createPage>[0],
        "http://127.0.0.1:3000/r/1234",
        {
          label: "viewer-17",
          role: "viewer",
          viewerIndex: 17,
          clearHostRoom: false,
          width: 1280,
          height: 720,
          frameRate: 30,
          expectedEndpointCap: 2,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Navigation failed: navigation rejected");
    expect(call).toHaveBeenCalledWith("Target.closeTarget", {
      targetId: "target-viewer-17",
    });
  });

  it("requires recovery to target one selected case", () => {
    expect(() =>
      parseBenchmarkConfig({
        CHROME_PATH: "chrome",
        BENCHMARK_VIEWERS: "1,3",
        BENCHMARK_RECOVERY_VIEWERS: "5",
      }),
    ).toThrow(/selected viewer count/);
  });

  it("defaults to cap two and accepts the deployment range", () => {
    expect(parseExpectedEndpointCap(undefined)).toBe(2);
    expect(parseExpectedEndpointCap("1")).toBe(1);
    expect(parseExpectedEndpointCap("3")).toBe(3);
    for (const value of ["0", "2.5", "4"]) {
      expect(() => parseExpectedEndpointCap(value)).toThrow(/integer from 1 to 3/);
    }
  });

  it("requires a relay-sized case for the optional quality control smoke", () => {
    expect(() =>
      parseBenchmarkConfig({
        CHROME_PATH: "chrome",
        BENCHMARK_VIEWERS: "1",
        BENCHMARK_QUALITY_SMOKE: "1",
      }),
    ).toThrow(/at least 3/);
    expect(
      parseBenchmarkConfig({
        CHROME_PATH: "chrome",
        BENCHMARK_VIEWERS: "3",
        BENCHMARK_QUALITY_SMOKE: "1",
      }).qualityControlSmoke,
    ).toBe(true);
  });

  it("writes a report file by default and reserves '-' for stdout", () => {
    expect(parseBenchmarkConfig({ CHROME_PATH: "chrome" }).outputPath).toBe(
      "benchmark-results/peer-assisted.json",
    );
    expect(
      parseBenchmarkConfig({ CHROME_PATH: "chrome", BENCHMARK_OUTPUT: "-" })
        .outputPath,
    ).toBeNull();
  });
});

describe("peer topology loopback observations", () => {
  it("bounds failure evidence and removes media-path identifiers and raw errors", () => {
    const unsafe = page("viewer", "viewer-11", 0, 1);
    unsafe.roomId = "room-secret";
    unsafe.peerId = "peer-secret";
    unsafe.routeAssignment.upstream = {
      kind: "peer",
      peerId: "parent-secret",
    };
    unsafe.connections = Array.from({ length: 9 }, (_, index) => ({
      ...structuredClone(unsafe.connections[0]!),
      index,
      connectionId: `connection-secret-${index}`,
      remotePeerId: `remote-secret-${index}`,
      error: `private-error-${index}`,
    }));

    const failure = buildBenchmarkFailureEvidence([unsafe], 21);
    expect(failure).toMatchObject({
      expectedPageCount: 21,
      observedPageCount: 1,
      pages: [
        {
          label: "viewer-11",
          authenticated: true,
          upstreamKind: "peer",
          connectionCount: 9,
        },
      ],
    });
    expect(failure.pages[0]?.connections).toHaveLength(6);
    expect(sanitizeFailurePageEvidence(unsafe)).toEqual(failure.pages[0]);
    const serialized = JSON.stringify(failure);
    for (const secret of [
      "room-secret",
      "peer-secret",
      "parent-secret",
      "connection-secret",
      "remote-secret",
      "private-error",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("requests one Host-only route snapshot and retains only timing samples", () => {
    const observer = createObserverHarness();
    const socket = observer.socket();
    authenticate(socket);
    socket.emitMessage({
      type: "authenticated",
      role: "host",
      peerId: "host_peer_0001",
      mediaMode: "peer-assisted",
      routeRevision: 1,
      routeAssignment: routeAssignment([]),
      qualitySettings: lowQualitySettings,
    });

    expect(observer.requestRouteDiagnosticSnapshot()).toBe(true);
    expect(observer.requestRouteDiagnosticSnapshot()).toBe(false);
    expect(
      socket.sent
        .map((value) => JSON.parse(value) as { type?: string })
        .filter((message) => message.type === "request-route-diagnostic"),
    ).toHaveLength(1);

    const children = Array.from(
      { length: MAX_VIEWERS_PER_ROOM_LIMIT },
      (_, index) => ({
        ordinal: index + 1,
        ...(index === 0
          ? {
              peerId: "must_not_escape",
              connectionId: "must_not_escape",
            }
          : {}),
        queueWaitMs: index === 0 ? 30 : null,
        candidateStartMs: index === 0 ? 50 : index === 1 ? 20 : null,
        firstDecodedFrameMs: index === 0 ? 80 : null,
        finalMs: index === 0 ? 90 : null,
      }),
    );
    socket.emitMessage({
      type: "route-diagnostic-snapshot",
      snapshot: { children },
    });

    const timing = observer.routeDiagnosticTimingSamples();
    expect(timing?.queueWaitMs).toHaveLength(MAX_VIEWERS_PER_ROOM_LIMIT);
    expect(timing?.queueWaitMs.slice(0, 2)).toEqual([30, null]);
    expect(timing?.candidateStartMs.slice(0, 2)).toEqual([50, 20]);
    expect(timing?.firstDecodedFrameMs.slice(0, 2)).toEqual([80, null]);
    expect(timing?.finalMs.slice(0, 2)).toEqual([90, null]);
    expect(
      JSON.stringify(observer.routeDiagnosticTimingSamples()),
    ).not.toContain("must_not_escape");
  });

  it("captures a partial failure snapshot without satisfying exact 20", () => {
    const observer = createObserverHarness();
    const socket = observer.socket();
    authenticate(socket);
    socket.emitMessage({
      type: "authenticated",
      role: "host",
      peerId: "host_peer_0001",
      mediaMode: "peer-assisted",
      routeRevision: 1,
      routeAssignment: routeAssignment([]),
      qualitySettings: lowQualitySettings,
    });
    expect(observer.requestRouteDiagnosticSnapshot()).toBe(true);
    socket.emitMessage({
      type: "route-diagnostic-snapshot",
      snapshot: {
        children: Array.from(
          { length: MAX_VIEWERS_PER_ROOM_LIMIT - 1 },
          (_, index) => ({
            ordinal: index + 1,
            queueWaitMs: null,
            candidateStartMs: null,
            firstDecodedFrameMs: null,
            finalMs: null,
          }),
        ),
      },
    });
    const timing = observer.routeDiagnosticTimingSamples();
    expect(timing?.queueWaitMs).toHaveLength(
      MAX_VIEWERS_PER_ROOM_LIMIT - 1,
    );
    expect(
      buildRouteTimingCheck(
        "captured",
        summarizeBenchmarkRouteTiming(
          timing as Parameters<typeof summarizeBenchmarkRouteTiming>[0],
        ),
      ).passed,
    ).toBe(false);
  });

  it("does not expose the route diagnostic request on a Viewer page", () => {
    const observer = createObserverHarness(2, "viewer");
    const socket = observer.socket();
    authenticate(socket, "viewer");
    socket.emitMessage({
      type: "authenticated",
      role: "viewer",
      peerId: "viewer_peer_0001",
      mediaMode: "peer-assisted",
      routeRevision: 1,
      routeAssignment: {
        upstream: { kind: "peer", peerId: "host_peer_0001" },
        childPeerIds: [],
        sfuPublicationGeneration: null,
      },
      qualitySettings: lowQualitySettings,
    });

    expect(observer.requestRouteDiagnosticSnapshot()).toBe(false);
    expect(
      socket.sent
        .map((value) => JSON.parse(value) as { type?: string })
        .some((message) => message.type === "request-route-diagnostic"),
    ).toBe(false);
  });

  it.each([
    ["an SFU upstream without a generation", { kind: "sfu" }, null],
    [
      "a peer upstream with a generation",
      { kind: "peer", peerId: "host_peer_0001" },
      "publication_generation_12345678",
    ],
  ])("rejects %s in the v9 route observer", (_label, upstream, generation) => {
    const observer = createObserverHarness(2, "viewer");
    const socket = observer.socket();
    authenticate(socket, "viewer");
    socket.emitMessage({
      type: "authenticated",
      role: "viewer",
      peerId: "viewer_peer_0001",
      mediaMode: "peer-assisted",
      routeRevision: 1,
      routeAssignment: {
        upstream,
        childPeerIds: [],
        sfuPublicationGeneration: generation,
      },
      qualitySettings: lowQualitySettings,
    });

    expect(observer.snapshot()).toMatchObject({
      routeRevision: null,
      routeAssignment: null,
    });
  });

  it("counts only active media connections in the requested direction", () => {
    const host = page("host", "host", 2, 0);
    host.connections[0]!.connectionState = "closed";
    expect(activeVideoEdgeCount(host, "send")).toBe(1);
    expect(activeVideoEdgeCount(host, "receive")).toBe(0);
  });

  it("summarizes raw fanout and first-frame fields without a score", () => {
    const initialPages = [
      page("host", "host", 2, 0),
      page("viewer", "viewer-1", 1, 1),
      page("viewer", "viewer-2", 0, 1),
      page("viewer", "viewer-3", 0, 1),
    ];
    const finalPages = structuredClone(initialPages);
    for (const viewer of finalPages.filter((entry) => entry.role === "viewer")) {
      viewer.connections.at(-1)!.receiveTotals!.framesTotal = 20;
    }
    const summary = summarizeSamples(
      [
        { atEpochMs: 2_000, elapsedMs: 0, pages: initialPages },
        { atEpochMs: 4_000, elapsedMs: 2_000, pages: finalPages },
      ],
      3,
    );
    expect(summary.maxHostActiveMediaEdges).toBe(2);
    expect(summary.maxRelayActiveMediaEdges).toBe(1);
    expect(summary.everyViewerDecoded).toBe(true);
    expect(summary.firstFrames[0]?.decodedAfterAuthenticateMs).toBe(600);
    expect(summary.maxFirstDecodedAfterAuthenticateMs).toBe(600);
    expect(summary.senderEvidence.host.bitrateKbps.mean).toBeNull();
    expect(summary.browserProcessResources.measuredCpuTimeSeconds).toBeNull();
    expect(
      summary.finalTopology.every(
        (entry) =>
          JSON.stringify(entry.qualitySettings) ===
          JSON.stringify(lowQualitySettings),
      ),
    ).toBe(true);
  });

  it("summarizes identified sender evidence and rejects reset process intervals", () => {
    const makePages = (bitrate: number, fps: number, intervalFrames: number | null, intervalTime: number | null, reason: string) => {
      const pages = [page("host", "host", 1, 0), page("viewer", "viewer-1", 1, 1)];
      pages[0]!.connections[0]!.send = {
        rtpStatsId: "host-rtp",
        bitrateKbps: bitrate,
        framesPerSecond: fps,
        resolution: fps === 25 ? "640x360" : "1280x720",
        availableOutgoingKbps: bitrate * 4,
        intervalFramesEncoded: intervalFrames,
        intervalEncodeTimeMs: intervalTime,
        qualityLimitationReason: reason,
      };
      pages[1]!.connections[0]!.send = {
        ...pages[0]!.connections[0]!.send,
        rtpStatsId: "relay-rtp",
        bitrateKbps: bitrate / 2,
      };
      return pages;
    };
    const processSample = (browserCpu: number, rendererCpu: number) => ({ processes: [
      { type: "browser", id: 1, cpuTimeSeconds: browserCpu }, { type: "renderer", id: 2, cpuTimeSeconds: rendererCpu },
    ] });
    const summary = summarizeSamples(
      [
        { atEpochMs: 2_000, elapsedMs: 0, pages: makePages(1_000, 25, null, null, "none"), browserProcesses: processSample(10, 2) },
        { atEpochMs: 4_000, elapsedMs: 2_000, pages: makePages(1_200, 30, 20, 40, "none"), browserProcesses: processSample(10.4, 2.6) },
        { atEpochMs: 6_000, elapsedMs: 4_000, pages: makePages(1_400, 30, 30, 75, "cpu"), browserProcesses: processSample(9, 3) },
      ],
      1,
    );

    expect(summary.senderEvidence.host).toMatchObject({
      uniqueSenderCount: 1,
      unknownIdentitySamples: 0,
      bitrateKbps: { sampleCount: 3, min: 1_000, max: 1_400, mean: 1_200 },
      framesPerSecond: { sampleCount: 3, min: 25, max: 30 },
      resolutions: ["1280x720", "640x360"],
      encodeIntervals: { sampleCount: 2, framesEncoded: 50, encodeTimeMs: 115 },
      qualityLimitationReasonSamples: { none: 2, cpu: 1 },
    });
    expect(summary.senderEvidence.host.encodeIntervals.meanEncodeMsPerFrame).toBe(2.3);
    expect(summary.senderEvidence.relay.bitrateKbps.mean).toBe(600);
    expect(summary.browserProcessResources).toMatchObject({
      validCpuIntervals: 1,
      invalidCpuIntervals: 1,
      measuredWallTimeSeconds: 2,
      peakResidentSetBytes: null,
    });
    expect(summary.browserProcessResources.measuredCpuTimeSeconds).toBeCloseTo(1);
    expect(summary.browserProcessResources.averageCpuUtilizationPercent).toBeCloseTo(50);
  });

  it("checks one endpoint cap for Host and Viewer senders", () => {
    const initial = [
      page("host", "host", 2, 0),
      ...Array.from({ length: 3 }, (_, index) =>
        page("viewer", `viewer-${index + 1}`, index === 0 ? 1 : 0, 1),
      ),
    ];
    const final = structuredClone(initial);
    for (const viewer of final.filter((entry) => entry.role === "viewer")) {
      viewer.connections.at(-1)!.receiveTotals!.framesTotal = 20;
    }
    const summary = summarizeSamples(
      [
        { atEpochMs: 2_000, elapsedMs: 0, pages: initial },
        { atEpochMs: 4_000, elapsedMs: 2_000, pages: final },
      ],
      3,
    );
    const checks = buildRunChecks(summary, 3, "720p30", 2);
    expect(checks.find((check) => check.name === "host-assigned-children")?.passed).toBe(true);
    expect(checks.find((check) => check.name === "relay-active-media-edges")?.passed).toBe(true);
    const overused = {
      ...summary,
      maxRelayActiveMediaEdges: 3,
    };
    expect(
      buildRunChecks(overused, 3, "720p30", 2).find(
        (check) => check.name === "relay-active-media-edges",
      )?.passed,
    ).toBe(false);
  });

  it("fails continuity when frames freeze or stats collection errors", () => {
    const frozenInitial = [
      page("host", "host", 1, 0),
      page("viewer", "viewer-1", 0, 1),
    ];
    const frozenFinal = structuredClone(frozenInitial);
    expect(
      summarizeSamples(
        [
          { atEpochMs: 2_000, elapsedMs: 0, pages: frozenInitial },
          { atEpochMs: 4_000, elapsedMs: 2_000, pages: frozenFinal },
        ],
        1,
      ).everyViewerDecoded,
    ).toBe(false);

    const errorFinal = structuredClone(frozenFinal);
    errorFinal[1]!.connections[0]!.receiveTotals!.framesTotal = 20;
    errorFinal[1]!.connections[0]!.error = "getStats failed";
    expect(
      summarizeSamples(
        [
          { atEpochMs: 2_000, elapsedMs: 0, pages: frozenInitial },
          { atEpochMs: 4_000, elapsedMs: 2_000, pages: errorFinal },
        ],
        1,
      ).everyViewerDecoded,
    ).toBe(false);
  });

  it("accepts an authoritative SFU root and records its route generation", () => {
    const initial = [
      page("host", "host", 1, 0),
      page("viewer", "viewer-1", 0, 1),
    ];
    initial[0]!.routeRevision = 7;
    initial[0]!.routeAssignment.sfuPublicationGeneration =
      "publication_generation_12345678";
    initial[1]!.routeRevision = 7;
    initial[1]!.routeAssignment.upstream = { kind: "sfu" };
    initial[1]!.routeAssignment.sfuPublicationGeneration =
      "publication_generation_12345678";
    markSfuMedia(initial[0]!);
    markSfuMedia(initial[1]!);

    const final = structuredClone(initial);
    final[1]!.connections[0]!.receiveTotals!.framesTotal = 20;
    const summary = summarizeSamples(
      [
        { atEpochMs: 2_000, elapsedMs: 0, pages: initial },
        { atEpochMs: 4_000, elapsedMs: 2_000, pages: final },
      ],
      1,
    );

    expect(summary.everyViewerDecoded).toBe(true);
    expect(summary.viewerContinuity[0]).toMatchObject({
      assigned: true,
      routeRevision: 7,
      upstreamKind: "sfu",
    });
    expect(summary.finalTopology).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "host",
          routeRevision: 7,
          routeUpstream: { kind: "none" },
          sfuPublicationGeneration: "publication_generation_12345678",
        }),
        expect.objectContaining({
          role: "viewer",
          parentPeerId: null,
          routeRevision: 7,
          routeUpstream: { kind: "sfu" },
        }),
      ]),
    );
  });

  it("accepts admitted SFU subscriptions and detects excess Host media edges", () => {
    const generation = "publication_generation_12345678";
    const host = page("host", "host", 2, 0);
    const direct = page("viewer", "viewer-1", 0, 1);
    const firstRoot = page("viewer", "viewer-2", 0, 1);
    const secondRoot = page("viewer", "viewer-3", 0, 1);
    host.routeRevision = 7;
    host.routeAssignment.childPeerIds = [direct.peerId];
    host.routeAssignment.sfuPublicationGeneration = generation;
    host.maxAssignedChildren = 1;
    direct.routeRevision = 7;
    direct.routeAssignment.upstream = {
      kind: "peer",
      peerId: host.peerId,
    };
    for (const root of [firstRoot, secondRoot]) {
      root.routeRevision = 7;
      root.routeAssignment.upstream = { kind: "sfu" };
      root.routeAssignment.sfuPublicationGeneration = generation;
    }
    for (const participant of [host, firstRoot, secondRoot]) {
      markSfuMedia(participant);
    }

    const initial = [host, direct, firstRoot, secondRoot];
    const final = structuredClone(initial);
    for (const viewer of final.slice(1)) {
      viewer.connections.at(-1)!.receiveTotals!.framesTotal = 20;
    }
    const summary = summarizeSamples(
      [
        { atEpochMs: 2_000, elapsedMs: 0, pages: initial },
        { atEpochMs: 4_000, elapsedMs: 2_000, pages: final },
      ],
      3,
    );
    const checks = buildRunChecks(summary, 3, "720p30");

    expect(summary).toMatchObject({
      maxHostActiveMediaEdges: 2,
      maxHostAssignedChildren: 1,
      sfuRootCount: 2,
      sfuPublicationCoherent: true,
      everyViewerDecoded: true,
    });
    expect(
      checks.find((check) => check.name === "sfu-route-consistency")?.passed,
    ).toBe(true);
    expect(
      checks.find((check) => check.name === "host-active-media-edges")?.passed,
    ).toBe(true);

    const thirdRoot = page("viewer", "viewer-4", 0, 1);
    thirdRoot.routeRevision = 7;
    thirdRoot.routeAssignment.upstream = { kind: "sfu" };
    thirdRoot.routeAssignment.sfuPublicationGeneration = generation;
    markSfuMedia(thirdRoot);
    const threeRootInitial = [...structuredClone(initial), thirdRoot];
    const threeRootFinal = structuredClone(threeRootInitial);
    for (const viewer of threeRootFinal.slice(1)) {
      viewer.connections.at(-1)!.receiveTotals!.framesTotal = 20;
    }
    const threeRootSummary = summarizeSamples(
      [
        { atEpochMs: 2_000, elapsedMs: 0, pages: threeRootInitial },
        { atEpochMs: 4_000, elapsedMs: 2_000, pages: threeRootFinal },
      ],
      4,
    );
    expect(threeRootSummary.sfuRootCount).toBe(3);
    expect(
      buildRunChecks(threeRootSummary, 4, "720p30").find(
        (check) => check.name === "sfu-route-consistency",
      )?.passed,
    ).toBe(true);

    const excessiveHostInitial = structuredClone(initial);
    const excessiveHostFinal = structuredClone(final);
    excessiveHostInitial[0]!.maxActiveOutboundMediaEdges = 3;
    excessiveHostFinal[0]!.maxActiveOutboundMediaEdges = 3;
    const excessiveHostSummary = summarizeSamples(
      [
        { atEpochMs: 2_000, elapsedMs: 0, pages: excessiveHostInitial },
        { atEpochMs: 4_000, elapsedMs: 2_000, pages: excessiveHostFinal },
      ],
      3,
    );
    expect(
      buildRunChecks(excessiveHostSummary, 3, "720p30").find(
        (check) => check.name === "host-active-media-edges",
      )?.passed,
    ).toBe(false);
  });

  it("fails SFU continuity without one same-revision Host publication", () => {
    function summarizeSfu(
      hostGeneration: string | null,
      hostRevision: number,
      viewerRevision: number,
      viewerGeneration: string | null = null,
    ) {
      const initial = [
        page("host", "host", 1, 0),
        page("viewer", "viewer-1", 0, 1),
      ];
      initial[0]!.routeRevision = hostRevision;
      initial[0]!.routeAssignment.sfuPublicationGeneration = hostGeneration;
      initial[1]!.routeRevision = viewerRevision;
      initial[1]!.routeAssignment.upstream = { kind: "sfu" };
      initial[1]!.routeAssignment.sfuPublicationGeneration = viewerGeneration;
      markSfuMedia(initial[0]!);
      markSfuMedia(initial[1]!);
      const final = structuredClone(initial);
      final[1]!.connections[0]!.receiveTotals!.framesTotal = 20;
      return summarizeSamples(
        [
          { atEpochMs: 2_000, elapsedMs: 0, pages: initial },
          { atEpochMs: 4_000, elapsedMs: 2_000, pages: final },
        ],
        1,
      );
    }

    const missing = summarizeSfu(null, 7, 7);
    expect(missing.sfuPublicationCoherent).toBe(false);
    expect(missing.everyViewerDecoded).toBe(false);

    const mismatchedRevision = summarizeSfu(
      "publication_generation_12345678",
      7,
      8,
    );
    expect(mismatchedRevision.sfuPublicationCoherent).toBe(false);
    expect(mismatchedRevision.everyViewerDecoded).toBe(false);

    const mismatchedOwner = summarizeSfu(
      "publication_generation_12345678",
      7,
      7,
      "viewer_generation_12345678",
    );
    expect(mismatchedOwner.sfuPublicationCoherent).toBe(false);
    expect(mismatchedOwner.everyViewerDecoded).toBe(false);
  });

  it("requires every SFU-rooted participant to share the active revision", () => {
    const initial = [
      page("host", "host", 1, 0),
      page("viewer", "viewer-1", 1, 1),
      page("viewer", "viewer-2", 0, 1),
    ];
    initial[0]!.routeRevision = 7;
    initial[0]!.routeAssignment.sfuPublicationGeneration =
      "publication_generation_12345678";
    initial[1]!.routeRevision = 7;
    initial[1]!.routeAssignment.upstream = { kind: "sfu" };
    initial[1]!.routeAssignment.sfuPublicationGeneration =
      "publication_generation_12345678";
    initial[2]!.routeRevision = 6;
    initial[2]!.routeAssignment.upstream = {
      kind: "peer",
      peerId: initial[1]!.peerId,
    };
    markSfuMedia(initial[0]!);
    markSfuMedia(initial[1]!);

    const final = structuredClone(initial);
    final[1]!.connections.at(-1)!.receiveTotals!.framesTotal = 20;
    final[2]!.connections.at(-1)!.receiveTotals!.framesTotal = 20;
    const summary = summarizeSamples(
      [
        { atEpochMs: 2_000, elapsedMs: 0, pages: initial },
        { atEpochMs: 4_000, elapsedMs: 2_000, pages: final },
      ],
      2,
    );

    expect(summary.sfuPublicationObserved).toBe(true);
    expect(summary.sfuPublicationCoherent).toBe(false);
    expect(summary.everyViewerDecoded).toBe(false);
  });

  it("does not treat old peer frames as active SFU media", () => {
    const initial = [
      page("host", "host", 1, 0),
      page("viewer", "viewer-1", 0, 1),
    ];
    initial[0]!.routeRevision = 7;
    initial[0]!.routeAssignment.sfuPublicationGeneration =
      "publication_generation_12345678";
    initial[1]!.routeRevision = 7;
    initial[1]!.routeAssignment.upstream = { kind: "sfu" };
    initial[1]!.routeAssignment.sfuPublicationGeneration =
      "publication_generation_12345678";
    markSfuMedia(initial[0]!);

    const final = structuredClone(initial);
    final[1]!.connections[0]!.receiveTotals!.framesTotal = 20;
    const summary = summarizeSamples(
      [
        { atEpochMs: 2_000, elapsedMs: 0, pages: initial },
        { atEpochMs: 4_000, elapsedMs: 2_000, pages: final },
      ],
      1,
    );

    expect(summary.sfuPublicationObserved).toBe(true);
    expect(summary.sfuPublicationCoherent).toBe(false);
    expect(summary.everyViewerDecoded).toBe(false);
  });

  it("reports only the no-orphan invariant when no SFU root is active", () => {
    const initial = [
      page("host", "host", 1, 0),
      page("viewer", "viewer-1", 0, 1),
    ];
    const final = structuredClone(initial);
    final[1]!.connections[0]!.receiveTotals!.framesTotal = 20;
    const summary = summarizeSamples(
      [
        { atEpochMs: 2_000, elapsedMs: 0, pages: initial },
        { atEpochMs: 4_000, elapsedMs: 2_000, pages: final },
      ],
      1,
    );
    const checks = buildRunChecks(summary, 1, "720p30");

    expect(summary.sfuPublicationObserved).toBe(false);
    expect(checks.some((check) => check.name === "sfu-route-consistency")).toBe(
      false,
    );
    expect(checks).toContainEqual(
      expect.objectContaining({
        name: "no-orphan-sfu-publication",
        passed: true,
      }),
    );

    const orphaned = structuredClone(final);
    orphaned[0]!.routeAssignment.sfuPublicationGeneration =
      "publication_generation_12345678";
    const orphanedSummary = summarizeSamples(
      [
        { atEpochMs: 2_000, elapsedMs: 0, pages: initial },
        { atEpochMs: 4_000, elapsedMs: 2_000, pages: orphaned },
      ],
      1,
    );
    expect(orphanedSummary.sfuPublicationObserved).toBe(false);
    expect(orphanedSummary.sfuPublicationCoherent).toBe(false);
    expect(
      buildRunChecks(orphanedSummary, 1, "720p30").find(
        (check) => check.name === "no-orphan-sfu-publication",
      )?.passed,
    ).toBe(false);
  });

  it("keeps loopback timing diagnostic while gating topology and decoding", () => {
    const initial = [
      page("host", "host", 1, 0),
      page("viewer", "viewer-1", 0, 1),
    ];
    initial[1]!.authenticateSentAtEpochMs = 1_000;
    const final = structuredClone(initial);
    final[1]!.firstDecodedAtEpochMs = 31_000;
    final[1]!.connections[0]!.receiveTotals!.framesTotal = 20;
    const summary = summarizeSamples(
      [
        { atEpochMs: 2_000, elapsedMs: 0, pages: initial },
        { atEpochMs: 32_000, elapsedMs: 30_000, pages: final },
      ],
      1,
    );
    const checks = buildRunChecks(summary, 1, "720p30");

    expect(summary.maxFirstDecodedAfterAuthenticateMs).toBe(30_000);
    expect(
      checks.some((check) => check.name === "first-decoded-frame"),
    ).toBe(false);
    expect(
      checks.find((check) => check.name === "all-viewers-decoded")?.passed,
    ).toBe(true);
    expect(
      checks
        .filter((check) => check.name.endsWith("media-edges"))
        .every((check) => check.passed),
    ).toBe(true);
  });

  it("gates recovery on resumed decoding and the two-edge bounds, not elapsed time", () => {
    const recovered = {
      triggered: true,
      recoveredAtEpochMs: 60_000,
      recoveryMs: 50_000,
      maxHostActiveMediaEdges: 2,
      maxHostAssignedChildren: 2,
    };

    expect(buildRecoveryCheck(recovered).passed).toBe(true);
    expect(
      buildRecoveryCheck({ ...recovered, recoveredAtEpochMs: undefined }).passed,
    ).toBe(false);
    expect(
      buildRecoveryCheck({ ...recovered, maxHostActiveMediaEdges: 3 }).passed,
    ).toBe(false);
    expect(
      buildRecoveryCheck({ ...recovered, maxHostAssignedChildren: 3 }).passed,
    ).toBe(false);
    expect(
      buildRecoveryCheck({
        triggered: true,
        recoveredAtEpochMs: 60_000,
      }).passed,
    ).toBe(false);
  });

  it("requires unaffected viewers to keep decoding after relay reassignment", () => {
    const before = [
      page("viewer", "viewer-1", 1, 1),
      page("viewer", "viewer-2", 0, 1),
    ];
    const baselines = captureRecoveryViewerBaselines(before);
    expect(baselines).not.toBeNull();
    const after = structuredClone(before);
    after[0]!.connections.at(-1)!.receiveTotals!.framesTotal = 20;

    expect(everyViewerRecoveredMedia(baselines, after)).toBe(false);

    after[1]!.connections.at(-1)!.receiveTotals!.framesTotal = 20;
    expect(everyViewerRecoveredMedia(baselines, after)).toBe(true);

    after[1]!.connections.at(-1)!.connectionId = "replacement-connection";
    expect(everyViewerRecoveredMedia(baselines, after)).toBe(false);
    after[1]!.connections.at(-1)!.connectionId = "receive-0";
    after[1]!.connections.at(-1)!.receiveTotals!.id = "replacement-rtp";
    expect(everyViewerRecoveredMedia(baselines, after)).toBe(false);
  });

  it("does not treat an unavailable recovery baseline as decoded growth", () => {
    const missing = [page("viewer", "viewer-1", 0, 1)];
    missing[0]!.connections = [];
    const current = [page("viewer", "viewer-1", 0, 1)];

    expect(captureRecoveryViewerBaselines(missing)).toBeNull();
    expect(everyViewerRecoveredMedia(null, current)).toBe(false);

    const rebased = captureRecoveryViewerBaselines(current);
    expect(rebased).not.toBeNull();
    expect(
      everyViewerRecoveredMedia(rebased, structuredClone(current)),
    ).toBe(false);

    current[0]!.connections[0]!.connectionId = null;
    expect(captureRecoveryViewerBaselines(current)).not.toBeNull();

    const errored = structuredClone(current);
    errored[0]!.connections[0]!.receiveTotals = null;
    errored[0]!.connections[0]!.error = "getStats failed";
    expect(captureRecoveryViewerBaselines(errored)).toBeNull();
  });

  it("retains a probe-observed host peak above the current edge count", () => {
    const host = page("host", "host", 2, 0);
    host.maxActiveOutboundMediaEdges = 3;
    host.maxAssignedChildren = 3;

    const peaks = mergeRecoveryHostPeaks({}, host);

    expect(peaks).toEqual({
      maxHostActiveMediaEdges: 3,
      maxHostAssignedChildren: 3,
    });
    expect(
      buildRecoveryCheck({
        triggered: true,
        recoveredAtEpochMs: 60_000,
        ...peaks,
      }).passed,
    ).toBe(false);
  });

  it("fails closed when decoded media has no authoritative upstream", () => {
    const initial = [
      page("host", "host", 1, 0),
      page("viewer", "viewer-1", 0, 1),
    ];
    initial[1]!.routeAssignment.upstream = { kind: "none" };
    const final = structuredClone(initial);
    final[1]!.connections[0]!.receiveTotals!.framesTotal = 20;

    expect(
      summarizeSamples(
        [
          { atEpochMs: 2_000, elapsedMs: 0, pages: initial },
          { atEpochMs: 4_000, elapsedMs: 2_000, pages: final },
        ],
        1,
      ).everyViewerDecoded,
    ).toBe(false);

    final[1]!.routeAssignment.upstream = {
      kind: "peer",
      peerId: "parent-peer",
    };
    final[1]!.routeRevision = null;
    expect(
      summarizeSamples(
        [
          { atEpochMs: 2_000, elapsedMs: 0, pages: initial },
          { atEpochMs: 4_000, elapsedMs: 2_000, pages: final },
        ],
        1,
      ).everyViewerDecoded,
    ).toBe(false);
  });

  it("requires every viewer to decode and render after a quality change", () => {
    const before = [
      page("host", "host", 2, 0),
      page("viewer", "viewer-1", 1, 1),
      page("viewer", "viewer-2", 0, 1),
    ];
    const after = structuredClone(before);
    for (const viewer of after.filter((entry) => entry.role === "viewer")) {
      viewer.connections.at(-1)!.receiveTotals!.framesTotal += 1;
      viewer.renderedFrames += 1;
    }
    expect(everyViewerAdvanced(before, after)).toBe(true);

    after[2]!.renderedFrames = before[2]!.renderedFrames;
    expect(everyViewerAdvanced(before, after)).toBe(false);
    after[2]!.renderedFrames += 1;
    after[1]!.connections.at(-1)!.receiveTotals!.framesTotal =
      before[1]!.connections.at(-1)!.receiveTotals!.framesTotal;
    expect(everyViewerAdvanced(before, after)).toBe(false);
  });

  it("observes only active authoritative route transitions", () => {
    const observer = createObserverHarness();
    const owner = observer.socket();
    const outsider = observer.socket();
    const activeRoute = routeAssignment(["child_peer_0001"]);
    const preparedRoute = routeAssignment(
      ["child_peer_0001", "child_peer_0002"],
      "publication_generation_12345678",
    );
    const conflictingRoute = routeAssignment(["conflict_peer_01"]);

    outsider.emitMessage({
      type: "authenticated",
      role: "host",
      peerId: "outsider_peer_01",
      mediaMode: "peer-assisted",
      routeRevision: 99,
      routeAssignment: conflictingRoute,
      qualitySettings: lowQualitySettings,
    });
    expect(observer.snapshot().peerId).toBeNull();

    authenticate(owner);
    owner.emitMessage({
      type: "authenticated",
      role: "host",
      peerId: "host_peer_0001",
      mediaMode: "peer-assisted",
      routeRevision: 4,
      routeAssignment: activeRoute,
      qualitySettings: lowQualitySettings,
    });
    expect(observer.snapshot()).toMatchObject({
      routeRevision: 4,
      routeAssignment: activeRoute,
      maxAssignedChildren: 1,
    });

    owner.emitMessage({
      type: "route-update",
      revision: 5,
      phase: "prepare",
      assignment: preparedRoute,
    });
    expect(observer.snapshot()).toMatchObject({
      routeRevision: 4,
      routeAssignment: activeRoute,
      maxAssignedChildren: 1,
    });

    owner.emitMessage({
      type: "route-update",
      revision: 3,
      phase: "active",
      assignment: preparedRoute,
    });
    owner.emitMessage({
      type: "route-update",
      revision: 5,
      phase: "active",
      assignment: conflictingRoute,
    });
    expect(observer.snapshot().routeAssignment).toEqual(activeRoute);

    owner.emitMessage({
      type: "route-update",
      revision: 5,
      phase: "active",
      assignment: preparedRoute,
    });
    expect(observer.snapshot()).toMatchObject({
      routeRevision: 5,
      routeAssignment: preparedRoute,
      maxAssignedChildren: 2,
    });

    owner.emitMessage({
      type: "route-update",
      revision: 5,
      phase: "prepare",
      assignment: preparedRoute,
    });
    owner.emitMessage({
      type: "route-update",
      revision: 5,
      phase: "active",
      assignment: activeRoute,
    });
    owner.emitMessage({
      type: "media-assignment",
      mediaAssignment: {
        parentPeerId: null,
        childPeerIds: ["legacy_child_01"],
      },
    });
    expect(observer.snapshot()).toMatchObject({
      routeRevision: 5,
      routeAssignment: preparedRoute,
      maxAssignedChildren: 2,
    });
  });

  it("accepts a three-child route only for an explicit cap3 observer", () => {
    const assignment = routeAssignment(["child_peer_0001", "child_peer_0002", "child_peer_0003"]);
    for (const [cap, accepted] of [[2, false], [3, true]] as const) {
      const observer = createObserverHarness(cap);
      const socket = observer.socket();
      authenticate(socket);
      socket.emitMessage({
        type: "authenticated",
        role: "host",
        peerId: "host_peer_0001",
        mediaMode: "peer-assisted",
        routeRevision: 1,
        routeAssignment: assignment,
        qualitySettings: lowQualitySettings,
      });
      expect(observer.snapshot().routeAssignment !== null).toBe(accepted);
    }
  });

  it("clears hybrid state only from the current authenticated socket", () => {
    const observer = createObserverHarness();
    const previous = observer.socket();
    const current = observer.socket();
    const assignment = routeAssignment(["child_peer_0001"]);

    authenticate(previous);
    previous.emitMessage({
      type: "authenticated",
      role: "host",
      peerId: "host_peer_0001",
      mediaMode: "peer-assisted",
      routeRevision: 4,
      routeAssignment: assignment,
      qualitySettings: lowQualitySettings,
    });
    authenticate(current);
    expect(observer.snapshot()).toMatchObject({
      signalingConnected: false,
      routeRevision: 4,
      routeAssignment: assignment,
    });
    current.emitMessage({
      type: "authenticated",
      role: "host",
      peerId: "host_peer_0001",
      viewerPeerIds: [],
    });
    expect(observer.snapshot()).toMatchObject({
      signalingConnected: true,
      routeRevision: null,
      routeAssignment: null,
    });

    previous.emitMessage({
      type: "route-update",
      revision: 6,
      phase: "active",
      assignment,
    });
    previous.emitClose();
    expect(observer.snapshot()).toMatchObject({
      signalingConnected: true,
      routeRevision: null,
      routeAssignment: null,
    });

    current.emitClose();
    expect(observer.snapshot().signalingConnected).toBe(false);
  });

  it("injects the requested deterministic capture dimensions", () => {
    const source = buildBenchmarkInitScript({
      label: "host-1",
      role: "host",
      viewerIndex: null,
      clearHostRoom: true,
      width: 1280,
      height: 720,
      frameRate: 30,
      expectedEndpointCap: 2,
    });
    expect(source).toContain('"width":1280');
    expect(source).toContain('"frameRate":30');
    expect(source).toContain("getDisplayMedia");
    expect(source).toContain("collectConnectionMetrics");
    expect(source).toContain("set-quality-settings");
    expect(source).toContain("renderedFrames");
  });
});
