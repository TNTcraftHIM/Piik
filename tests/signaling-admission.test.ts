import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignalingClient } from "../src/client/lib/signaling";
import { DEFAULT_ROUTE_POLICY } from "../src/shared/protocol";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function fixture(role: "host" | "viewer" = "host") {
  vi.useFakeTimers();
  const sockets: Socket[] = [];
  class Socket extends EventTarget {
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    readyState = 1;
    send = vi.fn();
    close = vi.fn();
    constructor() { super(); sockets.push(this); }
    receive(message: object) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("window", { location: new URL("https://share.test/"), setTimeout, clearTimeout });
  const events = { onMessage: vi.fn(), onStatus: vi.fn(), onAccessRequired: vi.fn(), onTerminated: vi.fn() };
  const identity = { roomId: "9527", clientId: "test_client_12345678" };
  const signal = new SignalingClient(role === "host"
    ? { ...identity, role, token: "h".repeat(43), roomSession: true,
      shareGeneration: "share_generation_12345678", routePolicy: DEFAULT_ROUTE_POLICY }
    : { ...identity, role }, events, Date.now, { roomInteractions: true });
  signal.start();
  sockets[0]!.dispatchEvent(new Event("open"));
  const reject = (code = "AUTH_REQUIRED") => {
    // Human-readable text is not a second authentication protocol.
    sockets[0]!.receive({ type: "error", code, message: "Authentication unavailable" });
    sockets[0]!.dispatchEvent(Object.assign(new Event("close"), { code: 4003 }));
  };
  return { signal, sockets, events, reject };
}

describe("room authentication and site admission", () => {
  it("replays only this page's relay intent after the authenticated page's ordinary capacity report", async () => {
    const { signal, sockets, events } = fixture("viewer");
    const wire = JSON.parse(readFileSync(new URL("./fixtures/wire-samples.json", import.meta.url), "utf8"));
    const authenticated = JSON.parse(wire.serverMessages.find(
      (sample: { name: string }) => sample.name === "authenticated-viewer-minimal").json);
    events.onMessage.mockImplementation(message => {
      if (message.type === "authenticated") signal.send({ type: "relay-capacity", downstreamEdges: 3 });
    });
    sockets[0]!.receive(authenticated);
    expect(signal.relayVolunteerRequest).toBeNull();
    expect(sockets[0]!.send.mock.calls.map(([raw]) => JSON.parse(raw).type)).not.toContain("set-relay-volunteer");
    expect(signal.setRelayVolunteer(true, 20)).toBe(true);
    sockets[0]!.receive({ type: "relay-volunteer", enabled: true, capacity: 20 });
    for (const enabled of [true, false]) {
      if (!enabled) {
        signal.setRelayVolunteer(false, 20);
        // An earlier enabled acknowledgement must not restore consent while
        // the newer withdrawal is in flight or replay it after socket loss.
        sockets.at(-1)!.receive({ type: "relay-volunteer", enabled: true, capacity: 20 });
        expect(signal.relayVolunteerRequest?.enabled).toBe(false);
        sockets.at(-1)!.receive({ type: "relay-volunteer", enabled: false, capacity: 2 });
      }
      sockets.at(-1)!.dispatchEvent(Object.assign(new Event("close"), { code: 1006 }));
      await vi.advanceTimersByTimeAsync(800);
      const socket = sockets.at(-1)!;
      socket.dispatchEvent(new Event("open"));
      socket.receive(authenticated);
      const reports = socket.send.mock.calls.map(([raw]) => JSON.parse(raw)).filter(message =>
        message.type === "relay-capacity" || message.type === "set-relay-volunteer");
      expect(reports).toEqual([
        { type: "relay-capacity", downstreamEdges: 3 },
        { type: "set-relay-volunteer", enabled, capacity: 20 },
      ]);
    }
    signal.stop();
    expect(signal.relayVolunteerRequest).toBeNull();
  });

  it("publishes collaboration only after capability discovery and clears it across shares", () => {
    const wire = JSON.parse(readFileSync(new URL("./fixtures/wire-samples.json", import.meta.url), "utf8"));
    const auth = (role: string) => JSON.parse(wire.serverMessages.find(
      (sample: { name: string }) => sample.name === `authenticated-${role}-minimal`).json);
    const host = fixture("host");
    const authenticated = auth("host");
    const grants = [{ endpointId: "1".repeat(32), device: "gamepad" as const }];
    host.sockets[0]!.receive(authenticated);
    host.signal.setCoPlayGrants(grants);
    expect(host.sockets[0]!.send.mock.calls.some(([raw]) => JSON.parse(raw).type === "set-co-play-presence")).toBe(false);
    host.signal.enableCoPlayPresence();
    expect(host.sockets[0]!.send).toHaveBeenCalledWith(JSON.stringify({ type: "set-co-play-presence", shareGeneration: authenticated.shareGeneration, grants }));
    host.signal.stopSharing(authenticated.shareGeneration);
    host.signal.startSharing("next_coplay_generation", authenticated.qualitySettings, DEFAULT_ROUTE_POLICY);
    host.sockets[0]!.receive({ type: "sharing-started", shareGeneration: "next_coplay_generation",
      routePolicy: DEFAULT_ROUTE_POLICY, routeRevision: authenticated.routeRevision,
      routeAssignment: authenticated.routeAssignment, qualitySettings: authenticated.qualitySettings, paused: false });
    expect(host.sockets[0]!.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "set-co-play-presence", shareGeneration: "next_coplay_generation", grants: [] }));
    host.signal.stop();
    const viewer = fixture("viewer");
    viewer.sockets[0]!.receive(auth("viewer"));
    viewer.signal.enableCoPlayPresence();
    expect(viewer.sockets[0]!.send).toHaveBeenCalledWith(JSON.stringify({ type: "subscribe-co-play-presence" }));
    viewer.signal.stop();
  });

  it("opts into audio presence after discovery and replays subscriptions and Host intent on reconnect", async () => {
    const wire = JSON.parse(readFileSync(new URL("./fixtures/wire-samples.json", import.meta.url), "utf8"));
    const auth = (role: string) => JSON.parse(wire.serverMessages.find(
      (sample: { name: string }) => sample.name === `authenticated-${role}-minimal`).json);
    const viewer = fixture("viewer");
    viewer.sockets[0]!.receive(auth("viewer"));
    expect(viewer.sockets[0]!.send.mock.calls.some(([raw]) => JSON.parse(raw).type === "subscribe-audio-presence")).toBe(false);
    viewer.signal.enableAudioPresence();
    expect(viewer.sockets[0]!.send).toHaveBeenCalledWith(JSON.stringify({ type: "subscribe-audio-presence" }));
    viewer.sockets[0]!.dispatchEvent(Object.assign(new Event("close"), { code: 1006 }));
    await vi.advanceTimersByTimeAsync(800);
    viewer.sockets[1]!.dispatchEvent(new Event("open"));
    viewer.sockets[1]!.receive(auth("viewer"));
    expect(viewer.sockets[1]!.send).toHaveBeenCalledWith(JSON.stringify({ type: "subscribe-audio-presence" }));
    viewer.signal.stop();

    const host = fixture();
    host.signal.setAudioAvailable(false);
    const authenticated = { ...auth("host"), shareGeneration: "share_generation_12345678" };
    host.sockets[0]!.receive(authenticated);
    expect(host.sockets[0]!.send.mock.calls.some(([raw]) => JSON.parse(raw).type === "set-audio-presence")).toBe(false);
    host.signal.enableAudioPresence();
    host.signal.setAudioAvailable(true);
    const intent = { type: "set-audio-presence", shareGeneration: authenticated.shareGeneration, available: true };
    expect(host.sockets[0]!.send).toHaveBeenLastCalledWith(JSON.stringify(intent));
    host.sockets[0]!.dispatchEvent(Object.assign(new Event("close"), { code: 1006 }));
    host.signal.setAudioAvailable(false);
    await vi.advanceTimersByTimeAsync(800);
    host.sockets[1]!.dispatchEvent(new Event("open"));
    host.sockets[1]!.receive(authenticated);
    expect(host.sockets[1]!.send).toHaveBeenCalledWith(JSON.stringify({ ...intent, available: false }));
    host.signal.stopSharing(authenticated.shareGeneration);
    host.signal.startSharing("next_audio_generation", authenticated.qualitySettings, DEFAULT_ROUTE_POLICY);
    host.signal.setAudioAvailable(true);
    const next = { ...intent, shareGeneration: "next_audio_generation" };
    expect(host.sockets[1]!.send).not.toHaveBeenCalledWith(JSON.stringify(next));
    host.sockets[1]!.receive({ type: "sharing-started", shareGeneration: "next_audio_generation",
      routePolicy: DEFAULT_ROUTE_POLICY, routeRevision: authenticated.routeRevision,
      routeAssignment: authenticated.routeAssignment, qualitySettings: authenticated.qualitySettings, paused: false });
    expect(host.sockets[1]!.send).toHaveBeenCalledWith(JSON.stringify(next));
    host.signal.stop();
  });

  it("restores Viewer route preference after discovery and reconnects with the acknowledged choice", async () => {
    const { signal, sockets, events } = fixture("viewer");
    const wire = JSON.parse(readFileSync(new URL("./fixtures/wire-samples.json", import.meta.url), "utf8"));
    const authenticated = JSON.parse(wire.serverMessages.find(
      (sample: { name: string }) => sample.name === "authenticated-viewer-minimal").json);
    expect(JSON.parse(sockets[0]!.send.mock.calls[0]![0])).not.toHaveProperty("routePreference");
    expect(signal.setViewerRoutePreference("sfu")).toBe(false);
    // Capability discovery finishes after authenticate went onto the wire.
    signal.enableViewerRouteSelection("sfu");
    sockets[0]!.receive(authenticated);
    expect(sockets[0]!.send).toHaveBeenCalledWith(JSON.stringify({ type: "set-viewer-route-preference", preference: "sfu" }));
    expect(signal.setViewerRoutePreference("p2p")).toBe(true);
    sockets[0]!.receive({ type: "viewer-route-preference", preference: "p2p", accepted: true });
    expect(signal.setViewerRoutePreference("sfu")).toBe(true);
    sockets[0]!.receive({ type: "viewer-route-preference", preference: "p2p", accepted: false });
    sockets[0]!.dispatchEvent(Object.assign(new Event("close"), { code: 1006 }));
    await vi.advanceTimersByTimeAsync(800);
    sockets[1]!.dispatchEvent(new Event("open"));
    expect(JSON.parse(sockets[1]!.send.mock.calls[0]![0])).toMatchObject({ type: "authenticate", routePreference: "p2p" });
    expect(events.onTerminated).not.toHaveBeenCalled();
    signal.stop();
  });

  it("skips an unknown reaction without interrupting chat, media messages or a pending send", () => {
    const { signal, sockets, events } = fixture();
    const interactions = signal.interactions!;
    const wire = JSON.parse(readFileSync(new URL("./fixtures/wire-samples.json", import.meta.url), "utf8"));
    const authenticated = JSON.parse(wire.serverMessages.find(
      (sample: { name: string }) => sample.name === "authenticated-host-minimal").json);
    sockets[0]!.receive(authenticated);
    sockets[0]!.receive({ type: "room-interactions-ready", serverTime: Date.now() });
    expect(interactions.send({ kind: "chat", text: "keep my draft" })).toBe(true);
    const before = interactions.getSnapshot();
    const event = { type: "room-interaction", id: "future_event_1234", requestId: before.pending!.requestId,
      occurredAt: Date.now(), sender: { peerId: authenticated.peerId, role: "host", displayName: "Friend" },
      payload: { kind: "reaction", reaction: "future-effect" } };
    sockets[0]!.receive(event);
    expect(interactions.getSnapshot()).toBe(before);
    sockets[0]!.receive({ ...event, id: "chat_event_1234", payload: { kind: "chat", text: "keep my draft" } });
    expect(interactions.getSnapshot().messages).toHaveLength(1);
    expect(interactions.getSnapshot().pending).toBeNull();
    const media = { type: "host-status", online: true, paused: false };
    sockets[0]!.receive(media);
    expect(events.onMessage).toHaveBeenCalledWith(media);
    expect(events.onTerminated).not.toHaveBeenCalled();
    expect(sockets[0]!.close).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
    signal.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps one connection when starting the room during reconnect backoff", async () => {
    const { signal, sockets, events } = fixture();
    sockets[0]!.dispatchEvent(Object.assign(new Event("close"), { code: 1006 }));
    // Starting a share reuses the room's signal and calls start() again.
    signal.start();
    const replacement = sockets[1]!;
    replacement.dispatchEvent(new Event("open"));
    await vi.advanceTimersByTimeAsync(800);
    expect(sockets).toHaveLength(2);
    expect(replacement.close).not.toHaveBeenCalled();
    expect(events.onTerminated).not.toHaveBeenCalled();
    signal.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { required: false, authenticated: true },
    { required: true, authenticated: true },
  ])("keeps Host publication intent and retries when site access is valid: %j", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(status)));
    const { signal, sockets, events, reject } = fixture();
    const interactions = signal.interactions;
    interactions!.authenticated("host_peer_12345678");
    interactions!.receive({ type: "room-interactions-ready", serverTime: Date.now() });
    interactions!.receive({ type: "room-interaction", id: "chat_event_12345678", requestId: "chat_request_12345678",
      occurredAt: Date.now(), sender: { peerId: "host_peer_12345678", role: "host", displayName: "Friend" },
      payload: { kind: "chat", text: "keep this conversation" } });
    reject();
    await vi.advanceTimersByTimeAsync(800);
    expect(events.onAccessRequired).not.toHaveBeenCalled();
    expect(events.onTerminated).not.toHaveBeenCalled();
    expect(events.onMessage).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(2);
    sockets[1]!.dispatchEvent(new Event("open"));
    expect(JSON.parse(sockets[1]!.send.mock.calls[0]![0])).toMatchObject({
      type: "authenticate", shareGeneration: "share_generation_12345678", roomSession: true,
    });
    expect(signal.interactions).toBe(interactions);
    expect(interactions!.getSnapshot().messages[0]?.payload).toEqual({ kind: "chat", text: "keep this conversation" });
    signal.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns a Host to site admission only after authoritative denial", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ required: true, authenticated: false })));
    const { signal, sockets, events, reject } = fixture();
    reject();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.onAccessRequired).toHaveBeenCalledOnce();
    expect(events.onStatus).toHaveBeenLastCalledWith("offline");
    expect(sockets).toHaveLength(1);
    signal.stop();
  });

  it("retries a Viewer authentication timeout without checking site access", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { signal, sockets, events, reject } = fixture("viewer");
    reject();
    await vi.advanceTimersByTimeAsync(800);
    expect(sockets).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(events.onAccessRequired).not.toHaveBeenCalled();
    signal.stop();
  });

  it.each([false, true])("keeps a failed or stalled access check in connection recovery (stall=%s)", async stall => {
    vi.stubGlobal("fetch", vi.fn((_url, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      if (stall) options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      else reject(new Error("offline"));
    })));
    const { signal, sockets, events, reject } = fixture();
    reject();
    await vi.advanceTimersByTimeAsync(stall ? 8_800 : 800);
    expect(sockets).toHaveLength(2);
    expect(events.onAccessRequired).not.toHaveBeenCalled();
    expect(events.onTerminated).not.toHaveBeenCalled();
    signal.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["stop", "replace"])("ignores a late site denial after %s", async action => {
    let finish!: (response: Response) => void;
    let requestSignal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, options: RequestInit) => {
      requestSignal = options.signal;
      return new Promise<Response>(resolve => { finish = resolve; });
    }));
    const { signal, sockets, events, reject } = fixture();
    reject();
    await vi.advanceTimersByTimeAsync(0);
    if (action === "stop") signal.stop();
    else signal.start();
    expect(requestSignal?.aborted).toBe(true);
    finish(Response.json({ required: true, authenticated: false }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.onAccessRequired).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(action === "stop" ? 1 : 2);
    signal.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an invalid room credential terminal", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { signal, sockets, events, reject } = fixture();
    reject("INVALID_TOKEN");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(1);
    expect(events.onMessage).toHaveBeenCalledWith(expect.objectContaining({ code: "INVALID_TOKEN" }));
    expect(fetch).not.toHaveBeenCalled();
    signal.stop();
  });
});
