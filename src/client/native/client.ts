import type { z } from "zod";
import type { RemoteControlMode } from "../remote-control/protocol";
import { debugError, debugEvent } from "../lib/debug";
import { clientRuntimePort } from "../lib/session";
import { NATIVE_CLIENT_PORT_START, NATIVE_CLIENT_PORT_END } from "./discovery-ports";

import type {
  IceConfig,
  QualitySettings,
  SignalPayload,
  SfuSignalMessage,
  PunchPrediction,
} from "../../shared/protocol";
import { createOpaqueId } from "../lib/opaque-id";
import {
  nativeCaptureTargetKey,
  type NativeCapturePath,
} from "./capture-selection";
import {
  captureOptionsResponseSchema,
  edgeOfferResponseSchema,
  nativeAckResponseSchema,
  remoteStopShortcutResponseSchema,
  nativeEventSchema,
  nativeDiscoveryIdentitySchema,
  nativeConnectSchema,
  nativeHealthSchema,
  NATIVE_CLIENT_PROTOCOL,
  NATIVE_CLIENT_SUBPROTOCOL,
  pongResponseSchema,
  publicationResponseSchema,
  receiveAnswerResponseSchema,
  readyResponseSchema,
  requestFailedResponseSchema,
  shareStartedResponseSchema,
  shareSourceReplacedResponseSchema,
  shareUpdatedResponseSchema,
  sourceListResponseSchema,
  microphoneListResponseSchema,
  sourcePreviewResponseSchema,
  punchPreparedResponseSchema,
  punchCompleteResponseSchema,
  type NativeAdapter,
  type NativeClientEvent,
  type NativeHealth,
  type NativeCaptureTarget,
  type NativeIceCandidate,
  type NativeVideoCodec,
  type RemoteStopShortcut,
} from "./wire";

const REQUEST_TIMEOUT_MS = 8_000;

interface NativeDiscoveryOptions {
  waitForPermission?: boolean;
  signal?: AbortSignal;
}

export function isLoopbackPage(): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
}

async function ungrantedLocalPermission(): Promise<PermissionState | null> {
  // App Local already runs on loopback. Its permission can say "prompt" even
  // though loopback-to-loopback requests do not need consent.
  if (isLoopbackPage()) return null;
  for (const name of ["loopback-network", "local-network-access"]) {
    try {
      const { state } = await navigator.permissions.query({ name: name as PermissionName });
      return state === "granted" ? null : state;
    } catch {
      // Older Chromium uses the combined name; other browsers may expose neither.
    }
  }
  return null;
}

interface PendingRequest<T = unknown> {
  operation: string;
  schema: z.ZodType<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: number | null;
}

export interface NativeShareInput {
  shareId: string;
  source: NativeCaptureTarget;
  audio: boolean;
  excludeAudio?: NativeCaptureTarget;
  showCaptureBorder?: boolean;
  adapterIndex: number;
  encoderIndex: number;
  edgeCapacity: number;
  profile: QualitySettings;
  codec: NativeVideoCodec | "auto";
}

export class NativeCompatibilityError extends Error {
  constructor(readonly actualProtocol: number) {
    super(`Piik App control protocol ${actualProtocol} is incompatible with ${NATIVE_CLIENT_PROTOCOL}`);
    this.name = "NativeCompatibilityError";
  }
}

/** The control boundary knows the failed operation, not the driver's cause. */
export class NativeRequestError extends Error {
  constructor(
    readonly reason: "unavailable" | "timeout" | "send-failed" | "rejected" | "invalid-response" | "disconnected",
    readonly operation: string,
    options?: ErrorOptions,
  ) {
    super({
      unavailable: "Piik App is unavailable",
      timeout: "Piik App request timed out",
      "send-failed": "Piik App request failed",
      rejected: "Piik App request failed",
      "invalid-response": "Piik App response is invalid",
      disconnected: "Piik App disconnected",
    }[reason], options);
    this.name = "NativeRequestError";
  }
}

export async function discoverNativeHealth(
  options: NativeDiscoveryOptions = {},
): Promise<NativeHealth | null> {
  const health = await discoverNative("health", body => nativeHealthSchema.parse(body), options);
  if (health) debugEvent("native", "discovered", { capabilities: health.nativeMedia });
  return health;
}

/** A local approval address is not permission to use native media. */
export async function discoverNativeConnect(signal?: AbortSignal): Promise<string | null> {
  return discoverNative("connect-discovery", body => {
    const { connectURL } = nativeConnectSchema.parse(body);
    const url = new URL(connectURL);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
        url.username || url.password || url.pathname !== "/client" || url.search || url.hash) {
      throw new Error("Invalid local App approval address");
    }
    url.searchParams.set("site", window.location.origin);
    return url.toString();
  }, { signal });
}

async function discoverNative<T>(
  path: "health" | "connect-discovery", read: (body: unknown) => T,
  { waitForPermission = true, signal }: NativeDiscoveryOptions,
): Promise<T | null> {
  if (signal?.aborted) return null;
  if (!waitForPermission) {
    const permission = await ungrantedLocalPermission();
    if (permission) {
      debugEvent("native", "unavailable", { stage: "permission", permission });
      return null;
    }
  }
  if (signal?.aborted) return null;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  // The first request may wait for browser permission. One shared deadline
  // bounds the scan; a silent port must not hide an App on another port.
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    // An explicit launch stays with its App even when another approved App is faster.
    const selectedPort = clientRuntimePort();
    const ports = selectedPort === null ? Array.from({
      length: NATIVE_CLIENT_PORT_END - NATIVE_CLIENT_PORT_START + 1,
    }, (_, index) => NATIVE_CLIENT_PORT_START + index) : [selectedPort];
    return await Promise.any(ports.map(async port => {
      const response = await fetch(`http://127.0.0.1:${port}/${path}`, {
        cache: "no-store",
        signal: controller.signal,
        ...(isLoopbackPage() ? {} : { targetAddressSpace: "loopback" }),
      } as RequestInit);
      if (!response.ok) throw new Error("Piik App discovery was not accepted");
      const body: unknown = await response.json();
      const identity = nativeDiscoveryIdentitySchema.safeParse(body);
      if (!identity.success || identity.data.port !== port) {
        throw new Error("Not a Piik App discovery response");
      }
      if (identity.data.protocol !== NATIVE_CLIENT_PROTOCOL) {
        throw new NativeCompatibilityError(identity.data.protocol);
      }
      return read(body);
    }));
  } catch (error) {
    const incompatible = error instanceof AggregateError
      ? error.errors.find((failure) => failure instanceof NativeCompatibilityError)
      : undefined;
    if (incompatible) {
      debugEvent("native", "incompatible", {
        expectedProtocol: NATIVE_CLIENT_PROTOCOL,
        actualProtocol: incompatible.actualProtocol,
      });
      throw incompatible;
    }
    // A failed fetch cannot distinguish an absent App from blocked local access.
    debugEvent("native", "unavailable", { stage: "discovery", timedOut: controller.signal.aborted });
    return null;
  } finally {
    signal?.removeEventListener("abort", abort);
    window.clearTimeout(timer);
    controller.abort();
  }
}

export async function notifyNativePresentation(
  language: "zh" | "en" | "vis",
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  const health = await discoverNativeHealth({ signal, waitForPermission: false });
  if (!health || signal.aborted) return;
  await fetch(`http://127.0.0.1:${health.port}/presentation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language }),
    signal,
    ...(isLoopbackPage() ? {} : { targetAddressSpace: "loopback" }),
  } as RequestInit);
}

export class NativeClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(event: NativeClientEvent) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;
  private audioVolumeUpdates = new Map<"set-microphone" | "set-share-volume", { shareId: string; volume: number; done: Promise<void> }>();

  private constructor(
    readonly health: NativeHealth,
    private readonly socket: WebSocket,
  ) {
    socket.addEventListener("message", (event) =>
      this.handleMessage(event.data),
    );
    socket.addEventListener("close", () => this.handleClose());
    socket.addEventListener("error", () => this.handleClose());
  }

  static async connect(options?: NativeDiscoveryOptions): Promise<NativeClient | null> {
    const signal = options?.signal;
    const health = await discoverNativeHealth(options);
    if (!health || signal?.aborted) return null;
    const socket = new WebSocket(`ws://127.0.0.1:${health.port}/control`, [
      `${NATIVE_CLIENT_SUBPROTOCOL}.${health.instanceToken}`,
    ]);
    const client = new NativeClient(health, socket);
    // Acquisition owns discovery, the WebSocket handshake and hello together.
    // Once returned, the caller owns the live client independently of this signal.
    const abort = () => client.close();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const opened = await new Promise<boolean>((resolveOpen) => {
        const finish = (value: boolean) => {
          window.clearTimeout(timer);
          socket.removeEventListener("open", onOpen);
          socket.removeEventListener("error", fail);
          socket.removeEventListener("close", fail);
          signal?.removeEventListener("abort", fail);
          resolveOpen(value);
        };
        const onOpen = () => finish(socket.protocol === `${NATIVE_CLIENT_SUBPROTOCOL}.${health.instanceToken}`);
        const fail = () => finish(false);
        const timer = window.setTimeout(fail, REQUEST_TIMEOUT_MS);
        socket.addEventListener("open", onOpen);
        socket.addEventListener("error", fail);
        socket.addEventListener("close", fail);
        signal?.addEventListener("abort", fail, { once: true });
      });
      if (!opened || client.closed || signal?.aborted) {
        if (!signal?.aborted) debugEvent("native", "unavailable", { stage: "control" });
        client.close();
        return null;
      }
      await client.request("hello", {}, readyResponseSchema);
      if (client.closed || signal?.aborted) { client.close(); return null; }
      debugEvent("native", "connected");
      return client;
    } catch {
      client.close();
      return null;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  onEvent(listener: (event: NativeClientEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    if (this.closed) {
      listener();
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async ping(): Promise<void> {
    await this.request("ping", {}, pongResponseSchema);
  }

  async captureOptions(): Promise<NativeAdapter[]> {
    const response = await this.request(
      "capture-options",
      {},
      captureOptionsResponseSchema,
    );
    return response.adapters;
  }

  async sources(): Promise<NativeCaptureTarget[]> {
    const response = await this.request(
      "list-sources",
      {},
      sourceListResponseSchema,
    );
    return response.sources;
  }

  async sourcePreview(target: NativeCaptureTarget): Promise<string | null> {
    const response = await this.request(
      "source-preview",
      { source: target },
      sourcePreviewResponseSchema,
    );
    if (response.sourceKey !== nativeCaptureTargetKey(target)) {
      throw new Error("Native capture preview identity changed");
    }
    return response.data
      ? `data:${response.mime};base64,${response.data}`
      : null;
  }

  async startShare(
    input: NativeShareInput,
    onRequested?: () => void,
  ): Promise<{ audio: boolean; codec: NativeVideoCodec; sourceAudio?: boolean }> {
    // Older Apps reject unknown command fields.
    const { showCaptureBorder = false, excludeAudio, ...shareInput } = input;
    this.validateAudioExclusion(excludeAudio);
    const response = await this.request(
      "start-share",
      {
        ...shareInput,
        ...(excludeAudio ? { excludeAudio } : {}),
        // Keep a stable output for source-audio toggles during sharing.
        ...(this.health.nativeMedia.microphone || this.health.nativeMedia.shareVolume ? { microphoneMixing: true } : {}),
        ...(this.health.nativeMedia.remoteInput ? { remoteInput: true } : {}),
        ...(this.health.nativeMedia.captureBorderControl ? { showCaptureBorder } : {}),
        ...(this.health.nativeMedia.sourceCancellation ? { reportSourceCancellation: true } : {}),
        ...(this.health.nativeMedia.captureFailureDetails ? { reportCaptureFailure: true } : {}),
      },
      shareStartedResponseSchema,
      input.source.kind === "picker" ? null : REQUEST_TIMEOUT_MS,
      onRequested,
    );
    if (response.shareId !== input.shareId) {
      throw new Error("Native share identity changed");
    }
    return { audio: response.audio, codec: response.codec, sourceAudio: response.sourceAudio };
  }

  async updateShare(shareId: string, profile: QualitySettings): Promise<void> {
    const response = await this.request(
      "update-share",
      { shareId, profile },
      shareUpdatedResponseSchema,
      null,
    );
    if (response.shareId !== shareId) {
      throw new Error("Native share identity changed");
    }
  }

  private validateAudioExclusion(target: NativeCaptureTarget | undefined): void {
    if (target && !this.health.nativeMedia.processAudioExclusion) {
      throw new Error("Piik App does not support audio exclusion");
    }
  }

  async replaceShareSource(
    shareId: string,
    source: NativeCaptureTarget,
    audio: boolean,
    path: NativeCapturePath,
    showCaptureBorder = false,
    excludeAudio?: NativeCaptureTarget,
  ): Promise<void> {
    this.validateAudioExclusion(excludeAudio);
    const response = await this.request(
      "replace-share-source",
      {
        shareId,
        source,
        audio,
        ...(excludeAudio ? { excludeAudio } : {}),
        adapterIndex: path.adapterIndex,
        encoderIndex: path.encoderIndex,
        ...(this.health.nativeMedia.captureBorderControl ? { showCaptureBorder } : {}),
        ...(this.health.nativeMedia.sourceCancellation ? { reportSourceCancellation: true } : {}),
      },
      shareSourceReplacedResponseSchema,
      source.kind === "picker" ? null : REQUEST_TIMEOUT_MS,
    );
    if (response.shareId !== shareId) {
      throw new Error("Native share identity changed");
    }
  }

  async prepareEdge(
    shareId: string,
    connectionId: string,
    iceConfig: IceConfig,
    sourceConnectionId?: string,
    punched = false,
  ): Promise<RTCSessionDescriptionInit> {
    const response = await this.request(
      "prepare-edge",
      {
        shareId,
        connectionId,
        ...(punched ? { punched: true } : {}),
        ...(sourceConnectionId ? { sourceConnectionId } : {}),
        iceServers: iceConfig.iceServers.map((server) => ({
          urls: Array.isArray(server.urls) ? server.urls : [server.urls],
        })),
      },
      edgeOfferResponseSchema,
    );
    if (
      response.shareId !== shareId ||
      response.connectionId !== connectionId
    ) {
      throw new Error("Native edge identity changed");
    }
    return { type: "offer", sdp: response.sdp };
  }

  async preparePunch(shareId: string, connectionId: string, iceConfig: IceConfig,
    secret: string, edgeCapacity?: number, sourceConnectionId?: string): Promise<PunchPrediction | null> {
    const response = await this.request("prepare-punch", {
      shareId, connectionId, secret,
      ...(edgeCapacity !== undefined ? { edgeCapacity } : {}),
      ...(sourceConnectionId ? { sourceConnectionId } : {}),
      iceServers: iceConfig.iceServers.map(server => ({ urls: Array.isArray(server.urls) ? server.urls : [server.urls] })),
    }, punchPreparedResponseSchema);
    return response.prediction;
  }

  async runPunch(shareId: string, connectionId: string, prediction: PunchPrediction): Promise<boolean> {
    return (await this.request("run-punch", { shareId, connectionId, prediction }, punchCompleteResponseSchema)).connected;
  }

  async closePunch(shareId: string, connectionId: string): Promise<void> {
    await this.request("close-punch", { shareId, connectionId }, nativeAckResponseSchema);
  }

  async preparePublication(
    shareId: string,
    publicationGeneration: string,
    connectionId: string,
    iceConfig: IceConfig,
  ) {
    const response = await this.request(
      "prepare-publication",
      {
        shareId,
        publicationGeneration,
        connectionId,
        iceServers: iceConfig.iceServers.map((server) => ({
          urls: Array.isArray(server.urls) ? server.urls : [server.urls],
        })),
      },
      publicationResponseSchema,
    );
    if (
      response.type !== "publication-offer" ||
      !response.sdp ||
      response.shareId !== shareId ||
      response.publicationGeneration !== publicationGeneration ||
      response.connectionId !== connectionId
    ) {
      throw new Error("Native publication identity changed");
    }
    return {
      description: { type: "offer" as const, sdp: response.sdp },
      media: response.media,
    };
  }

  async publicationMedia(
    shareId: string,
    publicationGeneration: string,
    connectionId: string,
  ) {
    const response = await this.request(
      "publication-media",
      {
        shareId,
        publicationGeneration,
        connectionId,
      },
      publicationResponseSchema,
    );
    if (
      response.type !== "publication-media" ||
      response.shareId !== shareId ||
      response.publicationGeneration !== publicationGeneration ||
      response.connectionId !== connectionId
    ) {
      throw new Error("Native publication identity changed");
    }
    return response.media;
  }

  async acceptPublicationSignal(
    shareId: string,
    message: SfuSignalMessage,
  ): Promise<void> {
    const identity = {
      shareId,
      publicationGeneration: message.publicationGeneration,
      connectionId: message.connectionId,
    };
    if (
      message.kind === "description" &&
      message.description?.type === "answer"
    ) {
      await this.request(
        "publication-answer",
        { ...identity, sdp: message.description.sdp },
        nativeAckResponseSchema,
      );
    } else if (message.kind === "candidate") {
      await this.request(
        "publication-candidate",
        { ...identity, candidate: message.candidate ?? null },
        nativeAckResponseSchema,
      );
    } else if (message.kind === "layers") {
      await this.request(
        "publication-layers",
        { ...identity, activeCount: message.activeCount },
        nativeAckResponseSchema,
      );
    }
  }

  async closePublication(
    shareId: string,
    publicationGeneration: string,
    connectionId: string,
  ): Promise<void> {
    await this.request(
      "close-publication",
      { shareId, publicationGeneration, connectionId },
      nativeAckResponseSchema,
    );
  }

  async prepareLocalEdge(
    shareId: string,
    connectionId: string,
    sourceConnectionId?: string,
    restart = false,
  ): Promise<RTCSessionDescriptionInit & { offerId: string }> {
    const response = await this.request(
      "prepare-local-edge",
      {
        shareId,
        connectionId,
        restart,
        ...(sourceConnectionId ? { sourceConnectionId } : {}),
      },
      edgeOfferResponseSchema,
    );
    if (
      response.shareId !== shareId ||
      response.connectionId !== connectionId
    ) {
      throw new Error("Native local edge identity changed");
    }
    return { type: "offer", sdp: response.sdp, offerId: response.id };
  }

  async receiveOffer(
    shareId: string,
    connectionId: string,
    offer: RTCSessionDescriptionInit,
    iceConfig: IceConfig,
    edgeCapacity: number,
    punched = false,
  ): Promise<{
    answer: { type: "answer"; sdp: string };
    audio: boolean;
    codec: NativeVideoCodec;
    reused: boolean;
  }> {
    if (offer.type !== "offer" || !offer.sdp) {
      throw new Error("Native receiver requires an SDP offer");
    }
    const response = await this.request(
      "receive-offer",
      {
        shareId,
        connectionId,
        ...(this.health.nativeMedia.receiverReuse ? { reuseReceiver: true } : {}),
        edgeCapacity,
        ...(punched ? { punched: true } : {}),
        iceServers: iceConfig.iceServers.map((server) => ({
          urls: Array.isArray(server.urls) ? server.urls : [server.urls],
        })),
        sdp: offer.sdp,
      },
      receiveAnswerResponseSchema,
    );
    if (
      response.shareId !== shareId ||
      response.connectionId !== connectionId
    ) {
      throw new Error("Native receiver identity changed");
    }
    return {
      answer: { type: "answer", sdp: response.sdp },
      audio: response.audio,
      codec: response.codec,
      reused: response.reused === true,
    };
  }

  async addReceiveCandidate(
    shareId: string,
    connectionId: string,
    candidate: NativeIceCandidate | null,
  ): Promise<void> {
    await this.request(
      "receive-candidate",
      { shareId, connectionId, candidate },
      nativeAckResponseSchema,
    );
  }

  async closeReceiver(shareId: string, connectionId: string): Promise<void> {
    await this.request(
      "close-receiver",
      { shareId, connectionId },
      nativeAckResponseSchema,
    );
  }

  async stopReceive(shareId: string): Promise<void> {
    await this.request("stop-receive", { shareId }, nativeAckResponseSchema);
  }

  async acceptSignal(
    shareId: string,
    connectionId: string,
    payload: SignalPayload,
    offerId?: string,
  ): Promise<void> {
    if (payload.connectionId !== connectionId || payload.kind === "punch") return;
    if (payload.kind === "description") {
      if (payload.description.type !== "answer") return;
      await this.request(
        "edge-answer",
        { shareId, connectionId, sdp: payload.description.sdp, ...(offerId ? { offerId } : {}) },
        nativeAckResponseSchema,
      );
      return;
    }
    await this.request(
      "edge-candidate",
      { shareId, connectionId, candidate: payload.candidate },
      nativeAckResponseSchema,
    );
  }

  async closeEdge(shareId: string, connectionId: string): Promise<void> {
    await this.request(
      "close-edge",
      { shareId, connectionId },
      nativeAckResponseSchema,
    );
  }

  async microphones(): Promise<{ id: string; label: string }[]> {
    if (!this.health.nativeMedia.microphone) throw new Error("Piik App microphone is unavailable");
    return (await this.request("list-microphones", {}, microphoneListResponseSchema)).devices;
  }

  async setMicrophone(shareId: string, enabled: boolean, volume: number, deviceId = ""): Promise<void> {
    if (!this.health.nativeMedia.microphone) throw new Error("Piik App microphone is unavailable");
    await this.request("set-microphone", { shareId, enabled, volume, deviceId }, nativeAckResponseSchema, null);
  }

  // Dragging keeps at most one request in flight and one latest value. It cannot
  // queue dozens of slider events ahead of Stop or reopen a lost microphone.
  setMicrophoneVolume(shareId: string, volume: number): Promise<void> {
    if (!this.health.nativeMedia.microphone) return Promise.reject(new Error("Piik App microphone is unavailable"));
    return this.setAudioVolume("set-microphone", shareId, volume);
  }

  setShareVolume(shareId: string, volume: number): Promise<void> {
    if (!this.health.nativeMedia.shareVolume) return Promise.reject(new Error("Piik App share volume is unavailable"));
    return this.setAudioVolume("set-share-volume", shareId, volume);
  }

  private setAudioVolume(type: "set-microphone" | "set-share-volume", shareId: string, volume: number): Promise<void> {
    const active = this.audioVolumeUpdates.get(type);
    if (active?.shareId === shareId) { active.volume = volume; return active.done; }
    const update = { shareId, volume, done: Promise.resolve() };
    this.audioVolumeUpdates.set(type, update);
    update.done = (async () => {
      do {
        const sent = update.volume;
        await this.request(type, { shareId, volume: sent }, nativeAckResponseSchema);
        if (sent === update.volume) break;
      } while (this.audioVolumeUpdates.get(type) === update && !this.closed);
    })().finally(() => { if (this.audioVolumeUpdates.get(type) === update) this.audioVolumeUpdates.delete(type); });
    return update.done;
  }

  async setRemoteControl(shareId: string, requestId: string, allow: boolean): Promise<void> {
    await this.request("set-remote-control", { shareId, requestId, allow }, nativeAckResponseSchema);
  }

  async setRemoteControlPolicy(shareId: string, mode: RemoteControlMode, password?: string): Promise<void> {
    await this.request("set-remote-control-policy", { shareId, mode, ...(password !== undefined ? { password } : {}),
      ...(this.health.nativeMedia.remoteCoPlay ? { coPlay: true } : {}) }, nativeAckResponseSchema, null);
  }

  async remoteStopShortcut(shareId: string, key?: number): Promise<RemoteStopShortcut> {
    if (!this.health.nativeMedia.remoteStopShortcut) throw new Error("Piik App shortcut settings are unavailable");
    return this.request(key === undefined ? "get-remote-stop-shortcut" : "set-remote-stop-shortcut",
      { shareId, ...(key === undefined ? {} : { key }) }, remoteStopShortcutResponseSchema);
  }

  async setRemoteInputPeers(shareId: string, peers: { peerId: string; endpointId: string; secret: string }[]): Promise<void> {
    await this.request("set-remote-input-peers", { shareId, peers }, nativeAckResponseSchema);
  }

  async setRemoteControlSimultaneous(shareId: string, enabled: boolean): Promise<void> {
    await this.request("set-remote-control-simultaneous", { shareId, enabled }, nativeAckResponseSchema);
  }

  async stopShare(shareId: string): Promise<void> {
    for (const [type, update] of this.audioVolumeUpdates) if (update.shareId === shareId) this.audioVolumeUpdates.delete(type);
    await this.request("stop-share", { shareId }, nativeAckResponseSchema);
  }

  async setPaused(shareId: string, paused: boolean): Promise<void> {
    await this.request(
      "pause-share",
      { shareId, paused },
      nativeAckResponseSchema,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.audioVolumeUpdates.clear();
    this.rejectPending();
    this.listeners.clear();
    this.closeListeners.clear();
    if (this.socket.readyState < WebSocket.CLOSING) {
      this.socket.close(1000, "page closed");
    }
  }

  private request<T>(
    type: string,
    fields: object,
    schema: z.ZodType<T>,
    timeoutMs: number | null = REQUEST_TIMEOUT_MS,
    onRequested?: () => void,
  ): Promise<T> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new NativeRequestError("unavailable", type));
    }
    const id = createOpaqueId();
    const began = performance.now();
    const details = { type, requestId: id };
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const timer =
        timeoutMs === null
          ? null
          : window.setTimeout(() => {
              this.pending.delete(id);
              debugEvent("native", "request-timeout", { ...details, durationMs: performance.now() - began });
              rejectRequest(new NativeRequestError("timeout", type));
            }, timeoutMs);
      this.pending.set(id, {
        operation: type,
        schema,
        resolve: (value) => {
          debugEvent("native", "response", { ...details, durationMs: performance.now() - began, applied: value });
          resolveRequest(value as T);
        },
        reject: (error) => {
          debugError("native", "request-failed", error, { ...details, durationMs: performance.now() - began });
          rejectRequest(error);
        },
        timer,
      });
      try {
        debugEvent("native", "request", { ...details, requested: fields, timeoutMs });
        this.socket.send(
          JSON.stringify({
            version: NATIVE_CLIENT_PROTOCOL,
            id,
            type,
            ...fields,
          }),
        );
      } catch (error) {
        if (timer !== null) window.clearTimeout(timer);
        this.pending.delete(id);
        debugError("native", "request-failed", error, { ...details, durationMs: performance.now() - began });
        rejectRequest(new NativeRequestError("send-failed", type, { cause: error }));
        return;
      }
      onRequested?.();
    });
  }

  private handleMessage(raw: unknown): void {
    let value: unknown;
    try {
      value = JSON.parse(String(raw));
    } catch {
      debugEvent("native", "protocol-failed", { stage: "json-invalid" });
      this.failConnection();
      return;
    }
    const id = requestId(value);
    if (id) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (pending.timer !== null) window.clearTimeout(pending.timer);
      const failure = requestFailedResponseSchema.safeParse(value);
      if (failure.success) {
        if (failure.data.code === "source-canceled") {
          pending.reject(new DOMException("Source selection canceled", "NotAllowedError"));
          return;
        }
        pending.reject(new NativeRequestError("rejected", pending.operation, { cause: { code: failure.data.code } }));
        return;
      }
      const parsed = pending.schema.safeParse(value);
      if (parsed.success) {
        pending.resolve(parsed.data);
      } else {
        pending.reject(new NativeRequestError("invalid-response", pending.operation, { cause: parsed.error }));
      }
      return;
    }
    const event = nativeEventSchema.safeParse(value);
    if (!event.success) {
      // A rejected observation has no control authority. Drop it without
      // retiring healthy media; its identity/state must still pass to be used.
      if (value && typeof value === "object" && "type" in value &&
        (value.type === "edge-quality" || value.type === "publication-quality")) {
        debugError("native", "quality-sample-invalid", event.error);
        return;
      }
      debugError("native", "protocol-failed", event.error, { stage: "event-invalid" });
      this.failConnection();
      return;
    }
    debugEvent("native", "event", event.data);
    for (const listener of this.listeners) {
      listener(event.data);
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    debugEvent("native", "closed");
    this.closed = true;
    this.rejectPending();
    this.listeners.clear();
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    for (const listener of listeners) listener();
  }

  private failConnection(): void {
    if (this.socket.readyState < WebSocket.CLOSING) {
      this.socket.close(1008, "invalid Client message");
    }
    this.handleClose();
  }

  private rejectPending(): void {
    for (const request of this.pending.values()) {
      if (request.timer !== null) window.clearTimeout(request.timer);
      request.reject(new NativeRequestError("disconnected", request.operation));
    }
    this.pending.clear();
  }
}

function requestId(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("id" in value)) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}
