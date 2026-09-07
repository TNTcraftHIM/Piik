import {
  createRoomResponseSchema,
  clientMessageSchema,
  decodeServerMessage,
  SIGNALING_PROTOCOL,
  type ClientMessage,
  type CreateRoomResponse,
  type QualitySettings,
  type ServerMessage,
} from "../src/shared/protocol";
import { SfuPublisher } from "../src/client/sfu/publisher";
import { SfuSubscriber } from "../src/client/sfu/subscriber";
import type { SfuConnectionConfig } from "../src/client/sfu/peer";

const high: QualitySettings = {
  resolution: "720p", maxFramerate: 15, maxBitrate: 2_000_000,
  degradationPreference: "maintain-resolution", screenAudioQuality: "saver",
};
const low: QualitySettings = { ...high, resolution: "480p" };
const shareGeneration = crypto.randomUUID();
let socket: WebSocket | null = null;
let publisher: SfuPublisher | null = null;
let subscriber: SfuSubscriber | null = null;
let configuration: SfuConnectionConfig | null = null;
let source: MediaStream | null = null;
let audio: AudioContext | null = null;
let canvas: HTMLCanvasElement | null = null;
let video: HTMLVideoElement | null = null;
let drawTimer: number | null = null;
let preparedRevision = 0;
let decoded = false;
let authenticated = false;
let committed = false;
let publicationRetired = false;
let sharingStopped = false;
let stopping = false;
let peerFailures = 0;
let published = false;
let simulcast = false;
let audioKbps = 0;
let audioCodec: string | null = null;
let error: string | null = null;
let messageTail = Promise.resolve();

function send(message: ClientMessage): boolean {
  clientMessageSchema.parse(message);
  if (socket?.readyState !== WebSocket.OPEN) return false;
  if (message.type === "sfu-signal" && message.description?.type === "offer") {
    simulcast = message.description.sdp.includes("a=simulcast:send q;h");
  }
  socket.send(JSON.stringify(message));
  return true;
}

function failed(reason: unknown): void {
  error = reason instanceof Error ? reason.message : String(reason);
}

async function accept(message: ServerMessage, host: boolean): Promise<void> {
  if (message.type === "error") throw new Error(`${message.code}: ${message.message}`);
  if (message.type === "authenticated") authenticated = true;
  if (message.type === "sharing-stopped") {
    sharingStopped = true;
    await subscriber?.disconnect();
  }
  if (message.type === "route-update") {
    if (message.phase === "prepare" && !host) {
      if (message.candidate.transport === "direct") {
        // Exercise the ordinary fallback operation without changing room policy.
        peerFailures += 1;
        send({ type: "route-failed", revision: message.revision,
          phase: "prepare", connectionId: message.candidate.connectionId });
      } else preparedRevision = message.revision;
    }
    if (message.phase === "active") {
      if (!host && message.assignment.upstream.kind === "sfu") {
        if (!decoded) throw new Error("SFU committed before decoded-frame proof");
        committed = true;
      }
      if (configuration && message.assignment.sfuPublicationGeneration === configuration.publicationGeneration) {
        configuration = { ...configuration, revision: message.revision };
        publisher?.updateConfig(configuration);
        subscriber?.updateConfig(configuration);
      }
    }
  }
  if (message.type === "sfu-config") {
    if (configuration) {
      if (configuration.connectionId !== message.connectionId ||
          configuration.publicationGeneration !== message.publicationGeneration) {
        throw new Error("Unexpected SFU replacement during bounded acceptance");
      }
      configuration = message;
      publisher?.updateConfig(message);
      subscriber?.updateConfig(message);
      return;
    }
    configuration = message;
    if (host) {
      publisher = new SfuPublisher({ send, onDisconnected: () => {
        if (!stopping) failed("Publisher disconnected");
      } });
      await publisher.connect(message);
      published = await publisher.activate(source!, high, "vp8");
      if (!published) throw new Error("Publisher did not activate");
    } else {
      video = document.createElement("video");
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.style.cssText = "max-width:100%;width:640px";
      document.body.append(video);
      subscriber = new SfuSubscriber({
        send,
        onStream: (stream) => {
          if (!video || video.srcObject === stream) return;
          video.srcObject = stream;
          if (stream) void video.play().catch(failed);
        },
        onStats: (metrics) => {
          audioKbps = metrics.audioBitrateKbps ?? 0;
          audioCodec = metrics.audioCodec;
        },
        onFirstDecodedFrame: () => {
          decoded = true;
          return send({ type: "route-ready", revision: preparedRevision, phase: "prepare" });
        },
        onDisconnected: () => { if (!sharingStopped) failed("Subscriber disconnected"); },
      });
      await subscriber.connect(message);
      subscriber.armDecodedFrameProof();
      subscriber.activate();
    }
  }
  if (message.type === "sfu-signal") {
    await publisher?.acceptSignal(message);
    await subscriber?.acceptSignal(message);
  }
}

async function connect(room: CreateRoomResponse, host: boolean): Promise<void> {
  socket = new WebSocket(new URL("/signal", location.href).href.replace(/^http/, "ws"));
  socket.addEventListener("message", ({ data }) => {
    messageTail = messageTail.then(() => accept(decodeServerMessage(String(data)), host)).catch(failed);
  });
  socket.addEventListener("error", () => failed("Room WebSocket failed"));
  socket.addEventListener("close", (event) => {
    if (host && stopping && event.code === 1000 && event.reason === "Sharing stopped") {
      void publisher?.disconnect().then(() => { publicationRetired = true; });
    } else if (!stopping && !sharingStopped) failed(`Unexpected room socket close: ${event.code}`);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Room WebSocket timed out")), 10_000);
    socket!.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  const common = { type: "authenticate", protocol: SIGNALING_PROTOCOL,
    roomId: room.roomId, clientId: crypto.randomUUID() } as const;
  send(host
    ? { ...common, role: "host", token: room.hostToken, shareGeneration,
        qualitySettings: high, routePolicy: { peerOnly: false, topologyOptimization: false, natPrediction: false } }
    : { ...common, role: "viewer", viewerGrant: new URLSearchParams(new URL(room.inviteUrl).hash.slice(1)).get("v")! });
}

export async function startHost(): Promise<CreateRoomResponse> {
  const response = await fetch("/api/rooms", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ codeEntryPolicy: "private" }),
  });
  if (!response.ok) throw new Error(`Room creation failed: ${response.status}`);
  const room = createRoomResponseSchema.parse(await response.json());
  canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  canvas.style.cssText = "max-width:100%;width:640px";
  document.body.append(canvas);
  const context = canvas.getContext("2d")!;
  let frame = 0;
  drawTimer = window.setInterval(() => {
    context.fillStyle = "#167d8d";
    context.fillRect(0, 0, canvas!.width, canvas!.height);
    context.fillStyle = "#f2d748";
    context.fillRect((frame++ * 17) % canvas!.width, 60, 100, 100);
    context.fillStyle = "#ffffff";
    context.font = "48px sans-serif";
    context.fillText(String(frame), 40, 240);
  }, 1000 / 15);
  source = canvas.captureStream(15);
  audio = new AudioContext();
  const tone = audio.createOscillator();
  const gain = audio.createGain();
  gain.gain.value = 0.05;
  const destination = audio.createMediaStreamDestination();
  tone.connect(gain).connect(destination);
  tone.start();
  await audio.resume();
  source.addTrack(destination.stream.getAudioTracks()[0]!);
  await connect(room, true);
  return room;
}

export async function startViewer(room: CreateRoomResponse): Promise<void> {
  await connect(room, false);
}

export function snapshot() {
  return { authenticated, published, simulcast, decoded, committed, peerFailures,
    audioKbps, audioCodec, publicationRetired, sharingStopped,
    warning: publisher?.getQualityWarning() ?? null,
    failureStage: publisher?.getFailureStage() ?? null, error };
}

export async function waitForFrames(width: number, height: number) {
  if (!video) throw new Error("Viewer video is unavailable");
  const target = video;
  return await new Promise<{ frames: number; width: number; height: number }>((resolve, reject) => {
    let frames = 0;
    let callback = 0;
    const timer = setTimeout(() => {
      target.cancelVideoFrameCallback(callback);
      reject(new Error(`Viewer did not decode ${width}x${height}; current ${target.videoWidth}x${target.videoHeight}; ${error ?? "no signaling error"}`));
    }, 20_000);
    const next = () => {
      callback = target.requestVideoFrameCallback(() => {
        frames = target.videoWidth === width && target.videoHeight === height ? frames + 1 : 0;
        if (frames < 15) return next();
        clearTimeout(timer);
        resolve({ frames, width: target.videoWidth, height: target.videoHeight });
      });
    };
    next();
  });
}

export async function lowerProfile(): Promise<boolean> {
  if (!publisher || !canvas) throw new Error("Publisher is unavailable");
  canvas.width = 854;
  canvas.height = 480;
  send({ type: "set-quality-settings", qualitySettings: low });
  return await publisher.updateProfile(low);
}

export function stopSharing(): void {
  stopping = true;
  send({ type: "stop-sharing", shareGeneration });
}

export async function stop(): Promise<boolean> {
  stopping = true;
  await publisher?.disconnect();
  await subscriber?.disconnect();
  if (drawTimer !== null) clearInterval(drawTimer);
  source?.getTracks().forEach((track) => track.stop());
  await audio?.close();
  video?.remove();
  canvas?.remove();
  const closed = !source || source.getTracks().every((track) => track.readyState === "ended");
  socket?.close();
  return closed;
}
