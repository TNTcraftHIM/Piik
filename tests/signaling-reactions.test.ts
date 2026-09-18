import { afterEach, expect, test, vi } from "vitest";
import { SignalingClient } from "../src/client/lib/signaling";
import { getRuntimeCapabilities } from "../src/client/lib/api";
import { DEFAULT_QUALITY_SETTINGS, DEFAULT_ROUTE_POLICY, SIGNALING_PROTOCOL } from "../src/shared/protocol";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
vi.mock("../src/client/lib/api", () => ({ getRuntimeCapabilities: vi.fn() }));

test("reconnect rechecks optional capabilities without replaying throws or touching media messages", async () => {
  vi.useFakeTimers();
  vi.mocked(getRuntimeCapabilities).mockResolvedValue({ sfu: false, natPrediction: false, reactions: true });
  const sockets: Socket[] = [];
  class Socket extends EventTarget {
    static OPEN = 1;
    static CLOSING = 2;
    readyState = Socket.OPEN;
    send = vi.fn();
    close = vi.fn();
    constructor() { super(); sockets.push(this); }
    receive(message: object) {
      const event = new Event("message");
      Object.defineProperty(event, "data", { value: JSON.stringify(message) });
      this.dispatchEvent(event);
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("window", {
    location: new URL("https://piik.test/r/1234"),
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
  });
  const onMessage = vi.fn();
  const signal = new SignalingClient({ roomId: "1234", role: "viewer", clientId: "viewer-client" }, {
    onMessage, onStatus: vi.fn(), onTerminated: vi.fn(), onAccessRequired: vi.fn(),
  });
  const authenticate = (socket: Socket) => {
    socket.dispatchEvent(new Event("open"));
    socket.receive({
      type: "authenticated", protocol: SIGNALING_PROTOCOL, role: "viewer", peerId: "viewer_12345678",
      maxViewers: 20, endpointMediaCopyCapacity: 2, hostOnline: true, connectionId: null,
      mediaMode: "peer-assisted", shareGeneration: "share_12345678", routeRevision: 0,
      routeAssignment: { upstream: { kind: "none" }, childPeerIds: [], sfuPublicationGeneration: null },
      qualitySettings: DEFAULT_QUALITY_SETTINGS, routePolicy: DEFAULT_ROUTE_POLICY,
      iceConfig: { iceServers: [], natPredictionStunUrls: [] }, codeEntryPolicy: "open",
      viewerAuthorizationGeneration: "viewer_generation_12345678",
    });
  };
  signal.start();
  authenticate(sockets[0]);
  expect(signal.sendReaction("host_12345678", "heart")).toBe(false);
  const received = vi.fn();
  const availability = vi.fn();
  const unsubscribe = signal.subscribeReactions(received, availability);
  await vi.waitFor(() => expect(availability).toHaveBeenLastCalledWith(true));
  expect(signal.sendReaction("host_12345678", "tomato")).toBe(true);
  const reaction = { type: "reaction", id: "reaction_12345678", fromPeerId: "viewer_12345678", targetPeerId: "host_12345678", prop: "tomato" };
  sockets[0].receive(reaction);
  expect(received).toHaveBeenCalledWith(reaction);
  expect(onMessage).toHaveBeenCalledOnce(); // Authentication only; effects do not enter media dispatch.
  sockets[0].readyState = Socket.CLOSING;
  const closed = new Event("close");
  Object.defineProperties(closed, { code: { value: 1006 }, reason: { value: "network interrupted" } });
  sockets[0].dispatchEvent(closed);
  expect(signal.sendReaction("host_12345678", "heart")).toBe(false);
  vi.advanceTimersByTime(750);
  authenticate(sockets[1]);
  await vi.waitFor(() => expect(availability).toHaveBeenLastCalledWith(true));
  expect(sockets[1].send.mock.calls.map(([value]) => JSON.parse(String(value)).type))
    .toEqual(["authenticate", "subscribe-reactions"]);
  // A rollback can retain the baseline wire protocol but remove the optional feature.
  vi.mocked(getRuntimeCapabilities).mockResolvedValue({ sfu: false, natPrediction: false, reactions: false });
  sockets[1].readyState = Socket.CLOSING;
  sockets[1].dispatchEvent(closed);
  vi.advanceTimersByTime(750);
  authenticate(sockets[2]);
  await vi.waitFor(() => expect(getRuntimeCapabilities).toHaveBeenCalledTimes(3));
  expect(signal.sendReaction("host_12345678", "heart")).toBe(false);
  expect(sockets[2].send.mock.calls.map(([value]) => JSON.parse(String(value)).type)).toEqual(["authenticate"]);
  unsubscribe();
  sockets[2].receive(reaction);
  expect(received).toHaveBeenCalledOnce();
  signal.stop();
});
