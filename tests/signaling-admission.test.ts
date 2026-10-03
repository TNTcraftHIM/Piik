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
