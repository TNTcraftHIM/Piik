import { readFile } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { WatchBytes } from "../src/client/channel/watch-bytes";
import * as hosting from "../src/client/channel/hosting";
import type { WatchBytePlan } from "../src/client/channel/protocol";

afterEach(() => vi.restoreAllMocks());

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
  function deliver(raw: string): void {
    for (const effect of JSON.parse(raw)) {
      if (effect.type === "read") deliver(sourceCore.read_result(effect.requestId, JSON.stringify({
        mimeType: "video/mp4", totalSize: content.length, bytes: Array.from(content.slice(effect.offset, effect.offset + effect.length)), eof: effect.offset + effect.length >= content.length,
      })));
      else if (effect.type === "send_chunk") {
        const bytes = Uint8Array.from(effect.frame as number[]);
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
