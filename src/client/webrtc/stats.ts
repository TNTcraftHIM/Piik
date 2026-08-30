import {
  EMPTY_METRICS,
  type ConnectionMetrics,
} from "../types";
import { deriveVideoCodecEvidence } from "../../shared/video-codec-evidence";

type StatsRecord = Record<string, unknown> & {
  id: string;
  type: string;
  timestamp: number;
};

type QualityLimitationDurations = Record<
  "none" | "bandwidth" | "cpu" | "other",
  number
>;

export interface StatsAccumulator {
  mediaId: string | null;
  ssrc: number | null;
  trackIdentifier: string | null;
  lossSourceId: string | null;
  bytes: number | null;
  frames: number | null;
  timestamp: number | null;
  previousTotalEncodeTime: number | null;
  previousTotalDecodeTime: number | null;
  previousPacketsSent: number | null;
  previousPacketsReceived: number | null;
  previousPacketsLost: number | null;
  previousFramesDropped: number | null;
  previousFreezeCount: number | null;
  previousTotalFreezesDuration: number | null;
  previousPauseCount: number | null;
  previousTotalPausesDuration: number | null;
  previousRetransmittedPackets: number | null;
  previousRetransmittedBytes: number | null;
  previousVideoJitterBufferDelay: number | null;
  previousVideoJitterBufferEmittedCount: number | null;
  previousQualityLimitationDurations: QualityLimitationDurations | null;
  audioMediaId: string | null;
  audioSsrc: number | null;
  audioTrackIdentifier: string | null;
  audioLossSourceId: string | null;
  audioBytes: number | null;
  audioTimestamp: number | null;
  previousAudioPacketsReceived: number | null;
  previousAudioPacketsLost: number | null;
  previousAudioJitterBufferDelay: number | null;
  previousAudioJitterBufferEmittedCount: number | null;
  previousAudioTotalSamplesReceived: number | null;
  previousAudioConcealedSamples: number | null;
  previousAudioConcealmentEvents: number | null;
}

export interface StatsMediaSelector {
  trackIdentifier: string | null;
  rid?: string | null;
  audioTrackIdentifier?: string | null;
}

interface NativeSenderQualityPrevious {
  timestamp: number;
  durations: QualityLimitationDurations | null;
  framesEncoded: number | null;
  bytesSent: number | null;
}

export interface NativeSenderQualityAccumulator {
  previousByStatsId: Map<string, NativeSenderQualityPrevious>;
}

export function createNativeSenderQualityAccumulator(): NativeSenderQualityAccumulator {
  return { previousByStatsId: new Map() };
}

export function collectNativeSenderQualityFromReport(
  report: RTCStatsReport,
  trackIdentifier: string,
  accumulator: NativeSenderQualityAccumulator,
): Pick<
  ConnectionMetrics,
  | "sampleTimestampMs"
  | "nativeEdgeQualityState"
  | "qualityLimitationReason"
  | "sampleWindowMs"
  | "intervalFramesEncoded"
  | "bitrateKbps"
> {
  const records: StatsRecord[] = [];
  report.forEach((raw) => {
    const record = raw as StatsRecord;
    if (
      record.type === "outbound-rtp" &&
      record.kind === "video" &&
      record.isRemote !== true &&
      record.active !== false &&
      mediaTrackIdentifier(report, record, "send") === trackIdentifier
    ) {
      records.push(record);
    }
  });
  const activeIds = new Set(records.map((record) => record.id));
  for (const id of accumulator.previousByStatsId.keys()) {
    if (!activeIds.has(id)) accumulator.previousByStatsId.delete(id);
  }
  const samples = records.map((record) => {
    const timestamp = numberValue(record, "timestamp");
    const durations = qualityLimitationDurationsValue(record);
    const reason = stringValue(record, "qualityLimitationReason");
    const framesEncoded = numberValue(record, "framesEncoded");
    const bytesSent = numberValue(record, "bytesSent");
    const previous = accumulator.previousByStatsId.get(record.id);
    const windowMs =
      timestamp !== null && previous && timestamp > previous.timestamp
        ? timestamp - previous.timestamp
        : null;
    const state = nativeEdgeQualityState(
      reason,
      durations,
      previous?.durations ?? null,
      windowMs !== null,
    );
    const intervalFramesEncoded =
      previous &&
      framesEncoded !== null &&
      previous.framesEncoded !== null &&
      framesEncoded >= previous.framesEncoded
        ? framesEncoded - previous.framesEncoded
        : null;
    const bitrateKbps =
      previous &&
      windowMs !== null &&
      bytesSent !== null &&
      previous.bytesSent !== null &&
      bytesSent >= previous.bytesSent
        ? ((bytesSent - previous.bytesSent) * 8) / (windowMs / 1_000) / 1_000
        : null;
    if (timestamp !== null) {
      accumulator.previousByStatsId.set(record.id, {
        timestamp,
        durations,
        framesEncoded,
        bytesSent,
      });
    } else {
      accumulator.previousByStatsId.delete(record.id);
    }
    return {
      timestamp,
      state,
      reason,
      windowMs,
      intervalFramesEncoded,
      bitrateKbps,
    };
  });
  const bitrateKbps =
    samples.length > 0 && samples.every((sample) => sample.bitrateKbps !== null)
      ? samples.reduce((total, sample) => total + sample.bitrateKbps!, 0)
      : null;
  if (
    samples.length === 0 ||
    samples.some(
      (sample) =>
        sample.state === "unknown" ||
        sample.timestamp === null ||
        sample.windowMs === null ||
        sample.intervalFramesEncoded === null,
    )
  ) {
    return {
      sampleTimestampMs: null,
      nativeEdgeQualityState: "unknown",
      qualityLimitationReason: null,
      sampleWindowMs: null,
      intervalFramesEncoded: null,
      bitrateKbps,
    };
  }
  const degraded = samples.filter((sample) => sample.state === "degraded");
  return {
    sampleTimestampMs: Math.min(...samples.map((sample) => sample.timestamp!)),
    nativeEdgeQualityState: degraded.length > 0 ? "degraded" : "healthy",
    qualityLimitationReason:
      degraded.some((sample) => sample.reason === "bandwidth")
        ? "bandwidth"
        : degraded.length > 0
          ? "cpu"
          : "none",
    sampleWindowMs: Math.min(...samples.map((sample) => sample.windowMs!)),
    intervalFramesEncoded: samples.reduce(
      (total, sample) => total + sample.intervalFramesEncoded!,
      0,
    ),
    bitrateKbps,
  };
}

export function captureMetrics(
  track: MediaStreamTrack,
): Pick<
  ConnectionMetrics,
  "captureWidth" | "captureHeight" | "captureFramesPerSecond"
> {
  try {
    const settings = track.getSettings();
    const finite = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    return {
      captureWidth: finite(settings.width),
      captureHeight: finite(settings.height),
      captureFramesPerSecond: finite(settings.frameRate),
    };
  } catch {
    return {
      captureWidth: null,
      captureHeight: null,
      captureFramesPerSecond: null,
    };
  }
}

export function createStatsAccumulator(): StatsAccumulator {
  return {
    mediaId: null,
    ssrc: null,
    trackIdentifier: null,
    lossSourceId: null,
    bytes: null,
    frames: null,
    timestamp: null,
    previousTotalEncodeTime: null,
    previousTotalDecodeTime: null,
    previousPacketsSent: null,
    previousPacketsReceived: null,
    previousPacketsLost: null,
    previousFramesDropped: null,
    previousFreezeCount: null,
    previousTotalFreezesDuration: null,
    previousPauseCount: null,
    previousTotalPausesDuration: null,
    previousRetransmittedPackets: null,
    previousRetransmittedBytes: null,
    previousVideoJitterBufferDelay: null,
    previousVideoJitterBufferEmittedCount: null,
    previousQualityLimitationDurations: null,
    audioMediaId: null,
    audioSsrc: null,
    audioTrackIdentifier: null,
    audioLossSourceId: null,
    audioBytes: null,
    audioTimestamp: null,
    previousAudioPacketsReceived: null,
    previousAudioPacketsLost: null,
    previousAudioJitterBufferDelay: null,
    previousAudioJitterBufferEmittedCount: null,
    previousAudioTotalSamplesReceived: null,
    previousAudioConcealedSamples: null,
    previousAudioConcealmentEvents: null,
  };
}

export function mergeStatsReports(
  reports: readonly (RTCStatsReport | undefined)[],
): RTCStatsReport | null {
  const merged = new Map<string, unknown>();
  for (const report of reports) {
    report?.forEach((record, id) => merged.set(id, record));
  }
  return merged.size > 0 ? (merged as unknown as RTCStatsReport) : null;
}

function intervalDelta(
  current: number | null,
  previous: number | null,
  hasInterval: boolean,
): number | null {
  if (
    !hasInterval ||
    current === null ||
    previous === null ||
    current < previous
  ) {
    return null;
  }
  return current - previous;
}

function intervalAverageMs(
  totalTime: number | null,
  previousTotalTime: number | null,
  frames: number | null,
  previousFrames: number | null,
): number | null {
  if (
    totalTime === null ||
    previousTotalTime === null ||
    frames === null ||
    previousFrames === null
  ) {
    return null;
  }

  const frameDelta = frames - previousFrames;
  const timeDelta = totalTime - previousTotalTime;
  return frameDelta > 0 && timeDelta >= 0
    ? (timeDelta / frameDelta) * 1_000
    : null;
}

export function packetLossPercentFromDeltas(
  packetsReceivedDelta: number | null,
  packetsLostDelta: number | null,
): number | null {
  if (
    packetsReceivedDelta === null ||
    packetsLostDelta === null ||
    !Number.isFinite(packetsReceivedDelta) ||
    !Number.isFinite(packetsLostDelta) ||
    packetsReceivedDelta < 0 ||
    packetsLostDelta < 0
  ) {
    return null;
  }
  const packetDelta = packetsReceivedDelta + packetsLostDelta;
  return packetDelta > 0 ? (packetsLostDelta / packetDelta) * 100 : null;
}

function percentOfInterval(
  partDelta: number | null,
  totalDelta: number | null,
): number | null {
  if (
    partDelta === null ||
    totalDelta === null ||
    !Number.isFinite(partDelta) ||
    !Number.isFinite(totalDelta) ||
    partDelta < 0 ||
    totalDelta <= 0 ||
    partDelta > totalDelta
  ) {
    return null;
  }
  return (partDelta / totalDelta) * 100;
}

function numberValue(record: StatsRecord | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(record: StatsRecord | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function qualityLimitationDurationsValue(
  record: StatsRecord | null,
): QualityLimitationDurations | null {
  const value = record?.qualityLimitationDurations;
  if (!value || typeof value !== "object") {
    return null;
  }
  const durations = value as Record<string, unknown>;
  const result = {} as QualityLimitationDurations;
  for (const reason of ["none", "bandwidth", "cpu", "other"] as const) {
    const duration = durations[reason];
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
      return null;
    }
    result[reason] = duration;
  }
  return result;
}

function nativeEdgeQualityState(
  reason: string | null,
  current: QualityLimitationDurations | null,
  previous: QualityLimitationDurations | null,
  hasInterval: boolean,
): ConnectionMetrics["nativeEdgeQualityState"] {
  if (!hasInterval || !current || !previous) {
    return "unknown";
  }
  const deltas = {} as QualityLimitationDurations;
  for (const key of ["none", "bandwidth", "cpu", "other"] as const) {
    if (current[key] < previous[key]) {
      return "unknown";
    }
    deltas[key] = current[key] - previous[key];
  }
  if (
    reason === "none" &&
    deltas.none > 0 &&
    deltas.bandwidth === 0 &&
    deltas.cpu === 0 &&
    deltas.other === 0
  ) {
    return "healthy";
  }
  if (
    (reason === "bandwidth" || reason === "cpu") &&
    deltas[reason] > 0 &&
    deltas.none === 0 &&
    deltas.other === 0 &&
    deltas[reason === "bandwidth" ? "cpu" : "bandwidth"] === 0
  ) {
    return "degraded";
  }
  return "unknown";
}

function booleanValue(record: StatsRecord | null, key: string): boolean | null {
  const value = record?.[key];
  return typeof value === "boolean" ? value : null;
}

function getRecord(report: RTCStatsReport, id: string | null): StatsRecord | null {
  if (!id) {
    return null;
  }
  return (report.get(id) as StatsRecord | undefined) ?? null;
}

function mediaTrackIdentifier(
  report: RTCStatsReport,
  media: StatsRecord,
  direction: "send" | "receive",
): string | null {
  if (direction === "receive") {
    return stringValue(media, "trackIdentifier");
  }
  const source = mediaSourceRecord(report, media);
  return stringValue(source, "trackIdentifier");
}

function mediaSourceRecord(
  report: RTCStatsReport,
  media: StatsRecord | null,
): StatsRecord | null {
  const source = getRecord(report, stringValue(media, "mediaSourceId"));
  return source?.type === "media-source"
    ? source
    : null;
}

function mediaRecord(
  report: RTCStatsReport,
  direction: "send" | "receive",
  selector: StatsMediaSelector | null,
  kind: "audio" | "video" = "video",
): StatsRecord | null {
  const expectedType = direction === "send" ? "outbound-rtp" : "inbound-rtp";
  const isExpectedMedia = (record: StatsRecord): boolean =>
    record.type === expectedType &&
    record.kind === kind &&
    record.isRemote !== true;

  const candidates: StatsRecord[] = [];
  report.forEach((raw) => {
    const record = raw as StatsRecord;
    if (isExpectedMedia(record)) {
      candidates.push(record);
    }
  });
  const selectedTrackIdentifier = selector?.trackIdentifier ?? null;
  const selectedRid = selector?.rid ?? null;
  const narrowed = candidates.filter(
    (candidate) =>
      (selectedTrackIdentifier === null ||
        mediaTrackIdentifier(report, candidate, direction) ===
          selectedTrackIdentifier) &&
      (selectedRid === null || stringValue(candidate, "rid") === selectedRid),
  );
  return narrowed.length === 1 ? narrowed[0]! : null;
}

export function decodedVideoFrames(
  report: RTCStatsReport,
  selector: StatsMediaSelector | null = null,
): number | null {
  return numberValue(mediaRecord(report, "receive", selector), "framesDecoded");
}

export function maxEncodedVideoFrames(
  report: RTCStatsReport,
  trackIdentifier: string,
): number {
  let frames = 0;
  report.forEach((raw) => {
    const record = raw as StatsRecord;
    if (
      record.type === "outbound-rtp" &&
      record.kind === "video" &&
      record.isRemote !== true &&
      mediaTrackIdentifier(report, record, "send") === trackIdentifier
    ) {
      frames = Math.max(frames, numberValue(record, "framesEncoded") ?? 0);
    }
  });
  return frames;
}

export function highestActiveVideoRid(
  report: RTCStatsReport,
  trackIdentifier: string,
): string | null {
  let selectedRid: string | null = null;
  let selectedPixels = -1;
  report.forEach((raw) => {
    const record = raw as StatsRecord;
    if (
      record.type !== "outbound-rtp" ||
      record.kind !== "video" ||
      record.isRemote === true ||
      record.active === false ||
      mediaTrackIdentifier(report, record, "send") !== trackIdentifier
    ) {
      return;
    }
    const rid = stringValue(record, "rid");
    const width = numberValue(record, "frameWidth");
    const height = numberValue(record, "frameHeight");
    if (!rid || width === null || height === null || width <= 0 || height <= 0) {
      return;
    }
    const pixels = width * height;
    if (pixels > selectedPixels) {
      selectedRid = rid;
      selectedPixels = pixels;
    }
  });
  return selectedRid;
}

function transportRecord(
  report: RTCStatsReport,
  media: StatsRecord | null,
): StatsRecord | null {
  const referenced = getRecord(report, stringValue(media, "transportId"));
  return referenced?.type === "transport" ? referenced : null;
}

function selectedCandidatePair(
  report: RTCStatsReport,
  transport: StatsRecord | null,
): StatsRecord | null {
  if (!transport) {
    return null;
  }
  const candidatePairs: StatsRecord[] = [];
  report.forEach((raw) => {
    const record = raw as StatsRecord;
    if (record.type === "candidate-pair") {
      candidatePairs.push(record);
    }
  });

  const pairId = stringValue(transport, "selectedCandidatePairId");
  if (pairId) {
    const referenced = getRecord(report, pairId);
    return referenced?.type === "candidate-pair" &&
      stringValue(referenced, "transportId") === transport.id
      ? referenced
      : null;
  }
  const selected = candidatePairs.filter(
    (pair) =>
      stringValue(pair, "transportId") === transport.id &&
      pair.state === "succeeded" &&
      (pair.nominated === true || pair.selected === true),
  );
  return selected.length === 1 ? selected[0]! : null;
}

function linkedRemoteInbound(
  report: RTCStatsReport,
  outbound: StatsRecord | null,
  kind: "audio" | "video" = "video",
): StatsRecord | null {
  const remote = getRecord(report, stringValue(outbound, "remoteId"));
  return remote?.type === "remote-inbound-rtp" && remote.kind === kind
    ? remote
    : null;
}

function linkedMediaCodec(
  report: RTCStatsReport,
  media: StatsRecord | null,
  transport: StatsRecord | null,
  kind: "audio" | "video",
): StatsRecord | null {
  const codec = getRecord(report, stringValue(media, "codecId"));
  const mimeType = stringValue(codec, "mimeType");
  return codec?.type === "codec" &&
    transport !== null &&
    stringValue(codec, "transportId") === transport.id &&
    mimeType !== null &&
    new RegExp(`^${kind}\\/[A-Za-z0-9.+-]{1,32}$`, "i").test(mimeType)
    ? codec
    : null;
}

function deriveCodecEvidence(codec: StatsRecord | null) {
  const mimeType = stringValue(codec, "mimeType");
  return deriveVideoCodecEvidence(
    mimeType,
    stringValue(codec, "sdpFmtpLine"),
  );
}

function positiveIntegerValue(
  record: StatsRecord | null,
  key: string,
): number | null {
  const value = numberValue(record, key);
  return value !== null && Number.isInteger(value) && value > 0 ? value : null;
}

function candidateAddressValue(record: StatsRecord | null): string | null {
  const value = stringValue(record, "address");
  return value !== null &&
    value.length <= 255 &&
    !/[\u0000-\u0020\u007f]/.test(value)
    ? value
    : null;
}

function candidatePortValue(record: StatsRecord | null): number | null {
  const value = numberValue(record, "port");
  return value !== null &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 65_535
    ? value
    : null;
}

function audioCodecParameters(codec: StatsRecord | null): string | null {
  const value = stringValue(codec, "sdpFmtpLine");
  return value !== null && value.length <= 512 && /^[\x20-\x7e]+$/.test(value)
    ? value
    : null;
}

function scalabilityModeValue(media: StatsRecord | null): string | null {
  const value = stringValue(media, "scalabilityMode");
  return value && /^[A-Za-z0-9_-]{1,32}$/.test(value) ? value : null;
}

export async function collectConnectionMetrics(
  connection: RTCPeerConnection,
  direction: "send" | "receive",
  previous: StatsAccumulator,
  selector: StatsMediaSelector | null = null,
): Promise<ConnectionMetrics> {
  return collectConnectionMetricsFromReport(
    await connection.getStats(),
    direction,
    previous,
    selector,
  );
}

export function collectConnectionMetricsFromReport(
  report: RTCStatsReport,
  direction: "send" | "receive",
  previous: StatsAccumulator,
  selector: StatsMediaSelector | null = null,
): ConnectionMetrics {
  const media = mediaRecord(report, direction, selector);
  const transport = transportRecord(report, media);
  let pair = selectedCandidatePair(report, transport);
  let localCandidate = getRecord(
    report,
    stringValue(pair, "localCandidateId"),
  );
  let remoteCandidate = getRecord(
    report,
    stringValue(pair, "remoteCandidateId"),
  );
  if (
    localCandidate?.type !== "local-candidate" ||
    remoteCandidate?.type !== "remote-candidate"
  ) {
    pair = null;
    localCandidate = null;
    remoteCandidate = null;
  }
  const localType = stringValue(localCandidate, "candidateType");
  const remoteType = stringValue(remoteCandidate, "candidateType");
  const path =
    localType === "relay" || remoteType === "relay"
      ? "unknown"
      : localType !== null && remoteType !== null
        ? "direct"
        : "unknown";

  const mediaId = media?.id ?? null;
  const ssrc = numberValue(media, "ssrc");
  const trackIdentifier = media
    ? mediaTrackIdentifier(report, media, direction)
    : null;
  const remoteInbound =
    direction === "send" ? linkedRemoteInbound(report, media) : null;
  const lossSource = direction === "send" ? remoteInbound : media;
  const lossSourceId = lossSource?.id ?? null;
  const sameMedia =
    mediaId !== null &&
    mediaId === previous.mediaId &&
    ssrc === previous.ssrc &&
    trackIdentifier === previous.trackIdentifier;
  const sameLossSource =
    sameMedia &&
    lossSourceId !== null &&
    lossSourceId === previous.lossSourceId;
  const bytesKey = direction === "send" ? "bytesSent" : "bytesReceived";
  const bytes = numberValue(media, bytesKey);
  const framesKey = direction === "send" ? "framesEncoded" : "framesDecoded";
  const frames = numberValue(media, framesKey);
  const timestamp = numberValue(media, "timestamp");
  const framesEncoded = numberValue(media, "framesEncoded");
  const framesDecoded = numberValue(media, "framesDecoded");
  const packetsSent = numberValue(media, "packetsSent");
  const packetsReceived = numberValue(lossSource, "packetsReceived");
  const packetsLost = numberValue(lossSource, "packetsLost");
  const totalEncodeTime = numberValue(media, "totalEncodeTime");
  const totalDecodeTime = numberValue(media, "totalDecodeTime");
  const framesDropped = numberValue(media, "framesDropped");
  const freezeCount = numberValue(media, "freezeCount");
  const totalFreezesDuration = numberValue(media, "totalFreezesDuration");
  const pauseCount = numberValue(media, "pauseCount");
  const totalPausesDuration = numberValue(media, "totalPausesDuration");
  const retransmittedPackets = numberValue(
    media,
    direction === "send"
      ? "retransmittedPacketsSent"
      : "retransmittedPacketsReceived",
  );
  const retransmittedBytes = numberValue(
    media,
    direction === "send"
      ? "retransmittedBytesSent"
      : "retransmittedBytesReceived",
  );
  const videoJitterBufferDelay = numberValue(media, "jitterBufferDelay");
  const videoJitterBufferEmittedCount = numberValue(
    media,
    "jitterBufferEmittedCount",
  );
  const qualityLimitationReason = stringValue(
    media,
    "qualityLimitationReason",
  );
  const qualityLimitationDurations = qualityLimitationDurationsValue(media);
  let bitrateKbps: number | null = null;
  let derivedFps: number | null = null;
  const sampleWindowMs =
    sameMedia &&
    timestamp !== null &&
    previous.timestamp !== null &&
    timestamp > previous.timestamp
      ? timestamp - previous.timestamp
      : null;

  if (sampleWindowMs !== null) {
    const elapsedSeconds = sampleWindowMs / 1_000;
    if (bytes !== null && previous.bytes !== null && bytes >= previous.bytes) {
      bitrateKbps = ((bytes - previous.bytes) * 8) / elapsedSeconds / 1_000;
    }
    if (
      frames !== null &&
      previous.frames !== null &&
      frames >= previous.frames
    ) {
      derivedFps = (frames - previous.frames) / elapsedSeconds;
    }
  }
  const intervalEncodeMs =
    direction === "send"
      ? intervalAverageMs(
          totalEncodeTime,
          sampleWindowMs !== null ? previous.previousTotalEncodeTime : null,
          framesEncoded,
          sampleWindowMs !== null ? previous.frames : null,
        )
      : null;
  const intervalFramesEncoded =
    direction === "send"
      ? intervalDelta(framesEncoded, previous.frames, sampleWindowMs !== null)
      : null;
  const encodeTimeDelta =
    direction === "send"
      ? intervalDelta(
          totalEncodeTime,
          previous.previousTotalEncodeTime,
          sampleWindowMs !== null,
        )
      : null;
  const intervalDecodeMs =
    direction === "receive"
      ? intervalAverageMs(
          totalDecodeTime,
          sampleWindowMs !== null ? previous.previousTotalDecodeTime : null,
          framesDecoded,
          sampleWindowMs !== null ? previous.frames : null,
        )
      : null;
  const lossPacketsReceivedDelta = intervalDelta(
    packetsReceived,
    previous.previousPacketsReceived,
    sampleWindowMs !== null && sameLossSource,
  );
  const intervalPacketsReceived =
    direction === "receive" ? lossPacketsReceivedDelta : null;
  const intervalPacketsSent =
    direction === "send"
      ? intervalDelta(
          packetsSent,
          previous.previousPacketsSent,
          sampleWindowMs !== null,
        )
      : null;
  const intervalPacketsLost =
    direction === "receive" || direction === "send"
      ? intervalDelta(
          packetsLost,
          previous.previousPacketsLost,
          sampleWindowMs !== null && sameLossSource,
        )
      : null;
  const intervalFramesDecoded =
    direction === "receive"
      ? intervalDelta(
          framesDecoded,
          previous.frames,
          sampleWindowMs !== null,
        )
      : null;
  const intervalFramesDropped = intervalDelta(
    framesDropped,
    previous.previousFramesDropped,
    sampleWindowMs !== null,
  );
  const intervalFreezeCount = intervalDelta(
    freezeCount,
    previous.previousFreezeCount,
    sampleWindowMs !== null,
  );
  const freezeDurationDelta = intervalDelta(
    totalFreezesDuration,
    previous.previousTotalFreezesDuration,
    sampleWindowMs !== null,
  );
  const intervalPauseCount =
    direction === "receive"
      ? intervalDelta(
          pauseCount,
          previous.previousPauseCount,
          sampleWindowMs !== null,
        )
      : null;
  const pauseDurationDelta =
    direction === "receive"
      ? intervalDelta(
          totalPausesDuration,
          previous.previousTotalPausesDuration,
          sampleWindowMs !== null,
        )
      : null;
  const intervalRetransmittedPackets = intervalDelta(
    retransmittedPackets,
    previous.previousRetransmittedPackets,
    sampleWindowMs !== null,
  );
  const intervalRetransmittedBytes = intervalDelta(
    retransmittedBytes,
    previous.previousRetransmittedBytes,
    sampleWindowMs !== null,
  );
  const videoJitterBufferDelayMs =
    direction === "receive" && sampleWindowMs !== null
      ? intervalAverageMs(
          videoJitterBufferDelay,
          previous.previousVideoJitterBufferDelay,
          videoJitterBufferEmittedCount,
          previous.previousVideoJitterBufferEmittedCount,
        )
      : null;
  const currentNativeEdgeQualityState = nativeEdgeQualityState(
    qualityLimitationReason,
    qualityLimitationDurations,
    previous.previousQualityLimitationDurations,
    sampleWindowMs !== null,
  );
  previous.mediaId = mediaId;
  previous.ssrc = ssrc;
  previous.trackIdentifier = trackIdentifier;
  previous.lossSourceId = lossSourceId;
  previous.bytes = bytes;
  previous.frames = frames;
  previous.timestamp = timestamp;
  previous.previousTotalEncodeTime = totalEncodeTime;
  previous.previousTotalDecodeTime = totalDecodeTime;
  previous.previousPacketsSent = packetsSent;
  previous.previousPacketsReceived = packetsReceived;
  previous.previousPacketsLost = packetsLost;
  previous.previousFramesDropped = framesDropped;
  previous.previousFreezeCount = freezeCount;
  previous.previousTotalFreezesDuration = totalFreezesDuration;
  previous.previousPauseCount = pauseCount;
  previous.previousTotalPausesDuration = totalPausesDuration;
  previous.previousRetransmittedPackets = retransmittedPackets;
  previous.previousRetransmittedBytes = retransmittedBytes;
  previous.previousVideoJitterBufferDelay = videoJitterBufferDelay;
  previous.previousVideoJitterBufferEmittedCount =
    videoJitterBufferEmittedCount;
  previous.previousQualityLimitationDurations = qualityLimitationDurations;

  const linkedCodec = linkedMediaCodec(report, media, transport, "video");
  const codecEvidence = deriveCodecEvidence(linkedCodec);
  const mediaSource =
    direction === "send" ? mediaSourceRecord(report, media) : null;
  const audio =
    selector?.audioTrackIdentifier === null
      ? null
      : mediaRecord(
          report,
          direction,
          selector?.audioTrackIdentifier === undefined
            ? null
            : { trackIdentifier: selector.audioTrackIdentifier },
          "audio",
        );
  const audioTransport = transportRecord(report, audio);
  const audioRemoteInbound =
    direction === "send"
      ? linkedRemoteInbound(report, audio, "audio")
      : null;
  const audioLossSource = direction === "send" ? audioRemoteInbound : audio;
  const audioMediaId = audio?.id ?? null;
  const audioSsrc = numberValue(audio, "ssrc");
  const audioTrackIdentifier = audio
    ? mediaTrackIdentifier(report, audio, direction)
    : null;
  const audioLossSourceId = audioLossSource?.id ?? null;
  const sameAudio =
    audioMediaId !== null &&
    audioMediaId === previous.audioMediaId &&
    audioSsrc === previous.audioSsrc &&
    audioTrackIdentifier === previous.audioTrackIdentifier;
  const sameAudioLossSource =
    sameAudio &&
    audioLossSourceId !== null &&
    audioLossSourceId === previous.audioLossSourceId;
  const audioBytes = numberValue(
    audio,
    direction === "send" ? "bytesSent" : "bytesReceived",
  );
  const audioTimestamp = numberValue(audio, "timestamp");
  const audioSampleWindowMs =
    sameAudio &&
    audioTimestamp !== null &&
    previous.audioTimestamp !== null &&
    audioTimestamp > previous.audioTimestamp
      ? audioTimestamp - previous.audioTimestamp
      : null;
  const audioPacketsReceived = numberValue(audioLossSource, "packetsReceived");
  const audioPacketsLost = numberValue(audioLossSource, "packetsLost");
  const audioJitterBufferDelay = numberValue(audio, "jitterBufferDelay");
  const audioJitterBufferEmittedCount = numberValue(
    audio,
    "jitterBufferEmittedCount",
  );
  const audioTotalSamplesReceived = numberValue(audio, "totalSamplesReceived");
  const audioConcealedSamples = numberValue(audio, "concealedSamples");
  const audioConcealmentEvents = numberValue(audio, "concealmentEvents");
  const audioPacketsReceivedDelta = intervalDelta(
    audioPacketsReceived,
    previous.previousAudioPacketsReceived,
    audioSampleWindowMs !== null && sameAudioLossSource,
  );
  const audioPacketsLostDelta = intervalDelta(
    audioPacketsLost,
    previous.previousAudioPacketsLost,
    audioSampleWindowMs !== null && sameAudioLossSource,
  );
  const audioBitrateKbps =
    audioSampleWindowMs !== null &&
    audioBytes !== null &&
    previous.audioBytes !== null &&
    audioBytes >= previous.audioBytes
      ? ((audioBytes - previous.audioBytes) * 8) / audioSampleWindowMs
      : null;
  const audioJitterBufferDelayMs =
    direction === "receive" && audioSampleWindowMs !== null
      ? intervalAverageMs(
          audioJitterBufferDelay,
          previous.previousAudioJitterBufferDelay,
          audioJitterBufferEmittedCount,
          previous.previousAudioJitterBufferEmittedCount,
        )
      : null;
  const intervalAudioTotalSamplesReceived = intervalDelta(
    audioTotalSamplesReceived,
    previous.previousAudioTotalSamplesReceived,
    direction === "receive" && audioSampleWindowMs !== null,
  );
  const intervalAudioConcealedSamples = intervalDelta(
    audioConcealedSamples,
    previous.previousAudioConcealedSamples,
    direction === "receive" && audioSampleWindowMs !== null,
  );
  const intervalAudioConcealmentEvents = intervalDelta(
    audioConcealmentEvents,
    previous.previousAudioConcealmentEvents,
    direction === "receive" && audioSampleWindowMs !== null,
  );
  const videoEstimatedPlayoutTimestamp = numberValue(
    media,
    "estimatedPlayoutTimestamp",
  );
  const audioEstimatedPlayoutTimestamp = numberValue(
    audio,
    "estimatedPlayoutTimestamp",
  );
  const audioVideoPlayoutDeltaMs =
    direction === "receive" &&
    videoEstimatedPlayoutTimestamp !== null &&
    audioEstimatedPlayoutTimestamp !== null
      ? audioEstimatedPlayoutTimestamp - videoEstimatedPlayoutTimestamp
      : null;
  previous.audioMediaId = audioMediaId;
  previous.audioSsrc = audioSsrc;
  previous.audioTrackIdentifier = audioTrackIdentifier;
  previous.audioLossSourceId = audioLossSourceId;
  previous.audioBytes = audioBytes;
  previous.audioTimestamp = audioTimestamp;
  previous.previousAudioPacketsReceived = audioPacketsReceived;
  previous.previousAudioPacketsLost = audioPacketsLost;
  previous.previousAudioJitterBufferDelay = audioJitterBufferDelay;
  previous.previousAudioJitterBufferEmittedCount =
    audioJitterBufferEmittedCount;
  previous.previousAudioTotalSamplesReceived = audioTotalSamplesReceived;
  previous.previousAudioConcealedSamples = audioConcealedSamples;
  previous.previousAudioConcealmentEvents = audioConcealmentEvents;
  const linkedAudioCodec = linkedMediaCodec(
    report,
    audio,
    audioTransport,
    "audio",
  );
  const width = numberValue(media, "frameWidth");
  const height = numberValue(media, "frameHeight");
  const iceProtocol =
    stringValue(localCandidate, "protocol") ??
    stringValue(remoteCandidate, "protocol");
  return {
    ...EMPTY_METRICS,
    sampleTimestampMs: timestamp,
    sampleWindowMs,
    rtpStatsId: mediaId,
    rtpSsrc: ssrc,
    rtpMid: stringValue(media, "mid"),
    rtpRid: stringValue(media, "rid"),
    trackIdentifier,
    selectedCandidatePairId: pair?.id ?? null,
    path,
    iceProtocol,
    localCandidateType: localType,
    remoteCandidateType: remoteType,
    localCandidateAddress: candidateAddressValue(localCandidate),
    localCandidatePort: candidatePortValue(localCandidate),
    remoteCandidateAddress: candidateAddressValue(remoteCandidate),
    remoteCandidatePort: candidatePortValue(remoteCandidate),
    rttMs:
      numberValue(pair, "currentRoundTripTime") !== null
        ? numberValue(pair, "currentRoundTripTime")! * 1_000
        : numberValue(remoteInbound, "roundTripTime") !== null
          ? numberValue(remoteInbound, "roundTripTime")! * 1_000
          : null,
    bitrateKbps,
    availableOutgoingKbps:
      numberValue(pair, "availableOutgoingBitrate") !== null
        ? numberValue(pair, "availableOutgoingBitrate")! / 1_000
        : null,
    mediaSourceFramesPerSecond: numberValue(mediaSource, "framesPerSecond"),
    framesPerSecond: numberValue(media, "framesPerSecond") ?? derivedFps,
    frameWidth: width,
    frameHeight: height,
    resolution: width !== null && height !== null ? `${width}x${height}` : null,
    packetsLost,
    intervalPacketsSent,
    intervalPacketsReceived,
    intervalPacketsLost,
    packetLossPercent: packetLossPercentFromDeltas(
      lossPacketsReceivedDelta,
      intervalPacketsLost,
    ),
    jitterMs:
      numberValue(direction === "send" ? remoteInbound : media, "jitter") !== null
        ? numberValue(direction === "send" ? remoteInbound : media, "jitter")! *
          1_000
        : null,
    framesDropped,
    intervalFramesDecoded,
    intervalFramesDropped,
    intervalFreezeCount,
    intervalFreezeDurationMs:
      freezeDurationDelta === null ? null : freezeDurationDelta * 1_000,
    intervalPauseCount,
    intervalPauseDurationMs:
      pauseDurationDelta === null ? null : pauseDurationDelta * 1_000,
    intervalRetransmittedPackets,
    intervalRetransmittedBytes,
    codec: codecEvidence.codec,
    codecProfile: codecEvidence.profile,
    codecParameters: codecEvidence.parameters,
    audioBitrateKbps,
    audioPacketLossPercent: packetLossPercentFromDeltas(
      audioPacketsReceivedDelta,
      audioPacketsLostDelta,
    ),
    audioJitterMs:
      numberValue(audioLossSource, "jitter") !== null
        ? numberValue(audioLossSource, "jitter")! * 1_000
        : null,
    audioVideoPlayoutDeltaMs,
    videoJitterBufferDelayMs,
    audioJitterBufferDelayMs,
    audioConcealedSamplesPercent: percentOfInterval(
      intervalAudioConcealedSamples,
      intervalAudioTotalSamplesReceived,
    ),
    intervalAudioConcealmentEvents,
    audioCodec: stringValue(linkedAudioCodec, "mimeType"),
    audioCodecClockRate: positiveIntegerValue(linkedAudioCodec, "clockRate"),
    audioCodecChannels: positiveIntegerValue(linkedAudioCodec, "channels"),
    audioCodecParameters: audioCodecParameters(linkedAudioCodec),
    scalabilityMode:
      direction === "send" ? scalabilityModeValue(media) : null,
    encoderImplementation: stringValue(media, "encoderImplementation"),
    powerEfficientEncoder: booleanValue(media, "powerEfficientEncoder"),
    intervalFramesEncoded,
    intervalEncodeTimeMs:
      encodeTimeDelta === null ? null : encodeTimeDelta * 1_000,
    intervalEncodeMs,
    intervalDecodeMs,
    qualityLimitationReason,
    nativeEdgeQualityState: currentNativeEdgeQualityState,
  };
}
