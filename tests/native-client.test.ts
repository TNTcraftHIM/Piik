import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { NATIVE_CLIENT_PORT_START, NATIVE_CLIENT_PORT_END } from "../src/client/native/discovery-ports";
import { channelAppDiscovery, discoverChannelAppHealth, nativeConnectionMetricsSchema } from "../src/client/channel/app-link";

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

it("Native metrics retain unknown measurements and reject unscoped response fields", () => {
  const id = crypto.randomUUID();
  const value = { sessionId: id, bindingId: id, connections: [{ pairId: id, connectionId: id, peerId: id,
    sampleTimestampMs: null, ageMs: null, rttMs: null, bweBps: null,
    streams: [{ flowId: id, publicationId: id, selected: false, direction: "receive", media: "audio",
      mid: "sound", rid: null, codec: null, sampleTimestampMs: 500, ageMs: 20, bytes: 100, packets: 2,
      rttMs: null, lossFraction: null, jitterMs: null }] }] };
  expect(nativeConnectionMetricsSchema.parse(value)).toEqual(value);
  expect(nativeConnectionMetricsSchema.safeParse({ ...value, address: "private" }).success).toBe(false);
  expect(nativeConnectionMetricsSchema.safeParse({ ...value, connections: [{ ...value.connections[0], streams: [
    { ...value.connections[0].streams[0], sampleTimestampMs: -1 },
  ] }] }).success).toBe(false);
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

describe("current App discovery", () => {
  const health = { service: "piik-channel-app", protocol: 1, port: NATIVE_CLIENT_PORT_START, token: "fixture-token" };

  it("discovers with caller cancellation when AbortSignal.any is unavailable", async () => {
    vi.spyOn(AbortSignal, "any").mockImplementation(() => { throw new TypeError("AbortSignal.any is not a function"); });
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("http://127.0.0.1:8787/") });
    const fetcher = vi.fn(async (url: string) => {
      if (new URL(url).port !== String(health.port)) throw new TypeError("No listener");
      return new Response(JSON.stringify(health));
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(discoverChannelAppHealth({ signal: new AbortController().signal })).resolves.toMatchObject({ port: health.port });
    expect(fetcher).toHaveBeenCalled();
  });

  it("discovers only a local approval page without opening native control", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/r/9527") });
    const socket = vi.fn();
    vi.stubGlobal("WebSocket", socket);
    const fetcher = vi.fn(async (url: string) => url === `http://127.0.0.1:${health.port}/connect-discovery`
      ? new Response(JSON.stringify({ ...health, connectURL: "http://127.0.0.1:54321/client" }))
      : new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(channelAppDiscovery.connect()).resolves.toBe("http://127.0.0.1:54321/client?site=https%3A%2F%2Fpiik.example");
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
    await expect(channelAppDiscovery.connect()).resolves.toBeNull();
  });

  it.each([false, true])("cancels the whole approval scan with its caller (permission prompt: %s)", async prompting => {
    vi.spyOn(AbortSignal, "any").mockImplementation(() => { throw new TypeError("AbortSignal.any is not a function"); });
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/") });
    if (prompting) vi.stubGlobal("navigator", { permissions: {
      query: vi.fn().mockResolvedValue(Object.assign(new EventTarget(), { state: "prompt" })),
    } });
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      const signal = init.signal!;
      signals.push(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })));
    const controller = new AbortController();
    const result = channelAppDiscovery.connect(controller.signal);
    await vi.waitFor(() => expect(signals).toHaveLength(NATIVE_CLIENT_PORT_END - NATIVE_CLIENT_PORT_START + 1));
    controller.abort();
    await expect(result).resolves.toBeNull();
    expect(signals).toHaveLength(NATIVE_CLIENT_PORT_END - NATIVE_CLIENT_PORT_START + 1);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  it.each(["prompt", "denied"] as const)("does not hold Viewer reception for %s permission and observes a later grant", async (state) => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: { hostname: "piik.example" } });
    const query = vi.fn().mockResolvedValue({ state });
    vi.stubGlobal("navigator", { permissions: { query } });
    const fetcher = vi.fn(async () => new Response(JSON.stringify(health)));
    vi.stubGlobal("fetch", fetcher);
    const socket = vi.fn();
    vi.stubGlobal("WebSocket", socket);

    await expect(discoverChannelAppHealth({ waitForPermission: false })).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(socket).not.toHaveBeenCalled();
    query.mockResolvedValue({ state: "granted" });
    await expect(discoverChannelAppHealth({ waitForPermission: false })).resolves.toMatchObject({ port: health.port });
  });

  it("still lets explicit source discovery ask for local permission", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: { hostname: "piik.example" } });
    const query = vi.fn().mockResolvedValue(Object.assign(new EventTarget(), { state: "prompt" }));
    vi.stubGlobal("navigator", { permissions: { query } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(health))));
    await expect(discoverChannelAppHealth()).resolves.toMatchObject({ port: health.port });
    expect(query).toHaveBeenCalledOnce();
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])("keeps App Local reception on %s available without cross-address-space consent", async (hostname) => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: { hostname } });
    const query = vi.fn().mockResolvedValue({ state: "prompt" });
    vi.stubGlobal("navigator", { permissions: { query } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(health))));
    await expect(discoverChannelAppHealth({ waitForPermission: false })).resolves.toMatchObject({ port: health.port });
    expect(query).not.toHaveBeenCalled();
  });

  it("uses the older combined permission when split permission is unsupported", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: { hostname: "piik.example" } });
    const query = vi.fn().mockRejectedValueOnce(new TypeError("Unsupported permission"))
      .mockResolvedValue({ state: "prompt" });
    vi.stubGlobal("navigator", { permissions: { query } });
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(discoverChannelAppHealth({ waitForPermission: false })).resolves.toBeNull();
    expect(query).toHaveBeenLastCalledWith({ name: "local-network-access" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([undefined, { query: vi.fn().mockRejectedValue(new TypeError("Unsupported permission")) }])(
    "retains ordinary discovery when local permissions cannot be queried",
    async (permissions) => {
      vi.stubGlobal("window", { setTimeout, clearTimeout, location: { hostname: "piik.example" } });
      vi.stubGlobal("navigator", { permissions });
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(health))));
      await expect(discoverChannelAppHealth({ waitForPermission: false })).resolves.toMatchObject({ port: health.port });
    },
  );

  it("prefers a compatible App on a later port after observing an incompatible App", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/") });
    const fetcher = vi.fn(async (url: string) => {
      const port = Number(new URL(url).port);
      return new Response(JSON.stringify({ ...health, port,
        protocol: port === health.port ? 1 + 1 : 1,
      }));
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(discoverChannelAppHealth()).resolves.toMatchObject({
      protocol: 1, port: NATIVE_CLIENT_PORT_START + 1,
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
    const discovery = discoverChannelAppHealth();
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(discovery).resolves.toMatchObject({ port: health.port });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not spend the discovery deadline while the user decides local permission", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/") });
    const permission = Object.assign(new EventTarget(), { state: "prompt" as PermissionState });
    const query = vi.fn().mockResolvedValue(permission);
    const remove = vi.spyOn(permission, "removeEventListener");
    vi.stubGlobal("navigator", { permissions: { query } });
    let respond!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string, options: RequestInit) => {
      if (Number(new URL(url).port) !== health.port) return Promise.reject(new TypeError("No listener"));
      return new Promise<Response>((resolve, reject) => {
        respond = resolve;
        options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
      });
    }));
    const settled = vi.fn();
    const discovery = discoverChannelAppHealth().then(settled);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(settled).not.toHaveBeenCalled();
    permission.state = "granted";
    permission.dispatchEvent(new Event("change"));
    respond(Response.json(health));
    await discovery;
    expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ port: health.port }));
    expect(query).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("change", expect.any(Function));
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
    await expect(discoverChannelAppHealth()).resolves.toMatchObject({ port: health.port + 1 });
    expect(silentSignal?.aborted).toBe(true);
  });

  it.each(["unsupported", "grant", "response"])("bounds silent discovery ports with one network deadline after %s", async mode => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "any").mockImplementation(() => { throw new TypeError("AbortSignal.any is not a function"); });
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/") });
    const permission = Object.assign(new EventTarget(), { state: "prompt" as PermissionState });
    if (mode !== "unsupported") vi.stubGlobal("navigator", { permissions: { query: vi.fn().mockResolvedValue(permission) } });
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
      signals.push(options.signal!);
      if (mode === "response" && Number(new URL(url).port) === health.port) return new Response(null, { status: 403 });
      return new Promise<Response>((_resolve, reject) => {
        options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }));
    const discovery = discoverChannelAppHealth({ signal: new AbortController().signal });
    if (mode === "grant") {
      await vi.advanceTimersByTimeAsync(12_000);
      expect(signals.every(signal => !signal.aborted)).toBe(true);
      permission.state = "granted";
      permission.dispatchEvent(new Event("change"));
    }
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(discovery).resolves.toBeNull();
    expect(signals).toHaveLength(NATIVE_CLIENT_PORT_END - NATIVE_CLIENT_PORT_START + 1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not wait for a permission decision when every discovery port rejects", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/") });
    const permission = Object.assign(new EventTarget(), { state: "prompt" });
    const remove = vi.spyOn(permission, "removeEventListener");
    vi.stubGlobal("navigator", { permissions: { query: vi.fn().mockResolvedValue(permission) } });
    const fetcher = vi.fn().mockRejectedValue(new TypeError("No listener"));
    vi.stubGlobal("fetch", fetcher);
    await expect(discoverChannelAppHealth()).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(NATIVE_CLIENT_PORT_END - NATIVE_CLIENT_PORT_START + 1);
    expect(remove).toHaveBeenCalledWith("change", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains the hosted address-space hint without a no-hint fallback", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/") });
    vi.stubGlobal("navigator", { permissions: { query: vi.fn().mockResolvedValue({ state: "granted" }) } });
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json(health));
    vi.stubGlobal("fetch", fetcher);
    await expect(discoverChannelAppHealth()).resolves.toMatchObject({ port: health.port });
    expect(fetcher.mock.calls.every(call => (call[1] as RequestInit & { targetAddressSpace: string }).targetAddressSpace === "loopback")).toBe(true);
    fetcher.mockImplementation(() => { throw new TypeError("Unsupported IPAddressSpace"); });
    fetcher.mockClear();
    await expect(discoverChannelAppHealth()).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(NATIVE_CLIENT_PORT_END - NATIVE_CLIENT_PORT_START + 1);
    expect(fetcher.mock.calls.every(call => (call[1] as RequestInit & { targetAddressSpace: string }).targetAddressSpace === "loopback")).toBe(true);
  });

  it("identifies an incompatible App before reading its protocol-specific metadata", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("http://127.0.0.1/") });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => Response.json({
      service: "piik-channel-app", protocol: 2, port: Number(new URL(input).port), token: { format: "different-protocol" },
    })));
    await expect(discoverChannelAppHealth().catch(error => channelAppDiscovery.isIncompatible(error))).resolves.toBe(true);
  });

  it("treats denied, absent and malformed endpoints as ordinary Browser-only operation", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/") });
    const malformed = [
      { ...health, service: "another-service" },
      { ...health, protocol: "8" },
      { ...health, token: 42 },
      { ...health, token: undefined },
      { ...health, protocol: 8, port: NATIVE_CLIENT_PORT_END },
    ];
    let responseIndex = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      const body = malformed[responseIndex++];
      if (body) return new Response(JSON.stringify(body));
      if (responseIndex % 2 === 0) return new Response(null, { status: 403 });
      throw new TypeError("Network unavailable");
    }));
    await expect(discoverChannelAppHealth()).resolves.toBeNull();
  });
});

describe("published Native wire", () => {
  const health = {
    protocol: NATIVE_CLIENT_PROTOCOL,
    service: "piik-client",
    port: NATIVE_CLIENT_PORT_START,
    instanceToken: "a".repeat(43),
    nativeMedia: { video: true, hardwareH264: true },
  };

  it("preserves the published strict failure reader for requests without cancellation opt-in", () => {
    const published = z.object({ version: z.literal(10), id: z.string(), type: z.literal("request-failed"), code: z.literal("operation-failed") }).strict();
    const legacy = { version: 10, id: "request_start", type: "request-failed", code: "operation-failed" };
    expect(published.safeParse(legacy).success).toBe(true);
    expect(requestFailedResponseSchema.safeParse(legacy).success).toBe(true);
    const optedIn = { ...legacy, code: "source-canceled" };
    expect(published.safeParse(optedIn).success).toBe(false);
    expect(requestFailedResponseSchema.safeParse(optedIn).success).toBe(true);
  });

  it("requires the controlled App platform in remote-control state", () => {
    const event = { version: NATIVE_CLIENT_PROTOCOL, type: "remote-control-state", shareId: "share_123456", mode: "off", requests: [] };
    expect(nativeEventSchema.safeParse(event).success).toBe(false);
    for (const platform of ["windows", "darwin", "linux"]) {
      expect(nativeEventSchema.parse({ ...event, platform })).toMatchObject({ platform });
    }
    expect(nativeEventSchema.safeParse({ ...event, platform: "unknown" }).success).toBe(false);
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
});
