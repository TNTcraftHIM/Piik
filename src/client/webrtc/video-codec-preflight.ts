import {
  configureVideoSender,
  startupVideoProfile,
  type QualityProfile,
} from "../media/quality";
import {
  applyH264ProbeCodec,
  type BrowserVideoCodec,
} from "./video-codec";

const PREFLIGHT_DEADLINE_MS = 4_000;
const PREFLIGHT_POLL_MS = 100;
const PREFLIGHT_MIN_SOURCE_FRAMES = 15;
const PREFLIGHT_MAX_FRAME_DEFICIT = 2;
const PREFLIGHT_FPS_WINDOW_MS = 1_000;

export interface H264ProbeSample {
  outboundId: string;
  sourceId: string;
  timestamp: number;
  codec: string;
  framesEncoded: number | null;
  sourceFrames: number | null;
  encodedFramesPerSecond: number | null;
  sourceFramesPerSecond: number | null;
  qualityLimitationReason: string | null;
}

type StatsRecord = RTCStats & Record<string, unknown>;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function recordById(
  report: RTCStatsReport,
  id: unknown,
): StatsRecord | null {
  if (typeof id !== "string") {
    return null;
  }
  return (report.get(id) as StatsRecord | undefined) ?? null;
}

function readH264ProbeSample(report: RTCStatsReport): H264ProbeSample | null {
  const candidates: StatsRecord[] = [];
  report.forEach((raw) => {
    const record = raw as StatsRecord;
    if (
      record.type === "outbound-rtp" &&
      record.kind === "video" &&
      record.isRemote !== true &&
      finiteNumber(record.framesEncoded) !== null
    ) {
      candidates.push(record);
    }
  });
  if (candidates.length !== 1) {
    return null;
  }
  const outbound = candidates[0]!;
  const codec = recordById(report, outbound.codecId);
  const source = recordById(report, outbound.mediaSourceId);
  const mimeType = stringValue(codec?.mimeType);
  if (
    codec?.type !== "codec" ||
    source?.type !== "media-source" ||
    mimeType?.toLowerCase() !== "video/h264"
  ) {
    return null;
  }
  return {
    outboundId: outbound.id,
    sourceId: source.id,
    timestamp: finiteNumber(outbound.timestamp) ?? 0,
    codec: mimeType,
    framesEncoded: finiteNumber(outbound.framesEncoded),
    sourceFrames: finiteNumber(source.frames),
    encodedFramesPerSecond: finiteNumber(outbound.framesPerSecond),
    sourceFramesPerSecond: finiteNumber(source.framesPerSecond),
    qualityLimitationReason: stringValue(outbound.qualityLimitationReason),
  };
}

export function h264ProbeSustainsSource(
  baseline: H264ProbeSample,
  current: H264ProbeSample,
): boolean | null {
  if (
    baseline.outboundId !== current.outboundId ||
    baseline.sourceId !== current.sourceId ||
    current.timestamp <= baseline.timestamp ||
    current.codec.toLowerCase() !== "video/h264" ||
    current.qualityLimitationReason === "cpu"
  ) {
    return false;
  }
  if (
    baseline.framesEncoded !== null &&
    current.framesEncoded !== null &&
    baseline.sourceFrames !== null &&
    current.sourceFrames !== null &&
    current.framesEncoded >= baseline.framesEncoded &&
    current.sourceFrames >= baseline.sourceFrames
  ) {
    const encoded = current.framesEncoded - baseline.framesEncoded;
    const source = current.sourceFrames - baseline.sourceFrames;
    if (source < PREFLIGHT_MIN_SOURCE_FRAMES) {
      return null;
    }
    return encoded + PREFLIGHT_MAX_FRAME_DEFICIT >= source;
  }
  if (
    current.timestamp - baseline.timestamp < PREFLIGHT_FPS_WINDOW_MS ||
    current.encodedFramesPerSecond === null ||
    current.sourceFramesPerSecond === null ||
    current.sourceFramesPerSecond <= 0
  ) {
    return null;
  }
  return (
    current.encodedFramesPerSecond + PREFLIGHT_MAX_FRAME_DEFICIT >=
    current.sourceFramesPerSecond
  );
}

function hasProbeWindow(
  baseline: H264ProbeSample,
  current: H264ProbeSample,
): boolean {
  if (
    baseline.outboundId !== current.outboundId ||
    baseline.sourceId !== current.sourceId ||
    current.timestamp <= baseline.timestamp
  ) {
    return false;
  }
  if (
    baseline.sourceFrames !== null &&
    current.sourceFrames !== null &&
    current.sourceFrames >= baseline.sourceFrames
  ) {
    return (
      current.sourceFrames - baseline.sourceFrames >=
      PREFLIGHT_MIN_SOURCE_FRAMES
    );
  }
  return current.timestamp - baseline.timestamp >= PREFLIGHT_FPS_WINDOW_MS;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForIceGathering(
  connection: RTCPeerConnection,
  deadline: number,
  signal?: AbortSignal,
): Promise<void> {
  while (connection.iceGatheringState !== "complete") {
    if (Date.now() >= deadline) {
      throw new Error("H.264 preflight timed out");
    }
    await delay(PREFLIGHT_POLL_MS, signal);
  }
}

async function runH264Probe(
  track: MediaStreamTrack,
  profile: QualityProfile,
  signal?: AbortSignal,
): Promise<boolean> {
  const senderConnection = new RTCPeerConnection({ iceServers: [] });
  const receiverConnection = new RTCPeerConnection({ iceServers: [] });
  const abort = () => {
    senderConnection.close();
    receiverConnection.close();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const transceiver = senderConnection.addTransceiver(track, {
      direction: "sendonly",
    });
    if (!applyH264ProbeCodec(transceiver)) {
      return false;
    }
    await configureVideoSender(
      transceiver.sender,
      startupVideoProfile(profile),
    );
    const deadline = Date.now() + PREFLIGHT_DEADLINE_MS;
    await senderConnection.setLocalDescription(
      await senderConnection.createOffer(),
    );
    await waitForIceGathering(senderConnection, deadline, signal);
    await receiverConnection.setRemoteDescription(
      senderConnection.localDescription!,
    );
    await receiverConnection.setLocalDescription(
      await receiverConnection.createAnswer(),
    );
    await waitForIceGathering(receiverConnection, deadline, signal);
    await senderConnection.setRemoteDescription(
      receiverConnection.localDescription!,
    );

    let warmupBaseline: H264ProbeSample | null = null;
    let measurementBaseline: H264ProbeSample | null = null;
    while (Date.now() < deadline) {
      if (signal?.aborted || track.readyState === "ended") {
        return false;
      }
      const sample = readH264ProbeSample(
        await transceiver.sender.getStats(),
      );
      if (sample) {
        warmupBaseline ??= sample;
        if (
          !measurementBaseline &&
          sample !== warmupBaseline &&
          hasProbeWindow(warmupBaseline, sample)
        ) {
          measurementBaseline = sample;
        } else if (measurementBaseline && sample !== measurementBaseline) {
          const result = h264ProbeSustainsSource(measurementBaseline, sample);
          if (result !== null) {
            return result;
          }
        }
      }
      await delay(PREFLIGHT_POLL_MS, signal);
    }
    return false;
  } finally {
    signal?.removeEventListener("abort", abort);
    senderConnection.close();
    receiverConnection.close();
  }
}

export async function preferredVideoCodecForTrack(
  track: MediaStreamTrack,
  profile: QualityProfile,
  signal?: AbortSignal,
): Promise<BrowserVideoCodec> {
  let codec: BrowserVideoCodec = "vp8";
  if (track.kind !== "video" || track.readyState === "ended") {
    console.debug("[Screener] video codec preflight", codec);
    return codec;
  }
  try {
    codec = (await runH264Probe(track, profile, signal)) ? "h264" : "vp8";
  } catch {}
  if (!signal?.aborted) {
    console.debug("[Screener] video codec preflight", codec);
  }
  return codec;
}
