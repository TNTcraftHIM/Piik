import { afterEach, describe, expect, it, vi } from "vitest";

function browser(search = "?debug=1") {
  const page = Object.assign(new EventTarget(), {
    location: new URL(`https://private.example/r/1234${search}#v=private-grant`),
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
  }) as unknown as Window;
  vi.stubGlobal("window", page);
  vi.stubGlobal("document", { visibilityState: "visible" });
  vi.stubGlobal("navigator", { userAgent: "test-browser", language: "en", onLine: true });
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  return page;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("opt-in Browser diagnostics", () => {
  it("does no diagnostic collection without the explicit flag", async () => {
    const page = browser("");
    const debug = await import("../src/client/lib/debug");
    expect(debug.installBrowserDebug()).toBeUndefined();
    debug.debugEvent("capture", "requested", { resolution: "1080p" });
    debug.debugError("capture", "failed", new Error("private detail"));
    expect(console.info).not.toHaveBeenCalled();
    expect(page.__PIIK_DEBUG__).toBeUndefined();
  });

  it("retains error causes, stacks and technical context while removing credentials and media", async () => {
    const page = browser();
    const debug = await import("../src/client/lib/debug");
    const cleanup = debug.installBrowserDebug();
    const error = new Error('Encoding failed: {"password":"secret-password"}', {
      cause: new Error("fetch https://user:secret-auth@example.test/api?token=secret-query#secret-fragment failed; Bearer secret-bearer"),
    });
    debug.debugError("capture", "failed", error, {
      connectionId: "connection-123", address: "192.0.2.1", requested: { width: 1920, fps: 60 },
      hostToken: "secret-host", nested: { icePwd: "secret-ice", cookie: "secret-cookie", sdp: "secret-sdp", remoteSdp: "secret-remote-sdp" },
      data: "secret-pixels", payload: "secret-audio",
      viewerGrant: "secret-grant", passwordHash: "secret-hash",
      transportError: "piik-client-v9.secret-capability Basic secret-basic\nCookie: session=secret-session; refresh=secret-refresh",
    });
    const report = await page.__PIIK_DEBUG__!.export();
    for (const secret of ["secret-password", "secret-auth", "secret-query", "secret-fragment", "secret-bearer",
      "secret-host", "secret-ice", "secret-cookie", "secret-sdp", "secret-remote-sdp", "secret-pixels", "secret-audio", "private-grant",
      "secret-grant", "secret-hash", "secret-capability", "secret-basic", "secret-session", "secret-refresh"])
      expect(report).not.toContain(secret);
    for (const useful of ["Encoding failed", "fetch", "stack", "cause", "connection-123", "192.0.2.1", "1920"])
      expect(report).toContain(useful);
    cleanup?.();
  });

  it("bounds history and reports eviction, truncation, retained range and collector failure", async () => {
    const page = browser();
    const debug = await import("../src/client/lib/debug");
    debug.installBrowserDebug();
    for (let revision = 0; revision < 8_300; revision++) debug.debugEvent("signal", "route", { revision });
    const saved = page.__PIIK_DEBUG__!.events();
    expect(saved).toHaveLength(8_192);
    saved[0]!.details.revision = -1;
    expect(page.__PIIK_DEBUG__!.events()[0]!.details.revision).toBe(108);
    // Exercise the byte limit separately from the event-count limit.
    for (let index = 0; index < 1_100; index++) debug.debugEvent("capture", "state", { message: "界".repeat(9_000) });
    debug.debugError("webrtc", "collector-failed", new Error("stats unavailable"), { collector: "getStats", connectionId: "edge" });
    const report = JSON.parse(await debug.exportBrowserDebug());
    expect(report.history.retainedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(report.history.retainedEvents).toBeLessThan(1_100);
    expect(report.history.evictedEvents).toBeGreaterThan(108);
    expect(report.history.truncatedEvents).toBe(1_100);
    expect(report.history.firstSequence).toBe(report.events[0].sequence);
    expect(report.history.lastAt).toBe(report.events.at(-1).at);
    expect(report.partial).toBe(true);
    expect(report.collectorErrors).toContainEqual(expect.objectContaining({ collector: "getStats", connectionId: "edge" }));
  });

  it("returns retained evidence when optional Browser metadata never completes", async () => {
    browser();
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { userAgent: "known-browser", userAgentData: {
      getHighEntropyValues: () => new Promise(() => undefined),
    } });
    const debug = await import("../src/client/lib/debug");
    debug.debugEvent("capture", "active", { width: 1280 });
    const exporting = debug.exportBrowserDebug();
    await vi.advanceTimersByTimeAsync(1_000);
    const report = JSON.parse(await exporting);
    expect(report.environment.userAgent).toBe("known-browser");
    expect(report.events).toHaveLength(1);
    expect(report.partial).toBe(true);
    expect(report.collectorErrors[0].collector).toBe("environment");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("correlates existing RTC samples and DTLS events without adding statistics polls", async () => {
    const page = browser();
    vi.useFakeTimers();
    const debug = await import("../src/client/lib/debug");
    const rtc = await import("../src/client/lib/debug-webrtc");
    debug.installBrowserDebug();
    const transport = Object.assign(new EventTarget(), { state: "connecting" });
    const connection = Object.assign(new EventTarget(), {
      connectionState: "connecting", iceConnectionState: "checking", iceGatheringState: "complete", signalingState: "stable",
      getSenders: () => [{ transport }], getReceivers: () => [], getStats: vi.fn(),
    });
    const peer = connection as unknown as RTCPeerConnection;
    rtc.observeDebugConnection(peer, { connectionId: "local-edge", role: "send" });
    transport.state = "connected";
    transport.dispatchEvent(new Event("statechange"));
    rtc.debugRtcStats(peer, new Map([
      ["video", { id: "video", type: "outbound-rtp", framesEncoded: 60, totalEncodeTime: 0.3 }],
      ["codec", { id: "codec", type: "codec", mimeType: "video/H264", sdpFmtpLine: "packetization-mode=1;profile-level-id=42e01f" }],
      ["private", { id: "private", type: "certificate", base64Certificate: "private-certificate" }],
    ]) as unknown as RTCStatsReport);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(connection.getStats).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const history = page.__PIIK_DEBUG__!.events();
    expect(history.filter((event) => event.scope === "webrtc").every((event) => event.details.connectionId === "local-edge")).toBe(true);
    expect(history).toContainEqual(expect.objectContaining({ event: "dtls-state", details: expect.objectContaining({ state: "connected" }) }));
    const report = await debug.exportBrowserDebug();
    expect(report).toContain("framesEncoded");
    expect(report).toContain("packetization-mode=1;profile-level-id=42e01f");
    expect(report).not.toContain("private-certificate");
  });

  it("correlates actual Native request and response using their existing wire identity", async () => {
    const page = browser();
    const token = "x".repeat(43);
    class Socket extends EventTarget {
      static OPEN = 1; static CLOSING = 2;
      readyState = 1; protocol = `piik-client-v9.${token}`;
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      close() { this.readyState = 3; }
      send(raw: string) {
        const request = JSON.parse(raw);
        queueMicrotask(() => this.dispatchEvent(Object.assign(new Event("message"), {
          data: JSON.stringify({ version: 9, id: request.id,
            type: request.type === "hello" ? "ready" : "share-updated",
            ...(request.shareId ? { shareId: request.shareId } : {}) }),
        })));
      }
    }
    vi.stubGlobal("WebSocket", Socket);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      protocol: 9, service: "piik-client", port: 39721, instanceToken: token,
      nativeMedia: { video: true, processAudio: false, systemAudio: true, hardwareH264: true, softwareVP8: true },
    }), { status: 200 })));
    const debug = await import("../src/client/lib/debug");
    debug.installBrowserDebug();
    const { NativeClient } = await import("../src/client/native/client");
    const { DEFAULT_QUALITY_SETTINGS } = await import("../src/shared/protocol");
    const client = await NativeClient.connect();
    expect(client).not.toBeNull();
    try { await client!.updateShare("share_123456", DEFAULT_QUALITY_SETTINGS); }
    finally { client!.close(); }
    const history = page.__PIIK_DEBUG__!.events().filter((event) => event.details.type === "update-share");
    expect(history.map((event) => event.event)).toEqual(["request", "response"]);
    expect(history[1]!.details.requestId).toBe(history[0]!.details.requestId);
    expect(history[1]!.details.durationMs).toBeGreaterThanOrEqual(0);
    expect(history[0]!.details.requested).toMatchObject({ profile: DEFAULT_QUALITY_SETTINGS });
    expect(await debug.exportBrowserDebug()).not.toContain(token);
  });

  it("reports an observed App mismatch without exposing its capability token", async () => {
    const page = browser();
    const token = "x".repeat(43);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      protocol: 8, service: "piik-client", port: 39721, instanceToken: token,
    }))));
    const debug = await import("../src/client/lib/debug");
    debug.installBrowserDebug();
    const { NativeClient } = await import("../src/client/native/client");
    await expect(NativeClient.connect()).rejects.toMatchObject({ name: "NativeCompatibilityError" });
    expect(page.__PIIK_DEBUG__!.events()).toContainEqual(expect.objectContaining({
      scope: "native", event: "incompatible", details: { actualProtocol: 8, expectedProtocol: 9 },
    }));
    expect(await debug.exportBrowserDebug()).not.toContain(token);
  });
});
