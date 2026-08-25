import {
  MAX_MEDIA_ROUTE_REVISION,
  MAX_VIEWER_QUALITY_EVIDENCE_BYTES,
  VIEWER_QUALITY_EVIDENCE_EXPIRY_MS,
  VIEWER_QUALITY_EVIDENCE_INTERVAL_MS,
  viewerQualityEvidenceMessageSchema,
  viewerQualityEvidenceMetricsSchema,
  type ClientMessage,
  type MediaRouteUpstream,
  type ServerMessage,
  type ViewerQualityEvidenceMetrics,
} from "../../shared/protocol";
import {
  EMPTY_METRICS,
  type ConnectionMetrics,
  type PeerSnapshot,
} from "../types";
import { packetLossPercentFromDeltas } from "../webrtc/stats";

export type ViewerQualityEvidence = Extract<
  ServerMessage,
  { type: "viewer-quality-evidence" }
>;

type ViewerQualityEvidenceMetric = keyof ViewerQualityEvidenceMetrics;

function viewerQualityEvidenceMetricKeys(
  metrics: ViewerQualityEvidenceMetrics,
): ViewerQualityEvidenceMetric[] {
  return Object.keys(metrics) as ViewerQualityEvidenceMetric[];
}

export interface ViewerQualityEvidencePresentation {
  evidence: ViewerQualityEvidence;
  fresh: boolean;
  receivedAtMs: number;
}

type ViewerQualityEvidenceWindow = Pick<
  Extract<ClientMessage, { type: "viewer-quality-evidence" }>,
  "windowMs" | "metrics"
>;

function boundedNumber(value: number | null, maximum: number): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= maximum
    ? value
    : null;
}

function boundedSignedNumber(
  value: number | null,
  absoluteMaximum: number,
): number | null {
  return value !== null &&
    Number.isFinite(value) &&
    Math.abs(value) <= absoluteMaximum
    ? value
    : null;
}

function boundedInteger(value: number | null, maximum: number): number | null {
  return value !== null && Number.isInteger(value) && value >= 0 && value <= maximum
    ? value
    : null;
}

function boundedString(
  value: string | null,
  maximumLength: number,
  pattern: RegExp,
): string | null {
  return value !== null &&
    value.length <= maximumLength &&
    pattern.test(value)
    ? value
    : null;
}

export function qualityEvidenceWindowFromMetrics(
  metrics: ConnectionMetrics,
): ViewerQualityEvidenceWindow | null {
  if (metrics.sampleWindowMs === null || !Number.isFinite(metrics.sampleWindowMs)) {
    return null;
  }
  const windowMs = Math.round(metrics.sampleWindowMs);
  if (windowMs < 1_000 || windowMs > 5_000) {
    return null;
  }

  const boundedWidth = boundedInteger(metrics.frameWidth, 16_384);
  const boundedHeight = boundedInteger(metrics.frameHeight, 16_384);
  const width = boundedWidth !== null && boundedWidth >= 1 ? boundedWidth : null;
  const height =
    boundedHeight !== null && boundedHeight >= 1 ? boundedHeight : null;
  const dimensions =
    width !== null && height !== null
      ? { width, height }
      : { width: null, height: null };
  const freezeDuration = boundedNumber(
    metrics.intervalFreezeDurationMs,
    windowMs,
  );
  const candidate: ViewerQualityEvidenceMetrics = {
    ...dimensions,
    framesPerSecond: boundedNumber(metrics.framesPerSecond, 240),
    bitrateKbps: boundedNumber(metrics.bitrateKbps, 100_000),
    packetsReceivedDelta: boundedInteger(
      metrics.intervalPacketsReceived,
      1_000_000,
    ),
    packetsLostDelta: boundedInteger(metrics.intervalPacketsLost, 1_000_000),
    rttMs: boundedNumber(metrics.rttMs, 60_000),
    jitterMs: boundedNumber(metrics.jitterMs, 60_000),
    framesDecodedDelta: boundedInteger(
      metrics.intervalFramesDecoded,
      10_000,
    ),
    framesDroppedDelta: boundedInteger(
      metrics.intervalFramesDropped,
      10_000,
    ),
    decodeMsPerFrame: boundedNumber(metrics.intervalDecodeMs, 60_000),
    freezeCountDelta: boundedInteger(metrics.intervalFreezeCount, 10_000),
    freezeDurationMsDelta: freezeDuration,
    codec: boundedString(
      metrics.codec,
      64,
      /^video\/[A-Za-z0-9.+-]{1,32}$/i,
    ),
    codecProfile: boundedString(
      metrics.codecProfile,
      64,
      /^[a-z0-9-]+=[a-z0-9]+$/,
    ),
    codecParameters: boundedString(
      metrics.codecParameters,
      128,
      /^[a-z0-9-]+=[a-z0-9]+(?:; [a-z0-9-]+=[a-z0-9]+)*$/,
    ),
    audioBitrateKbps: boundedNumber(metrics.audioBitrateKbps, 10_000),
    audioPacketLossPercent: boundedNumber(
      metrics.audioPacketLossPercent,
      100,
    ),
    audioJitterMs: boundedNumber(metrics.audioJitterMs, 60_000),
    audioVideoPlayoutDeltaMs: boundedSignedNumber(
      metrics.audioVideoPlayoutDeltaMs,
      60_000,
    ),
    videoJitterBufferDelayMs: boundedNumber(
      metrics.videoJitterBufferDelayMs,
      60_000,
    ),
    audioJitterBufferDelayMs: boundedNumber(
      metrics.audioJitterBufferDelayMs,
      60_000,
    ),
    audioConcealedSamplesPercent: boundedNumber(
      metrics.audioConcealedSamplesPercent,
      100,
    ),
    audioConcealmentEventsDelta: boundedInteger(
      metrics.intervalAudioConcealmentEvents,
      10_000,
    ),
    audioCodec: boundedString(
      metrics.audioCodec,
      64,
      /^audio\/[A-Za-z0-9.+-]{1,32}$/i,
    ),
  };
  const parsed = viewerQualityEvidenceMetricsSchema.safeParse(candidate);
  return parsed.success ? { windowMs, metrics: parsed.data } : null;
}

export class ViewerQualityEvidenceReporter {
  private connectionId: string | null = null;
  private routeRevision: number | null = null;
  private sequence = 0;
  private lastSentAtMs: number | null = null;
  private lastSampleTimestampMs: number | null = null;

  constructor(
    private readonly send: (message: ClientMessage) => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  offer(snapshot: PeerSnapshot, routeRevision: number): boolean {
    return this.offerMetrics(
      snapshot.connectionId,
      snapshot.metrics,
      routeRevision,
    );
  }

  offerMetrics(
    connectionId: string,
    metrics: ConnectionMetrics,
    routeRevision: number,
  ): boolean {
    if (
      !Number.isSafeInteger(routeRevision) ||
      routeRevision < 0 ||
      routeRevision > MAX_MEDIA_ROUTE_REVISION
    ) {
      return false;
    }
    const window = qualityEvidenceWindowFromMetrics(metrics);
    const sampleTimestampMs = metrics.sampleTimestampMs;
    if (
      !window ||
      sampleTimestampMs === null ||
      !Number.isFinite(sampleTimestampMs) ||
      sampleTimestampMs < 0
    ) {
      return false;
    }
    if (this.connectionId !== connectionId) {
      this.connectionId = connectionId;
      this.routeRevision = routeRevision;
      this.sequence = 0;
      this.lastSentAtMs = null;
      this.lastSampleTimestampMs = null;
    } else if (this.routeRevision !== routeRevision) {
      this.routeRevision = routeRevision;
      this.lastSentAtMs = null;
      this.lastSampleTimestampMs = null;
    }
    if (this.sequence > Number.MAX_SAFE_INTEGER) {
      return false;
    }

    if (
      this.lastSampleTimestampMs !== null &&
      sampleTimestampMs <= this.lastSampleTimestampMs
    ) {
      return false;
    }
    const now = this.now();
    if (
      !Number.isFinite(now) ||
      (this.lastSentAtMs !== null &&
        now - this.lastSentAtMs < VIEWER_QUALITY_EVIDENCE_INTERVAL_MS)
    ) {
      return false;
    }

    const message = {
      type: "viewer-quality-evidence" as const,
      guard: {
        connectionId,
        routeRevision,
      },
      sequence: this.sequence,
      ...window,
    };
    const parsed = viewerQualityEvidenceMessageSchema.safeParse(message);
    if (
      !parsed.success ||
      new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength >
        MAX_VIEWER_QUALITY_EVIDENCE_BYTES ||
      !this.send(parsed.data)
    ) {
      return false;
    }

    this.sequence += 1;
    this.lastSentAtMs = now;
    this.lastSampleTimestampMs = sampleTimestampMs;
    return true;
  }

  reset(): void {
    this.connectionId = null;
    this.routeRevision = null;
    this.sequence = 0;
    this.lastSentAtMs = null;
    this.lastSampleTimestampMs = null;
  }
}

function sameViewerQualityEvidenceIdentity(
  previous: ViewerQualityEvidence,
  next: ViewerQualityEvidence,
): boolean {
  return (
    previous.viewerPeerId === next.viewerPeerId &&
    qualityEvidenceUpstreamMatches(previous, next.upstream) &&
    previous.guard.connectionId === next.guard.connectionId &&
    previous.guard.routeRevision === next.guard.routeRevision
  );
}

export function qualityEvidenceUpstreamMatches(
  evidence: ViewerQualityEvidence,
  upstream: MediaRouteUpstream,
): boolean {
  return (
    evidence.upstream.kind === upstream.kind &&
    (evidence.upstream.kind !== "peer" ||
      (upstream.kind === "peer" &&
        evidence.upstream.peerId === upstream.peerId))
  );
}

export function presentViewerQualityEvidence(
  previous: ViewerQualityEvidencePresentation | null,
  evidence: ViewerQualityEvidence,
  nowMs: number = Date.now(),
): ViewerQualityEvidencePresentation {
  const continuing =
    previous !== null &&
    sameViewerQualityEvidenceIdentity(previous.evidence, evidence) &&
    evidence.sequence > previous.evidence.sequence;
  const current = continuing
    ? refreshViewerQualityEvidencePresentation(previous, nowMs)
    : null;
  const metrics = { ...evidence.metrics };

  for (const metric of viewerQualityEvidenceMetricKeys(evidence.metrics)) {
    if (
      evidence.metrics[metric] === null &&
      current !== null &&
      current.evidence.metrics[metric] !== null
    ) {
      metrics[metric] = current.evidence.metrics[metric] as never;
    }
  }

  return {
    evidence: { ...evidence, metrics },
    fresh: true,
    receivedAtMs: nowMs,
  };
}

export function refreshViewerQualityEvidencePresentation(
  presentation: ViewerQualityEvidencePresentation,
  nowMs: number = Date.now(),
): ViewerQualityEvidencePresentation {
  const fresh =
    nowMs < presentation.receivedAtMs + VIEWER_QUALITY_EVIDENCE_EXPIRY_MS;
  if (fresh === presentation.fresh) {
    return presentation;
  }
  return { ...presentation, fresh };
}

export function nextViewerQualityEvidencePresentationExpiryAt(
  presentation: ViewerQualityEvidencePresentation,
  nowMs: number = Date.now(),
): number | null {
  return presentation.fresh
    ? Math.max(
        nowMs,
        presentation.receivedAtMs + VIEWER_QUALITY_EVIDENCE_EXPIRY_MS,
      )
    : null;
}

export function qualityEvidenceIdentityMatchesSnapshot(
  evidence: ViewerQualityEvidence,
  snapshot: PeerSnapshot | null,
): snapshot is PeerSnapshot {
  return (
    snapshot !== null &&
    snapshot.peerId === evidence.viewerPeerId &&
    snapshot.connectionId === evidence.guard.connectionId
  );
}

export function qualityEvidenceMatchesSnapshot(
  evidence: ViewerQualityEvidence,
  snapshot: PeerSnapshot | null,
): boolean {
  return (
    qualityEvidenceIdentityMatchesSnapshot(evidence, snapshot) &&
    snapshot.connectionState === "connected"
  );
}

export function reconcileViewerQualityEvidencePresentation(
  presentation: ViewerQualityEvidencePresentation,
  snapshot: PeerSnapshot | null,
): ViewerQualityEvidencePresentation | null {
  if (
    !qualityEvidenceIdentityMatchesSnapshot(presentation.evidence, snapshot) ||
    snapshot?.connectionState === "failed" ||
    snapshot?.connectionState === "closed"
  ) {
    return null;
  }
  if (snapshot.connectionState !== "connected" && presentation.fresh) {
    return { ...presentation, fresh: false };
  }
  return presentation;
}

export function freshViewerQualityEvidence(
  presentation: ViewerQualityEvidencePresentation | null | undefined,
): ViewerQualityEvidence | null {
  return presentation?.fresh ? presentation.evidence : null;
}

export function classifyHostViewerQualityEvidence(
  evidence: ViewerQualityEvidence,
  hostPeerId: string | null,
  routeRevision: number,
  directSnapshot: PeerSnapshot | null,
): "direct" | "peer-relayed" | "sfu" | null {
  if (
    hostPeerId === null ||
    evidence.guard.routeRevision !== routeRevision
  ) {
    return null;
  }
  if (evidence.upstream.kind === "sfu") {
    return "sfu";
  }
  if (evidence.upstream.peerId !== hostPeerId) {
    return "peer-relayed";
  }
  return qualityEvidenceMatchesSnapshot(evidence, directSnapshot)
    ? "direct"
    : null;
}

export function metricsFromQualityEvidence(
  evidence: ViewerQualityEvidence,
): ConnectionMetrics {
  const metrics = evidence.metrics;
  return {
    ...EMPTY_METRICS,
    sampleWindowMs: evidence.windowMs,
    framesPerSecond: metrics.framesPerSecond,
    frameWidth: metrics.width,
    frameHeight: metrics.height,
    resolution:
      metrics.width !== null && metrics.height !== null
        ? `${metrics.width}x${metrics.height}`
        : null,
    bitrateKbps: metrics.bitrateKbps,
    packetsLost: metrics.packetsLostDelta,
    intervalPacketsReceived: metrics.packetsReceivedDelta,
    intervalPacketsLost: metrics.packetsLostDelta,
    packetLossPercent: packetLossPercentFromDeltas(
      metrics.packetsReceivedDelta,
      metrics.packetsLostDelta,
    ),
    rttMs: metrics.rttMs,
    jitterMs: metrics.jitterMs,
    framesDropped: metrics.framesDroppedDelta,
    intervalFramesDecoded: metrics.framesDecodedDelta,
    intervalFramesDropped: metrics.framesDroppedDelta,
    intervalDecodeMs: metrics.decodeMsPerFrame,
    intervalFreezeCount: metrics.freezeCountDelta,
    intervalFreezeDurationMs: metrics.freezeDurationMsDelta,
    codec: metrics.codec,
    codecProfile: metrics.codecProfile,
    codecParameters: metrics.codecParameters,
    audioBitrateKbps: metrics.audioBitrateKbps,
    audioPacketLossPercent: metrics.audioPacketLossPercent,
    audioJitterMs: metrics.audioJitterMs,
    audioVideoPlayoutDeltaMs: metrics.audioVideoPlayoutDeltaMs,
    videoJitterBufferDelayMs: metrics.videoJitterBufferDelayMs,
    audioJitterBufferDelayMs: metrics.audioJitterBufferDelayMs,
    audioConcealedSamplesPercent: metrics.audioConcealedSamplesPercent,
    intervalAudioConcealmentEvents: metrics.audioConcealmentEventsDelta,
    audioCodec: metrics.audioCodec,
  };
}
