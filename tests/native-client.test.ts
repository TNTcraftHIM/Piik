import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { discoverNativeConnect, discoverNativeHealth, NativeClient, NativeCompatibilityError, notifyNativePresentation } from "../src/client/native/client";
import { DEFAULT_QUALITY_SETTINGS } from "../src/shared/protocol";
import { AppQualityPreference } from "../src/client/native/quality-preference";
import { NATIVE_CLIENT_PORT_START, NATIVE_CLIENT_PORT_END } from "../src/client/native/discovery-ports";
import { channelAppDiscovery, discoverChannelAppHealth } from "../src/client/channel/app-link";

import {
  nativeEventSchema,
  nativeHealthSchema,
  nativeRelayCapacity,
  NATIVE_CLIENT_PROTOCOL,
  nativeCaptureTargetSchema,
  shareSourceReplacedResponseSchema,
  shareStartedResponseSchema,
  shareUpdatedResponseSchema,
  sourcePreviewResponseSchema,
  receiveAnswerResponseSchema,
  requestFailedResponseSchema,
} from "../src/client/native/wire";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("discovers the room App independently of v10 media control and checks health after approval", async () => {
  vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://channel.example/") });
  let approved = false;
  vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
    const url = new URL(raw), port = Number(url.port);
    if (port === NATIVE_CLIENT_PORT_START) return Response.json({ service: "piik-client", protocol: 10, port });
    if (port !== NATIVE_CLIENT_PORT_START + 1) throw new TypeError("No listener");
    const identity = { service: "piik-channel-app", protocol: 1, port };
    if (url.pathname === "/connect-discovery") return Response.json({ ...identity, connectURL: `http://127.0.0.1:${port}/client` });
    return approved ? Response.json({ ...identity, token: "instance-token" }) : new Response(null, { status: 403 });
  }));
  await expect(channelAppDiscovery.connect()).resolves.toBe(`http://127.0.0.1:${NATIVE_CLIENT_PORT_START + 1}/client?site=https%3A%2F%2Fchannel.example`);
  await expect(discoverChannelAppHealth()).resolves.toBeNull();
  approved = true;
  await expect(discoverChannelAppHealth()).resolves.toMatchObject({ protocol: 1, port: NATIVE_CLIENT_PORT_START + 1, token: "instance-token" });
});

it("uses an explicit non-secret App port outside the default scan range", async () => {
  const page = { setTimeout, clearTimeout, location: new URL("https://channel.example/?piik-client-port=48995#piik-client=1"),
    history: { state: null, replaceState: vi.fn() } };
  vi.stubGlobal("window", page);
  const bootstrap = await import("../src/client/lib/session");
  bootstrap.takeClientLaunchBootstrap();
  try {
    const fetcher = vi.fn(async () => Response.json({ service: "piik-channel-app", protocol: 1, port: 48995, token: "instance-token" }));
    vi.stubGlobal("fetch", fetcher);
    await expect(discoverChannelAppHealth()).resolves.toMatchObject({ port: 48995 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:48995/health", expect.anything());
    expect(page.history.replaceState).toHaveBeenCalledWith(null, "", "/");
  } finally {
    page.location = new URL("https://channel.example/#piik-client=1");
    bootstrap.takeClientLaunchBootstrap();
  }
});

describe("native App private wire", () => {
  it("preserves the published strict failure reader for requests without cancellation opt-in", () => {
    const published = z.object({ version: z.literal(10), id: z.string(), type: z.literal("request-failed"), code: z.literal("operation-failed") }).strict();
    const legacy = { version: 10, id: "request_start", type: "request-failed", code: "operation-failed" };
    expect(published.safeParse(legacy).success).toBe(true);
    expect(requestFailedResponseSchema.safeParse(legacy).success).toBe(true);
    const optedIn = { ...legacy, code: "source-canceled" };
    expect(published.safeParse(optedIn).success).toBe(false);
    expect(requestFailedResponseSchema.safeParse(optedIn).success).toBe(true);
  });
  const health = {
    protocol: NATIVE_CLIENT_PROTOCOL,
    service: "piik-client",
    port: NATIVE_CLIENT_PORT_START,
    instanceToken: "a".repeat(43),
    nativeMedia: { video: true, hardwareH264: true },
  };

  it("discovers with caller cancellation when AbortSignal.any is unavailable", async () => {
    vi.spyOn(AbortSignal, "any").mockImplementation(() => { throw new TypeError("AbortSignal.any is not a function"); });
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("http://127.0.0.1:8787/") });
    const fetcher = vi.fn(async (url: string) => {
      if (new URL(url).port !== String(health.port)) throw new TypeError("No listener");
      return new Response(JSON.stringify(health));
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(discoverNativeHealth({ signal: new AbortController().signal })).resolves.toMatchObject({ port: health.port });
    expect(fetcher).toHaveBeenCalled();
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])("discovers and updates presentation from %s without an address-space hint", async hostname => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL(`http://${hostname}:8787/`) });
    const query = vi.fn().mockResolvedValue({ state: "prompt" });
    vi.stubGlobal("navigator", { permissions: { query } });
    const fetcher = vi.fn((url: string, init: RequestInit) => {
      if ("targetAddressSpace" in init) throw new TypeError("loopback is not a valid IPAddressSpace enum value");
      return Promise.resolve(new Response(JSON.stringify(url.endsWith("quality-preference") ? DEFAULT_QUALITY_SETTINGS
        : url.endsWith("connect-discovery") ? { ...health, connectURL: "http://127.0.0.1:54321/client" }
          : { ...health, qualityPreference: true })));
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(discoverNativeHealth({ waitForPermission: false })).resolves.toMatchObject({ port: health.port });
    await expect(discoverNativeConnect()).resolves.toContain("http://127.0.0.1:54321/client?");
    await notifyNativePresentation("en", new AbortController().signal);
    const preference = await AppQualityPreference.connect(new AbortController().signal);
    await expect(preference!.read()).resolves.toEqual(DEFAULT_QUALITY_SETTINGS);
    expect(query).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledWith(`http://127.0.0.1:${health.port}/presentation`, expect.objectContaining({ method: "POST" }));
    expect(fetcher.mock.calls.every(([, init]) => !("targetAddressSpace" in init))).toBe(true);
  });

  it("retains the address-space hint for hosted discovery and presentation without a no-hint fallback", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/") });
    vi.stubGlobal("navigator", { permissions: { query: vi.fn().mockResolvedValue({ state: "granted" }) } });
    const fetcher = vi.fn(async (url: string, _init: RequestInit) => new Response(JSON.stringify(
      url.endsWith("quality-preference") ? DEFAULT_QUALITY_SETTINGS : { ...health, qualityPreference: true })));
    vi.stubGlobal("fetch", fetcher);
    await notifyNativePresentation("en", new AbortController().signal);
    const preference = await AppQualityPreference.connect(new AbortController().signal);
    await expect(preference!.read()).resolves.toEqual(DEFAULT_QUALITY_SETTINGS);
    expect(fetcher.mock.calls.every(call => (call[1] as RequestInit & { targetAddressSpace: string }).targetAddressSpace === "loopback")).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(`http://127.0.0.1:${health.port}/presentation`, expect.objectContaining({ targetAddressSpace: "loopback" }));
    fetcher.mockImplementation(() => { throw new TypeError("Unsupported IPAddressSpace"); });
    fetcher.mockClear();
    await expect(discoverNativeHealth()).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(NATIVE_CLIENT_PORT_END - NATIVE_CLIENT_PORT_START + 1);
    expect(fetcher.mock.calls.every(call => (call[1] as RequestInit & { targetAddressSpace: string }).targetAddressSpace === "loopback")).toBe(true);
  });

  it("requires the controlled App platform in remote-control state", () => {
    const event = { version: NATIVE_CLIENT_PROTOCOL, type: "remote-control-state", shareId: "share_123456", mode: "off", requests: [] };
    expect(nativeEventSchema.safeParse(event).success).toBe(false);
    for (const platform of ["windows", "darwin", "linux"]) {
      expect(nativeEventSchema.parse({ ...event, platform })).toMatchObject({ platform });
    }
    expect(nativeEventSchema.safeParse({ ...event, platform: "unknown" }).success).toBe(false);
  });

  it.each(["prompt", "denied"])("background App preferences do not request local access when permission is %s", async (state) => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/") });
    vi.stubGlobal("navigator", { permissions: { query: vi.fn().mockResolvedValue({ state }) } });
    const fetcher = vi.fn(async () => new Response(JSON.stringify(health)));
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    await notifyNativePresentation("en", controller.signal);
    expect(await AppQualityPreference.connect(controller.signal)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("discovers only a local approval page without opening native control", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/r/9527") });
    const socket = vi.fn();
    vi.stubGlobal("WebSocket", socket);
    const fetcher = vi.fn(async (url: string) => url === `http://127.0.0.1:${health.port}/connect-discovery`
      ? new Response(JSON.stringify({ ...health, connectURL: "http://127.0.0.1:54321/client" }))
      : new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(discoverNativeConnect()).resolves.toBe("http://127.0.0.1:54321/client?site=https%3A%2F%2Fpiik.example");
    expect(fetcher.mock.calls.every(([url]) => url.endsWith("/connect-discovery"))).toBe(true);
    expect(socket).not.toHaveBeenCalled();
  });

  it.each([
    "https://untrusted.example/client", "http://localhost:54321/client", "http://127.0.0.1:54321/other",
    "http://user@127.0.0.1:54321/client", "http://127.0.0.1:54321/client?site=https://other.example",
  ])("rejects an unsafe App approval address: %s", async (connectURL) => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/") });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === `http://127.0.0.1:${health.port}/connect-discovery`
      ? new Response(JSON.stringify({ ...health, connectURL })) : new Response(null, { status: 404 })));
    await expect(discoverNativeConnect()).resolves.toBeNull();
  });

  it("cancels the whole approval scan with its caller", async () => {
    vi.spyOn(AbortSignal, "any").mockImplementation(() => { throw new TypeError("AbortSignal.any is not a function"); });
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/") });
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      const signal = init.signal!;
      signals.push(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })));
    const controller = new AbortController();
    const result = discoverNativeConnect(controller.signal);
    controller.abort();
    await expect(result).resolves.toBeNull();
    expect(signals).toHaveLength(NATIVE_CLIENT_PORT_END - NATIVE_CLIENT_PORT_START + 1);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  it("reads numeric video capability descriptions and rejects malformed limits", () => {
    const nativeMedia = { ...health.nativeMedia, maxVideoResolution: { width: 3840, height: 3840 },
      maxVideoPixels: 3840 * 2160, maxVideoMacroblocksPerSecond: 983_040 };
    expect(nativeHealthSchema.parse({ ...health, nativeMedia }).nativeMedia).toMatchObject(nativeMedia);
    const stronger = { ...nativeMedia, maxVideoResolution: { width: 32768, height: 32768 },
      maxVideoPixels: 32768 ** 2, maxVideoFramerate: 120, maxVideoBitrate: 100_000_000,
      maxAudioBitrate: 960_000, maxRelayChildren: 32 };
    const strongerHealth = nativeHealthSchema.parse({ ...health, nativeMedia: stronger });
    expect(strongerHealth.nativeMedia).toMatchObject(stronger);
    expect(nativeRelayCapacity(20, strongerHealth)).toBe(20);
    expect(nativeHealthSchema.safeParse({ ...health, nativeMedia: { ...nativeMedia, maxVideoPixels: 0 } }).success).toBe(false);
    expect(nativeHealthSchema.safeParse({ ...health, nativeMedia: { ...nativeMedia, maxVideoMacroblocksPerSecond: -1 } }).success).toBe(false);
    expect(nativeHealthSchema.parse({ ...health, nativeMedia: { ...nativeMedia, maxRelayChildren: 20 } })
      .nativeMedia.maxRelayChildren).toBe(20);
    for (const maxRelayChildren of [0, 0x1_0000_0000, 1.5]) {
      expect(nativeHealthSchema.safeParse({ ...health, nativeMedia: { ...nativeMedia, maxRelayChildren } }).success).toBe(false);
    }
  });

  it.each(["opening", "hello", "close"])("retires App acquisition during %s without waiting for its timeout", async stage => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/") });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(health))));
    const sockets: Socket[] = [];
    class Socket extends EventTarget {
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      readyState = 0;
      protocol = `piik-client-v10.${health.instanceToken}`;
      close = vi.fn(() => { this.readyState = Socket.CLOSING; });
      send = vi.fn();
      constructor() { super(); sockets.push(this); }
    }
    vi.stubGlobal("WebSocket", Socket);
    const controller = new AbortController();
    const settled = vi.fn();
    const connecting = NativeClient.connect({ signal: controller.signal }).then(settled);
    await vi.advanceTimersByTimeAsync(0);
    const socket = sockets[0]!;
    expect(socket).toBeDefined();
    if (stage === "hello") {
      socket.readyState = Socket.OPEN;
      socket.dispatchEvent(new Event("open"));
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.send).toHaveBeenCalledOnce();
    }
    if (stage === "close") {
      socket.readyState = 3;
      socket.dispatchEvent(new Event("close"));
    } else controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledExactlyOnceWith(null);
    expect(vi.getTimerCount()).toBe(0);
    if (stage !== "close") expect(socket.close).toHaveBeenCalledOnce();
    // An obsolete opening event cannot start a hello or revive acquisition.
    socket.dispatchEvent(new Event("open"));
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.send).toHaveBeenCalledTimes(stage === "hello" ? 1 : 0);
    await connecting;
  });

  it("binds a local answer to its prepare request across an ICE restart", async () => {
    const requests: Record<string, unknown>[] = [];
    class Socket extends EventTarget {
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      readyState = Socket.OPEN;
      protocol = `piik-client-v10.${health.instanceToken}`;
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      close() { this.readyState = Socket.CLOSING; }
      send(payload: string) {
        const request = JSON.parse(payload) as Record<string, unknown>;
        requests.push(request);
        const fields = request.type === "hello" ? { type: "ready" }
          : request.type === "prepare-local-edge" ? {
            type: "edge-offer", shareId: request.shareId, connectionId: request.connectionId, sdp: "v=0\r\n",
          } : { type: "edge-answer-accepted" };
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
          data: JSON.stringify({ version: 10, id: request.id, ...fields }),
        })));
      }
    }
    vi.stubGlobal("WebSocket", Socket);
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/") });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(health))));
    const controller = new AbortController();
    const client = (await NativeClient.connect({ signal: controller.signal }))!;
    controller.abort(); // Acquisition cancellation no longer owns this accepted client.
    try {
      let lastOffer = "";
      for (const restart of [false, true]) {
        const offer = await client.prepareLocalEdge("share_123456", "local_123456", "source_123456", restart);
        expect(offer.offerId).toBe(requests.at(-1)?.id);
        expect(offer.offerId).not.toBe(lastOffer);
        expect(requests.at(-1)).toMatchObject({ type: "prepare-local-edge", restart, sourceConnectionId: "source_123456" });
        await client.acceptSignal("share_123456", "local_123456", {
          kind: "description", connectionId: "local_123456", description: { type: "answer", sdp: "v=0\r\n" },
        }, offer.offerId);
        expect(requests.at(-1)).toMatchObject({ type: "edge-answer", offerId: offer.offerId });
        lastOffer = offer.offerId;
      }
    } finally { client.close(); }
  });

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
      vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("http://127.0.0.1/") });
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
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/") });
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
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/") });
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
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/") });
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
    vi.spyOn(AbortSignal, "any").mockImplementation(() => { throw new TypeError("AbortSignal.any is not a function"); });
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/") });
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
      signals.push(options.signal!);
      return new Promise<Response>((_resolve, reject) => {
        options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }));
    const discovery = discoverNativeHealth({ signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(discovery).resolves.toBeNull();
    expect(signals).toHaveLength(NATIVE_CLIENT_PORT_END - NATIVE_CLIENT_PORT_START + 1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("identifies an incompatible App even when that protocol uses different token or media metadata", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/") });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...health, protocol: NATIVE_CLIENT_PROTOCOL + 1,
      instanceToken: { format: "different-protocol" }, nativeMedia: "different-protocol",
    }))));
    await expect(NativeClient.connect()).rejects.toMatchObject({
      name: "NativeCompatibilityError", actualProtocol: NATIVE_CLIENT_PROTOCOL + 1,
    });
  });

  it("treats denied, absent and malformed endpoints as ordinary Browser-only operation", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/") });
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
      location: new URL("http://127.0.0.1/"),
    });
    const fetcher = vi.fn(async (url: string) => url.endsWith("/health")
      ? new Response(JSON.stringify({
          protocol: 10, service: "piik-client", port: 39_721,
          instanceToken: "a".repeat(43),
          nativeMedia: {video: true, processAudio: false, systemAudio: true, hardwareH264: true, softwareVP8: true},
        }), {status: 200})
      : new Response(null, {status: 204}));
    vi.stubGlobal("fetch", fetcher);
    const stale = new AbortController();
    const staleNotification = notifyNativePresentation("zh", stale.signal);
    stale.abort();
    await staleNotification;
    expect(fetcher).not.toHaveBeenCalled();
    const current = new AbortController();
    await notifyNativePresentation("vis", current.signal);
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:39721/health", expect.anything());
    expect(fetcher).toHaveBeenLastCalledWith("http://127.0.0.1:39721/presentation", expect.objectContaining({
      method: "POST", body: JSON.stringify({language: "vis"}), signal: current.signal,
    }));
  });

  it("notifies the owner once on an unexpected close and stays silent on cleanup", async () => {
    const sockets: FakeWebSocket[] = [];
    const token = "a".repeat(43);
    let failureCode = "operation-failed";
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = FakeWebSocket.OPEN;
      protocol = `piik-client-v10.${token}`;
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
              version: 10,
              id: request.id,
              type: request.type === "hello" ? "ready" : request.type === "ping" ? "pong" : "request-failed",
              ...(request.type === "update-share" ? { code: failureCode } : {}),
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
      location: new URL("https://piik.example/"),
    });
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        protocol: 10,
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
      .rejects.toMatchObject({ name: "NativeRequestError", reason: "rejected", operation: "update-share" });
    failureCode = "source-canceled";
    await expect(client!.updateShare("share_123456", DEFAULT_QUALITY_SETTINGS))
      .rejects.toMatchObject({ name: "NotAllowedError" });
    await client!.ping();
    expect(sockets[0]!.close).not.toHaveBeenCalled();
    expect(unexpected).not.toHaveBeenCalled();
    vi.useFakeTimers();
    window.setTimeout = globalThis.setTimeout;
    window.clearTimeout = globalThis.clearTimeout;
    const timedOut = expect(client!.sources()).rejects.toMatchObject({ reason: "timeout", operation: "list-sources" });
    await vi.advanceTimersByTimeAsync(8_000);
    await timedOut;
    expect(sockets[0]!.close).not.toHaveBeenCalled();
    vi.useRealTimers();
    window.setTimeout = globalThis.setTimeout;
    window.clearTimeout = globalThis.clearTimeout;
    const pending = client!.sources();
    const closedRequest = expect(pending).rejects.toMatchObject({ name: "NativeRequestError", reason: "disconnected", operation: "list-sources" });
    sockets[0]!.emitUnexpectedClose();
    sockets[0]!.emitUnexpectedClose();
    expect(unexpected).toHaveBeenCalledOnce();
    await closedRequest;
    await expect(client!.sources()).rejects.toMatchObject({ reason: "unavailable", operation: "list-sources" });

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
        protocol: 10,
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
        video: true, processAudio: false, processAudioExclusion: false, systemAudio: false, microphone: false, captureBorderControl: false, hardwareH264: false, softwareVP8: false,
      },
    });
    expect(nativeHealthSchema.parse({ ...health, nativeMedia: undefined }).nativeMedia)
      .toEqual({ receiverReuse: false, video: false, processAudio: false, processAudioExclusion: false, systemAudio: false, microphone: false, captureBorderControl: false, hardwareH264: false, softwareVP8: false });
    for (const invalid of [
      { protocol: 0 }, { protocol: 9.5 }, { protocol: Number.MAX_SAFE_INTEGER + 1 },
      { service: "other" }, { port: NATIVE_CLIENT_PORT_END + 1 }, { instanceToken: "short" },
      { nativeMedia: { softwareVP8: "true" } }, { nativeMedia: { captureBorderControl: "true" } }, { nativeMedia: null },
    ]) expect(nativeHealthSchema.safeParse({ ...health, ...invalid }).success).toBe(false);
  });

  it.each([undefined, false, true])("gates optional capture commands on advertised support: %s", async (supported) => {
    const requests: Record<string, unknown>[] = [];
    class CaptureSocket extends EventTarget {
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      readyState = CaptureSocket.OPEN;
      protocol = `piik-client-v10.${health.instanceToken}`;
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
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/") });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...health, nativeMedia: { ...health.nativeMedia, captureBorderControl: supported, remoteInput: supported, sourceCancellation: supported },
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
        const onRequested = vi.fn(() => expect(requests.at(-1)?.type).toBe("start-share"));
        let acknowledged = false;
        const starting = client!.startShare({ ...input, showCaptureBorder }, onRequested);
        void starting.then(() => { acknowledged = true; });
        expect(onRequested).toHaveBeenCalledOnce();
        expect(acknowledged).toBe(false);
        await starting;
        await client!.replaceShareSource(input.shareId, input.source, input.audio, input, showCaptureBorder);
        const extension = supported ? { showCaptureBorder: showCaptureBorder ?? false, reportSourceCancellation: true } : {};
        expect(requests.at(-2)).toEqual({
          version: NATIVE_CLIENT_PROTOCOL, id: expect.any(String), type: "start-share", ...input, ...extension,
          ...(supported ? { remoteInput: true } : {}),
        });
        expect(requests.at(-1)).toEqual({
          version: NATIVE_CLIENT_PROTOCOL, id: expect.any(String), type: "replace-share-source",
          shareId: input.shareId, source: input.source, audio: true, adapterIndex: 0, encoderIndex: 0, ...extension,
        });
      }
      const unsent = vi.fn();
      vi.spyOn(CaptureSocket.prototype, "send").mockImplementationOnce(() => { throw new Error("send failed"); });
      await expect(client!.startShare(input, unsent)).rejects.toMatchObject({ reason: "send-failed" });
      expect(unsent).not.toHaveBeenCalled();
      client!.close();
      await expect(client!.startShare(input, unsent)).rejects.toMatchObject({ reason: "unavailable" });
      expect(unsent).not.toHaveBeenCalled();
    } finally { client!.close(); }
  });

  it.each([false, true])("never silently drops requested audio exclusion (%s)", async (supported) => {
    const requests: Record<string, unknown>[] = [];
    class Socket extends EventTarget {
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      readyState = Socket.OPEN;
      protocol = `piik-client-v10.${health.instanceToken}`;
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      close() { this.readyState = Socket.CLOSING; }
      send(payload: string) {
        const request = JSON.parse(payload) as Record<string, unknown>;
        requests.push(request);
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
          version: NATIVE_CLIENT_PROTOCOL, id: request.id,
          ...(request.type === "hello" ? { type: "ready" } : {
            type: request.type === "start-share" ? "share-started" : "share-source-replaced", shareId: request.shareId,
            ...(request.type === "start-share" ? { audio: true, codec: "vp8", sourceAudio: true } : {}),
          }),
        }) })));
      }
    }
    vi.stubGlobal("WebSocket", Socket);
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/") });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...health,
      nativeMedia: { ...health.nativeMedia, microphone: true, ...(supported ? { processAudioExclusion: true } : {}) },
    }))));
    const client = (await NativeClient.connect())!;
    const input = { shareId: "share_123456", source: { kind: "display" as const, sourceId: "1", title: "Display" },
      audio: true, adapterIndex: 0, encoderIndex: 0, edgeCapacity: 1, profile: DEFAULT_QUALITY_SETTINGS, codec: "vp8" as const };
    const excludeAudio = { kind: "window" as const, sourceId: "2", pid: 123, creationTime: "456", title: "Voice fixture" };
    try {
      expect(client.health.nativeMedia.processAudioExclusion).toBe(supported);
      await client.startShare(input);
      expect(requests.at(-1)).not.toHaveProperty("excludeAudio");
      if (supported) {
        await client.startShare({ ...input, excludeAudio });
        await client.replaceShareSource(input.shareId, input.source, true, input, false, excludeAudio);
        expect(requests.at(-2)?.excludeAudio).toEqual(excludeAudio);
        expect(requests.at(-1)?.excludeAudio).toEqual(excludeAudio);
      } else {
        const count = requests.length;
        await expect(client.startShare({ ...input, excludeAudio })).rejects.toThrow("audio exclusion");
        await expect(client.replaceShareSource(input.shareId, input.source, true, input, false, excludeAudio)).rejects.toThrow("audio exclusion");
        expect(requests).toHaveLength(count);
      }
    } finally { client.close(); }
  });

  it.each([
    { microphone: false, shareVolume: false },
    { microphone: true, shareVolume: true },
    { microphone: false, shareVolume: true },
  ])("gates audio mixing and coalesces volume without delaying Stop (%j)", async ({ microphone, shareVolume }) => {
    const supported = microphone || shareVolume;
    const requests: Record<string, unknown>[] = [];
    let socket!: Socket;
    class Socket extends EventTarget {
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      readyState = Socket.OPEN;
      protocol = `piik-client-v10.${health.instanceToken}`;
      constructor() { super(); socket = this; queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      close() { this.readyState = Socket.CLOSING; }
      ack(request: Record<string, unknown>, type: string, fields = {}) {
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ version: 10, id: request.id, type, ...fields }) }));
      }
      send(payload: string) {
        const request = JSON.parse(payload) as Record<string, unknown>;
        requests.push(request);
        if (request.type === "set-microphone" || request.type === "set-share-volume") return;
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
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/") });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...health, nativeMedia: { ...health.nativeMedia, microphone, shareVolume },
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
        await expect(client.setShareVolume("share_123456", 2)).rejects.toThrow();
        await expect(client.microphones()).rejects.toThrow();
        expect(requests.some(request => request.type === "set-microphone")).toBe(false);
        expect(requests.some(request => request.type === "set-share-volume")).toBe(false);
        return;
      }
      if (microphone) expect(await client.microphones()).toEqual([{ id: "headset", label: "USB Headset" }]);
      else await expect(client.microphones()).rejects.toThrow();
      const volume = client.setShareVolume("share_123456", .5);
      expect(client.setShareVolume("share_123456", 2)).toBe(volume);
      const shareVolumeRequest = requests.at(-1)!;
      const microphoneVolume = microphone ? client.setMicrophoneVolume("share_123456", .4) : null;
      if (microphone) expect(client.setMicrophoneVolume("share_123456", .9)).toBe(microphoneVolume);
      const microphoneVolumeRequest = requests.at(-1)!;
      socket.ack(shareVolumeRequest, "share-volume-set");
      await vi.waitFor(() => expect(requests.at(-1)).toMatchObject({ type: "set-share-volume", volume: 2 }));
      socket.ack(requests.at(-1)!, "share-volume-set");
      await volume;
      if (!microphone) {
        expect(requests.some(request => request.type === "set-microphone")).toBe(false);
        return;
      }
      socket.ack(microphoneVolumeRequest, "microphone-set");
      await vi.waitFor(() => expect(requests.at(-1)).toMatchObject({ type: "set-microphone", volume: .9 }));
      socket.ack(requests.at(-1)!, "microphone-set");
      await microphoneVolume;
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
      protocol = `piik-client-v10.${health.instanceToken}`;
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      close() { this.readyState = Socket.CLOSING; }
      send(payload: string) {
        const request = JSON.parse(payload) as Record<string, unknown>;
        requests.push(request);
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
          version: 10, id: request.id, ...(request.type === "hello" ? { type: "ready" } : {
            type: "receive-answer", shareId: request.shareId, connectionId: request.connectionId,
            sdp: "answer", audio: false, codec: "vp8", ...(supported ? { reused: true } : {}),
          }),
        }) })));
      }
    }
    vi.stubGlobal("WebSocket", Socket);
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/") });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...health, nativeMedia: { ...health.nativeMedia, ...(supported ? { receiverReuse: true } : {}) },
    }))));
    const client = (await NativeClient.connect())!;
    try {
      const result = await client.receiveOffer("share_123456", "connection_1234", { type: "offer", sdp: "offer" }, { iceServers: [] }, 2);
      expect(requests.at(-1)).toEqual({ version: 10, id: expect.any(String), type: "receive-offer",
        shareId: "share_123456", connectionId: "connection_1234", sdp: "offer", iceServers: [], edgeCapacity: 2,
        ...(supported ? { reuseReceiver: true } : {}),
      });
      expect(result.reused).toBe(supported);
    } finally { client.close(); }
  });

  it("keeps exact positive physical identities and accepts system picker zero", () => {
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
    expect(nativeCaptureTargetSchema.safeParse({
      kind: "picker", sourceId: "0", title: "System picker",
    }).success).toBe(true);
    expect(nativeCaptureTargetSchema.safeParse({
      kind: "display", sourceId: "0", title: "Display",
    }).success).toBe(false);
    expect(nativeCaptureTargetSchema.safeParse({
      kind: "window", sourceId: "0", pid: 1234, creationTime: "134327999999999999", title: "Game",
    }).success).toBe(false);
  });

  it("fences native events by share and connection identity", () => {
    const event = {
      version: 10,
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
      version: 10,
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
      version: 10,
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
      resolution: { width: 2560, height: 1440 },
      maxFramerate: 60,
      maxBitrate: 12_000_000,
      degradationPreference: "maintain-framerate",
      maxAudioBitrate: 192000,
    };
    expect(shareStartedResponseSchema.safeParse({
      version: 10,
      id: "request_start",
      type: "share-started",
      shareId: "share_123456",
      audio: true,
      codec: "h264",
    }).success).toBe(true);
    expect(shareUpdatedResponseSchema.safeParse({
      version: 10,
      id: "request_update",
      type: "share-updated",
      shareId: "share_123456",
    }).success).toBe(true);
    expect(shareSourceReplacedResponseSchema.safeParse({
      version: 10,
      id: "request_source",
      type: "share-source-replaced",
      shareId: "share_123456",
    }).success).toBe(true);
    expect(shareUpdatedResponseSchema.safeParse({
      version: 10,
      id: "request_update",
      type: "share-updated",
      shareId: "share_123456",
      profile,
    }).success).toBe(false);
  });

  it("requires the actual Native codec instead of reporting Auto as media", () => {
    const response = {
      version: 10,
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
        version: 10, id: "request_start", type: "share-started",
        shareId: response.shareId, audio: false, codec,
      }).success).toBe(true);
    }
    expect(receiveAnswerResponseSchema.safeParse(response).success).toBe(false);
    expect(receiveAnswerResponseSchema.safeParse({ ...response, codec: "auto" }).success).toBe(false);
  });

  it("accepts only internally consistent native quality evidence", () => {
    const event = {
      version: 10,
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

  it.each(["edge-quality", "publication-quality"] as const)("isolates %s observations from control lifetime", async (type) => {
    class Socket extends EventTarget {
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static latest: Socket;
      readyState = Socket.OPEN;
      protocol = `piik-client-v10.${health.instanceToken}`;
      close = vi.fn(() => { this.readyState = Socket.CLOSING; this.dispatchEvent(new Event("close")); });
      constructor() { super(); Socket.latest = this; queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      emit(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
      send(payload: string) {
        const request = JSON.parse(payload);
        this.emit({ version: 10, id: request.id, type: request.type === "hello" ? "ready" : "pong" });
      }
    }
    vi.stubGlobal("WebSocket", Socket);
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/") });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(health)));
    const client = (await NativeClient.connect())!;
    const received = vi.fn();
    client.onEvent(received);
    const event = { version: 10, type, shareId: "share_123456", connectionId: "connection_123456",
      sampleTimestampMs: 10_000, sampleWindowMs: 2_000, rtpStatsId: "rtp-1", trackIdentifier: "screen",
      state: "healthy", reason: "none", framesPerSecond: 480, bitrateKbps: 120_000,
      availableOutgoingKbps: 1_000_000, width: 1920, height: 1080,
      ...(type === "edge-quality" ? { intervalFramesEncoded: 60 } : {
        publicationGeneration: "publication_123456", codec: "vp8", videoEncodingCount: 2,
        activeVideoEncodingCount: 2, rid: "h", intervalFramesSent: 60, audioBitrateKbps: 192,
      }),
    };
    Socket.latest.emit(event);
    expect(received).toHaveBeenLastCalledWith(event);
    Socket.latest.emit({ ...event, framesPerSecond: -1, availableOutgoingKbps: "invalid" });
    expect(received).toHaveBeenLastCalledWith({ ...event, framesPerSecond: null, availableOutgoingKbps: null });
    // Invalid identity/state never becomes evidence, but cannot retire media.
    Socket.latest.emit({ ...event, shareId: "bad", state: "degraded", reason: "none" });
    expect(received).toHaveBeenCalledTimes(2);
    await expect(client.ping()).resolves.toBeUndefined();
    expect(Socket.latest.close).not.toHaveBeenCalled();
    Socket.latest.emit({ version: 10, type: "edge-state", shareId: "bad" });
    expect(Socket.latest.close).toHaveBeenCalledWith(1008, "invalid Client message");
  });
});
