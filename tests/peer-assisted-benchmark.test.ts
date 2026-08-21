import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import {
  activeVideoEdgeCount,
  buildBenchmarkInitScript,
  buildRecoveryCheck,
  buildRunChecks,
  captureRecoveryViewerBaselines,
  everyViewerAdvanced,
  everyViewerRecoveredMedia,
  mergeRecoveryHostPeaks,
  parseBenchmarkConfig,
  parseExpectedEndpointCap,
  parseViewerCounts,
  summarizeSamples,
} from "../scripts/peer-assisted-benchmark";
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
    activeRouteReady: [] as Array<{
      revision: number;
      upstreamKind: ParticipantRouteAssignment["upstream"]["kind"];
      sfuPublicationGeneration: string | null;
    }>,
    firstDecodedAtEpochMs: role === "viewer" ? 1_500 : null,
    firstRenderedAtEpochMs: role === "viewer" ? 1_550 : null,
    renderedFrames: role === "viewer" ? 10 : 0,
    connections: [
      ...Array.from({ length: sendEdges }, (_, index) => ({
        index,
        createdAtEpochMs: 1_000,
        connectionId: `send-${index}`,
        remotePeerId: `child-${index}`,
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
  private readonly listeners = new Map<
    string,
    Array<(event: { data?: string }) => void>
  >();

  send(_data: string): void {}

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
  activeRouteReady: Array<{
    revision: number;
    upstreamKind: ParticipantRouteAssignment["upstream"]["kind"];
    sfuPublicationGeneration: string | null;
  }>;
  maxAssignedChildren: number;
}

function createObserverHarness(expectedEndpointCap = 2) {
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
    label: "host-1",
    role: "host",
    viewerIndex: null,
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
  };
  return {
    socket: () => new WebSocketConstructor(),
    snapshot: () => structuredClone(api.snapshot()),
  };
}

function authenticate(socket: FakeWebSocket): void {
  socket.send(
    JSON.stringify({
      type: "authenticate",
      roomId: "1",
      role: "host",
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

function markActiveRouteReady(observation: ReturnType<typeof page>): void {
  if (observation.routeRevision === null) {
    throw new Error("An active route revision is required");
  }
  observation.activeRouteReady.push({
    revision: observation.routeRevision,
    upstreamKind: observation.routeAssignment.upstream.kind,
    sfuPublicationGeneration:
      observation.routeAssignment.sfuPublicationGeneration,
  });
}

describe("peer topology loopback configuration", () => {
  it("uses the bounded 1/3/5/8 matrix by default", () => {
    expect(parseViewerCounts(undefined)).toEqual([1, 3, 5, 8]);
  });

  it("deduplicates configured viewer counts without changing their order", () => {
    expect(parseViewerCounts("8, 3,3,1")).toEqual([8, 3, 1]);
    expect(() => parseViewerCounts("9")).toThrow(/1 to 8/);
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

  it("keeps cap2 by default and accepts only an explicit cap3 expectation", () => {
    expect(parseExpectedEndpointCap(undefined)).toBe(2);
    for (const value of ["1", "2.5", "4"]) {
      expect(() => parseExpectedEndpointCap(value)).toThrow(/integer from 2 to 3/);
    }
    expect(
      parseBenchmarkConfig({
        CHROME_PATH: "chrome",
        BENCHMARK_EXPECTED_ENDPOINT_CAP: "3",
      }).expectedEndpointCap,
    ).toBe(3);
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
    expect(
      summary.finalTopology.every(
        (entry) =>
          JSON.stringify(entry.qualitySettings) ===
          JSON.stringify(lowQualitySettings),
      ),
    ).toBe(true);
  });

  it("requires an explicit cap3 run to exercise cap3 fanout", () => {
    const initial = [
      page("host", "host", 3, 0),
      ...Array.from({ length: 6 }, (_, index) =>
        page("viewer", `viewer-${index + 1}`, index === 0 ? 3 : 0, 1),
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
      6,
    );
    const checks = buildRunChecks(summary, 6, "720p30", 3);
    expect(checks.find((check) => check.name === "endpoint-cap-observed")?.passed).toBe(true);
    const underused = {
      ...summary,
      maxHostAssignedChildren: 2,
      maxRelayActiveMediaEdges: 2,
    };
    expect(
      buildRunChecks(underused, 6, "720p30", 3).find(
        (check) => check.name === "endpoint-cap-observed",
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
    markActiveRouteReady(initial[0]!);
    markActiveRouteReady(initial[1]!);

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
      markActiveRouteReady(initial[0]!);
      markActiveRouteReady(initial[1]!);
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
    initial[2]!.routeRevision = 6;
    initial[2]!.routeAssignment.upstream = {
      kind: "peer",
      peerId: initial[1]!.peerId,
    };
    markActiveRouteReady(initial[0]!);
    markActiveRouteReady(initial[1]!);

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
    markActiveRouteReady(initial[0]!);

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

    owner.send(
      JSON.stringify({ type: "route-ready", revision: 5, phase: "active" }),
    );
    outsider.send(
      JSON.stringify({ type: "route-ready", revision: 5, phase: "active" }),
    );
    expect(observer.snapshot().activeRouteReady).toEqual([
      {
        revision: 5,
        upstreamKind: "none",
        sfuPublicationGeneration: "publication_generation_12345678",
      },
    ]);

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
      activeRouteReady: [],
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
