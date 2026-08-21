import { describe, expect, it, vi } from "vitest";

import { runConnectionSelfCheck } from "../src/client/media/connection-self-check.ts";

type Listener = (event: unknown) => void;

class FakeSocket {
  private readonly listeners = new Map<string, Listener[]>();
  readonly close = vi.fn();

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: "open" | "error"): void {
    this.listeners.get(type)?.forEach((listener) => listener({}));
  }
}

class FakePeer {
  iceGatheringState: RTCIceGatheringState = "gathering";
  private readonly listeners = new Map<string, Listener[]>();
  readonly close = vi.fn();
  readonly createDataChannel = vi.fn();
  readonly createOffer = vi.fn(async () => ({ type: "offer", sdp: "test" }));

  constructor(
    private readonly candidateType: RTCIceCandidateType | null,
    private readonly completes = true,
  ) {}

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  async setLocalDescription(): Promise<void> {
    if (this.candidateType) {
      this.listeners.get("icecandidate")?.forEach((listener) =>
        listener({ candidate: { type: this.candidateType } }),
      );
    }
    if (this.completes) {
      this.iceGatheringState = "complete";
      this.listeners
        .get("icegatheringstatechange")
        ?.forEach((listener) => listener({}));
    }
  }
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("connection self-check", () => {
  it("passes only a gathered srflx candidate and keeps SFU/UDP unknown", async () => {
    const socket = new FakeSocket();
    const peer = new FakePeer("srflx");
    const socketFactory = vi.fn((url: string) => {
      void url;
      queueMicrotask(() => socket.emit("open"));
      return socket as unknown as WebSocket;
    });
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/healthz"
        ? response({ status: "ok" })
        : response({
            iceConfig: {
              iceServers: [{ urls: ["stun:stun.example.test:3478"] }],
            },
            sfuConfigured: true,
          }),
    ) as unknown as typeof fetch;

    const result = await runConnectionSelfCheck({
      baseUrl: "https://share.example.test/",
      fetcher,
      socketFactory,
      peerFactory: () => peer as unknown as RTCPeerConnection,
      timeoutMs: 50,
    });

    expect(socketFactory).toHaveBeenCalledWith("wss://share.example.test/signal");
    expect(result).toEqual({
      site: { status: "passed", detail: "站点健康" },
      signaling: { status: "passed", detail: "WSS 可达" },
      stun: { status: "passed", detail: "已获得 srflx 候选" },
      sfu: { status: "unknown", detail: "已配置，需实际路由验证" },
    });
    expect(peer.close).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledWith(1000, "self-check");
  });

  it("does not treat host gathering or SFU configuration absence as success", async () => {
    const socket = new FakeSocket();
    const peer = new FakePeer("host");
    const result = await runConnectionSelfCheck({
      baseUrl: "http://localhost:5173/",
      fetcher: (async (input: RequestInfo | URL) =>
        String(input) === "/healthz"
          ? response({ status: "ok" })
          : response({
              iceConfig: { iceServers: [{ urls: "stun:localhost:3478" }] },
              sfuConfigured: false,
            })) as typeof fetch,
      socketFactory: () => {
        queueMicrotask(() => socket.emit("error"));
        return socket as unknown as WebSocket;
      },
      peerFactory: () => peer as unknown as RTCPeerConnection,
      timeoutMs: 50,
    });

    expect(result.signaling.status).toBe("failed");
    expect(result.stun).toEqual({
      status: "failed",
      detail: "未获得 STUN 候选",
    });
    expect(result.sfu).toEqual({ status: "unknown", detail: "当前未配置" });
  });

  it("closes a temporary peer connection when STUN gathering times out", async () => {
    const socket = new FakeSocket();
    const peer = new FakePeer(null, false);
    const result = await runConnectionSelfCheck({
      baseUrl: "https://share.example.test/",
      fetcher: (async (input: RequestInfo | URL) =>
        String(input) === "/healthz"
          ? response({ status: "ok" })
          : response({
              iceConfig: { iceServers: [{ urls: "stun:localhost:3478" }] },
              sfuConfigured: true,
            })) as typeof fetch,
      socketFactory: () => {
        queueMicrotask(() => socket.emit("open"));
        return socket as unknown as WebSocket;
      },
      peerFactory: () => peer as unknown as RTCPeerConnection,
      timeoutMs: 100,
    });

    expect(result.stun).toEqual({
      status: "failed",
      detail: "未获得 STUN 候选",
    });
    expect(peer.close).toHaveBeenCalledOnce();
  });

  it("closes WSS and skips STUN when the caller unmounts as config settles", async () => {
    const controller = new AbortController();
    const socket = new FakeSocket();
    const peerFactory = vi.fn();
    const socketFactory = vi.fn(() => socket as unknown as WebSocket);
    let resolveConfig!: (value: unknown) => void;
    const config = new Promise<unknown>((resolve) => {
      resolveConfig = resolve;
    });
    const fetcher = (async (input: RequestInfo | URL) =>
      String(input) === "/healthz"
        ? response({ status: "ok" })
        : ({ ok: true, json: () => config }) as Response) as typeof fetch;

    const pending = runConnectionSelfCheck({
      baseUrl: "https://share.example.test/",
      fetcher,
      signal: controller.signal,
      socketFactory,
      peerFactory,
      timeoutMs: 1_000,
    });
    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledOnce());
    resolveConfig({
      iceConfig: { iceServers: [{ urls: "stun:localhost:3478" }] },
      sfuConfigured: true,
    });
    controller.abort();

    const result = await pending;
    expect(socket.close).toHaveBeenCalledWith(1000, "self-check");
    expect(peerFactory).not.toHaveBeenCalled();
    expect(result.stun.detail).toBe("自检已取消");
  });

  it("immediately closes an active STUN peer when the caller cancels", async () => {
    const controller = new AbortController();
    const socket = new FakeSocket();
    const peer = new FakePeer(null, false);
    const peerFactory = vi.fn(() => peer as unknown as RTCPeerConnection);
    const pending = runConnectionSelfCheck({
      baseUrl: "https://share.example.test/",
      fetcher: (async (input: RequestInfo | URL) =>
        String(input) === "/healthz"
          ? response({ status: "ok" })
          : response({
              iceConfig: { iceServers: [{ urls: "stun:localhost:3478" }] },
              sfuConfigured: true,
            })) as typeof fetch,
      signal: controller.signal,
      socketFactory: () => {
        queueMicrotask(() => socket.emit("open"));
        return socket as unknown as WebSocket;
      },
      peerFactory,
      timeoutMs: 1_000,
    });
    await vi.waitFor(() => expect(peerFactory).toHaveBeenCalledOnce());
    controller.abort();

    const result = await pending;
    expect(peer.close).toHaveBeenCalledOnce();
    expect(result.stun.detail).toBe("自检已取消");
  });
});
