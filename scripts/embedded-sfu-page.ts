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
import { NativeClient } from "../src/client/native/client";
import { NativeSfuPublisher } from "../src/client/native/native-sfu-publisher";
import { defaultNativeCapturePath } from "../src/client/native/capture-selection";
import { HostSfuRoute, type HostPublisherTransport } from "../src/client/media/host-sfu-route";
import { ViewerSfuRoute } from "../src/client/media/viewer-sfu-route";

const high: QualitySettings = {
  resolution: "720p", maxFramerate: 15, maxBitrate: 2_000_000,
  degradationPreference: "maintain-resolution", screenAudioQuality: "saver",
};
const low: QualitySettings = { ...high, resolution: "480p" };
const shareGeneration = crypto.randomUUID();
const clientId = crypto.randomUUID();
let socket: WebSocket | null = null;
let publisher: HostPublisherTransport | null = null;
let native: NativeClient | null = null;
let nativeShareStarted = false;
let nativeShareStopped = false;
let nativeFramesPerSecond = 0;
let nativeBitrateKbps = 0;
let nativeEncodingCount = 0;
let viewerRoute: ViewerSfuRoute | null = null;
let hostRoute: HostSfuRoute | null = null;
let profile = high;
let failSubscriber: (() => void) | null = null;
let configuration: SfuConnectionConfig | null = null;
let source: MediaStream | null = null;
let audio: AudioContext | null = null;
let canvas: HTMLCanvasElement | null = null;
let video: HTMLVideoElement | null = null;
let drawTimer: number | null = null;
let decoded = false;
let authenticated = false;
let committed = false;
let publicationRetired = false;
let sharingStopped = false;
let stopping = false;
let peerFailures = 0;
let published = false;
let simulcast = false;
let codec: "vp8" | "h264" = "vp8";
let audioKbps = 0;
let audioCodec: string | null = null;
let error: string | null = null;
let messageTail = Promise.resolve();
let routeStatus: string | null = null;
const routeEvents: Array<{ type: string; revision?: number; phase?: string; connectionId?: string | null }> = [];

function traceRoute(message: { type: string; revision?: number; phase?: string; connectionId?: string | null }): void {
  routeEvents.push({ type: message.type, revision: message.revision, phase: message.phase, connectionId: message.connectionId });
  if (routeEvents.length > 20) routeEvents.shift();
}

function send(message: ClientMessage): boolean {
  clientMessageSchema.parse(message);
  if (socket?.readyState !== WebSocket.OPEN) return false;
  if (message.type === "route-failed" || message.type === "route-ready") traceRoute(message);
  if (message.type === "sfu-signal" && message.kind !== "candidate") traceRoute({ ...message, type: `send-${message.kind}` });
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
  if (message.type === "route-update" || message.type === "sfu-config" || message.type === "route-status") traceRoute(message);
  if (message.type === "route-status") routeStatus = message.state;
  if (message.type === "sfu-signal" && message.kind !== "candidate") traceRoute({ ...message, type: `receive-${message.kind}` });
  if (message.type === "error") throw new Error(`${message.code}: ${message.message}`);
  if (message.type === "authenticated") {
    authenticated = true;
    if (host && !hostRoute) hostRoute = new HostSfuRoute({
      send, getStream: () => source, getProfile: () => profile,
      getVideoCodec: () => codec, reconcileChildren: () => undefined,
      createPublisher: (onDisconnected, onStats) => {
        publisher = native
          ? new NativeSfuPublisher(native, shareGeneration, { iceServers: [] }, {
              send, onDisconnected, onStats: metrics => {
                onStats(metrics);
                nativeFramesPerSecond = metrics?.framesPerSecond ?? 0;
                nativeBitrateKbps = metrics?.bitrateKbps ?? 0;
                nativeEncodingCount = metrics?.videoEncodingCount ?? 0;
              },
            })
          : new SfuPublisher({ send, onDisconnected, onStats });
        return publisher;
      },
    });
    await hostRoute?.resyncAuthoritative({ revision: message.routeRevision,
      phase: "active", assignment: message.routeAssignment });
    if (!host && !viewerRoute) {
      video = document.createElement("video");
      video.volume = 0.1;
      video.autoplay = true;
      video.playsInline = true;
      video.style.cssText = "max-width:100%;width:640px";
      document.body.append(video);
      viewerRoute = new ViewerSfuRoute(message.peerId, {
        send, activatePeer: () => true,
        onSfuStream: stream => {
          decoded = committed = true;
          if (video && video.srcObject !== stream) {
            video.srcObject = stream;
            void video.play().catch(failed);
          }
        },
        onSfuUpdate: metrics => {
          audioKbps = metrics?.audioBitrateKbps ?? 0;
          audioCodec = metrics?.audioCodec ?? null;
        },
        createSubscriber: events => {
          const transport = new SfuSubscriber({ ...events, send,
            onState: state => { traceRoute({ type: `media-${state}` }); events.onState(state); },
            onFirstDecodedFrame: () => { traceRoute({ type: "decoded-frame" }); return events.onFirstDecodedFrame(); },
          });
          failSubscriber = () => { void transport.disconnect(); events.onDisconnected(); };
          return transport;
        },
      });
    }
    await viewerRoute?.resyncAuthoritative({ revision: message.routeRevision,
      phase: "active", assignment: message.routeAssignment }, message.peerId);
  }
  if (message.type === "sharing-stopped") {
    sharingStopped = true;
    await viewerRoute?.disconnect();
  }
  if (message.type === "route-update") {
    if (message.phase === "prepare") routeStatus = null;
    viewerRoute?.accept(message);
    await hostRoute?.acceptAndWait(message);
    if (message.phase === "prepare" && !host) {
      if (message.candidate.transport === "direct") {
        // Exercise the ordinary fallback operation without changing room policy.
        peerFailures += 1;
        send({ type: "route-failed", revision: message.revision,
          phase: "prepare", connectionId: message.candidate.connectionId });
      }
    }
  }
  if (message.type === "sfu-config") {
    configuration = message;
    if (host) {
      await hostRoute?.acceptConfig(message);
      published = publisher !== null;
    } else await viewerRoute?.acceptConfig(message);
  }
  if (message.type === "sfu-signal") {
    await hostRoute?.acceptSignal(message);
    await viewerRoute?.acceptSignal(message);
  }
}

async function connect(room: CreateRoomResponse, host: boolean): Promise<void> {
  socket = new WebSocket(new URL("/signal", location.href).href.replace(/^http/, "ws"));
  const connection = socket;
  socket.addEventListener("message", ({ data }) => {
    messageTail = messageTail.then(() => accept(decodeServerMessage(String(data)), host)).catch(failed);
  });
  socket.addEventListener("error", () => failed("Room WebSocket failed"));
  socket.addEventListener("close", (event) => {
    if (socket !== connection) return;
    if (host && stopping && event.code === 1000 && event.reason === "Sharing stopped") {
      void hostRoute?.disconnect().then(() => { publicationRetired = true; });
    } else if (!stopping && !sharingStopped) failed(`Unexpected room socket close: ${event.code}`);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Room WebSocket timed out")), 10_000);
    socket!.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  const common = { type: "authenticate", protocol: SIGNALING_PROTOCOL,
    roomId: room.roomId, clientId } as const;
  send(host
    ? { ...common, role: "host", token: room.hostToken, shareGeneration,
        qualitySettings: high, routePolicy: { peerOnly: false, topologyOptimization: false, natPrediction: false } }
    : { ...common, role: "viewer", viewerGrant: new URLSearchParams(new URL(room.inviteUrl).hash.slice(1)).get("v")! });
}

export async function startHost(nativeSource?: { title: string; port: number }, selectedCodec: "vp8" | "h264" = "vp8"): Promise<CreateRoomResponse> {
  codec = selectedCodec;
  const response = await fetch("/api/rooms", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ codeEntryPolicy: "private" }),
  });
  if (!response.ok) throw new Error(`Room creation failed: ${response.status}`);
  const room = createRoomResponseSchema.parse(await response.json());
  if (nativeSource) {
    native = await NativeClient.connect();
    if (!native || native.health.port !== nativeSource.port) throw new Error("Gate App was not discovered");
    const target = (await native.sources()).find((candidate) => candidate.kind === "window" && candidate.title === nativeSource.title);
    const path = defaultNativeCapturePath(await native.captureOptions(), codec, native.health.nativeMedia.softwareVP8);
    if (!target || !path) throw new Error("Native source is unavailable");
    native.onEvent((event) => {
      if (!stopping && event.type === "share-ended" && event.shareId === shareGeneration) failed("Native capture ended");
    });
    const started = await native.startShare({ shareId: shareGeneration, source: target,
      codec, audio: true, profile: high, edgeCapacity: 2, ...path });
    nativeShareStarted = true;
    source = new MediaStream();
    if (started.codec !== codec || !started.audio) throw new Error("Requested Native codec and Opus capture did not start");
    await connect(room, true);
    return room;
  }
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

export async function reconnectViewer(room: CreateRoomResponse): Promise<void> {
  const previous = socket;
  socket = null;
  previous?.close();
  authenticated = false;
  await connect(room, false);
}

export function snapshot() {
  return { authenticated, published, simulcast, decoded, committed, peerFailures,
    routeEvents, routeStatus,
    connectionId: configuration?.connectionId,
    audioKbps, audioCodec, publicationRetired, sharingStopped, nativeShareStarted, nativeShareStopped,
    nativeFramesPerSecond, nativeBitrateKbps, nativeEncodingCount,
    warning: publisher?.getQualityWarning?.() ?? null,
    failureStage: publisher?.getFailureStage?.() ?? null, error };
}

// Fault injection retires real media; the production route owner must negotiate
// and decode on a new server-owned edge before the gate counts recovery.
export function failSubscription(): string {
  if (!failSubscriber || !configuration || !committed) throw new Error("No active subscription");
  const previous = configuration.connectionId;
  decoded = committed = false;
  failSubscriber();
  return previous;
}

export async function audioEnergy(): Promise<number> {
  const probe = (window as unknown as { __piikGateAudioEnergy: () => Promise<number> }).__piikGateAudioEnergy;
  return await probe();
}

export async function waitForFrames(width: number, height: number, minimumFrames = 15) {
  if (!video) throw new Error("Viewer video is unavailable");
  const target = video;
  return await new Promise<{ frames: number; width: number; height: number }>((resolve, reject) => {
    let frames = 0;
    let callback = 0;
    const timer = setTimeout(() => {
      target.cancelVideoFrameCallback(callback);
      reject(new Error(`Viewer did not decode ${width}x${height}; current ${target.videoWidth}x${target.videoHeight}; ${frames} frame callbacks; ${document.visibilityState}; ${error ?? "no signaling error"}`));
    }, minimumFrames > 15 ? 30_000 : 20_000);
    const next = () => {
      callback = target.requestVideoFrameCallback(() => {
        frames = target.videoWidth === width && target.videoHeight === height ? frames + 1 : 0;
        if (frames < minimumFrames) return next();
        clearTimeout(timer);
        resolve({ frames, width: target.videoWidth, height: target.videoHeight });
      });
    };
    next();
  });
}

export async function lowerProfile(): Promise<boolean> {
  if (!publisher) throw new Error("Publisher is unavailable");
  if (native) await native.updateShare(shareGeneration, low);
  else {
    if (!canvas) throw new Error("Browser source is unavailable");
    canvas.width = 854;
    canvas.height = 480;
  }
  profile = low;
  send({ type: "set-quality-settings", qualitySettings: low });
  return await hostRoute!.updateProfile(low);
}

export function stopSharing(): void {
  stopping = true;
  send({ type: "stop-sharing", shareGeneration });
}

export async function stop(): Promise<boolean> {
  stopping = true;
  await hostRoute?.disconnect();
  await viewerRoute?.disconnect();
  if (native) {
    if (nativeShareStarted) {
      await native.stopShare(shareGeneration);
      nativeShareStopped = true;
    }
    native.close();
    native = null;
  }
  if (drawTimer !== null) clearInterval(drawTimer);
  source?.getTracks().forEach((track) => track.stop());
  await audio?.close();
  video?.remove();
  canvas?.remove();
  const closed = !source || source.getTracks().every((track) => track.readyState === "ended");
  socket?.close();
  return closed;
}
