import { describe, expect, it } from "vitest";

import type {
  ClientMessage,
  ServerMessage,
  ViewerQualityEvidenceMetrics,
} from "../src/shared/protocol.ts";
import {
  classifyHostViewerQualityEvidence,
  freshViewerQualityEvidence,
  metricsFromQualityEvidence,
  nextViewerQualityEvidencePresentationExpiryAt,
  presentViewerQualityEvidence,
  qualityEvidenceMatchesSnapshot,
  qualityEvidenceUpstreamMatches,
  qualityEvidenceWindowFromMetrics,
  reconcileViewerQualityEvidencePresentation,
  refreshViewerQualityEvidencePresentation,
  type ViewerQualityEvidence,
  ViewerQualityEvidenceReporter,
} from "../src/client/media/viewer-quality-evidence.ts";
import {
  EMPTY_METRICS,
  type ConnectionMetrics,
  type PeerSnapshot,
} from "../src/client/types.ts";

function receiveMetrics(
  overrides: Partial<ConnectionMetrics> = {},
): ConnectionMetrics {
    return {
      ...EMPTY_METRICS,
      sampleTimestampMs: 10_000,
      sampleWindowMs: 2_000,
    framesPerSecond: 60,
    frameWidth: 1_920,
    frameHeight: 1_080,
    resolution: "1920x1080",
    bitrateKbps: 7_500,
    intervalPacketsReceived: 1_500,
    intervalPacketsLost: 2,
    rttMs: 18,
    jitterMs: 3.5,
    audioBitrateKbps: 192,
    audioPacketLossPercent: 0.2,
    audioJitterMs: 2.5,
    audioVideoPlayoutDeltaMs: -12.5,
    videoJitterBufferDelayMs: 24,
    audioJitterBufferDelayMs: 18,
    audioConcealedSamplesPercent: 1,
    intervalAudioConcealmentEvents: 3,
    audioCodec: "audio/opus",
    intervalFramesDecoded: 120,
    intervalFramesDropped: 1,
    intervalDecodeMs: 2.4,
    intervalFreezeCount: 0,
    intervalFreezeDurationMs: 0,
    codec: "video/H264",
    codecProfile: "profile-level-id=42e01f",
    codecParameters:
      "packetization-mode=1; level-asymmetry-allowed=1",
    scalabilityMode: "L3T3_KEY",
    ...overrides,
  };
}

function snapshot(
  connectionId: string,
  metrics = receiveMetrics(),
): PeerSnapshot {
  return {
    peerId: "host_12345678",
    connectionId,
    connectionState: "connected",
    iceConnectionState: "connected",
    metrics,
    error: null,
  };
}

function serverEvidence(
  overrides: {
    viewerPeerId?: string;
    upstream?: { kind: "peer"; peerId: string } | { kind: "sfu" };
    connectionId?: string;
    routeRevision?: number;
    sequence?: number;
    metrics?: Partial<ViewerQualityEvidenceMetrics>;
  } = {},
): ViewerQualityEvidence {
  const window = qualityEvidenceWindowFromMetrics(receiveMetrics())!;
  return {
    type: "viewer-quality-evidence",
    viewerPeerId: overrides.viewerPeerId ?? "viewer_12345678",
    upstream: overrides.upstream ?? {
      kind: "peer",
      peerId: "host_12345678",
    },
    guard: {
      connectionId: overrides.connectionId ?? "connection_12345678",
      routeRevision: overrides.routeRevision ?? 0,
    },
    sequence: overrides.sequence ?? 0,
    windowMs: window.windowMs,
    metrics: { ...window.metrics, ...overrides.metrics },
  };
}

describe("viewer quality evidence", () => {
  it("normalizes only bounded adjacent receive evidence", () => {
    expect(qualityEvidenceWindowFromMetrics(receiveMetrics())).toEqual({
      windowMs: 2_000,
      metrics: {
        width: 1_920,
        height: 1_080,
        framesPerSecond: 60,
        bitrateKbps: 7_500,
        packetsReceivedDelta: 1_500,
        packetsLostDelta: 2,
        rttMs: 18,
        jitterMs: 3.5,
        framesDecodedDelta: 120,
        framesDroppedDelta: 1,
        decodeMsPerFrame: 2.4,
        freezeCountDelta: 0,
        freezeDurationMsDelta: 0,
        codec: "video/H264",
        codecProfile: "profile-level-id=42e01f",
        codecParameters:
          "packetization-mode=1; level-asymmetry-allowed=1",
        audioBitrateKbps: 192,
        audioPacketLossPercent: 0.2,
        audioJitterMs: 2.5,
        audioVideoPlayoutDeltaMs: -12.5,
        videoJitterBufferDelayMs: 24,
        audioJitterBufferDelayMs: 18,
        audioConcealedSamplesPercent: 1,
        audioConcealmentEventsDelta: 3,
        audioCodec: "audio/opus",
      },
    });

    expect(
      qualityEvidenceWindowFromMetrics(
        receiveMetrics({
          sampleWindowMs: 9_000,
          rtpStatsId: "must-not-leave-the-client",
        }),
      ),
    ).toBeNull();
    const bounded = qualityEvidenceWindowFromMetrics(
        receiveMetrics({
          frameWidth: 0,
          frameHeight: 0,
        bitrateKbps: 200_000,
        intervalPacketsLost: -1,
        rttMs: 70_000,
        audioBitrateKbps: 20_000,
        audioPacketLossPercent: 101,
        audioVideoPlayoutDeltaMs: -70_000,
        audioCodec: "audio/not valid",
        codecParameters: "raw fmtp; secret=value/with/slash",
        audioCodecParameters: "useinbandfec=1",
        localCandidateAddress: "192.0.2.10",
        localCandidatePort: 50_000,
        remoteCandidateAddress: "203.0.113.20",
        remoteCandidatePort: 50_001,
      }),
    );
    expect(bounded?.metrics).toMatchObject({
      width: null,
      height: null,
      bitrateKbps: null,
      packetsLostDelta: null,
      rttMs: null,
      audioBitrateKbps: null,
      audioPacketLossPercent: null,
      audioVideoPlayoutDeltaMs: null,
      audioCodec: null,
      codecParameters: null,
    });
    expect(JSON.stringify(bounded)).not.toContain("rtpStatsId");
    expect(JSON.stringify(bounded)).not.toContain("must-not-leave-the-client");
    expect(JSON.stringify(bounded)).not.toContain("scalabilityMode");
    expect(JSON.stringify(bounded)).not.toContain("L3T3_KEY");
    expect(JSON.stringify(bounded)).not.toContain("audioCodecParameters");
    expect(JSON.stringify(bounded)).not.toContain("useinbandfec=1");
    expect(JSON.stringify(bounded)).not.toContain("192.0.2.10");
    expect(JSON.stringify(bounded)).not.toContain("203.0.113.20");
  });

  it("rate-limits, deduplicates, and resets sequence per connection", () => {
    let now = 10_000;
    const sent: ClientMessage[] = [];
    const reporter = new ViewerQualityEvidenceReporter(
      (message) => {
        sent.push(message);
        return true;
      },
      () => now,
    );
    const first = snapshot("connection_first_12345678");

    expect(reporter.offer(first, 0)).toBe(true);
    expect(reporter.offer(first, 0)).toBe(false);
    now += 1_000;
    expect(
      reporter.offer(
        snapshot(
          first.connectionId,
          receiveMetrics({ sampleTimestampMs: 11_000, bitrateKbps: 7_000 }),
        ),
        0,
      ),
    ).toBe(false);
    now += 1_000;
    expect(
      reporter.offer(
        snapshot(
          first.connectionId,
          receiveMetrics({ sampleTimestampMs: 12_000, bitrateKbps: 6_500 }),
        ),
        0,
      ),
    ).toBe(true);
    expect(
      reporter.offer(
        snapshot(
          first.connectionId,
          receiveMetrics({ sampleTimestampMs: 12_000, bitrateKbps: 6_000 }),
        ),
        2,
      ),
    ).toBe(true);
    expect(
      reporter.offer(snapshot("connection_second_12345678"), 2),
    ).toBe(true);
    now += 2_000;
    expect(
      reporter.offer(
        snapshot(
          "connection_second_12345678",
          receiveMetrics({ sampleTimestampMs: 14_000 }),
        ),
        2,
      ),
    ).toBe(true);

    expect(
      sent.map((message) =>
        message.type === "viewer-quality-evidence"
          ? {
              connectionId: message.guard.connectionId,
              revision: message.guard.routeRevision,
              sequence: message.sequence,
            }
          : null,
      ),
    ).toEqual([
      {
        connectionId: "connection_first_12345678",
        revision: 0,
        sequence: 0,
      },
      {
        connectionId: "connection_first_12345678",
        revision: 0,
        sequence: 1,
      },
      {
        connectionId: "connection_first_12345678",
        revision: 2,
        sequence: 2,
      },
      {
        connectionId: "connection_second_12345678",
        revision: 2,
        sequence: 0,
      },
      {
        connectionId: "connection_second_12345678",
        revision: 2,
        sequence: 1,
      },
    ]);
  });

  it("reports SFU metrics with the exact route identity", () => {
    const sent: ClientMessage[] = [];
    const reporter = new ViewerQualityEvidenceReporter((message) => {
      sent.push(message);
      return true;
    });

    expect(
      reporter.offerMetrics(
        "sfu_connection_12345678",
        receiveMetrics(),
        3,
      ),
    ).toBe(true);
    expect(sent).toEqual([
      expect.objectContaining({
        type: "viewer-quality-evidence",
        guard: {
          connectionId: "sfu_connection_12345678",
          routeRevision: 3,
        },
        sequence: 0,
      }),
    ]);
  });

  it("pairs and renders only the current upstream connection", () => {
    const evidence = {
      type: "viewer-quality-evidence",
      viewerPeerId: "viewer_12345678",
      upstream: { kind: "peer", peerId: "host_12345678" },
      guard: {
        connectionId: "connection_12345678",
        routeRevision: 0,
      },
      sequence: 3,
      ...qualityEvidenceWindowFromMetrics(receiveMetrics())!,
    } as Extract<ServerMessage, { type: "viewer-quality-evidence" }>;
    const current = {
      ...snapshot(evidence.guard.connectionId),
      peerId: evidence.viewerPeerId,
    };

    expect(qualityEvidenceMatchesSnapshot(evidence, current)).toBe(true);
    expect(
      qualityEvidenceMatchesSnapshot(evidence, {
        ...current,
        connectionId: "connection_replaced_12345678",
      }),
    ).toBe(false);
    expect(
      classifyHostViewerQualityEvidence(
        evidence,
        "host_12345678",
        evidence.guard.routeRevision,
        current,
      ),
    ).toBe("direct");
    expect(
      classifyHostViewerQualityEvidence(
        evidence,
        "host_12345678",
        evidence.guard.routeRevision,
        { ...current, connectionId: "connection_replaced_12345678" },
      ),
    ).toBeNull();
    expect(
      classifyHostViewerQualityEvidence(
        {
          ...evidence,
          upstream: { kind: "peer", peerId: "viewer_relay_12345678" },
        },
        "host_12345678",
        evidence.guard.routeRevision,
        null,
      ),
    ).toBe("peer-relayed");
    const sfuEvidence = {
      ...evidence,
      upstream: { kind: "sfu" as const },
    };
    expect(
      classifyHostViewerQualityEvidence(
        sfuEvidence,
        "host_12345678",
        evidence.guard.routeRevision,
        null,
      ),
    ).toBe("sfu");
    expect(qualityEvidenceUpstreamMatches(sfuEvidence, { kind: "sfu" })).toBe(
      true,
    );
    expect(
      qualityEvidenceUpstreamMatches(sfuEvidence, {
        kind: "peer",
        peerId: "host_12345678",
      }),
    ).toBe(false);
    expect(
      classifyHostViewerQualityEvidence(
        evidence,
        "host_12345678",
        evidence.guard.routeRevision + 1,
        current,
      ),
    ).toBeNull();
    expect(metricsFromQualityEvidence(evidence)).toMatchObject({
      sampleWindowMs: 2_000,
      frameWidth: 1_920,
      frameHeight: 1_080,
      resolution: "1920x1080",
      bitrateKbps: 7_500,
      packetsLost: 2,
      packetLossPercent: (2 / 1_502) * 100,
      rttMs: 18,
      framesDropped: 1,
      intervalFramesDecoded: 120,
      intervalFramesDropped: 1,
      intervalFreezeCount: 0,
      codec: "video/H264",
      audioBitrateKbps: 192,
      audioPacketLossPercent: 0.2,
      audioJitterMs: 2.5,
      audioVideoPlayoutDeltaMs: -12.5,
      videoJitterBufferDelayMs: 24,
      audioJitterBufferDelayMs: 18,
      audioConcealedSamplesPercent: 1,
      intervalAudioConcealmentEvents: 3,
      audioCodec: "audio/opus",
    });
  });

  it("expires retained fields independently at their exact observation deadline", () => {
    const first = presentViewerQualityEvidence(
      null,
      serverEvidence({ sequence: 4 }),
      0,
    );
    const second = presentViewerQualityEvidence(
      first,
      serverEvidence({
        sequence: 5,
        metrics: {
          bitrateKbps: 6_000,
          codec: null,
          codecProfile: null,
          codecParameters: null,
        },
      }),
      2_000,
    );

    expect(second.evidence.metrics.codec).toBe("video/H264");
    expect(second.evidence.metrics.bitrateKbps).toBe(6_000);
    expect(nextViewerQualityEvidencePresentationExpiryAt(second, 2_000)).toBe(
      5_000,
    );
    expect(
      refreshViewerQualityEvidencePresentation(second, 4_999).evidence.metrics
        .codec,
    ).toBe("video/H264");

    const atFirstDeadline = refreshViewerQualityEvidencePresentation(
      second,
      5_000,
    );
    expect(atFirstDeadline).toMatchObject({ fresh: true });
    expect(atFirstDeadline.evidence.metrics).toMatchObject({
      codec: null,
      codecProfile: null,
      codecParameters: null,
      bitrateKbps: 6_000,
    });
    expect(
      nextViewerQualityEvidencePresentationExpiryAt(atFirstDeadline, 5_000),
    ).toBe(7_000);

    const expired = refreshViewerQualityEvidencePresentation(second, 7_000);
    expect(expired.fresh).toBe(false);
    expect(Object.values(expired.evidence.metrics)).toEqual(
      expect.arrayContaining([null]),
    );
    expect(
      Object.values(expired.evidence.metrics).every((value) => value === null),
    ).toBe(true);
    expect(
      nextViewerQualityEvidencePresentationExpiryAt(expired, 7_000),
    ).toBeNull();
  });

  it("does not extend a retained field when later samples still omit it", () => {
    const first = presentViewerQualityEvidence(
      null,
      serverEvidence({ sequence: 1 }),
      0,
    );
    const second = presentViewerQualityEvidence(
      first,
      serverEvidence({
        sequence: 2,
        metrics: {
          codec: null,
          codecProfile: null,
          codecParameters: null,
        },
      }),
      2_000,
    );
    const third = presentViewerQualityEvidence(
      second,
      serverEvidence({
        sequence: 3,
        metrics: {
          codec: null,
          codecProfile: null,
          codecParameters: null,
        },
      }),
      4_000,
    );

    expect(third.evidence.metrics.codec).toBe("video/H264");
    expect(nextViewerQualityEvidencePresentationExpiryAt(third, 4_000)).toBe(
      5_000,
    );
    expect(
      refreshViewerQualityEvidencePresentation(third, 5_000).evidence.metrics
        .codec,
    ).toBeNull();
  });

  it("resets retained fields on identity or non-monotonic sequence changes", () => {
    const first = presentViewerQualityEvidence(
      null,
      serverEvidence({ sequence: 9 }),
      0,
    );
    const resetSequence = presentViewerQualityEvidence(
      first,
      serverEvidence({ sequence: 0, metrics: { bitrateKbps: null } }),
      2_000,
    );
    expect(resetSequence.evidence.metrics.bitrateKbps).toBeNull();

    const changedRoute = presentViewerQualityEvidence(
      first,
      serverEvidence({
        sequence: 10,
        routeRevision: 1,
        metrics: {
          codec: null,
          codecProfile: null,
          codecParameters: null,
        },
      }),
      2_000,
    );
    expect(changedRoute.evidence.metrics.codec).toBeNull();

    const changedConnection = presentViewerQualityEvidence(
      first,
      serverEvidence({
        sequence: 10,
        connectionId: "connection_replaced_12345678",
        metrics: { framesPerSecond: null },
      }),
      2_000,
    );
    expect(changedConnection.evidence.metrics.framesPerSecond).toBeNull();
  });

  it("keeps a stale shell during transient states and clears terminal identities", () => {
    const evidence = serverEvidence();
    const presentation = presentViewerQualityEvidence(null, evidence, 0);
    const current = {
      ...snapshot(evidence.guard.connectionId),
      peerId: evidence.viewerPeerId,
    };

    expect(
      reconcileViewerQualityEvidencePresentation(presentation, current),
    ).toBe(presentation);
    expect(freshViewerQualityEvidence(presentation)).toBe(
      presentation.evidence,
    );
    for (const connectionState of [
      "new",
      "connecting",
      "disconnected",
    ] as const) {
      const reconciled = reconcileViewerQualityEvidencePresentation(
        presentation,
        { ...current, connectionState },
      );
      expect(reconciled).toMatchObject({ fresh: false });
      expect(reconciled?.evidence.metrics.bitrateKbps).toBe(7_500);
      expect(freshViewerQualityEvidence(reconciled)).toBeNull();
      expect(
        qualityEvidenceMatchesSnapshot(evidence, {
          ...current,
          connectionState,
        }),
      ).toBe(false);
    }
    for (const connectionState of ["failed", "closed"] as const) {
      expect(
        reconcileViewerQualityEvidencePresentation(presentation, {
          ...current,
          connectionState,
        }),
      ).toBeNull();
    }
    expect(
      reconcileViewerQualityEvidencePresentation(presentation, {
        ...current,
        connectionId: "connection_replaced_12345678",
      }),
    ).toBeNull();
    expect(
      reconcileViewerQualityEvidencePresentation(presentation, null),
    ).toBeNull();
  });

});
