import type { z } from "zod";

import type { IceConfig, SignalPayload } from "../../shared/protocol";
import { createOpaqueId } from "../lib/opaque-id";
import { nativeCaptureTargetKey } from "./capture-selection";
import {
  captureOptionsResponseSchema,
  edgeOfferResponseSchema,
  nativeAckResponseSchema,
  nativeEventSchema,
  nativeHealthSchema,
  NATIVE_CLIENT_PORT_END,
  NATIVE_CLIENT_PORT_START,
  NATIVE_CLIENT_PROTOCOL,
  NATIVE_CLIENT_SUBPROTOCOL,
  pongResponseSchema,
  readyResponseSchema,
  shareStartedResponseSchema,
  sourceListResponseSchema,
  sourcePreviewResponseSchema,
  type NativeAdapter,
  type NativeClientEvent,
  type NativeHealth,
  type NativeCaptureTarget,
} from "./wire";

const DISCOVERY_TIMEOUT_MS = 400;
const REQUEST_TIMEOUT_MS = 8_000;

interface PendingRequest<T = unknown> {
  schema: z.ZodType<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: number;
}

export interface NativeShareInput {
  shareId: string;
  source: NativeCaptureTarget;
  audio: boolean;
  adapterIndex: number;
  encoderIndex: number;
  edgeCapacity: number;
}

export async function discoverNativeHealth(): Promise<NativeHealth | null> {
  for (
    let port = NATIVE_CLIENT_PORT_START;
    port <= NATIVE_CLIENT_PORT_END;
    port += 1
  ) {
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => controller.abort(),
      DISCOVERY_TIMEOUT_MS,
    );
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        cache: "no-store",
        signal: controller.signal,
        targetAddressSpace: "loopback",
      } as RequestInit);
      if (!response.ok) continue;
      const parsed = nativeHealthSchema.safeParse(await response.json());
      if (parsed.success && parsed.data.port === port) {
        return parsed.data;
      }
    } catch {
      // An absent Client and a denied local-network permission are both
      // ordinary Browser-only operation.
    } finally {
      window.clearTimeout(timer);
    }
  }
  return null;
}

export class NativeClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(event: NativeClientEvent) => void>();
  private closed = false;

  private constructor(
    readonly health: NativeHealth,
    private readonly socket: WebSocket,
  ) {
    socket.addEventListener("message", (event) => this.handleMessage(event.data));
    socket.addEventListener("close", () => this.handleClose());
    socket.addEventListener("error", () => this.handleClose());
  }

  static async connect(): Promise<NativeClient | null> {
    const health = await discoverNativeHealth();
    if (!health) return null;
    const socket = new WebSocket(
      `ws://127.0.0.1:${health.port}/control`,
      [`${NATIVE_CLIENT_SUBPROTOCOL}.${health.instanceToken}`],
    );
    const opened = await new Promise<boolean>((resolveOpen) => {
      const timer = window.setTimeout(() => resolveOpen(false), REQUEST_TIMEOUT_MS);
      socket.addEventListener("open", () => {
        window.clearTimeout(timer);
        resolveOpen(socket.protocol === `${NATIVE_CLIENT_SUBPROTOCOL}.${health.instanceToken}`);
      }, { once: true });
      socket.addEventListener("error", () => {
        window.clearTimeout(timer);
        resolveOpen(false);
      }, { once: true });
    });
    if (!opened) {
      socket.close();
      return null;
    }
    const client = new NativeClient(health, socket);
    try {
      await client.request("hello", {}, readyResponseSchema);
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
    return response.data ? `data:${response.mime};base64,${response.data}` : null;
  }

  async startShare(input: NativeShareInput): Promise<{ audio: boolean }> {
    const response = await this.request("start-share", input, shareStartedResponseSchema);
    if (response.shareId !== input.shareId) {
      throw new Error("Native share identity changed");
    }
    return { audio: response.audio };
  }

  async prepareEdge(
    shareId: string,
    connectionId: string,
    iceConfig: IceConfig,
  ): Promise<RTCSessionDescriptionInit> {
    const response = await this.request(
      "prepare-edge",
      {
        shareId,
        connectionId,
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

  async prepareLocalEdge(
    shareId: string,
    connectionId: string,
  ): Promise<RTCSessionDescriptionInit> {
    const response = await this.request(
      "prepare-local-edge",
      { shareId, connectionId },
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

  async stopShare(shareId: string): Promise<void> {
    await this.request(
      "stop-share",
      { shareId },
      nativeAckResponseSchema,
    );
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
    this.rejectPending();
    this.listeners.clear();
    if (this.socket.readyState < WebSocket.CLOSING) {
      this.socket.close(1000, "page closed");
    }
  }

  private request<T>(
    type: string,
    fields: object,
    schema: z.ZodType<T>,
  ): Promise<T> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Screener Client is unavailable"));
    }
    const id = createOpaqueId();
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error("Screener Client request timed out"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        schema,
        resolve: resolveRequest as (value: unknown) => void,
        reject: rejectRequest,
        timer,
      });
      try {
        this.socket.send(JSON.stringify({
          version: NATIVE_CLIENT_PROTOCOL,
          id,
          type,
          ...fields,
        }));
      } catch {
        window.clearTimeout(timer);
        this.pending.delete(id);
        rejectRequest(new Error("Screener Client request failed"));
      }
    });
  }

  private handleMessage(raw: unknown): void {
    let value: unknown;
    try {
      value = JSON.parse(String(raw));
    } catch {
      this.failConnection();
      return;
    }
    const id = requestId(value);
    if (id) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      window.clearTimeout(pending.timer);
      const parsed = pending.schema.safeParse(value);
      if (parsed.success) {
        pending.resolve(parsed.data);
      } else {
        pending.reject(new Error("Screener Client response is invalid"));
      }
      return;
    }
    const event = nativeEventSchema.safeParse(value);
    if (!event.success) {
      this.failConnection();
      return;
    }
    for (const listener of this.listeners) {
      listener(event.data);
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending();
    this.listeners.clear();
  }

  private failConnection(): void {
    if (this.socket.readyState < WebSocket.CLOSING) {
      this.socket.close(1008, "invalid Client message");
    }
    this.handleClose();
  }

  private rejectPending(): void {
    for (const request of this.pending.values()) {
      window.clearTimeout(request.timer);
      request.reject(new Error("Screener Client disconnected"));
    }
    this.pending.clear();
  }
}

function requestId(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("id" in value)) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}
