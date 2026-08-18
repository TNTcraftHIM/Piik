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
  bytes: number | null;
  frames: number | null;
  timestamp: number | null;
}

export function createStatsAccumulator(): StatsAccumulator {
  return { bytes: null, frames: null, timestamp: null };
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

function selectedCandidatePair(report: RTCStatsReport): StatsRecord | null {
  let transport: StatsRecord | null = null;
  const candidatePairs: StatsRecord[] = [];
  report.forEach((raw) => {
    const record = raw as StatsRecord;
    if (record.type === "transport") {
      transport = record;
    } else if (record.type === "candidate-pair") {
      candidatePairs.push(record);
    }
  });

  const pairId = stringValue(transport, "selectedCandidatePairId");
  if (pairId) {
    return getRecord(report, pairId);
  }
  return (
    candidatePairs.find(
      (pair) =>
        pair.state === "succeeded" &&
        (pair.nominated === true || pair.selected === true),
    ) ?? null
  );
}

function mediaRecord(
  report: RTCStatsReport,
  direction: "send" | "receive",
): StatsRecord | null {
  let result: StatsRecord | null = null;
  report.forEach((raw) => {
    const record = raw as StatsRecord;
    const expectedType = direction === "send" ? "outbound-rtp" : "inbound-rtp";
    if (
      record.type === expectedType &&
      record.kind === "video" &&
      record.isRemote !== true
    ) {
      result = record;
    }
  });
  return result;
}

function remoteInboundVideo(report: RTCStatsReport): StatsRecord | null {
  let result: StatsRecord | null = null;
  report.forEach((raw) => {
    const record = raw as StatsRecord;
    if (record.type === "remote-inbound-rtp" && record.kind === "video") {
      result = record;
    }
  });
  return result;
}

export async function collectConnectionMetrics(
  connection: RTCPeerConnection,
  direction: "send" | "receive",
  previous: StatsAccumulator,
): Promise<ConnectionMetrics> {
  const report = await connection.getStats();
  const pair = selectedCandidatePair(report);
  const localCandidate = getRecord(
    report,
    stringValue(pair, "localCandidateId"),
  );
  const remoteCandidate = getRecord(
    report,
    stringValue(pair, "remoteCandidateId"),
  );
  const localType = stringValue(localCandidate, "candidateType");
  const remoteType = stringValue(remoteCandidate, "candidateType");
  const path =
    localType === "relay" || remoteType === "relay"
      ? "relay"
      : localType !== null && remoteType !== null
        ? "direct"
        : "unknown";

  const media = mediaRecord(report, direction);
  const remoteInbound = direction === "send" ? remoteInboundVideo(report) : null;
  const bytesKey = direction === "send" ? "bytesSent" : "bytesReceived";
  const bytes = numberValue(media, bytesKey);
  const framesKey = direction === "send" ? "framesEncoded" : "framesDecoded";
  const frames = numberValue(media, framesKey);
  const timestamp = media?.timestamp ?? null;
  let bitrateKbps: number | null = null;
  let derivedFps: number | null = null;

  if (
    bytes !== null &&
    timestamp !== null &&
    previous.bytes !== null &&
    previous.timestamp !== null &&
    timestamp > previous.timestamp
  ) {
    const elapsedSeconds = (timestamp - previous.timestamp) / 1_000;
    bitrateKbps = ((bytes - previous.bytes) * 8) / elapsedSeconds / 1_000;
    if (frames !== null && previous.frames !== null) {
      derivedFps = (frames - previous.frames) / elapsedSeconds;
    }
  }
  previous.bytes = bytes;
  previous.frames = frames;
  previous.timestamp = timestamp;

  const codec = getRecord(report, stringValue(media, "codecId"));
  const width = numberValue(media, "frameWidth");
  const height = numberValue(media, "frameHeight");
  const framesEncoded = numberValue(media, "framesEncoded");
  const framesDecoded = numberValue(media, "framesDecoded");
  const totalEncodeTime = numberValue(media, "totalEncodeTime");
  const totalDecodeTime = numberValue(media, "totalDecodeTime");
  const iceProtocol =
    stringValue(localCandidate, "protocol") ??
    stringValue(remoteCandidate, "protocol");
  const localRelayProtocol =
    localType === "relay" ? stringValue(localCandidate, "relayProtocol") : null;

  return {
    ...EMPTY_METRICS,
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
    framesDropped: numberValue(media, "framesDropped"),
    codec: stringValue(codec, "mimeType"),
    encoderImplementation: stringValue(media, "encoderImplementation"),
    powerEfficientEncoder: booleanValue(media, "powerEfficientEncoder"),
    averageEncodeMs:
      framesEncoded && totalEncodeTime !== null
        ? (totalEncodeTime / framesEncoded) * 1_000
        : null,
    averageDecodeMs:
      framesDecoded && totalDecodeTime !== null
        ? (totalDecodeTime / framesDecoded) * 1_000
        : null,
    qualityLimitationReason: stringValue(media, "qualityLimitationReason"),
  };
}
