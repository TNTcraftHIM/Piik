import { afterEach, describe, expect, it, vi } from "vitest";

import { discoverNativeHealth, NativeClient, NativeCompatibilityError, notifyNativePresentation } from "../src/client/native/client";
import { DEFAULT_QUALITY_SETTINGS } from "../src/shared/protocol";

import {
  nativeEventSchema,
  nativeHealthSchema,
  NATIVE_CLIENT_PROTOCOL,
  NATIVE_CLIENT_PORT_START,
  NATIVE_CLIENT_PORT_END,
  nativeCaptureTargetSchema,
  shareSourceReplacedResponseSchema,
  shareStartedResponseSchema,
  shareUpdatedResponseSchema,
  sourcePreviewResponseSchema,
  receiveAnswerResponseSchema,
} from "../src/client/native/wire";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("native App private wire", () => {
  const health = {
    protocol: NATIVE_CLIENT_PROTOCOL,
    service: "piik-client",
    port: NATIVE_CLIENT_PORT_START,
    instanceToken: "a".repeat(43),
    nativeMedia: { video: true, hardwareH264: true },
  };

  it.each(["prompt", "denied"] as const)("does not hold Viewer reception for %s permission and observes a later grant", async (state) => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: { hostname: "piik.example" } });
    const query = vi.fn().mockResolvedValue({ state });
    vi.stubGlobal("navigator", { permissions: { query } });
    const fetcher = vi.fn(async () => new Response(JSON.stringify(health)));
    vi.stubGlobal("fetch", fetcher);
    const socket = vi.fn();
    vi.stubGlobal("WebSocket", socket);

    await expect(NativeClient.connect({ waitForPermission: false })).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(socket).not.toHaveBeenCalled();
    query.mockResolvedValue({ state: "granted" });
    await expect(discoverNativeHealth({ waitForPermission: false })).resolves.toMatchObject({ port: health.port });
  });

  it("still lets explicit source discovery ask for local permission", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: { hostname: "piik.example" } });
    const query = vi.fn().mockResolvedValue({ state: "prompt" });
    vi.stubGlobal("navigator", { permissions: { query } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(health))));
    await expect(discoverNativeHealth()).resolves.toMatchObject({ port: health.port });
    expect(query).not.toHaveBeenCalled();
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])("keeps App Local reception on %s available without cross-address-space consent", async (hostname) => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: { hostname } });
    const query = vi.fn().mockResolvedValue({ state: "prompt" });
    vi.stubGlobal("navigator", { permissions: { query } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(health))));
    await expect(discoverNativeHealth({ waitForPermission: false })).resolves.toMatchObject({ port: health.port });
    expect(query).not.toHaveBeenCalled();
  });

  it("uses the older combined permission when split permission is unsupported", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: { hostname: "piik.example" } });
    const query = vi.fn().mockRejectedValueOnce(new TypeError("Unsupported permission"))
      .mockResolvedValue({ state: "prompt" });
    vi.stubGlobal("navigator", { permissions: { query } });
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(discoverNativeHealth({ waitForPermission: false })).resolves.toBeNull();
    expect(query).toHaveBeenLastCalledWith({ name: "local-network-access" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([undefined, { query: vi.fn().mockRejectedValue(new TypeError("Unsupported permission")) }])(
    "retains ordinary discovery when local permissions cannot be queried",
    async (permissions) => {
      vi.stubGlobal("window", { setTimeout, clearTimeout, location: { hostname: "piik.example" } });
      vi.stubGlobal("navigator", { permissions });
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(health))));
      await expect(discoverNativeHealth({ waitForPermission: false })).resolves.toMatchObject({ port: health.port });
    },
  );

  it.each([NATIVE_CLIENT_PROTOCOL - 1, NATIVE_CLIENT_PROTOCOL + 1])(
    "reports observed Piik App protocol %s without opening control or presentation",
    async (protocol) => {
      vi.stubGlobal("window", { setTimeout, clearTimeout });
      const socket = vi.fn();
      vi.stubGlobal("WebSocket", socket);
      const fetcher = vi.fn(async (url: string) => url === `http://127.0.0.1:${health.port}/health`
        ? new Response(JSON.stringify({ ...health, protocol }))
        : new Response(null, { status: 403 }));
      vi.stubGlobal("fetch", fetcher);
      await expect(NativeClient.connect()).rejects.toMatchObject({
        name: "NativeCompatibilityError", actualProtocol: protocol,
      });
      await expect(notifyNativePresentation("en", new AbortController().signal))
        .rejects.toBeInstanceOf(NativeCompatibilityError);
      expect(socket).not.toHaveBeenCalled();
      expect(fetcher.mock.calls.every(([url]) => url.endsWith("/health"))).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(2 * (NATIVE_CLIENT_PORT_END - NATIVE_CLIENT_PORT_START + 1));
    },
  );

  it("prefers a compatible App on a later port after observing an incompatible App", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const fetcher = vi.fn(async (url: string) => {
      const port = Number(new URL(url).port);
      return new Response(JSON.stringify({ ...health, port,
        protocol: port === health.port ? NATIVE_CLIENT_PROTOCOL + 1 : NATIVE_CLIENT_PROTOCOL,
      }));
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(discoverNativeHealth()).resolves.toMatchObject({
      protocol: NATIVE_CLIENT_PROTOCOL, port: NATIVE_CLIENT_PORT_START + 1,
    });
    expect(fetcher).toHaveBeenCalledTimes(NATIVE_CLIENT_PORT_END - NATIVE_CLIENT_PORT_START + 1);
  });

  it("keeps discovery alive while local access takes longer than 400 ms", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
      if (new URL(url).port !== String(health.port)) throw new TypeError("No listener");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 1_500);
        options.signal!.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
      return new Response(JSON.stringify(health));
    }));
    const discovery = discoverNativeHealth();
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(discovery).resolves.toMatchObject({ port: health.port });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finds a later App without waiting for a silent port and aborts the unused probe", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    let silentSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
      const port = Number(new URL(url).port);
      if (port === health.port) {
        silentSignal = options.signal!;
        return new Promise<Response>((_resolve, reject) => {
          silentSignal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      if (port !== health.port + 1) throw new TypeError("No listener");
      return new Response(JSON.stringify({ ...health, port }));
    }));
    await expect(discoverNativeHealth()).resolves.toMatchObject({ port: health.port + 1 });
    expect(silentSignal?.aborted).toBe(true);
  });

  it("bounds all silent discovery ports with one deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
      signals.push(options.signal!);
      return new Promise<Response>((_resolve, reject) => {
        options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }));
    const discovery = discoverNativeHealth();
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(discovery).resolves.toBeNull();
    expect(signals).toHaveLength(NATIVE_CLIENT_PORT_END - NATIVE_CLIENT_PORT_START + 1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("identifies an incompatible App even when that protocol uses different token or media metadata", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...health, protocol: NATIVE_CLIENT_PROTOCOL + 1,
      instanceToken: { format: "different-protocol" }, nativeMedia: "different-protocol",
    }))));
    await expect(NativeClient.connect()).rejects.toMatchObject({
      name: "NativeCompatibilityError", actualProtocol: NATIVE_CLIENT_PROTOCOL + 1,
    });
  });

  it("treats denied, absent and malformed endpoints as ordinary Browser-only operation", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const malformed = [
      { ...health, service: "another-service" },
      { ...health, protocol: "8" },
      { ...health, instanceToken: "invalid" },
      { ...health, nativeMedia: { video: "yes" } },
      { ...health, protocol: 8, port: NATIVE_CLIENT_PORT_END },
    ];
    let responseIndex = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      const body = malformed[responseIndex++];
      if (body) return new Response(JSON.stringify(body));
      if (responseIndex % 2 === 0) return new Response(null, { status: 403 });
      throw new TypeError("Network unavailable");
    }));
    await expect(NativeClient.connect()).resolves.toBeNull();
  });

  it("notifies only the current presentation request after App discovery", async () => {
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    const fetcher = vi.fn(async (url: string) => url.endsWith("/health")
      ? new Response(JSON.stringify({
          protocol: 9, service: "piik-client", port: 39_721,
          instanceToken: "a".repeat(43),
          nativeMedia: {video: true, processAudio: false, systemAudio: true, hardwareH264: true, softwareVP8: true},
        }), {status: 200})
      : new Response(null, {status: 204}));
    vi.stubGlobal("fetch", fetcher);
    const stale = new AbortController();
    const staleNotification = notifyNativePresentation("zh", stale.signal);
    stale.abort();
    await staleNotification;
    expect(fetcher).toHaveBeenCalledTimes(NATIVE_CLIENT_PORT_END - NATIVE_CLIENT_PORT_START + 1);
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:39721/health", expect.anything());
    const current = new AbortController();
    await notifyNativePresentation("vis", current.signal);
    expect(fetcher).toHaveBeenLastCalledWith("http://127.0.0.1:39721/presentation", expect.objectContaining({
      method: "POST", body: JSON.stringify({language: "vis"}), signal: current.signal,
    }));
  });

  it("notifies the owner once on an unexpected close and stays silent on cleanup", async () => {
    const sockets: FakeWebSocket[] = [];
    const token = "a".repeat(43);
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = FakeWebSocket.OPEN;
      protocol = `piik-client-v9.${token}`;
      readonly close = vi.fn(() => {
        this.readyState = FakeWebSocket.CLOSING;
      });

      constructor(readonly url: string, readonly protocols: string[]) {
        super();
        sockets.push(this);
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(payload: string): void {
        const request = JSON.parse(payload) as { id: string; type: string };
        if (!["hello", "update-share", "ping"].includes(request.type)) return;
        queueMicrotask(() => {
          const event = new Event("message");
          Object.defineProperty(event, "data", {
            value: JSON.stringify({
              version: 9,
              id: request.id,
              type: request.type === "hello" ? "ready" : request.type === "ping" ? "pong" : "request-failed",
              ...(request.type === "update-share" ? { code: "operation-failed" } : {}),
            }),
          });
          this.dispatchEvent(event);
        });
      }

      emitUnexpectedClose(): void {
        this.readyState = FakeWebSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        protocol: 9,
        service: "piik-client",
        port: 39_721,
        instanceToken: token,
        nativeMedia: {
          video: true,
          processAudio: false,
          systemAudio: false,
          hardwareH264: true,
          softwareVP8: true,
        },
      }), { status: 200 }),
    ));

    const client = await NativeClient.connect();
    expect(client).not.toBeNull();
    const unexpected = vi.fn();
    client!.onClose(unexpected);
    await expect(client!.updateShare("share_123456", DEFAULT_QUALITY_SETTINGS))
      .rejects.toThrow("Piik App request failed");
    await client!.ping();
    expect(sockets[0]!.close).not.toHaveBeenCalled();
    expect(unexpected).not.toHaveBeenCalled();
    sockets[0]!.emitUnexpectedClose();
    sockets[0]!.emitUnexpectedClose();
    expect(unexpected).toHaveBeenCalledOnce();

    const cleanClient = await NativeClient.connect();
    expect(cleanClient).not.toBeNull();
    const intentional = vi.fn();
    cleanClient!.onClose(intentional);
    cleanClient!.close();
    sockets[1]!.emitUnexpectedClose();
    expect(intentional).not.toHaveBeenCalled();
  });

  it("accepts descriptive health extensions and treats absent media features as unavailable", () => {
    expect(
      nativeHealthSchema.parse({
        protocol: 9,
        service: "piik-client",
        port: 39_721,
        instanceToken: "a".repeat(43),
        nativeMedia: {
          video: true,
          processAudio: false,
          systemAudio: true,
          hardwareH264: true,
          softwareVP8: true,
        },
      }),
    ).toMatchObject({ nativeMedia: { processAudio: false } });
    expect(
      nativeHealthSchema.safeParse({
        protocol: NATIVE_CLIENT_PROTOCOL,
        service: "piik-client",
        port: 39_721,
        instanceToken: "a".repeat(43),
        nativeMedia: {
          video: true,
          processAudio: true,
          systemAudio: true,
          hardwareH264: true,
          softwareVP8: false,
        },
        adapters: ["private"],
      }).success,
    ).toBe(true);
    expect(nativeHealthSchema.parse({
      ...health, futureDescription: "ignored", nativeMedia: { video: true, futureFeature: true },
    })).toEqual({
      ...health, nativeMedia: {
        receiverReuse: false,
        video: true, processAudio: false, systemAudio: false, microphone: false, captureBorderControl: false, hardwareH264: false, softwareVP8: false,
      },
    });
    expect(nativeHealthSchema.parse({ ...health, nativeMedia: undefined }).nativeMedia)
      .toEqual({ receiverReuse: false, video: false, processAudio: false, systemAudio: false, microphone: false, captureBorderControl: false, hardwareH264: false, softwareVP8: false });
    for (const invalid of [
      { protocol: 0 }, { protocol: 9.5 }, { protocol: Number.MAX_SAFE_INTEGER + 1 },
      { service: "other" }, { port: NATIVE_CLIENT_PORT_END + 1 }, { instanceToken: "short" },
      { nativeMedia: { softwareVP8: "true" } }, { nativeMedia: { captureBorderControl: "true" } }, { nativeMedia: null },
    ]) expect(nativeHealthSchema.safeParse({ ...health, ...invalid }).success).toBe(false);
  });

  it.each([undefined, false, true])("gates capture-border commands on advertised support: %s", async (supported) => {
    const requests: Record<string, unknown>[] = [];
    class CaptureSocket extends EventTarget {
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      readyState = CaptureSocket.OPEN;
      protocol = `piik-client-v9.${health.instanceToken}`;
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      close() { this.readyState = CaptureSocket.CLOSING; }
      send(payload: string) {
        const request = JSON.parse(payload) as Record<string, unknown>;
        requests.push(request);
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
          data: JSON.stringify({
            version: NATIVE_CLIENT_PROTOCOL, id: request.id,
            ...(request.type === "hello" ? { type: "ready" } : {
              type: request.type === "start-share" ? "share-started" : "share-source-replaced",
              shareId: request.shareId,
              ...(request.type === "start-share" ? { audio: true, codec: "h264" } : {}),
            }),
          }),
        })));
      }
    }
    vi.stubGlobal("WebSocket", CaptureSocket);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...health, nativeMedia: { ...health.nativeMedia, captureBorderControl: supported },
    }))));
    const client = await NativeClient.connect();
    expect(client).not.toBeNull();
    expect(client!.health.nativeMedia.captureBorderControl).toBe(supported ?? false);
    const input = {
      shareId: "share_123456", source: { kind: "display" as const, sourceId: "2", title: "Display 1" },
      audio: true, adapterIndex: 0, encoderIndex: 0, edgeCapacity: 2,
      profile: DEFAULT_QUALITY_SETTINGS, codec: "auto" as const,
    };
    try {
      for (const showCaptureBorder of [undefined, false, true]) {
        await client!.startShare({ ...input, showCaptureBorder });
        await client!.replaceShareSource(input.shareId, input.source, input.audio, input, showCaptureBorder);
        const extension = supported ? { showCaptureBorder: showCaptureBorder ?? false } : {};
        expect(requests.at(-2)).toEqual({
          version: NATIVE_CLIENT_PROTOCOL, id: expect.any(String), type: "start-share", ...input, ...extension,
        });
        expect(requests.at(-1)).toEqual({
          version: NATIVE_CLIENT_PROTOCOL, id: expect.any(String), type: "replace-share-source",
          shareId: input.shareId, source: input.source, audio: true, adapterIndex: 0, encoderIndex: 0, ...extension,
        });
      }
    } finally { client!.close(); }
  });

  it.each([false, true])("gates microphone mixing and coalesces volume without delaying Stop (%s)", async (supported) => {
    const requests: Record<string, unknown>[] = [];
    let socket!: Socket;
    class Socket extends EventTarget {
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      readyState = Socket.OPEN;
      protocol = `piik-client-v9.${health.instanceToken}`;
      constructor() { super(); socket = this; queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      close() { this.readyState = Socket.CLOSING; }
      ack(request: Record<string, unknown>, type: string, fields = {}) {
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ version: 9, id: request.id, type, ...fields }) }));
      }
      send(payload: string) {
        const request = JSON.parse(payload) as Record<string, unknown>;
        requests.push(request);
        if (request.type === "set-microphone") return;
        if (request.type === "list-microphones") {
          queueMicrotask(() => this.ack(request, "microphone-list", { devices: [{ id: "headset", label: "USB Headset" }] }));
          return;
        }
        queueMicrotask(() => this.ack(request,
          request.type === "hello" ? "ready" : request.type === "start-share" ? "share-started" : "share-stopped",
          request.type === "start-share" ? { shareId: request.shareId, audio: supported, codec: "vp8", ...(supported ? { sourceAudio: false } : {}) } : {}));
      }
    }
    vi.stubGlobal("WebSocket", Socket);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...health, nativeMedia: { ...health.nativeMedia, ...(supported ? { microphone: true } : {}) },
    }))));
    const client = (await NativeClient.connect())!;
    try {
      const started = await client.startShare({ shareId: "share_123456", audio: false,
        source: { kind: "display", sourceId: "1", title: "Screen" }, adapterIndex: 0, encoderIndex: 0,
        edgeCapacity: 1, profile: DEFAULT_QUALITY_SETTINGS, codec: "vp8" });
      expect(requests.at(-1)?.microphoneMixing).toBe(supported ? true : undefined);
      expect(started.audio).toBe(supported);
      if (!supported) {
        await expect(client.setMicrophone("share_123456", true, 1)).rejects.toThrow();
        await expect(client.microphones()).rejects.toThrow();
        expect(requests.some(request => request.type === "set-microphone")).toBe(false);
        return;
      }
      expect(await client.microphones()).toEqual([{ id: "headset", label: "USB Headset" }]);
      const choosing = client.setMicrophone("share_123456", true, 1, "headset");
      expect(requests.at(-1)).toMatchObject({ type: "set-microphone", deviceId: "headset", enabled: true });
      socket.ack(requests.at(-1)!, "microphone-set");
      await choosing;
      requests.length = 0;
      const pending = client.setMicrophoneVolume("share_123456", 0.1);
      for (let value = 2; value <= 20; value++) expect(client.setMicrophoneVolume("share_123456", value / 10)).toBe(pending);
      expect(requests.filter(request => request.type === "set-microphone")).toHaveLength(1);
      socket.ack(requests.at(-1)!, "microphone-set");
      await vi.waitFor(() => expect(requests.at(-1)?.volume).toBe(2));
      const last = requests.at(-1)!;
      expect(last).not.toHaveProperty("enabled");
      await client.stopShare("share_123456");
      socket.ack(last, "microphone-set");
      await pending;
      expect(requests.at(-1)?.type).toBe("stop-share");
    } finally { client.close(); }
  });

  it.each([false, true])("requests receiver reuse only from a capable App (%s)", async (supported) => {
    const requests: Record<string, unknown>[] = [];
    class Socket extends EventTarget {
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      readyState = Socket.OPEN;
      protocol = `piik-client-v9.${health.instanceToken}`;
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      close() { this.readyState = Socket.CLOSING; }
      send(payload: string) {
        const request = JSON.parse(payload) as Record<string, unknown>;
        requests.push(request);
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
          version: 9, id: request.id, ...(request.type === "hello" ? { type: "ready" } : {
            type: "receive-answer", shareId: request.shareId, connectionId: request.connectionId,
            sdp: "answer", audio: false, codec: "vp8", ...(supported ? { reused: true } : {}),
          }),
        }) })));
      }
    }
    vi.stubGlobal("WebSocket", Socket);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...health, nativeMedia: { ...health.nativeMedia, ...(supported ? { receiverReuse: true } : {}) },
    }))));
    const client = (await NativeClient.connect())!;
    try {
      const result = await client.receiveOffer("share_123456", "connection_1234", { type: "offer", sdp: "offer" }, { iceServers: [] }, 2);
      expect(requests.at(-1)).toEqual({ version: 9, id: expect.any(String), type: "receive-offer",
        shareId: "share_123456", connectionId: "connection_1234", sdp: "offer", iceServers: [], edgeCapacity: 2,
        ...(supported ? { reuseReceiver: true } : {}),
      });
      expect(result.reused).toBe(supported);
    } finally { client.close(); }
  });

  it("keeps 64-bit Windows identities as exact decimal strings", () => {
    expect(
      nativeCaptureTargetSchema.safeParse({
        kind: "window",
        sourceId: "12345678901234567890",
        pid: 1234,
        creationTime: "134327999999999999",
        title: "Game",
      }).success,
    ).toBe(true);
    expect(
      nativeCaptureTargetSchema.safeParse({
        kind: "window",
        sourceId: 12345678901234567890,
        pid: 1234,
        creationTime: 134327999999999999,
        title: "Game",
      }).success,
    ).toBe(false);
    expect(
      nativeCaptureTargetSchema.safeParse({
        kind: "display",
        sourceId: "65537",
        title: "Display 1",
      }).success,
    ).toBe(true);
    expect(
      nativeCaptureTargetSchema.safeParse({
        kind: "picker",
        sourceId: "1",
        title: "System picker",
      }).success,
    ).toBe(true);
  });

  it("fences native events by share and connection identity", () => {
    const event = {
      version: 9,
      type: "edge-state",
      shareId: "share_123456",
      connectionId: "edge_1234567",
      state: "connected",
    };
    expect(nativeEventSchema.safeParse(event).success).toBe(true);
    expect(
      nativeEventSchema.safeParse({ ...event, connectionId: "short" }).success,
    ).toBe(false);
    expect(
      nativeEventSchema.safeParse({ ...event, routeRevision: 1 }).success,
    ).toBe(false);
    const path = {
      version: 9,
      type: "edge-path",
      shareId: "share_123456",
      connectionId: "edge_1234567",
      localType: "host",
      remoteType: "srflx",
      natTraversalPath: "predicted",
    };
    expect(nativeEventSchema.safeParse(path).success).toBe(true);
    const { natTraversalPath: _missing, ...incompletePath } = path;
    expect(nativeEventSchema.safeParse(incompletePath).success).toBe(false);
  });

  it("keeps an unavailable preview advisory instead of treating it as media failure", () => {
    const preview = {
      version: 9,
      id: "request_preview",
      type: "source-preview",
      sourceKey: "display:65537",
      mime: "image/bmp",
      data: "",
    };
    expect(sourcePreviewResponseSchema.safeParse(preview).success).toBe(true);
    expect(sourcePreviewResponseSchema.safeParse({
      ...preview,
      data: Buffer.alloc(54 + 320 * 180 * 3).toString("base64"),
    }).success).toBe(true);
    expect(sourcePreviewResponseSchema.safeParse({
      ...preview,
      data: "A".repeat(256 * 1024 + 1),
    }).success).toBe(false);
  });

  it("keeps native share lifecycle responses as strict acknowledgements", () => {
    const profile = {
      resolution: "1440p",
      maxFramerate: 60,
      maxBitrate: 12_000_000,
      degradationPreference: "maintain-framerate",
      screenAudioQuality: "very-high",
    };
    expect(shareStartedResponseSchema.safeParse({
      version: 9,
      id: "request_start",
      type: "share-started",
      shareId: "share_123456",
      audio: true,
      codec: "h264",
    }).success).toBe(true);
    expect(shareUpdatedResponseSchema.safeParse({
      version: 9,
      id: "request_update",
      type: "share-updated",
      shareId: "share_123456",
    }).success).toBe(true);
    expect(shareSourceReplacedResponseSchema.safeParse({
      version: 9,
      id: "request_source",
      type: "share-source-replaced",
      shareId: "share_123456",
    }).success).toBe(true);
    expect(shareUpdatedResponseSchema.safeParse({
      version: 9,
      id: "request_update",
      type: "share-updated",
      shareId: "share_123456",
      profile,
    }).success).toBe(false);
  });

  it("requires the actual Native codec instead of reporting Auto as media", () => {
    const response = {
      version: 9,
      id: "request_receive",
      type: "receive-answer",
      shareId: "share_123456",
      connectionId: "edge_1234567",
      sdp: "v=0\r\n",
      audio: false,
    };
    for (const codec of ["h264", "vp8"]) {
      expect(receiveAnswerResponseSchema.safeParse({ ...response, codec }).success).toBe(true);
      expect(shareStartedResponseSchema.safeParse({
        version: 9, id: "request_start", type: "share-started",
        shareId: response.shareId, audio: false, codec,
      }).success).toBe(true);
    }
    expect(receiveAnswerResponseSchema.safeParse(response).success).toBe(false);
    expect(receiveAnswerResponseSchema.safeParse({ ...response, codec: "auto" }).success).toBe(false);
  });

  it("accepts only internally consistent native quality evidence", () => {
    const event = {
      version: 9,
      type: "edge-quality",
      shareId: "share_123456",
      connectionId: "edge_1234567",
      sampleTimestampMs: 10_000,
      sampleWindowMs: 2_000,
      rtpStatsId: "pc_12345678",
      trackIdentifier: "screen",
      state: "degraded",
      reason: "bandwidth",
      intervalFramesEncoded: 60,
      framesPerSecond: 30,
      bitrateKbps: 3_000,
      availableOutgoingKbps: 1_000,
      width: 1280,
      height: 720,
    };
    expect(nativeEventSchema.safeParse(event).success).toBe(true);
    expect(
      nativeEventSchema.safeParse({ ...event, reason: "none" }).success,
    ).toBe(false);
    expect(
      nativeEventSchema.safeParse({
        ...event,
        state: "unknown",
        reason: null,
      }).success,
    ).toBe(true);
  });
});
