import type { z } from "zod";
import { debugError, debugEvent } from "../lib/debug";

import type {
  IceConfig,
  QualitySettings,
  SignalPayload,
  SfuSignalMessage,
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
  nativeEventSchema,
  nativeDiscoveryIdentitySchema,
  nativeHealthSchema,
  NATIVE_CLIENT_PORT_END,
  NATIVE_CLIENT_PORT_START,
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
  type NativeAdapter,
  type NativeClientEvent,
  type NativeHealth,
  type NativeCaptureTarget,
  type NativeIceCandidate,
  type NativeVideoCodec,
} from "./wire";

const REQUEST_TIMEOUT_MS = 8_000;

interface NativeDiscoveryOptions {
  waitForPermission?: boolean;
}

async function ungrantedLocalPermission(): Promise<PermissionState | null> {
  // App Local already runs on loopback. Its permission can say "prompt" even
  // though loopback-to-loopback requests do not need consent.
  if (["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)) return null;
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
  schema: z.ZodType<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: number | null;
}

export interface NativeShareInput {
  shareId: string;
  source: NativeCaptureTarget;
  audio: boolean;
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

export async function discoverNativeHealth(
  { waitForPermission = true }: NativeDiscoveryOptions = {},
): Promise<NativeHealth | null> {
  if (!waitForPermission) {
    const permission = await ungrantedLocalPermission();
    if (permission) {
      debugEvent("native", "unavailable", { stage: "permission", permission });
      return null;
    }
  }
  const controller = new AbortController();
  // The first request may wait for browser permission. One shared deadline
  // bounds the scan; a silent port must not hide an App on another port.
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await Promise.any(Array.from({
      length: NATIVE_CLIENT_PORT_END - NATIVE_CLIENT_PORT_START + 1,
    }, async (_, index) => {
      const port = NATIVE_CLIENT_PORT_START + index;
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        cache: "no-store",
        signal: controller.signal,
        targetAddressSpace: "loopback",
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
      const health = nativeHealthSchema.parse(body);
      debugEvent("native", "discovered", { capabilities: health.nativeMedia });
      return health;
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
    window.clearTimeout(timer);
    controller.abort();
  }
}

export async function notifyNativePresentation(
  language: "zh" | "en" | "vis",
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  const health = await discoverNativeHealth();
  if (!health || signal.aborted) return;
  await fetch(`http://127.0.0.1:${health.port}/presentation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language }),
    signal,
    targetAddressSpace: "loopback",
  } as RequestInit);
}

export class NativeClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(event: NativeClientEvent) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;
  private microphoneVolumeUpdate: { shareId: string; volume: number; done: Promise<void> } | null = null;

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
    const health = await discoverNativeHealth(options);
    if (!health) return null;
    const socket = new WebSocket(`ws://127.0.0.1:${health.port}/control`, [
      `${NATIVE_CLIENT_SUBPROTOCOL}.${health.instanceToken}`,
    ]);
    const opened = await new Promise<boolean>((resolveOpen) => {
      const timer = window.setTimeout(
        () => resolveOpen(false),
        REQUEST_TIMEOUT_MS,
      );
      socket.addEventListener(
        "open",
        () => {
          window.clearTimeout(timer);
          resolveOpen(
            socket.protocol ===
              `${NATIVE_CLIENT_SUBPROTOCOL}.${health.instanceToken}`,
          );
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          window.clearTimeout(timer);
          resolveOpen(false);
        },
        { once: true },
      );
    });
    if (!opened) {
      debugEvent("native", "unavailable", { stage: "control" });
      socket.close();
      return null;
    }
    const client = new NativeClient(health, socket);
    try {
      await client.request("hello", {}, readyResponseSchema);
      debugEvent("native", "connected");
      return client;
    } catch {
      client.close();
      return null;
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
  ): Promise<{ audio: boolean; codec: NativeVideoCodec; sourceAudio?: boolean }> {
    // Older Apps reject unknown command fields.
    const { showCaptureBorder = false, ...shareInput } = input;
    const response = await this.request(
      "start-share",
      {
        ...shareInput,
        ...(this.health.nativeMedia.microphone ? { microphoneMixing: true } : {}),
        ...(this.health.nativeMedia.captureBorderControl ? { showCaptureBorder } : {}),
      },
      shareStartedResponseSchema,
      input.source.kind === "picker" ? null : REQUEST_TIMEOUT_MS,
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

  async replaceShareSource(
    shareId: string,
    source: NativeCaptureTarget,
    audio: boolean,
    path: NativeCapturePath,
    showCaptureBorder = false,
  ): Promise<void> {
    const response = await this.request(
      "replace-share-source",
      {
        shareId,
        source,
        audio,
        adapterIndex: path.adapterIndex,
        encoderIndex: path.encoderIndex,
        ...(this.health.nativeMedia.captureBorderControl ? { showCaptureBorder } : {}),
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
  ): Promise<RTCSessionDescriptionInit> {
    const response = await this.request(
      "prepare-edge",
      {
        shareId,
        connectionId,
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
  ): Promise<RTCSessionDescriptionInit> {
    const response = await this.request(
      "prepare-local-edge",
      {
        shareId,
        connectionId,
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
    return { type: "offer", sdp: response.sdp };
  }

  async receiveOffer(
    shareId: string,
    connectionId: string,
    offer: RTCSessionDescriptionInit,
    iceConfig: IceConfig,
    edgeCapacity: number,
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
  ): Promise<void> {
    if (payload.connectionId !== connectionId) return;
    if (payload.kind === "description") {
      if (payload.description.type !== "answer") return;
      await this.request(
        "edge-answer",
        { shareId, connectionId, sdp: payload.description.sdp },
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
    const active = this.microphoneVolumeUpdate;
    if (active?.shareId === shareId) { active.volume = volume; return active.done; }
    const update = { shareId, volume, done: Promise.resolve() };
    this.microphoneVolumeUpdate = update;
    update.done = (async () => {
      do {
        const sent = update.volume;
        await this.request("set-microphone", { shareId, volume: sent }, nativeAckResponseSchema);
        if (sent === update.volume) break;
      } while (this.microphoneVolumeUpdate === update && !this.closed);
    })().finally(() => { if (this.microphoneVolumeUpdate === update) this.microphoneVolumeUpdate = null; });
    return update.done;
  }

  async stopShare(shareId: string): Promise<void> {
    if (this.microphoneVolumeUpdate?.shareId === shareId) this.microphoneVolumeUpdate = null;
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
    this.microphoneVolumeUpdate = null;
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
  ): Promise<T> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Piik App is unavailable"));
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
              rejectRequest(new Error("Piik App request timed out"));
            }, timeoutMs);
      this.pending.set(id, {
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
        rejectRequest(new Error("Piik App request failed"));
      }
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
        pending.reject(new Error("Piik App request failed", { cause: { code: failure.data.code } }));
        return;
      }
      const parsed = pending.schema.safeParse(value);
      if (parsed.success) {
        pending.resolve(parsed.data);
      } else {
        pending.reject(new Error("Piik App response is invalid", { cause: parsed.error }));
      }
      return;
    }
    const event = nativeEventSchema.safeParse(value);
    if (!event.success) {
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
      request.reject(new Error("Piik App disconnected"));
    }
    this.pending.clear();
  }
}

function requestId(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("id" in value)) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}
