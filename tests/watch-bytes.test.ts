import { afterEach, expect, test, vi } from "vitest";
import { WatchBytes } from "../src/client/channel/watch-bytes";
import * as hosting from "../src/client/channel/hosting";
import type { WatchBytePlan } from "../src/client/channel/protocol";

const roomId = "room", activityId = crypto.randomUUID(), sessionId = crypto.randomUUID(), peer = crypto.randomUUID();
const source = { sessionId: peer, resourceId: crypto.randomUUID(), format: "file" as const };
const plan: WatchBytePlan = { roomId, activityId, source, upstream: peer, downstream: [], receiving: true };
class Delivery {
  reads: string[] = []; cancels: string[] = [];
  available = true;
  update() { return "[]"; }
  read(key: string, requestId: string) {
    this.reads.push(requestId);
    return JSON.stringify(this.available
      ? [{ type: "send_control", peer, control: { type: "pull", requestId, key: JSON.parse(key) } }]
      : [{ type: "failed", requestId, code: "watch_path_unavailable" }]);
  }
  cancel(id: string) { this.cancels.push(id); return "[]"; }
  control(_peer: string, control: string) { return control; }
  chunk() { return "[]"; }
  peer_closed() { return "[]"; }
  read_failed() { return "[]"; }
  request_failed() { return "[]"; }
  free = vi.fn();
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function setup() {
  const delivery = new Delivery();
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({ initializeRuntime: async () => {},
    encode_control: (value: string) => new TextEncoder().encode(value),
    WatchDelivery: class { constructor() { return delivery; } } } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  const bytes = new WatchBytes(vi.fn(async () => {})); bytes.update(sessionId, [plan], [{ peerId: peer, rooms: [roomId] }]);
  return { bytes, delivery };
}
test("range waits for Core effects without polling and clears its deadline after receipt", async () => {
  vi.useFakeTimers();
  const { bytes, delivery } = setup();
  try {
    const reading = bytes.read(roomId, activityId, source, source.resourceId, 0, 1024, new AbortController().signal);
    await vi.waitFor(() => expect(delivery.reads.length).toBeGreaterThan(0));
    const count = delivery.reads.length, id = delivery.reads.at(-1)!;
    await vi.advanceTimersByTimeAsync(2000);
    expect(delivery.reads).toHaveLength(count);

    bytes.data(peer, "control", JSON.stringify([{ type: "received", requestId: id, result: { mimeType: "video/mp4", totalSize: 3, bytes: [1, 2, 3], eof: true } }]));
    await expect(reading).resolves.toMatchObject({ bytes: Uint8Array.of(1, 2, 3), eof: true });
    expect(vi.getTimerCount()).toBe(0);
  } finally { bytes.reset(); }
});
test("waiting range cancels on deadline and cannot revive after reset", async () => {
  vi.useFakeTimers();
  const { bytes, delivery } = setup();
  const reading = bytes.read(roomId, activityId, source, source.resourceId, 0, 1024, new AbortController().signal);
  const rejected = expect(reading).rejects.toThrow("watch_read_timeout");
  await vi.waitFor(() => expect(delivery.reads.length).toBeGreaterThan(0));
  await vi.advanceTimersByTimeAsync(10000); await rejected;
  expect(delivery.cancels).toContain(delivery.reads.at(-1));
  bytes.reset(); await Promise.resolve();
  expect(delivery.free).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
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
    bytes.update(sessionId, [{ ...plan, source: { ...source, resourceId: crypto.randomUUID() } }], [{ peerId: peer, rooms: [roomId] }]);
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
