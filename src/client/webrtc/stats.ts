import {
  EMPTY_METRICS,
  type ConnectionMetrics,
} from "../types";

type StatsRecord = Record<string, unknown> & {
  id: string;
  type: string;
  timestamp: number;
};

export interface StatsAccumulator {
  mediaId: string | null;
  ssrc: number | null;
  trackIdentifier: string | null;
  bytes: number | null;
  frames: number | null;
  timestamp: number | null;
  previousTotalEncodeTime: number | null;
  previousTotalDecodeTime: number | null;
  previousFramesDropped: number | null;
  previousFreezeCount: number | null;
  previousTotalFreezesDuration: number | null;
  previousRetransmittedPackets: number | null;
  previousRetransmittedBytes: number | null;
}

export interface StatsMediaSelector {
  trackIdentifier: string | null;
}

export function createStatsAccumulator(): StatsAccumulator {
  return {
    mediaId: null,
    ssrc: null,
    trackIdentifier: null,
    bytes: null,
    frames: null,
    timestamp: null,
    previousTotalEncodeTime: null,
    previousTotalDecodeTime: null,
    previousFramesDropped: null,
    previousFreezeCount: null,
    previousTotalFreezesDuration: null,
    previousRetransmittedPackets: null,
    previousRetransmittedBytes: null,
  };
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
): StatsRecord | null {
  const expectedType = direction === "send" ? "outbound-rtp" : "inbound-rtp";
  const isExpectedMedia = (record: StatsRecord): boolean =>
    record.type === expectedType &&
    record.kind === "video" &&
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
): StatsRecord | null {
  const remote = getRecord(report, stringValue(outbound, "remoteId"));
  return remote?.type === "remote-inbound-rtp" && remote.kind === "video"
    ? remote
    : null;
}

interface CodecEvidence {
  codec: string | null;
  profile: string | null;
  parameters: string | null;
}

type CodecParameterRule = {
  profileKey: string | null;
  parameterKeys: readonly string[];
  validators: Readonly<Record<string, RegExp>>;
};

const CODEC_PARAMETER_RULES: Readonly<Record<string, CodecParameterRule>> = {
  "video/h264": {
    profileKey: "profile-level-id",
    parameterKeys: ["packetization-mode", "level-asymmetry-allowed"],
    validators: {
      "profile-level-id": /^[0-9a-f]{6}$/i,
      "packetization-mode": /^[0-2]$/,
      "level-asymmetry-allowed": /^[01]$/,
    },
  },
  "video/vp9": {
    profileKey: "profile-id",
    parameterKeys: ["max-fr", "max-fs"],
    validators: {
      "profile-id": /^[0-3]$/,
      "max-fr": /^[1-9][0-9]{0,9}$/,
      "max-fs": /^[1-9][0-9]{0,9}$/,
    },
  },
  "video/vp8": {
    profileKey: null,
    parameterKeys: ["max-fr", "max-fs"],
    validators: {
      "max-fr": /^[1-9][0-9]{0,9}$/,
      "max-fs": /^[1-9][0-9]{0,9}$/,
    },
  },
  "video/av1": {
    profileKey: "profile",
    parameterKeys: ["level-idx", "tier"],
    validators: {
      profile: /^[0-2]$/,
      "level-idx": /^(?:[0-9]|[12][0-9]|3[01])$/,
      tier: /^[01]$/,
    },
  },
};

function linkedVideoCodec(
  report: RTCStatsReport,
  media: StatsRecord | null,
  transport: StatsRecord | null,
): StatsRecord | null {
  const codec = getRecord(report, stringValue(media, "codecId"));
  const mimeType = stringValue(codec, "mimeType");
  return codec?.type === "codec" &&
    transport !== null &&
    stringValue(codec, "transportId") === transport.id &&
    mimeType !== null &&
    /^video\/[A-Za-z0-9.+-]{1,32}$/i.test(mimeType)
    ? codec
    : null;
}

function deriveCodecEvidence(codec: StatsRecord | null): CodecEvidence {
  const mimeType = stringValue(codec, "mimeType");
  if (!mimeType) {
    return { codec: null, profile: null, parameters: null };
  }
  const rule = CODEC_PARAMETER_RULES[mimeType.toLowerCase()];
  const fmtp = stringValue(codec, "sdpFmtpLine");
  if (!rule || !fmtp || fmtp.length > 2_048) {
    return { codec: mimeType, profile: null, parameters: null };
  }

  const segments = fmtp.split(";");
  if (segments.length > 32) {
    return { codec: mimeType, profile: null, parameters: null };
  }
  const values = new Map<string, string>();
  const seenKeys = new Set<string>();
  for (const segment of segments) {
    const separator = segment.indexOf("=");
    if (separator < 1) {
      continue;
    }
    const key = segment.slice(0, separator).trim().toLowerCase();
    const validator = rule.validators[key];
    if (!validator) {
      continue;
    }
    if (seenKeys.has(key)) {
      values.delete(key);
      continue;
    }
    seenKeys.add(key);
    const value = segment.slice(separator + 1).trim().toLowerCase();
    if (!validator.test(value)) {
      continue;
    }
    values.set(key, value);
  }

  const profileValue = rule.profileKey
    ? values.get(rule.profileKey)
    : undefined;
  const parameters = rule.parameterKeys
    .flatMap((key) => {
      const value = values.get(key);
      return value ? [`${key}=${value}`] : [];
    })
    .join("; ");
  return {
    codec: mimeType,
    profile:
      rule.profileKey && profileValue
        ? `${rule.profileKey}=${profileValue}`
        : null,
    parameters: parameters || null,
  };
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
  const report = await connection.getStats();
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
  const sameMedia =
    mediaId !== null &&
    mediaId === previous.mediaId &&
    ssrc === previous.ssrc &&
    trackIdentifier === previous.trackIdentifier;
  const remoteInbound =
    direction === "send" ? linkedRemoteInbound(report, media) : null;
  const bytesKey = direction === "send" ? "bytesSent" : "bytesReceived";
  const bytes = numberValue(media, bytesKey);
  const framesKey = direction === "send" ? "framesEncoded" : "framesDecoded";
  const frames = numberValue(media, framesKey);
  const timestamp = numberValue(media, "timestamp");
  const framesEncoded = numberValue(media, "framesEncoded");
  const framesDecoded = numberValue(media, "framesDecoded");
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
  previous.bytes = bytes;
  previous.frames = frames;
  previous.timestamp = timestamp;
  previous.previousTotalEncodeTime = totalEncodeTime;
  previous.previousTotalDecodeTime = totalDecodeTime;
  previous.previousFramesDropped = framesDropped;
  previous.previousFreezeCount = freezeCount;
  previous.previousTotalFreezesDuration = totalFreezesDuration;
  previous.previousRetransmittedPackets = retransmittedPackets;
  previous.previousRetransmittedBytes = retransmittedBytes;

  const linkedCodec = linkedVideoCodec(report, media, transport);
  const codecEvidence =
    direction === "send"
      ? deriveCodecEvidence(linkedCodec)
      : {
          codec: stringValue(linkedCodec, "mimeType"),
          profile: null,
          parameters: null,
        };
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
    resolution: width !== null && height !== null ? `${width}x${height}` : null,
    packetsLost:
      numberValue(direction === "send" ? remoteInbound : media, "packetsLost"),
    jitterMs:
      numberValue(direction === "send" ? remoteInbound : media, "jitter") !== null
        ? numberValue(direction === "send" ? remoteInbound : media, "jitter")! *
          1_000
        : null,
    framesDropped,
    intervalFramesDropped,
    intervalFreezeCount,
    intervalFreezeDurationMs:
      freezeDurationDelta === null ? null : freezeDurationDelta * 1_000,
    intervalRetransmittedPackets,
    intervalRetransmittedBytes,
    codec: codecEvidence.codec,
    codecProfile: codecEvidence.profile,
    codecParameters: codecEvidence.parameters,
    scalabilityMode:
      direction === "send" ? scalabilityModeValue(media) : null,
    encoderImplementation: stringValue(media, "encoderImplementation"),
    powerEfficientEncoder: booleanValue(media, "powerEfficientEncoder"),
    intervalEncodeMs,
    intervalDecodeMs,
    qualityLimitationReason: stringValue(media, "qualityLimitationReason"),
  };
}
