import { describe, expect, it } from "vitest";

import {
  activeVideoEdgeCount,
  buildBenchmarkInitScript,
  parseBenchmarkConfig,
  parseViewerCounts,
  summarizeSamples,
} from "../scripts/peer-assisted-benchmark";

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
    senderParameterApplications: [],
    maxActiveOutboundMediaEdges: sendEdges,
    maxAssignedChildren: sendEdges,
    assignment: {
      parentPeerId: role === "viewer" ? "parent-peer" : null,
      childPeerIds: Array.from({ length: sendEdges }, (_, index) => `child-${index}`),
    },
    firstDecodedAtEpochMs: role === "viewer" ? 1_500 : null,
    firstRenderedAtEpochMs: role === "viewer" ? 1_550 : null,
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
        connectionId: `receive-${index}`,
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

describe("peer-assisted benchmark configuration", () => {
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

describe("peer-assisted benchmark observations", () => {
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

  it("injects the requested deterministic capture dimensions", () => {
    const source = buildBenchmarkInitScript({
      label: "host-1",
      role: "host",
      viewerIndex: null,
      clearHostRoom: true,
      width: 1280,
      height: 720,
      frameRate: 30,
    });
    expect(source).toContain('"width":1280');
    expect(source).toContain('"frameRate":30');
    expect(source).toContain("getDisplayMedia");
    expect(source).toContain("collectConnectionMetrics");
    expect(source).toContain("set-quality-settings");
  });
});
