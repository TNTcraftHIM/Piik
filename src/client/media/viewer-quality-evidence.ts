import {
  MAX_MEDIA_ROUTE_REVISION,
  MAX_VIEWER_QUALITY_EVIDENCE_BYTES,
  VIEWER_QUALITY_EVIDENCE_EXPIRY_MS,
  VIEWER_QUALITY_EVIDENCE_INTERVAL_MS,
  viewerQualityEvidenceMessageSchema,
  viewerQualityEvidenceMetricsSchema,
  type ClientMessage,
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
  observedAtMs: Partial<Record<ViewerQualityEvidenceMetric, number>>;
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
    if (
      !Number.isSafeInteger(routeRevision) ||
      routeRevision < 0 ||
      routeRevision > MAX_MEDIA_ROUTE_REVISION
    ) {
      return false;
    }
    const window = qualityEvidenceWindowFromMetrics(snapshot.metrics);
    const sampleTimestampMs = snapshot.metrics.sampleTimestampMs;
    if (
      !window ||
      sampleTimestampMs === null ||
      !Number.isFinite(sampleTimestampMs) ||
      sampleTimestampMs < 0
    ) {
      return false;
    }
    if (this.connectionId !== snapshot.connectionId) {
      this.connectionId = snapshot.connectionId;
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
        connectionId: snapshot.connectionId,
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
    previous.parentPeerId === next.parentPeerId &&
    previous.guard.connectionId === next.guard.connectionId &&
    previous.guard.routeRevision === next.guard.routeRevision
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
  const observedAtMs: Partial<
    Record<ViewerQualityEvidenceMetric, number>
  > = {};

  for (const metric of viewerQualityEvidenceMetricKeys(evidence.metrics)) {
    if (evidence.metrics[metric] !== null) {
      observedAtMs[metric] = nowMs;
    } else if (
      current !== null &&
      current.evidence.metrics[metric] !== null &&
      current.observedAtMs[metric] !== undefined
    ) {
      metrics[metric] = current.evidence.metrics[metric] as never;
      observedAtMs[metric] = current.observedAtMs[metric];
    }
  }

  return {
    evidence: { ...evidence, metrics },
    fresh: true,
    receivedAtMs: nowMs,
    observedAtMs,
  };
}

export function refreshViewerQualityEvidencePresentation(
  presentation: ViewerQualityEvidencePresentation,
  nowMs: number = Date.now(),
): ViewerQualityEvidencePresentation {
  let metrics = presentation.evidence.metrics;
  let observedAtMs = presentation.observedAtMs;
  let changed = false;

  for (const metric of viewerQualityEvidenceMetricKeys(metrics)) {
    const observedAt = observedAtMs[metric];
    if (
      metrics[metric] !== null &&
      observedAt !== undefined &&
      nowMs >= observedAt + VIEWER_QUALITY_EVIDENCE_EXPIRY_MS
    ) {
      if (!changed) {
        metrics = { ...metrics };
        observedAtMs = { ...observedAtMs };
        changed = true;
      }
      metrics[metric] = null as never;
      delete observedAtMs[metric];
    }
  }

  const fresh =
    nowMs < presentation.receivedAtMs + VIEWER_QUALITY_EVIDENCE_EXPIRY_MS;
  if (!changed && fresh === presentation.fresh) {
    return presentation;
  }
  return {
    ...presentation,
    evidence: changed
      ? { ...presentation.evidence, metrics }
      : presentation.evidence,
    fresh,
    observedAtMs,
  };
}

export function nextViewerQualityEvidencePresentationExpiryAt(
  presentation: ViewerQualityEvidencePresentation,
  nowMs: number = Date.now(),
): number | null {
  let nextExpiryAt = presentation.fresh
    ? presentation.receivedAtMs + VIEWER_QUALITY_EVIDENCE_EXPIRY_MS
    : Number.POSITIVE_INFINITY;

  for (const metric of viewerQualityEvidenceMetricKeys(
    presentation.evidence.metrics,
  )) {
    const observedAt = presentation.observedAtMs[metric];
    if (
      presentation.evidence.metrics[metric] !== null &&
      observedAt !== undefined
    ) {
      nextExpiryAt = Math.min(
        nextExpiryAt,
        observedAt + VIEWER_QUALITY_EVIDENCE_EXPIRY_MS,
      );
    }
  }

  return Number.isFinite(nextExpiryAt)
    ? Math.max(nowMs, nextExpiryAt)
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
): "direct" | "peer-relayed" | null {
  if (
    hostPeerId === null ||
    evidence.guard.routeRevision !== routeRevision
  ) {
    return null;
  }
  if (evidence.parentPeerId !== hostPeerId) {
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
  };
}
