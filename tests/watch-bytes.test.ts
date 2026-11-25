import Hls, { LoaderContextType } from "hls.js";
import { afterEach, expect, test, vi } from "vitest";
import { WatchBytes } from "../src/client/channel/watch-bytes";
import { createResourceWatchMedia } from "../src/client/channel/watch-media";
import * as hosting from "../src/client/channel/hosting";
import type { WatchBytePlan } from "../src/client/channel/protocol";

vi.mock("../src/shared/media-resource", () => ({ mediaManifestBytes: () => 1_048_576 }));

const roomId = "room", activityId = crypto.randomUUID(), sessionId = crypto.randomUUID(), peer = crypto.randomUUID();
const source = { sessionId: peer, resourceId: crypto.randomUUID(), format: "file" as const };
const plan: WatchBytePlan = { roomId, activityId, source, upstream: peer, downstream: [], receiving: true };
class Delivery {
  reads: string[] = []; cancels: string[] = [];
  available = true;
  update() { return []; }
  read(key: string, requestId: string) {
    this.reads.push(requestId);
    return this.available
      ? [{ type: "send_control", peer, control: { type: "pull", requestId, key: JSON.parse(key) } }]
      : [{ type: "failed", requestId, code: "watch_path_unavailable" }];
  }
  cancel(id: string) { this.cancels.push(id); return []; }
  control(_peer: string, control: string) { return JSON.parse(control, (key, value) => key === "bytes" ? Uint8Array.from(value) : value); }
  chunk() { return []; }
  peer_closed() { return []; }
  read_failed() { return []; }
  request_failed() { return []; }
  free = vi.fn();
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function setup() {
  const delivery = new Delivery();
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({ initializeRuntime: async () => {},
    encode_control: (value: string) => new TextEncoder().encode(value),
    WatchDelivery: class { constructor() { return delivery; } } } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  const send = vi.fn(async () => {});
  const bytes = new WatchBytes(send); bytes.update(sessionId, [plan], [{ peerId: peer, rooms: [roomId] }]);
  return { bytes, delivery, send };
}
test("range waits for Core effects without polling and accepts a slow origin response", async () => {
  vi.useFakeTimers();
  const { bytes, delivery } = setup();
  try {
    const reading = bytes.read(roomId, activityId, source, source.resourceId, 0, 1024, new AbortController().signal);
    await vi.waitFor(() => expect(delivery.reads.length).toBeGreaterThan(0));
    const count = delivery.reads.length, id = delivery.reads.at(-1)!;
    await vi.advanceTimersByTimeAsync(20000);
    expect(delivery.reads).toHaveLength(count);

    bytes.data(peer, "control", JSON.stringify([{ type: "received", requestId: id, result: { mimeType: "video/mp4", totalSize: 3, bytes: [1, 2, 3], eof: true } }]));
    await expect(reading).resolves.toMatchObject({ bytes: Uint8Array.of(1, 2, 3), eof: true });
    expect(vi.getTimerCount()).toBe(0);
  } finally { bytes.reset(); }
});
test("a failed runtime load is retried by the next read", async () => {
  const { bytes, delivery } = setup();
  bytes.reset();
  vi.mocked(hosting.loadRoomHosting).mockRejectedValueOnce(new Error("room_runtime_unavailable"));
  bytes.update(sessionId, [plan], [{ peerId: peer, rooms: [roomId] }]);
  try {
    await expect(bytes.read(roomId, activityId, source, source.resourceId, 0, 1, new AbortController().signal))
      .rejects.toThrow("room_runtime_unavailable");
    void bytes.read(roomId, activityId, source, source.resourceId, 0, 1, new AbortController().signal).catch(() => {});
    await vi.waitFor(() => expect(delivery.reads).toHaveLength(1));
  } finally { bytes.reset(); }
});
test("a silent range can be cancelled while another range completes", async () => {
  const { bytes, delivery } = setup();
  const controller = new AbortController();
  try {
    const waiting = bytes.read(roomId, activityId, source, source.resourceId, 0, 1, controller.signal);
    const rejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    const healthy = bytes.read(roomId, activityId, source, source.resourceId, 1, 1, new AbortController().signal);
    await vi.waitFor(() => expect(delivery.reads).toHaveLength(2));
    const [silentId, healthyId] = delivery.reads;
    bytes.data(peer, "control", JSON.stringify([{ type: "received", requestId: healthyId,
      result: { mimeType: "video/mp4", totalSize: 2, bytes: [7], eof: true } }]));
    await expect(healthy).resolves.toMatchObject({ bytes: Uint8Array.of(7) });
    controller.abort();
    await rejected;
    expect(delivery.cancels).toEqual([silentId]);
  } finally { bytes.reset(); }
});

test("queued range rejects a replaced byte source and abort releases a waiting read", async () => {
  const { bytes, delivery } = setup();
  try {
    const cancel = new AbortController();
    const reading = bytes.read(roomId, activityId, source, source.resourceId, 0, 1024, cancel.signal);
    const rejected = expect(reading).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(delivery.reads.length).toBeGreaterThan(0));
    cancel.abort(); await rejected;
    const stale = bytes.read(roomId, activityId, source, source.resourceId, 0, 1024, new AbortController().signal);
    const replaced = expect(stale).rejects.toThrow("watch_source_changed");
    bytes.update(sessionId, [{ ...plan, receiving: false, source: { ...source, resourceId: crypto.randomUUID() } }], [{ peerId: peer, rooms: [roomId] }]);
    await replaced;
  } finally { bytes.reset(); }
});

test("a local media fetch waits for its join's receiving plan before sending its first Pull", async () => {
  vi.useFakeTimers();
  const { bytes, delivery } = setup();
  bytes.update(sessionId, [], [{ peerId: peer, rooms: [roomId] }]);
  const cancel = new AbortController();
  const reading = bytes.read(roomId, activityId, source, source.resourceId, 0, 1024, cancel.signal);
  const rejected = expect(reading).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(100);
  expect(delivery.reads).toHaveLength(0);
  bytes.update(sessionId, [plan], [{ peerId: peer, rooms: [roomId] }]);
  await vi.waitFor(() => expect(delivery.reads).toHaveLength(1));
  cancel.abort(); await rejected;
  bytes.reset();
});

test.each(["response", "source failure", "cancel"] as const)("HLS waits beyond the old manifest deadline before %s", async outcome => {
  vi.useFakeTimers();
  const { bytes, delivery, send } = setup();
  const hlsSource = { ...source, format: "hls" as const };
  const routed = { ...plan, source: hlsSource };
  const pairs = [{ peerId: peer, rooms: [roomId] }];
  const callbacks = { onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn(), onAbort: vi.fn() };
  const video = Object.assign(new EventTarget(), { pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn(), remove: vi.fn() });
  vi.stubGlobal("document", { createElement: () => video });
  vi.spyOn(Hls, "isSupported").mockReturnValue(true);
  const loadSource = vi.spyOn(Hls.prototype, "loadSource").mockImplementation(() => {});
  const attached = new Promise<Hls>(resolve => {
    vi.spyOn(Hls.prototype, "attachMedia").mockImplementation(function (this: Hls) { resolve(this); });
  });
  const media = createResourceWatchMedia(hlsSource, (id, offset, length, signal) =>
    bytes.read(roomId, activityId, hlsSource, id, offset, length, signal), { hlsDeadlineOwner: "reader" });
  try {
    bytes.update(sessionId, [{ ...routed, upstream: null }], []);
    const { config } = await attached;
    const loadPolicy = config.manifestLoadPolicy.default;
    const manifestURL = loadSource.mock.calls[0][0];
    new config.loader(config).load({ type: LoaderContextType.MANIFEST, url: manifestURL, responseType: "text" },
      { loadPolicy, timeout: loadPolicy.maxLoadTimeMs, maxRetry: 0, retryDelay: 0, maxRetryDelay: 0 }, callbacks);
    await vi.advanceTimersByTimeAsync(loadPolicy.maxLoadTimeMs + 5000);
    expect(send).not.toHaveBeenCalled();
    expect(Object.values(callbacks).every(callback => callback.mock.calls.length === 0)).toBe(true);

    if (outcome === "cancel") media.close();
    bytes.update(sessionId, [routed], pairs);
    await vi.advanceTimersByTimeAsync(0);
    if (outcome === "cancel") {
      expect(callbacks.onAbort).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalled();
    } else {
      expect(send).toHaveBeenCalledOnce();
      const requestId = delivery.reads[0];
      if (outcome === "response") {
        const manifest = "#EXTM3U\n#EXT-X-ENDLIST\n";
        const payload = Array.from(new TextEncoder().encode(manifest));
        bytes.data(peer, "control", JSON.stringify([{ type: "received", requestId, result: {
          mimeType: "application/vnd.apple.mpegurl", totalSize: payload.length, bytes: payload, eof: true,
        } }]));
        await vi.advanceTimersByTimeAsync(0);
        expect(callbacks.onError).not.toHaveBeenCalled();
        expect(callbacks.onSuccess).toHaveBeenCalledOnce();
        expect(callbacks.onSuccess.mock.calls[0][0].data).toBe(manifest);
      } else {
        bytes.data(peer, "control", JSON.stringify([{ type: "failed", requestId, code: "watch_media_timeout" }]));
        await vi.advanceTimersByTimeAsync(0);
        expect(callbacks.onError).toHaveBeenCalledOnce();
        expect(callbacks.onError.mock.calls[0][0].text).toBe("watch_media_timeout");
      }
    }
    expect(callbacks.onTimeout).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally { media.close(); bytes.reset(); }
});
test("initial projection failure releases the allocated delivery", async () => {
  const { bytes, delivery } = setup();
  vi.spyOn(delivery, "update").mockImplementationOnce(() => { throw new Error("projection"); });
  await expect(bytes.read(roomId, activityId, source, source.resourceId, 0, 1, new AbortController().signal)).rejects.toThrow("projection");
  expect(delivery.free).toHaveBeenCalledTimes(1);
  bytes.reset();
});
