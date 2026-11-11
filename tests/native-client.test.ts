import { afterEach, describe, expect, it, vi } from "vitest";

import { NATIVE_CLIENT_PORT_START, NATIVE_CLIENT_PORT_END } from "../src/client/native/discovery-ports";
import { channelAppDiscovery, discoverChannelAppHealth, nativeConnectionMetricsSchema } from "../src/client/channel/app-link";
import { CHANNEL_PROTOCOL } from "../src/client/channel/protocol";

import { nativeCaptureTargetSchema, nativeVideoCodecSchema, remoteControlStateSchema } from "../src/client/native/wire";

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
      outputId: null, mid: "sound", rid: null, codec: null, sampleTimestampMs: 500, ageMs: 20, bytes: 100, packets: 2,
      rttMs: null, lossFraction: null, jitterMs: null }] }] };
  expect(nativeConnectionMetricsSchema.parse(value)).toEqual(value);
  expect(nativeConnectionMetricsSchema.safeParse({ ...value, address: "private" }).success).toBe(false);
  expect(nativeConnectionMetricsSchema.safeParse({ ...value, connections: [{ ...value.connections[0], streams: [
    { ...value.connections[0].streams[0], sampleTimestampMs: -1 },
  ] }] }).success).toBe(false);
  expect(nativeConnectionMetricsSchema.safeParse({ ...value, connections: [{ ...value.connections[0], streams: [
    { ...value.connections[0].streams[0], outputId: undefined },
  ] }] }).success).toBe(false);
});

it("discovers the room App independently of v10 media control and checks health after approval", async () => {
  vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://channel.example/") });
  let approved = false;
  vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
    const url = new URL(raw), port = Number(url.port);
    if (port === NATIVE_CLIENT_PORT_START) return Response.json({ service: "piik-client", protocol: 10, port });
    if (port !== NATIVE_CLIENT_PORT_START + 1) throw new TypeError("No listener");
    const identity = { service: "piik-channel-app", protocol: 7, domainProtocol: CHANNEL_PROTOCOL, port };
    if (url.pathname === "/connect-discovery") return Response.json({ ...identity, connectURL: `http://127.0.0.1:${port}/client` });
    return approved ? Response.json({ ...identity, token: "instance-token" }) : new Response(null, { status: 403 });
  }));
  await expect(channelAppDiscovery.connect()).resolves.toBe(`http://127.0.0.1:${NATIVE_CLIENT_PORT_START + 1}/client?site=https%3A%2F%2Fchannel.example`);
  await expect(discoverChannelAppHealth().catch(error => channelAppDiscovery.isIncompatible(error))).resolves.toBe(true);
  approved = true;
  await expect(discoverChannelAppHealth()).resolves.toMatchObject({ protocol: 7, port: NATIVE_CLIENT_PORT_START + 1, token: "instance-token" });
});

it("uses an explicit non-secret App port outside the default scan range", async () => {
  const page = { setTimeout, clearTimeout, location: new URL("https://channel.example/?piik-client-port=48995#piik-client=1"),
    history: { state: null, replaceState: vi.fn() } };
  vi.stubGlobal("window", page);
  const bootstrap = await import("../src/client/lib/app-launch");
  bootstrap.takeClientLaunchBootstrap();
  try {
    const fetcher = vi.fn(async () => Response.json({ service: "piik-channel-app", protocol: 7, domainProtocol: CHANNEL_PROTOCOL, port: 48995, token: "instance-token" }));
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
  const health = { service: "piik-channel-app", protocol: 7, domainProtocol: CHANNEL_PROTOCOL, port: NATIVE_CLIENT_PORT_START, token: "fixture-token" };

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
        protocol: port === health.port ? health.protocol + 1 : health.protocol,
      }));
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(discoverChannelAppHealth()).resolves.toMatchObject({
      protocol: 7, port: NATIVE_CLIENT_PORT_START + 1,
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

  it.each([1, 2, 3, 4, 5, 6, 8])("identifies incompatible App protocol %s before reading its metadata", async protocol => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("http://127.0.0.1/") });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => Response.json({
      service: "piik-channel-app", protocol, port: Number(new URL(input).port), token: { format: "different-protocol" },
    })));
    await expect(discoverChannelAppHealth().catch(error => channelAppDiscovery.isIncompatible(error))).resolves.toBe(true);
  });

  it.each(["health", "connect"] as const)("identifies the public 2.x App through %s without using its control protocol", async method => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("http://127.0.0.1/") });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => Response.json({
      service: "piik-client", protocol: 10, port: Number(new URL(input).port), instanceToken: "fixture-token",
    })));
    await expect(channelAppDiscovery[method]().catch(error => channelAppDiscovery.isIncompatible(error))).resolves.toBe(true);
  });

  it.each([undefined, CHANNEL_PROTOCOL - 1])("rejects App control with mismatched domain protocol %s before approval", async domainProtocol => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("http://127.0.0.1/") });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const port = Number(new URL(input).port);
      return Response.json({ ...health, port, domainProtocol, connectURL: `http://127.0.0.1:${port}/client` });
    }));
    for (const method of ["health", "connect"] as const)
      await expect(channelAppDiscovery[method]().catch(error => channelAppDiscovery.isIncompatible(error))).resolves.toBe(true);
  });

  it("treats denied, absent and malformed endpoints as ordinary Browser-only operation", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout, location: new URL("https://piik.example/") });
    const malformed = [
      { ...health, service: "another-service" },
      { ...health, service: "piik-client", protocol: "10" },
      { ...health, service: "piik-client", protocol: 10, port: NATIVE_CLIENT_PORT_END },
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

describe("Native capture and input schemas", () => {
  it("requires the controlled App platform in remote-control state", () => {
    const state = { mode: "off", requests: [] };
    expect(remoteControlStateSchema.safeParse(state).success).toBe(false);
    for (const platform of ["windows", "darwin", "linux"]) {
      expect(remoteControlStateSchema.parse({ ...state, platform })).toMatchObject({ platform });
    }
    expect(remoteControlStateSchema.safeParse({ ...state, platform: "unknown" }).success).toBe(false);
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

  it("requires an actual Native codec instead of Auto", () => {
    for (const codec of ["h264", "vp8"]) expect(nativeVideoCodecSchema.parse(codec)).toBe(codec);
    expect(nativeVideoCodecSchema.safeParse(undefined).success).toBe(false);
    expect(nativeVideoCodecSchema.safeParse("auto").success).toBe(false);
  });
});
