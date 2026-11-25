import { readFile } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { WatchBytes } from "../src/client/channel/watch-bytes";
import * as hosting from "../src/client/channel/hosting";
import type { WatchBytePlan } from "../src/client/channel/protocol";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

test("a Browser relay reports a partial bulk response once and forwards the next range", async () => {
  const rust = await actualRuntime();
  const [provider, relayId, viewer, activityId, resourceId] = Array.from({ length: 5 }, () => crypto.randomUUID());
  const key = { roomId: "room", activityId, resourceId };
  const source = { sessionId: provider, resourceId, format: "file" as const };
  const plan = { roomId: key.roomId, activityId, source };
  const providerCore = new rust.WatchDelivery(provider);
  providerCore.update(JSON.stringify([{ ...plan, upstream: null, downstream: [relayId], receiving: false }]), JSON.stringify([[relayId, ["room"]]]));
  let chunks = 0, errors = 0, available = 8;
  const receiver = new WatchBytes(async (_peer, _kind, raw) => {
    relay.data(viewer, "control", JSON.stringify(JSON.parse(raw as string).body));
  });
  const relay = new WatchBytes(async (peer, kind, data) => {
    if (peer === provider) {
      const [read] = providerCore.control(relayId, JSON.stringify(JSON.parse(data as string).body));
      for (const chunk of providerCore.read_result(read.requestId, JSON.stringify({
        mimeType: "video/mp4", totalSize: read.length, bytes: Array(read.length).fill(7), eof: true,
      }))) relay.data(provider, "chunk", Uint8Array.from(chunk.frame));
    } else if (kind === "chunk") {
      if (++chunks > available) throw new Error("file_transfer_busy");
      receiver.data(relayId, kind, data);
    } else {
      const control = JSON.parse(data as string).body;
      expect(control.type).toBe("error");
      errors++;
      receiver.data(relayId, kind, JSON.stringify(control));
    }
  });
  try {
    relay.update(relayId, [{ ...plan, upstream: provider, downstream: [viewer], receiving: false }], [
      { peerId: viewer, rooms: ["room"] }, { peerId: provider, rooms: ["room"] },
    ]);
    receiver.update(viewer, [{ ...plan, upstream: relayId, downstream: [], receiving: true }], [{ peerId: relayId, rooms: ["room"] }]);
    const read = (length: number) => receiver.read("room", activityId, source, resourceId, 0, length, new AbortController().signal);
    for (const freeSlots of [8, 7]) {
      available = freeSlots;
      chunks = 0;
      await expect(read(65536)).rejects.toThrow("watch_path_unavailable");
      expect(chunks).toBe(9);
    }
    expect(errors).toBe(2);
    chunks = 0;
    expect((await read(2)).bytes).toEqual(Uint8Array.of(7, 7));
  } finally { receiver.reset(); relay.reset(); providerCore.free(); }
});

async function actualRuntime() {
  const rust = await import("../prototype/channel-browser/pkg/piik_channel_browser.js");
  await rust.default({ module_or_path: await readFile("prototype/channel-browser/pkg/piik_channel_browser_bg.wasm") });
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({ ...rust, initializeRuntime: async () => {} } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  return rust;
}

test("a Browser provider can finish a native range outside JS safe integer precision", async () => {
  const rust = await actualRuntime();
  const [provider, viewer, activityId, resourceId, requestId] = Array.from({ length: 5 }, () => crypto.randomUUID());
  const source = { sessionId: provider, resourceId, format: "file" };
  const key = { roomId: "room", activityId, resourceId };
  const writer = new rust.WatchDelivery(provider);
  try {
    writer.update(JSON.stringify([{ roomId: key.roomId, activityId, source, upstream: null, downstream: [viewer], receiving: false }]), JSON.stringify([[viewer, [key.roomId]]]));
    for (const offset of [Number.MAX_SAFE_INTEGER + 1, 0]) {
      const [read] = writer.control(viewer, JSON.stringify({ type: "pull", key, requestId, offset, length: 1 }));
      expect(read).toMatchObject({ type: "read", requestId, offset });
      const [cancel, reply] = writer.read_failed(requestId, "watch_source_unavailable");
      expect(cancel).toEqual({ type: "cancel_read", requestId });
      expect(reply).toMatchObject({ type: "send_control", peer: viewer, control: { type: "error", requestId, code: "watch_source_failed" } });
    }
  } finally { writer.free(); }
});

test("pending reads survive source latency and retire when the peer closes", async () => {
  await actualRuntime(); vi.useFakeTimers();
  const [viewer, peer, activityId, resourceId] = Array.from({ length: 4 }, () => crypto.randomUUID());
  const source = { sessionId: peer, resourceId, format: "file" as const };
  const plan: WatchBytePlan = { roomId: "owned", activityId, source, upstream: null, downstream: [], receiving: true };
  let sent!: () => void;
  const sending = new Promise<void>(resolve => { sent = resolve; });
  const send = vi.fn(async (_peer, _kind, raw) => {
    if (JSON.parse(raw).body.type === "pull") await sending;
  });
  const bytes = new WatchBytes(send);
  let settled = false;
  try {
    bytes.update(viewer, [plan], []);
    const reading = bytes.read(plan.roomId, activityId, source, resourceId, 0, 1024, new AbortController().signal);
    void reading.then(() => { settled = true; }, () => { settled = true; });
    const retired = expect(reading).rejects.toThrow("watch_path_unavailable");
    await vi.advanceTimersByTimeAsync(15000);
    expect(settled).toBe(false); expect(send).not.toHaveBeenCalled();
    bytes.update(viewer, [{ ...plan, upstream: peer }], [{ peerId: peer, rooms: [plan.roomId] }]);
    await vi.advanceTimersByTimeAsync(0); expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15000); expect(settled).toBe(false);
    sent(); await vi.advanceTimersByTimeAsync(60000); expect(settled).toBe(false);
    bytes.peerClosed(peer); await retired;
    expect(settled).toBe(true); expect(vi.getTimerCount()).toBe(0);
  } finally { sent(); bytes.reset(); }
});

test("cancelling a queued Pull prevents late transmission after cancellation", async () => {
  await actualRuntime(); vi.useFakeTimers();
  const [viewer, peer, activityId, resourceId] = Array.from({ length: 4 }, () => crypto.randomUUID());
  const source = { sessionId: peer, resourceId, format: "file" as const };
  let sent!: () => void, allowed!: () => boolean;
  const sending = new Promise<void>(resolve => { sent = resolve; });
  const bytes = new WatchBytes(async (_peer, _kind, raw, current) => {
    if (JSON.parse(raw as string).body.type === "pull") { allowed = current; await sending; }
  });
  const cancel = new AbortController();
  try {
    bytes.update(viewer, [{ roomId: "owned", activityId, source, upstream: peer, downstream: [], receiving: true }], [{ peerId: peer, rooms: ["owned"] }]);
    const reading = bytes.read("owned", activityId, source, resourceId, 0, 1024, cancel.signal);
    const rejected = expect(reading).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0); expect(allowed()).toBe(true);
    cancel.abort(); await rejected; expect(allowed()).toBe(false);
    sent(); await vi.advanceTimersByTimeAsync(15000);
    expect(vi.getTimerCount()).toBe(0);
  } finally { sent(); bytes.reset(); }
});

test("a real response received before send completion cannot leave a response deadline", async () => {
  const rust = await actualRuntime(); vi.useFakeTimers();
  const [viewer, peer, activityId, resourceId] = Array.from({ length: 4 }, () => crypto.randomUUID());
  const source = { sessionId: peer, resourceId, format: "file" as const };
  const sourceCore = new rust.WatchDelivery(peer);
  sourceCore.update(JSON.stringify([{ roomId: "owned", activityId, source, upstream: null, downstream: [viewer], receiving: false }]), JSON.stringify([[viewer, ["owned"]]]));
  let sent!: () => void;
  const sending = new Promise<void>(resolve => { sent = resolve; });
  const bytes = new WatchBytes(async (_peer, _kind, raw) => {
    const control = JSON.parse(rust.decode_control(new TextEncoder().encode(raw as string)));
    for (const effect of sourceCore.control(viewer, JSON.stringify(control.body))) {
      if (effect.type !== "read") continue;
      for (const result of sourceCore.read_result(effect.requestId, JSON.stringify({ mimeType: "video/mp4", totalSize: 3, bytes: [1, 2, 3], eof: true }))) {
        if (result.type === "send_chunk") bytes.data(peer, "chunk", Uint8Array.from(result.frame));
      }
    }
    await sending;
  });
  try {
    bytes.update(viewer, [{ roomId: "owned", activityId, source, upstream: peer, downstream: [], receiving: true }], [{ peerId: peer, rooms: ["owned"] }]);
    const reading = bytes.read("owned", activityId, source, resourceId, 0, 3, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    await expect(reading).resolves.toMatchObject({ bytes: Uint8Array.of(1, 2, 3) });
    sent(); await vi.advanceTimersByTimeAsync(15000);
    expect(vi.getTimerCount()).toBe(0);
  } finally { sent(); bytes.reset(); sourceCore.free(); }
});

test.each(["ready", "provider", "viewer"] as const)("Browser range uses real Core typed chunks with late plan at %s", async delayed => {
  const rust = await import("../prototype/channel-browser/pkg/piik_channel_browser.js");
  await rust.default({ module_or_path: await readFile("prototype/channel-browser/pkg/piik_channel_browser_bg.wasm") });
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({ ...rust, initializeRuntime: async () => {} } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  const [sourceId, viewerId, activityId, resourceId] = Array.from({ length: 4 }, () => crypto.randomUUID());
  const source = { sessionId: sourceId, resourceId, format: "file" as const };
  const sourceCore = new rust.WatchDelivery(sourceId);
  const sourcePlan: WatchBytePlan = { roomId: "room", activityId, source, upstream: null, downstream: [viewerId], receiving: false };
  sourceCore.update(JSON.stringify(delayed === "provider" ? [] : [sourcePlan]), JSON.stringify([[viewerId, ["room"]]]));
  let pulled = false;
  const content = Uint8Array.from({ length: 64000 }, (_, index) => index % 251), frames: number[] = [];
  const delivery = new WatchBytes(async (peer, kind, data, allowed) => {
    expect(peer).toBe(sourceId); expect(allowed()).toBe(true); expect(kind).toBe("control");
    const control = JSON.parse(rust.decode_control(new TextEncoder().encode(data as string)));
    expect(control.kind).toBe("watch");
    pulled = true;
    deliver(sourceCore.control(viewerId, JSON.stringify(control.body)));
  });
  function deliver(effects: ReturnType<typeof sourceCore.control>): void {
    for (const effect of effects) {
      if (effect.type === "read") deliver(sourceCore.read_result(effect.requestId, JSON.stringify({
        mimeType: "video/mp4", totalSize: content.length, bytes: Array.from(content.slice(effect.offset, effect.offset + effect.length)), eof: effect.offset + effect.length >= content.length,
      })));
      else if (effect.type === "send_chunk") {
        const bytes = effect.frame as Uint8Array;
        expect([...bytes.slice(0, 2)]).toEqual([0, 0]); expect(bytes.length).toBeLessThanOrEqual(8192);
        frames.push(bytes.length); delivery.data(sourceId, "chunk", bytes);
      } else if (effect.type === "send_control") delivery.data(sourceId, "control", JSON.stringify(effect.control));
    }
  }
  try {
    const viewerPlan = { ...sourcePlan, upstream: sourceId, downstream: [], receiving: true };
    delivery.update(viewerId, [{ ...viewerPlan, upstream: delayed === "viewer" ? null : sourceId }], [{ peerId: sourceId, rooms: ["room"] }]);
    const reading = delivery.read("room", activityId, source, resourceId, 0, 65536, new AbortController().signal);
    void reading.catch(() => {});
    if (delayed === "viewer") {
      // Receiving demand precedes the admitted base-tree path in real snapshots.
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(pulled).toBe(false);
      delivery.update(viewerId, [viewerPlan], [{ peerId: sourceId, rooms: ["room"] }]);
    }
    if (delayed === "provider") {
      await vi.waitFor(() => expect(pulled).toBe(true));
      expect(frames).toHaveLength(0);
      deliver(sourceCore.update(JSON.stringify([sourcePlan]), JSON.stringify([[viewerId, ["room"]]])));
    }
    const result = await reading;
    expect(result).toEqual({ mimeType: "video/mp4", totalSize: content.length, bytes: content, eof: true });
    expect(frames.length).toBeGreaterThan(1);
  } finally { delivery.reset(); sourceCore.free(); }
});
