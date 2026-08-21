import { describe, expect, it, vi } from "vitest";

import {
  createDiagnosticReport,
  DIAGNOSTIC_SCHEMA_VERSION,
  downloadDiagnosticReport,
  type DiagnosticConnectionInput,
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
      turnUrl: "turn:secret.example",
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
      expect(await createdBlob!.text()).toContain(`"schemaVersion": 1`);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
