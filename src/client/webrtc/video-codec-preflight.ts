import {
  configureVideoSender,
  QUALITY_RESOLUTIONS,
  startupVideoProfile,
  type QualityProfile,
} from "../media/quality";
import {
  applyH264ProbeCodec,
  type BrowserVideoCodec,
} from "./video-codec";
import { addRemoteIceCandidate } from "./nat-prediction";

const PREFLIGHT_DEADLINE_MS = 4_000;
const PREFLIGHT_POLL_MS = 100;
const PREFLIGHT_WARMUP_MS = 500;
const PREFLIGHT_MEASUREMENT_MS = 1_000;

export interface H264ProbeTarget {
  width: number;
  height: number;
  frameRate: number;
}

interface H264ProbeTrack {
  track: MediaStreamTrack;
  stop: () => void;
}

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

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function evenDimension(value: number, ceiling: number): number {
  return Math.min(ceiling, Math.max(2, Math.round(value / 2) * 2));
}

export function h264ProbeTarget(
  settings: MediaTrackSettings,
  profile: QualityProfile,
): H264ProbeTarget {
  const ceiling = QUALITY_RESOLUTIONS[profile.resolution];
  const sourceWidth = positiveNumber(settings.width, ceiling.width);
  const sourceHeight = positiveNumber(settings.height, ceiling.height);
  const scale = Math.max(
    sourceWidth / ceiling.width,
    sourceHeight / ceiling.height,
    1,
  );
  return {
    width: evenDimension(sourceWidth / scale, ceiling.width),
    height: evenDimension(sourceHeight / scale, ceiling.height),
    frameRate: profile.maxFramerate,
  };
}

function drawProbeFrame(
  context: CanvasRenderingContext2D,
  target: H264ProbeTarget,
  frame: number,
): void {
  const columns = 24;
  const rows = 14;
  const tileWidth = Math.ceil(target.width / columns);
  const tileHeight = Math.ceil(target.height / rows);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const hue = (frame * 29 + row * 71 + column * 43) % 360;
      const lightness = 35 + ((frame + row + column) % 30);
      context.fillStyle = `hsl(${hue} 80% ${lightness}%)`;
      context.fillRect(
        column * tileWidth,
        row * tileHeight,
        tileWidth,
        tileHeight,
      );
    }
  }
  const sweep =
    (frame * Math.max(8, Math.floor(target.width / 120))) % target.width;
  context.fillStyle = "#ffffff";
  context.fillRect(
    sweep,
    0,
    Math.max(4, Math.floor(target.width / 180)),
    target.height,
  );
}

function createH264ProbeTrack(
  source: MediaStreamTrack,
  profile: QualityProfile,
): H264ProbeTrack | null {
  if (typeof document === "undefined") {
    return null;
  }
  const target = h264ProbeTarget(source.getSettings(), profile);
  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context || typeof canvas.captureStream !== "function") {
    return null;
  }
  const stream = canvas.captureStream(target.frameRate);
  const track = stream.getVideoTracks()[0];
  if (!track) {
    return null;
  }
  track.contentHint = "motion";
  let frame = 1;
  drawProbeFrame(context, target, frame);
  const timer = window.setInterval(() => {
    frame += 1;
    drawProbeFrame(context, target, frame);
  }, 1_000 / target.frameRate);
  return {
    track,
    stop: () => {
      window.clearInterval(timer);
      track.stop();
    },
  };
}

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

function allowedFrameLag(targetFrameRate: number): number {
  return Math.max(
    1,
    Math.ceil((targetFrameRate * PREFLIGHT_POLL_MS) / 1_000),
  );
}

export function h264ProbeSustainsTarget(
  baseline: H264ProbeSample,
  current: H264ProbeSample,
  targetFrameRate: number,
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
  const elapsedMs = current.timestamp - baseline.timestamp;
  if (elapsedMs < PREFLIGHT_MEASUREMENT_MS) {
    return null;
  }
  const expectedFrames = (targetFrameRate * elapsedMs) / 1_000;
  const frameLag = allowedFrameLag(targetFrameRate);
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
    return (
      source + frameLag >= expectedFrames &&
      encoded + frameLag >= expectedFrames &&
      encoded + frameLag >= source
    );
  }
  if (
    current.encodedFramesPerSecond === null ||
    current.sourceFramesPerSecond === null ||
    current.sourceFramesPerSecond <= 0
  ) {
    return null;
  }
  return (
    current.sourceFramesPerSecond + frameLag >= targetFrameRate &&
    current.encodedFramesPerSecond + frameLag >= targetFrameRate &&
    current.encodedFramesPerSecond + frameLag >=
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
  return current.timestamp - baseline.timestamp >= PREFLIGHT_WARMUP_MS;
}

async function runH264Probe(
  track: MediaStreamTrack,
  profile: QualityProfile,
  signal?: AbortSignal,
): Promise<boolean> {
  const senderConnection = new RTCPeerConnection({ iceServers: [] });
  let receiver: RTCPeerConnection | undefined;
  let pollTimer: number | undefined;
  let stopReason: Error | undefined;
  let stop!: (reason: Error) => void;
  const stopped = new Promise<never>((_, reject) => {
    stop = (reason) => {
      stopReason ??= reason;
      reject(stopReason);
    };
  });
  // Closing a PeerConnection need not settle its pending SDP operations.
  // Every await belongs to this one budget, including setup and statistics.
  const wait = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (stopReason) throw stopReason;
    const value = await Promise.race([operation(), stopped]);
    if (stopReason) throw stopReason;
    return value;
  };
  const abort = () => stop(new DOMException("Codec probe cancelled", "AbortError"));
  const timer = window.setTimeout(
    () => stop(new Error("Codec probe timed out")), PREFLIGHT_DEADLINE_MS,
  );
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const receiverConnection = receiver = new RTCPeerConnection({ iceServers: [] });
    // This in-process probe can start encoding as soon as one local pair works;
    // gathering every candidate must not extend the codec decision.
    const senderCandidates: RTCIceCandidate[] = [];
    const receiverCandidates: RTCIceCandidate[] = [];
    let senderRemoteReady = false;
    let receiverRemoteReady = false;
    let iceFailed = false;
    const addCandidate = async (
      target: RTCPeerConnection,
      candidate: RTCIceCandidate,
    ): Promise<void> => {
      try {
        await addRemoteIceCandidate(target, candidate);
      } catch {
        iceFailed = true;
      }
    };
    senderConnection.addEventListener("icecandidate", (event) => {
      if (!event.candidate) return;
      if (receiverRemoteReady) {
        void addCandidate(receiverConnection, event.candidate);
      } else {
        senderCandidates.push(event.candidate);
      }
    });
    receiverConnection.addEventListener("icecandidate", (event) => {
      if (!event.candidate) return;
      if (senderRemoteReady) {
        void addCandidate(senderConnection, event.candidate);
      } else {
        receiverCandidates.push(event.candidate);
      }
    });
    const transceiver = senderConnection.addTransceiver(track, {
      direction: "sendonly",
    });
    if (!applyH264ProbeCodec(transceiver)) {
      return false;
    }
    await wait(() => configureVideoSender(
      transceiver.sender,
      startupVideoProfile(profile),
    ));
    const offer = await wait(() => senderConnection.createOffer());
    await wait(() => senderConnection.setLocalDescription(offer));
    await wait(() => receiverConnection.setRemoteDescription(
      senderConnection.localDescription!,
    ));
    receiverRemoteReady = true;
    await wait(() => Promise.all(
      senderCandidates.splice(0).map((candidate) =>
        addCandidate(receiverConnection, candidate),
      ),
    ));
    const answer = await wait(() => receiverConnection.createAnswer());
    await wait(() => receiverConnection.setLocalDescription(answer));
    await wait(() => senderConnection.setRemoteDescription(
      receiverConnection.localDescription!,
    ));
    senderRemoteReady = true;
    await wait(() => Promise.all(
      receiverCandidates.splice(0).map((candidate) =>
        addCandidate(senderConnection, candidate),
      ),
    ));

    let warmupBaseline: H264ProbeSample | null = null;
    let measurementBaseline: H264ProbeSample | null = null;
    for (;;) {
      if (signal?.aborted || track.readyState === "ended" || iceFailed) {
        return false;
      }
      const sample = readH264ProbeSample(
        await wait(() => transceiver.sender.getStats()),
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
          const result = h264ProbeSustainsTarget(
            measurementBaseline,
            sample,
            profile.maxFramerate,
          );
          if (result !== null) {
            return result;
          }
        }
      }
      await wait(() => new Promise<void>((resolve) => {
        pollTimer = window.setTimeout(resolve, PREFLIGHT_POLL_MS);
      }));
    }
  } finally {
    window.clearTimeout(timer);
    window.clearTimeout(pollTimer);
    signal?.removeEventListener("abort", abort);
    senderConnection.close();
    receiver?.close();
  }
}

export async function preferredVideoCodecForTrack(
  track: MediaStreamTrack,
  profile: QualityProfile,
  signal?: AbortSignal,
): Promise<BrowserVideoCodec> {
  if (signal?.aborted || track.kind !== "video" || track.readyState === "ended") {
    return "vp8";
  }
  let probe: H264ProbeTrack | null = null;
  try {
    probe = createH264ProbeTrack(track, profile);
    return probe && (await runH264Probe(probe.track, profile, signal))
      ? "h264"
      : "vp8";
  } catch {
    return "vp8";
  } finally {
    probe?.stop();
  }
}
