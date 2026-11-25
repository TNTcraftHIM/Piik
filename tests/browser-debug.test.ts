import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  it.each(["frame", "timeout", "close"])("exports a visible playback sample on %s", async outcome => {
    browser();
    vi.useFakeTimers();
    const { observeDebugPlayback } = await import("../src/client/lib/debug-webrtc");
    const { exportBrowserDebug } = await import("../src/client/lib/debug");
    const request = vi.fn<(cb: VideoFrameRequestCallback) => number>(() => 42);
    const cancel = vi.fn();
    const video = { requestVideoFrameCallback: request, cancelVideoFrameCallback: cancel,
      getBoundingClientRect: () => ({ width: 320, height: 180 }), ownerDocument: document,
      getVideoPlaybackQuality: () => ({ totalVideoFrames: 99 }) } as unknown as HTMLVideoElement;
    const release = observeDebugPlayback(video, () => ({ source: "screen", selected: true, presentedFrame: true }));
    expect(request).not.toHaveBeenCalled();
    const pending = exportBrowserDebug();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    if (outcome === "frame") request.mock.calls[0][0](0, { presentedFrames: 75 } as VideoFrameCallbackMetadata);
    if (outcome === "timeout") await vi.advanceTimersByTimeAsync(250);
    if (outcome === "close") release();
    const report = JSON.parse(await pending);
    expect(report.partial).toBe(false);
    const events = report.events.filter((event: { scope: string }) => event.scope === "playback");
    if (outcome === "close") expect(events).toEqual([]);
    else expect(events[0].details).toMatchObject({ displayWidth: 320, displayHeight: 180,
      totalVideoFrames: 99, presentedFrames: outcome === "frame" ? 75 : null });
    if (outcome !== "frame") expect(cancel).toHaveBeenCalledWith(42);
    release();
    expect(vi.getTimerCount()).toBe(0);
  });

  describe.each([false, true])("composited frame diagnostics (opt-in %s)", enabled => {
    let media: typeof import("../src/client/channel/components/ChannelMedia");
    let debug: typeof import("../src/client/lib/debug");
    beforeEach(async () => {
      browser(enabled ? "?debug=1" : "");
      vi.stubGlobal("document", { documentElement: {}, visibilityState: "visible" });
      [media, debug] = await Promise.all([
        import("../src/client/channel/components/ChannelMedia"),
        import("../src/client/lib/debug"),
      ]);
    });

    it("exports the first composited frame only for negotiated flows", async () => {
      const stream = { id: "private-local-stream" } as MediaStream;
      const frame = vi.fn();
      for (const flow of [undefined, "flow-0"]) {
        let callback!: () => void;
        const video = Object.assign(new EventTarget(), { srcObject: stream, readyState: 4, currentTime: 0,
          requestVideoFrameCallback: (fn: () => void) => { callback = fn; return 1; } });
        const stop = media.observeChannelInputFrame(video as unknown as HTMLVideoElement, stream, flow, frame);
        callback();
        for (const event of ["resize", "enterpictureinpicture", "playing"]) video.dispatchEvent(new Event(event));
        callback(); stop();
      }
      expect(frame).toHaveBeenCalledTimes(2);
      const report = await debug.exportBrowserDebug();
      expect(report).not.toContain(stream.id);
      const events = JSON.parse(report).events.filter((event: { event: string }) => event.event === "first-composited-frame");
      expect(events.map((event: { details: unknown }) => event.details)).toEqual(enabled ? [{ flowId: "flow-0" }] : []);
    });
  });
  it.each([false, true])("3.0 transport uses the shared opt-in collector and retires it with its peer (%s)", async enabled => {
    vi.useFakeTimers();
    const page = browser(enabled ? "?debug=1" : "");
    class Connection extends EventTarget {
      connectionState = "new";
      signalingState = "stable";
      getSenders = () => [];
      getReceivers = () => [];
      getStats = vi.fn(async () => new Map([["transport", { id: "transport", type: "transport", dtlsState: "new" }]]));
      close() { this.connectionState = "closed"; }
    }
    vi.stubGlobal("RTCPeerConnection", Connection);
    const debug = await import("../src/client/lib/debug");
    const { ChannelTransport } = await import("../src/client/channel/transport");
    const release = debug.installBrowserDebug();
    const transport = new ChannelTransport({ polite: true, iceServers: [], send: vi.fn(), receive: vi.fn(),
      connected: vi.fn(), roomData: vi.fn(), failed: vi.fn() });
    const error = new Event("error");
    Object.assign(error, { error: new Error("Synthetic browser diagnostic") });
    page.dispatchEvent(error);
    const report = JSON.parse(await debug.exportBrowserDebug());
    expect(report.events.some((record: { scope: string }) => record.scope === "window")).toBe(enabled);
    expect(report.events.some((record: { event: string; details: { role?: string } }) => record.event === "stats" && record.details.role === "channel-peer")).toBe(enabled);
    const connection = transport.pc as unknown as Connection;
    expect(connection.getStats).toHaveBeenCalledTimes(enabled ? 1 : 0);
    transport.close();
    await debug.exportBrowserDebug();
    expect(connection.getStats).toHaveBeenCalledTimes(enabled ? 1 : 0);
    expect(vi.getTimerCount()).toBe(0);
    release?.();
  });

  it("records native video frame counters while retaining track facts when statistics are unavailable", async () => {
    browser();
    const debug = await import("../src/client/lib/debug");
    const { debugTrack } = await import("../src/client/lib/debug-webrtc");
    const nativeStats = Object.create({
      get deliveredFrames() { return 40; },
      get discardedFrames() { return 2; },
      get totalFrames() { return 42; },
    });
    for (const [id, stats] of [["source", nativeStats], ["unsupported", undefined], ["unavailable", null]] as const) {
      const track = { id, kind: "video", readyState: "live", enabled: true, muted: false, contentHint: "motion",
        getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }), getConstraints: () => ({}) };
      if (stats !== undefined) Object.defineProperty(track, "stats", { get: () => stats });
      debugTrack(track as unknown as MediaStreamTrack, { senderTrackId: "generated-track" });
    }
    const exported = await debug.exportBrowserDebug();
    const tracks = JSON.parse(exported).events.map((event: { details: object }) => event.details);
    expect(tracks).toEqual([
      expect.objectContaining({ trackId: "source", senderTrackId: "generated-track",
        videoFrameStats: { deliveredFrames: 40, discardedFrames: 2, totalFrames: 42 } }),
      expect.objectContaining({ trackId: "unsupported", senderTrackId: "generated-track", enabled: true,
        settings: { width: 1920, height: 1080, frameRate: 30 } }),
      expect.objectContaining({ trackId: "unavailable", senderTrackId: "generated-track", enabled: true,
        settings: { width: 1920, height: 1080, frameRate: 30 } }),
    ]);
    expect(tracks[1]).not.toHaveProperty("videoFrameStats");
    expect(tracks[2]).not.toHaveProperty("videoFrameStats");
  });

  it("distinguishes Host input failure from a local stalled queue without exporting input authority or text", async () => {
    browser();
    const debug = await import("../src/client/lib/debug");
    const { RemoteInputSession } = await import("../src/client/remote-control/input-session");
    class Channel extends EventTarget {
      readyState = "open";
      bufferedAmount = 0;
      sent: Record<string, unknown>[] = [];
      send(data: string) { this.sent.push(JSON.parse(data)); }
      close() { this.readyState = "closed"; }
      receive(data: object) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) })); }
    }
    const channel = new Channel();
    const session = new RemoteInputSession(channel as unknown as RTCDataChannel, () => {});
    const grant = "b".repeat(64);
    const activate = () => {
      channel.receive({ platform: "windows", mode: "room", state: "ready" });
      session.request();
      const intent = channel.sent.at(-1)!.intent;
      channel.receive({ platform: "windows", mode: "room", state: "active", grant, intent });
      return intent;
    };
    const first = activate();
    channel.receive({ platform: "windows", mode: "room", state: "failed", intent: first });
    expect(session.state?.state).toBe("failed");
    const second = activate();
    channel.bufferedAmount = 8193;
    session.input({ type: "text", text: "private input content" });
    expect(session.state?.state).toBe("failed");
    expect(channel.readyState).toBe("closed");
    const exported = await debug.exportBrowserDebug();
    const report = JSON.parse(exported);
    expect(report.events).toEqual([
      expect.objectContaining({ scope: "remote-input", event: "host-failed", details: { previousState: "active", mode: "room" } }),
      expect.objectContaining({ scope: "remote-input", event: "send-failed", details: expect.objectContaining({ state: "active", readyState: "open", bufferedAmount: 8193 }) }),
    ]);
    for (const value of [grant, first, second, "private input content"]) expect(exported).not.toContain(value);
    session.dispose();
  });

  it("collects current preview receive and playback evidence only at export, until owner retirement", async () => {
    browser();
    const debug = await import("../src/client/lib/debug");
    const rtc = await import("../src/client/lib/debug-webrtc");
    let decoded = 0;
    const connection = Object.assign(new EventTarget(), {
      connectionState: "connected", getSenders: () => [], getReceivers: () => [],
      getStats: vi.fn(async () => new Map([["video", {
        id: "video", type: "inbound-rtp", bytesReceived: 1234, framesDecoded: decoded,
      }]])),
    });
    const releaseConnection = rtc.observeDebugConnection(connection as unknown as RTCPeerConnection,
      { role: "native-preview", generation: 3 });
    let presentedFrame = false;
    const releasePlayback = rtc.observeDebugPlayback({
      getBoundingClientRect: () => ({ width: 0, height: 0 }),
      videoWidth: 854, videoHeight: 480, readyState: 4, paused: false, ended: false,
      getVideoPlaybackQuality: () => ({ totalVideoFrames: 7, droppedVideoFrames: 1 }),
      ownerDocument: { visibilityState: "hidden" }, src: "private-video-url", title: "private-video-title",
    } as unknown as HTMLVideoElement, () => ({ source: "screen", flowId: "flow-0", selected: true, presentedFrame }));
    presentedFrame = true;
    expect(connection.getStats).not.toHaveBeenCalled();
    decoded = 8;
    const report = JSON.parse(await debug.exportBrowserDebug());
    expect(report.partial).toBe(false);
    expect(report.events).toContainEqual(expect.objectContaining({ event: "stats", details: expect.objectContaining({
      role: "native-preview", generation: 3,
      stats: [expect.objectContaining({ framesDecoded: 8, bytesReceived: 1234 })],
    }) }));
    expect(report.events).toContainEqual(expect.objectContaining({ event: "snapshot", details: expect.objectContaining({
      source: "screen", flowId: "flow-0", selected: true, presentedFrame: true, visibility: "hidden", displayWidth: 0, displayHeight: 0, presentedFrames: null, width: 854, height: 480, totalVideoFrames: 7, droppedVideoFrames: 1,
    }) }));
    expect(JSON.stringify(report)).not.toMatch(/private-video-(url|title)/);
    connection.connectionState = "closed";
    releaseConnection(); // Browser close() need not dispatch a state-change event.
    releasePlayback();
    const retired = JSON.parse(await debug.exportBrowserDebug());
    expect(retired.events.filter((event: { event: string }) => event.event === "stats" || event.event === "snapshot")).toHaveLength(2);
    expect(connection.getStats).toHaveBeenCalledOnce();
  });

  it("bounds a stalled export snapshot without changing its media owner", async () => {
    browser();
    vi.useFakeTimers();
    const debug = await import("../src/client/lib/debug");
    const release = debug.registerDebugCollector("preview", () => new Promise(() => {}));
    const exporting = debug.exportBrowserDebug();
    await vi.advanceTimersByTimeAsync(1_000);
    const report = JSON.parse(await exporting);
    expect(report.partial).toBe(true);
    expect(report.collectorErrors).toContainEqual(expect.objectContaining({ collector: "preview" }));
    release();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps explicit diagnostics through App entry without copying source credentials", async () => {
    browser("?debug=1&token=source-secret");
    const { withBrowserDebug } = await import("../src/client/lib/debug");
    const { clientLaunchURL } = await import("../src/client/lib/app-launch");
    const launched = new URL(clientLaunchURL(
      "https://site.example/?existing=1#owner=target-owner&piik-client=1",
      { lang: "en", theme: "light" },
    ));
    expect(launched.origin).toBe("https://site.example");
    expect(launched.search).toBe("?existing=1&debug=1");
    expect(new URLSearchParams(launched.hash.slice(1)).get("owner")).toBe("target-owner");
    expect(launched.href).not.toContain("source-secret");
    expect(new URL(clientLaunchURL("https://site.example/",
      { lang: "en", theme: "light" }, false)).search).toBe("");
    expect(new URL(clientLaunchURL("https://site.example/",
      { lang: "en", theme: "light" }, true)).search).toBe("?debug=1");
    expect(withBrowserDebug("/join")).toBe("https://private.example/join?debug=1");
  });

  it("does no diagnostic collection without the explicit flag", async () => {
    const page = browser("");
    const debug = await import("../src/client/lib/debug");
    expect(debug.withBrowserDebug("/join")).toBe("/join");
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
      roomInteraction: { payload: { kind: "chat", text: "private-chat-contents" } },
      viewerGrant: "secret-grant", passwordHash: "secret-hash",
      transportError: "piik-client-v10.secret-capability Basic secret-basic\nCookie: session=secret-session; refresh=secret-refresh",
    });
    const report = await page.__PIIK_DEBUG__!.export();
    for (const secret of ["secret-password", "secret-auth", "secret-query", "secret-fragment", "secret-bearer",
      "secret-host", "secret-ice", "secret-cookie", "secret-sdp", "secret-remote-sdp", "secret-pixels", "secret-audio", "private-grant",
      "secret-grant", "secret-hash", "secret-capability", "secret-basic", "secret-session", "secret-refresh", "private-chat-contents"])
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
      ["audio-codec", { id: "audio-codec", type: "codec", mimeType: "audio/opus", clockRate: 48000, channels: 2, sdpFmtpLine: "stereo=1;sprop-stereo=1" }],
      ["voice", { id: "voice", type: "inbound-rtp", kind: "audio", codecId: "audio-codec", trackIdentifier: "received-voice", packetsReceived: 20 }],
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
    expect(report).toContain("stereo=1;sprop-stereo=1");
    expect(report).toContain("audio-codec");
    expect(report).toContain("received-voice");
    expect(report).toContain("packetization-mode=1;profile-level-id=42e01f");
    expect(report).not.toContain("private-certificate");
  });

  it("keeps selected ICE evidence when many interface pairs exceed the raw report limit", async () => {
    browser();
    const debug = await import("../src/client/lib/debug");
    const rtc = await import("../src/client/lib/debug-webrtc");
    const connection = Object.assign(new EventTarget(), { getSenders: () => [], getReceivers: () => [] });
    const peer = connection as unknown as RTCPeerConnection;
    rtc.observeDebugConnection(peer, { connectionId: "many-interfaces", role: "receive" });
    const records = new Map<string, object>();
    for (let index = 0; index < 70; index++) {
      records.set(`pair-${index}`, { type: "candidate-pair", state: "failed" });
    }
    records.set("chosen", { type: "candidate-pair", state: "succeeded",
      localCandidateId: "local", remoteCandidateId: "remote", requestsSent: 4, responsesReceived: 3 });
    records.set("local", { type: "local-candidate", candidateType: "host", protocol: "udp", address: "192.0.2.1" });
    records.set("remote", { type: "remote-candidate", candidateType: "srflx", foundation: "sp1", address: "192.0.2.2" });
    records.set("transport", { type: "transport", selectedCandidatePairId: "chosen" });
    rtc.debugRtcStats(peer, records as unknown as RTCStatsReport);
    const report = JSON.parse(await debug.exportBrowserDebug());
    const sample = report.events.find((entry: { event: string }) => entry.event === "stats");
    expect(report.partial).toBe(true);
    expect(sample.details.stats).toHaveLength(64);
    expect(sample.details.ice.pairs).toMatchObject({ total: 71, failed: 70, succeeded: 1 });
    expect(sample.details.ice.selected).toEqual([{
      state: "succeeded", dtlsState: null,
      localType: "host", remoteType: "srflx", protocol: "udp", natTraversalPath: "predicted",
      requestsSent: 4, responsesReceived: 3, currentRoundTripTime: null,
    }]);
    expect(JSON.stringify(sample.details.ice)).not.toContain("192.0.2.");
  });
});


type AudioDiagnosticEvent = { event: string; details: {
  role?: string; trackId?: string; outputTrackId?: string; gain?: number;
  settings?: { channelCount?: number }; route?: string;
} };

it.each([false, true])("microphone diagnostics distinguish raw input from the output graph and follow replacement (%s)", async enabled => {
  browser(enabled ? "?debug=1" : "");
  const debug = await import("../src/client/lib/debug");
  const { MicrophoneInput } = await import("../src/client/media/microphone-input");
  const track = (id: string, channelCount: number) => ({ id, kind: "audio", readyState: "live", enabled: true,
    muted: false, contentHint: "", onended: null, stop: vi.fn(),
    getSettings: vi.fn(() => ({ channelCount, sampleRate: 48000 })),
    getConstraints: () => ({ channelCount: { ideal: 2 }, echoCancellation: false }) });
  const input = track("raw-mono", 1), next = track("raw-stereo", 2), output = track("graph-output", 2);
  const stream = (current: ReturnType<typeof track>) => ({ getAudioTracks: () => [current], getTracks: () => [current] });
  const node = () => ({ channelCount: 2, channelCountMode: "max", connect: vi.fn(), disconnect: vi.fn() });
  const gain = { ...node(), gain: { value: .5, setTargetAtTime: vi.fn() } };
  const destination = { ...node(), stream: stream(output) };
  const context = { state: "running", sampleRate: 48000, createGain: () => gain,
    createAnalyser: () => ({ ...node(), fftSize: 256 }), createMediaStreamSource: vi.fn(node),
    createMediaStreamDestination: () => destination, close: vi.fn(async () => {}) };
  const microphone = new MicrophoneInput(stream(input) as unknown as MediaStream, context as unknown as AudioContext, .5, vi.fn());
  const first = JSON.parse(await debug.exportBrowserDebug()) as { events: AudioDiagnosticEvent[] };
  const raw = first.events.find(event => event.details.role === "microphone-input");
  expect(raw?.details.settings?.channelCount).toBe(enabled ? 1 : undefined);
  if (enabled) {
    expect(raw?.details.outputTrackId).toBe("graph-output");
    expect(first.events.find(event => event.event === "microphone-graph")?.details.gain).toBe(.5);
  }
  await microphone.configure(stream(next) as unknown as MediaStream, false);
  const second = JSON.parse(await debug.exportBrowserDebug()) as { events: AudioDiagnosticEvent[] };
  const latest = second.events.filter(event => event.details.role === "microphone-input").at(-1);
  expect(latest?.details.trackId).toBe(enabled ? "raw-stereo" : undefined);
  expect(latest?.details.settings?.channelCount).toBe(enabled ? 2 : undefined);
  microphone.close();
  expect(JSON.parse(await debug.exportBrowserDebug()).events).toHaveLength(second.events.length);
  expect(input.getSettings).toHaveBeenCalledTimes(enabled ? 1 : 0);
  expect(next.getSettings).toHaveBeenCalledTimes(enabled ? 1 : 0);
  expect(input.stop).toHaveBeenCalledOnce();
  expect(next.stop).toHaveBeenCalledOnce();
});

it("playback diagnostics distinguish native-element and gain-graph playback without changing channel policy", async () => {
  browser();
  const debug = await import("../src/client/lib/debug");
  const { ViewerAudio } = await import("../src/client/media/viewer-audio");
  class Stream {
    constructor(public tracks: unknown[]) {}
    getAudioTracks() { return this.tracks; }
  }
  vi.stubGlobal("MediaStream", Stream);
  const track = { id: "received-stereo", kind: "audio", readyState: "live", enabled: true, muted: false,
    contentHint: "", getSettings: () => ({ channelCount: 2 }), getConstraints: () => ({}) };
  const video = Object.assign(new EventTarget(), { volume: 1, muted: false, paused: false, ended: false });
  const node = { channelCount: 2, channelCountMode: "max", connect: vi.fn(), disconnect: vi.fn() };
  const context = Object.assign(new EventTarget(), { state: "running", sampleRate: 48000, destination: { channelCount: 2 },
    createGain: () => ({ ...node, gain: { value: 1 } }), createMediaStreamSource: () => ({ ...node }), close: vi.fn(async () => {}) });
  vi.stubGlobal("AudioContext", function () { return context; });
  const audio = new ViewerAudio(video as unknown as HTMLMediaElement, vi.fn());
  audio.bind(new Stream([track]) as unknown as MediaStream);
  let events = JSON.parse(await debug.exportBrowserDebug()).events as AudioDiagnosticEvent[];
  expect(events.find(event => event.event === "playback-graph")?.details.route).toBe("native-element");
  audio.setLevel(.5);
  events = JSON.parse(await debug.exportBrowserDebug()).events as AudioDiagnosticEvent[];
  const graph = events.filter(event => event.event === "playback-graph").at(-1);
  expect(graph?.details).toMatchObject({ trackId: "received-stereo", route: "web-audio", gain: .5,
    requestedLevel: .5, sourceNodeChannels: 2, destinationNodeChannels: 2 });
  audio.dispose();
  expect(JSON.parse(await debug.exportBrowserDebug()).events).toHaveLength(events.length);
});

it("exports current Core pair, flow and helper facts without borrowing a sibling's connection or frames", async () => {
  vi.useFakeTimers();
  const page = browser();
  vi.stubGlobal("location", page.location);
  vi.stubGlobal("history", { state: null });
  Object.assign(document, { documentElement: { lang: "en" } });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  class Socket { static OPEN = 1; readyState = 1; send() {} close() { this.readyState = 3; } }
  vi.stubGlobal("WebSocket", Socket);
  class Connection extends EventTarget {
    static all: Connection[] = [];
    readonly index = Connection.all.push(this) - 1;
    connectionState = this.index ? "connected" : "connecting";
    iceConnectionState = this.index ? "connected" : "checking";
    signalingState = "stable";
    decoded = 0;
    getSenders = () => [];
    getReceivers = () => [];
    getStats = vi.fn(async () => new Map([
      ["same-transport-id", { id: "same-transport-id", type: "transport", dtlsState: this.index ? "connected" : "new" }],
      ["same-rtp-id", { id: "same-rtp-id", type: "inbound-rtp", kind: "video", trackIdentifier: `track-${this.index}`,
        transportId: "same-transport-id", framesDecoded: this.decoded }],
    ]));
    close() { this.connectionState = "closed"; }
  }
  vi.stubGlobal("RTCPeerConnection", Connection);
  const debug = await import("../src/client/lib/debug");
  const { ChannelSession } = await import("../src/client/channel/session");
  const { channelConnectionPreview } = await import("../src/client/pages/ChannelConnectionsPreview");
  const state = channelConnectionPreview("both").state;
  state.publications = state.publications.filter(p => p.kind === "screen");
  state.publications[1].sessionId = "friend"; state.publications[1].userId = "friend-user";
  state.subscriptions = state.publications.map(p => p.id);
  state.publications[0].source!.name = "private window title";
  state.users[0].name = "private participant name";
  state.pairs = ["host", "friend"].map((peerId, i) => ({ id: `pair-${i}`, peerId, rooms: [], canReceiveVideoLayers: false,
    outgoing: [], incoming: [{ id: `flow-${i}`, publicationId: state.publications[i].id, selected: true, inputFlowId: null }] }));
  const session = new ChannelSession();
  session.start();
  // Feed the existing owners controlled authority/RTC boundary values; no media or network is started.
  const owner = session as unknown as { view: object; media: { update(id: string, state: unknown): void; peers: Map<string, any> } };
  Object.assign(session, { view: { ...session.getSnapshot(), state, sessionId: "self", connection: "connected" },
    watching: new Map([[state.publications[0].id, { helperSessionId: "retired-helper" }]]),
    app: { connected: true, screens: new Set(), close() {}, stopCaptures() {} } });
  owner.media.update("self", state);
  for (const [i, plan] of state.pairs.entries()) {
    const transport = owner.media.peers.get(plan.id).transport;
    transport.remoteIds.set(`stream-${i}`, `flow-${i}`);
    transport.receiving.set(`stream-${i}`, { getTracks: () => [{ id: `track-${i}` }], removeTrack() {} });
  }
  try {
    const read = async () => JSON.parse(await debug.exportBrowserDebug());
    const first = await read(), stats = first.events.filter((e: any) => e.event === "stats");
    expect(stats.map((e: any) => [e.details.sessionId, e.details.pairId, e.details.peerId]))
      .toEqual([["self", "pair-0", "host"], ["self", "pair-1", "friend"]]);
    expect(stats.map((e: any) => e.details.incoming)).toEqual([
      [{ flowId: "flow-0", trackIds: ["track-0"] }], [{ flowId: "flow-1", trackIds: ["track-1"] }],
    ]);
    const context = first.events.find((e: any) => e.event === "media-snapshot").details;
    expect(context).toMatchObject({ appControlReady: true, nativeSessionIds: [],
      watches: [{ publicationId: state.publications[0].id, helperSessionId: "retired-helper", helperOnline: false }] });
    expect(context.pairs[0].incoming[0]).toMatchObject({ id: "flow-0", publicationId: state.publications[0].id, selected: true });
    expect(first.events.filter((e: any) => e.event === "created").map((e: any) =>
      [e.details.pairId, e.details.connectionState])).toEqual([["pair-0", "connecting"], ["pair-1", "connected"]]);
    expect(stats.every((e: any) => e.details.stats.find((r: any) => r.type === "inbound-rtp").framesDecoded === 0)).toBe(true);
    Connection.all[1].decoded = 12;
    const second = await read();
    const latest = second.events.filter((e: any) => e.event === "stats").slice(-2);
    expect(latest.map((e: any) => [e.details.pairId, e.details.stats.find((r: any) => r.type === "inbound-rtp").framesDecoded]))
      .toEqual([["pair-0", 0], ["pair-1", 12]]);
    for (const secret of ["private window title", "private participant name", "private-grant"])
      expect(JSON.stringify(second)).not.toContain(secret);
    const next = { ...state, pairs: state.pairs.slice(0, 1) };
    Object.assign(owner.view, { state: next }); owner.media.update("self", next);
    await read();
    expect(Connection.all[1].getStats).toHaveBeenCalledTimes(2);
    session.close();
    const retired = await read();
    expect(retired.events.filter((e: any) => e.event === "media-snapshot")).toHaveLength(3);
    expect(Connection.all[0].getStats).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  } finally { session.close(); }
});
