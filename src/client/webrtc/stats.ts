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
  previousRetransmittedPackets: number | null;
  previousRetransmittedBytes: number | null;
  audioMediaId: string | null;
  audioSsrc: number | null;
  audioTrackIdentifier: string | null;
  audioLossSourceId: string | null;
  audioBytes: number | null;
  audioTimestamp: number | null;
  previousAudioPacketsReceived: number | null;
  previousAudioPacketsLost: number | null;
}

export interface StatsMediaSelector {
  trackIdentifier: string | null;
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
    previousRetransmittedPackets: null,
    previousRetransmittedBytes: null,
    audioMediaId: null,
    audioSsrc: null,
    audioTrackIdentifier: null,
    audioLossSourceId: null,
    audioBytes: null,
    audioTimestamp: null,
    previousAudioPacketsReceived: null,
    previousAudioPacketsLost: null,
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

function numberValue(record: StatsRecord | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(record: StatsRecord | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
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
  const source = getRecord(report, stringValue(media, "mediaSourceId"));
  return source?.type === "media-source"
    ? stringValue(source, "trackIdentifier")
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
  const narrowed = selectedTrackIdentifier !== null
    ? candidates.filter(
        (candidate) =>
          mediaTrackIdentifier(report, candidate, direction) ===
          selectedTrackIdentifier,
      )
    : candidates;
  return narrowed.length === 1 ? narrowed[0]! : null;
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
      ? "relay"
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
  previous.previousRetransmittedPackets = retransmittedPackets;
  previous.previousRetransmittedBytes = retransmittedBytes;

  const linkedCodec = linkedMediaCodec(report, media, transport, "video");
  const codecEvidence = deriveCodecEvidence(linkedCodec);
  const audio = mediaRecord(report, direction, null, "audio");
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
  previous.audioMediaId = audioMediaId;
  previous.audioSsrc = audioSsrc;
  previous.audioTrackIdentifier = audioTrackIdentifier;
  previous.audioLossSourceId = audioLossSourceId;
  previous.audioBytes = audioBytes;
  previous.audioTimestamp = audioTimestamp;
  previous.previousAudioPacketsReceived = audioPacketsReceived;
  previous.previousAudioPacketsLost = audioPacketsLost;
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
  const localRelayProtocol =
    localType === "relay" ? stringValue(localCandidate, "relayProtocol") : null;

  return {
    ...EMPTY_METRICS,
    sampleTimestampMs: timestamp,
    sampleWindowMs,
    rtpStatsId: mediaId,
    rtpSsrc: ssrc,
    rtpMid: stringValue(media, "mid"),
    trackIdentifier,
    selectedCandidatePairId: pair?.id ?? null,
    path,
    iceProtocol,
    localRelayProtocol,
    localCandidateType: localType,
    remoteCandidateType: remoteType,
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
    audioCodec: stringValue(linkedAudioCodec, "mimeType"),
    audioCodecClockRate: positiveIntegerValue(linkedAudioCodec, "clockRate"),
    audioCodecChannels: positiveIntegerValue(linkedAudioCodec, "channels"),
    audioCodecParameters: audioCodecParameters(linkedAudioCodec),
    scalabilityMode:
      direction === "send" ? scalabilityModeValue(media) : null,
    encoderImplementation: stringValue(media, "encoderImplementation"),
    powerEfficientEncoder: booleanValue(media, "powerEfficientEncoder"),
    intervalEncodeMs,
    intervalDecodeMs,
    qualityLimitationReason: stringValue(media, "qualityLimitationReason"),
  };
}
