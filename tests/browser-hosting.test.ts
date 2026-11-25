import { afterEach, expect, test, vi } from "vitest";
import { BrowserHosting } from "../src/client/channel/browser-hosting";
import * as hosting from "../src/client/channel/hosting";
import type { ChannelView } from "../src/client/channel/types";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test("hosts released by an ended session finish closing before the next session opens the same room", async () => {
  const room = { id: "first", creatorId: "self" };
  const host = (closed: Promise<void>) => ({ roomId: room.id, summary: () => room, close: vi.fn(() => closed) });
  let finishClose!: () => void;
  const released = host(new Promise(resolve => { finishClose = resolve; })), reopened = host(Promise.resolve());
  const openExisting = vi.fn().mockResolvedValueOnce(released).mockResolvedValueOnce(reopened);
  vi.stubGlobal("indexedDB", {});
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({ BrowserRoomHost: { storedRoomIds: async () => [room.id], openExisting } } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  const request = vi.fn(async () => {});
  const owner = new BrowserHosting({
    view: () => ({ state: { channel: { id: "channel", rooms: [room] } }, self: { id: "self" } }) as unknown as ChannelView,
    socket: () => null, request, write: () => {}, report: () => {}, failures: () => {},
  });
  await owner.restore("ended", () => true);
  expect(owner.host(room.id)).toBe(released);
  owner.release();
  expect(released.close).toHaveBeenCalledOnce();
  const restoring = owner.restore("next", () => true);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(openExisting).toHaveBeenCalledOnce();
  finishClose();
  await restoring;
  expect(openExisting).toHaveBeenCalledTimes(2);
  expect(owner.host(room.id)).toBe(reopened);
  expect(request).toHaveBeenLastCalledWith({ type: "host_register", room, resumeBinding: undefined });
});

test("a room has one host: a host registered over another closes the one it replaces", async () => {
  const room = { id: "first", creatorId: "self" };
  const host = () => ({ roomId: room.id, summary: () => room, close: vi.fn(async () => {}) });
  const first = host(), second = host();
  const owner = new BrowserHosting({
    view: () => ({}) as unknown as ChannelView, socket: () => null, request: async () => {}, write: () => {}, report: () => {}, failures: () => {},
  });
  await owner.register(room.id, first as never, () => {});
  await owner.register(room.id, second as never, () => {});
  expect(owner.host(room.id)).toBe(second);
  expect(first.close).toHaveBeenCalledOnce();
  expect(second.close).not.toHaveBeenCalled();
});

test("a close that fails does not stop hosting from being restored", async () => {
  const room = { id: "first", creatorId: "self" };
  const failing = { roomId: room.id, summary: () => room, close: vi.fn(async () => { throw new Error("close_failed"); }) };
  const reopened = { roomId: room.id, summary: () => room, close: vi.fn(async () => {}) };
  vi.stubGlobal("indexedDB", {});
  vi.spyOn(hosting, "loadRoomHosting").mockResolvedValue({ BrowserRoomHost: { storedRoomIds: async () => [room.id],
    openExisting: vi.fn().mockResolvedValueOnce(failing).mockResolvedValueOnce(reopened) } } as unknown as Awaited<ReturnType<typeof hosting.loadRoomHosting>>);
  const owner = new BrowserHosting({
    view: () => ({ state: { channel: { id: "channel", rooms: [room] } }, self: { id: "self" } }) as unknown as ChannelView,
    socket: () => null, request: async () => {}, write: () => {}, report: () => {}, failures: () => {},
  });
  await owner.restore("ended", () => true);
  owner.release();
  await owner.restore("next", () => true);
  expect(owner.host(room.id)).toBe(reopened);
});
