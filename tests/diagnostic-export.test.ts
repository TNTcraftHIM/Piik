import { describe, expect, it, vi } from "vitest";

import {
  createDiagnosticReport,
  DIAGNOSTIC_SCHEMA_VERSION,
  downloadDiagnosticReport,
  summarizeRouteTiming,
  type DiagnosticConnectionInput,
  type ViewerDiagnosticInput,
} from "../src/client/lib/diagnostic-export.ts";
import { EMPTY_METRICS } from "../src/client/types.ts";

describe("diagnostic export privacy boundary", () => {
  it("exports a versioned allowlist and preserves unavailable values as null", () => {
    const report = createDiagnosticReport(
      "viewer",
      [
        {
          scope: "upstream",
          route: "p2p",
          direction: "receive",
          connectionState: "connected",
          iceConnectionState: "connected",
          metrics: {
            ...EMPTY_METRICS,
            path: "direct",
            iceProtocol: "udp",
            localCandidateType: "srflx",
            remoteCandidateType: "host",
            bitrateKbps: 4_200,
            framesPerSecond: 59.8,
            codec: "video/VP8",
            audioVideoPlayoutDeltaMs: -12.5,
            candidatePairResponsesReceived: 18,
            intervalCandidatePairResponsesReceived: 1,
            candidatePairSampleWindowMs: 2_000,
          },
        },
      ],
      new Date("2026-08-22T12:00:00.000Z"),
    );

    expect(report.schemaVersion).toBe(DIAGNOSTIC_SCHEMA_VERSION);
    expect(report.exportedAt).toBe("2026-08-22T12:00:00.000Z");
    expect(report.connections[0]).toMatchObject({
      scope: "upstream",
      route: "p2p",
      direction: "receive",
      connectionState: "connected",
      iceConnectionState: "connected",
      metrics: {
        iceProtocol: "udp",
        localCandidateType: "srflx",
        bitrateKbps: 4_200,
        framesPerSecond: 59.8,
        codec: "video/VP8",
        audioVideoPlayoutDeltaMs: -12.5,
        candidatePairResponsesReceived: 18,
        intervalCandidatePairResponsesReceived: 1,
        candidatePairSampleWindowMs: 2_000,
        audioJitterMs: null,
      },
    });
  });

  it("cannot serialize addresses, identities, raw signaling, URLs, or credentials", () => {
    const secrets = {
      localCandidateAddress: "sensitive-local-address",
      localCandidatePort: 50_000,
      remoteCandidateAddress: "sensitive-remote-address",
      remoteCandidatePort: 50_001,
      selectedCandidatePairId: "sensitive-pair-id",
      rtpStatsId: "sensitive-rtp-id",
      rtpSsrc: 4_242,
      rtpMid: "sensitive-mid",
      rtpRid: "sensitive-rid",
      trackIdentifier: "sensitive-track-id",
      rawCandidate: "candidate-sensitive",
      sdp: "sdp-sensitive",
      privateUrl: "https://secret.example",
      stunUrl: "stun:secret.example",
      username: "username-sensitive",
      credential: "credential-sensitive",
      token: "token-sensitive",
      errorText: "error-sensitive",
    };
    const unsafeInput = {
      scope: "viewer-edge",
      route: "p2p",
      direction: "send",
      connectionState: "connected",
      iceConnectionState: "connected",
      peerId: "peer-sensitive",
      clientId: "client-sensitive",
      roomCode: "room-sensitive",
      roomId: "room-id-sensitive",
      name: "name-sensitive",
      hostToken: "host-token-sensitive",
      viewerGrant: "viewer-grant-sensitive",
      roomPassword: "password-sensitive",
      metrics: { ...EMPTY_METRICS, ...secrets },
    } as unknown as DiagnosticConnectionInput;

    const json = JSON.stringify(createDiagnosticReport("host", [unsafeInput]));
    for (const value of [
      ...Object.values(secrets).map(String),
      "peer-sensitive",
      "client-sensitive",
      "room-sensitive",
      "room-id-sensitive",
      "name-sensitive",
      "host-token-sensitive",
      "viewer-grant-sensitive",
      "password-sensitive",
    ]) {
      expect(json).not.toContain(value);
    }
    for (const key of [
      "localCandidateAddress",
      "localCandidatePort",
      "remoteCandidateAddress",
      "remoteCandidatePort",
      "selectedCandidatePairId",
      "rtpStatsId",
      "rtpSsrc",
      "rtpMid",
      "rtpRid",
      "trackIdentifier",
      "peerId",
      "clientId",
      "roomCode",
      "roomId",
      "name",
      "hostToken",
      "viewerGrant",
      "roomPassword",
      "rawCandidate",
      "sdp",
      "turnUrl",
      "stunUrl",
      "username",
      "credential",
      "token",
      "errorText",
    ]) {
      expect(json).not.toContain(`"${key}"`);
    }
  });

  it("exports authenticated Viewer state even with zero connection metrics", () => {
    const viewerState: ViewerDiagnosticInput = {
      authenticated: true,
      stage: "route-failed",
      revision: 7,
      failureCode: "ROUTE_EXHAUSTED",
      signalState: "connected",
      hostState: "online",
      routeKind: "sfu",
      frameProof: "none",
    };
    const report = createDiagnosticReport(
      "viewer",
      [],
      new Date("2026-08-24T12:00:00.000Z"),
      viewerState,
    );

    expect(report.viewer).toEqual({
      stage: "route-failed",
      revision: "changed",
      failureCode: "ROUTE_EXHAUSTED",
      signalState: "connected",
      hostState: "online",
      routeKind: "sfu",
      frameProof: "none",
    });
    expect(report.connections).toEqual([]);
  });

  it("limits unauthenticated room denial diagnostics to stage and code", () => {
    const unsafe = {
      authenticated: false,
      stage: "access-denied",
      revision: 42,
      failureCode: "ROOM_ACCESS_DENIED",
      signalState: "reconnecting",
      hostState: "online",
      routeKind: "p2p",
      frameProof: "current",
      roomId: "private-room",
      viewerGrant: "private-grant",
      rawMessage: "private-error",
    } as unknown as ViewerDiagnosticInput;
    const report = createDiagnosticReport(
      "viewer",
      [
        {
          scope: "upstream",
          route: "p2p",
          direction: "receive",
          metrics: { ...EMPTY_METRICS, bitrateKbps: 9_999 },
        },
      ],
      new Date("2026-08-24T12:00:00.000Z"),
      unsafe,
    );

    expect(report.viewer).toEqual({
      stage: "access-denied",
      failureCode: "ROOM_ACCESS_DENIED",
    });
    expect(report.connections).toEqual([]);
    const json = JSON.stringify(report);
    expect(json).not.toContain("private-");
    expect(json).not.toContain("revision");
    expect(json).not.toContain("signalState");
    expect(json).not.toContain("hostState");
    expect(json).not.toContain("routeKind");
    expect(json).not.toContain("frameProof");
  });

  it("creates one local JSON Blob and revokes its URL after download", async () => {
    let createdBlob: Blob | null = null;
    const link = { href: "", download: "", hidden: false, click: vi.fn(), remove: vi.fn() };
    const append = vi.fn();
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("document", {
      createElement: vi.fn(() => link),
      body: { append },
    });
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn((blob: Blob) => {
        createdBlob = blob;
        return "blob:diagnostic";
      }),
      revokeObjectURL,
    });
    vi.stubGlobal("window", {
      setTimeout: (callback: () => void) => {
        callback();
        return 1;
      },
    });

    try {
      downloadDiagnosticReport("host", [{
        scope: "host-sfu",
        route: "sfu",
        direction: "send",
        metrics: EMPTY_METRICS,
      }]);
      expect(link.click).toHaveBeenCalledOnce();
      expect(link.remove).toHaveBeenCalledOnce();
      expect(append).toHaveBeenCalledWith(link);
      expect(link.download).toMatch(/^screener-diagnostics-host-.*\.json$/);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:diagnostic");
      expect(await createdBlob!.text()).toContain(`"schemaVersion": 2`);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports raw 20-Viewer timings with nearest-rank percentiles", () => {
    const values = Array.from({ length: 20 }, (_, index) =>
      index % 5 === 0 ? null : (20 - index) * 10,
    );

    const expected = {
      sampleCount: 16,
      pendingCount: 4,
      rawMs: [
        10, 20, 30, 40, 60, 70, 80, 90, 110, 120, 130, 140, 160, 170,
        180, 190,
      ],
      p50Ms: 90,
      p95Ms: 190,
      maxMs: 190,
    };
    expect(summarizeRouteTiming(values)).toEqual(expected);
    const report = createDiagnosticReport(
      "host",
      [],
      new Date("2026-08-24T12:00:00.000Z"),
      {
        children: values.map((finalMs, index) => ({
          ordinal: index + 1,
          parent: { kind: "none" as const },
          effectiveCapacity: 0,
          childCount: 0,
          demandAgeMs: 200,
          queueWaitMs: finalMs,
          candidateStartMs: finalMs,
          firstDecodedFrameMs: finalMs,
          finalMs,
          finalRoute: finalMs === null ? "waiting" as const : "direct" as const,
          rejectionBucket: "none" as const,
        })),
        operation: null,
      },
    );
    expect(report.route?.children).toHaveLength(20);
    expect(report.routeTimingSummary?.finalMs).toEqual(expected);
    expect(summarizeRouteTiming([null, null])).toEqual({
      sampleCount: 0,
      pendingCount: 2,
      rawMs: [],
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
    });
  });

  it("includes only sanitized route fields in a Host export", () => {
    const route = {
      children: [
        {
          ordinal: 1,
          parent: { kind: "host" as const },
          effectiveCapacity: 2,
          childCount: 0,
          demandAgeMs: 120,
          queueWaitMs: 10,
          candidateStartMs: 20,
          firstDecodedFrameMs: 70,
          finalMs: 70,
          finalRoute: "direct" as const,
          rejectionBucket: "none" as const,
        },
      ],
      operation: null,
    };
    const report = createDiagnosticReport(
      "host",
      [],
      new Date("2026-08-24T12:00:00.000Z"),
      route,
    );

    expect(report.route).toEqual(route);
    expect(report.routeTimingSummary).toMatchObject({
      queueWaitMs: { sampleCount: 1, pendingCount: 0, rawMs: [10] },
      finalMs: { p50Ms: 70, p95Ms: 70, maxMs: 70 },
    });
    expect(
      createDiagnosticReport(
        "viewer",
        [],
        new Date("2026-08-24T12:00:00.000Z"),
        route,
      ),
    ).toMatchObject({ route: null, routeTimingSummary: null });
  });
});
