import { afterEach, expect, test, vi } from "vitest";
import { WatchPlayer } from "../src/client/channel/watch-playback";
import type { WatchMedia, WatchMediaPatch, WatchMediaState } from "../src/client/channel/watch-media";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

test("one held alignment consumes the latest forced clock and coalesces intermediate paused seeks", async () => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockReturnValue(1000);
  const state: WatchMediaState = { position: 0, duration: 60, rate: 1, paused: true, readyState: 4, ended: false, buffered: null };
  let release!: () => void;
  const patches: WatchMediaPatch[] = [];
  const patch = vi.fn(async (value: WatchMediaPatch) => {
    patches.push(value);
    if (value.position === 10) await new Promise<void>(resolve => { release = resolve; });
    Object.assign(state, value);
  });
  const read = vi.fn(async () => ({ ...state }));
  const media: WatchMedia = { read, patch, ready: async () => {}, listen: () => () => {}, close: vi.fn() };
  const player = new WatchPlayer("owned", false, media, () => {});
  try {
    await player.ready();
    player.calibrate(1000, 1000, 1000);
    player.update({ timeline: "media", position: 10, paused: true, rate: 1, anchorTime: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toBeDefined();
    for (const position of [12, 18, 24])
      player.update({ timeline: "media", position, paused: true, rate: 1, anchorTime: 1000 });
    player.calibrate(2000, 1000, 1000);
    release();
    await player.serialize(async () => {});
    expect(state.position).toBe(24);
    expect(patches.filter(value => value.position !== undefined).map(value => value.position)).toEqual([10, 24]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(player.error).toBeNull();
  } finally { release?.(); player.close(); }
  expect(vi.getTimerCount()).toBe(0);
});

test("a late explicit resume keeps its authority while a normal alignment is in flight", async () => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockReturnValue(1000);
  const state: WatchMediaState = { position: 0, duration: 60, rate: 1, paused: true, readyState: 1, ended: false, buffered: null };
  let resolveRead!: (value: WatchMediaState) => void;
  const read = vi.fn(async () => ({ ...state }));
  read.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
  const patch = vi.fn(async (value: WatchMediaPatch) => { Object.assign(state, value); });
  const media: WatchMedia = { read, patch, ready: async () => {}, playbackAvailable: () => false, listen: () => () => {}, close: vi.fn() };
  const player = new WatchPlayer("owned", false, media, () => {});
  try {
    await player.ready();
    player.calibrate(1000, 1000, 1000);
    player.update({ timeline: "media", position: 24, paused: true, rate: 1, anchorTime: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    const resumed = player.resume();
    resolveRead({ ...state });
    await resumed;
    expect(state.position).toBe(24);
    expect(patch).toHaveBeenCalledExactlyOnceWith({ position: 24 });
  } finally { player.close(); }
  expect(vi.getTimerCount()).toBe(0);
});

test("retirement discards a queued shared update before a held read completes", async () => {
  vi.useFakeTimers();
  const state: WatchMediaState = { position: 0, duration: 60, rate: 1, paused: true, readyState: 4, ended: false, buffered: null };
  let resolveRead!: (value: WatchMediaState) => void;
  const read = vi.fn(() => new Promise<WatchMediaState>(resolve => { resolveRead = resolve; }));
  const patch = vi.fn(async () => {}), close = vi.fn();
  const player = new WatchPlayer("owned", false, { read, patch, ready: async () => {}, listen: () => () => {}, close }, () => {});
  await player.ready();
  player.calibrate(1000, 1000, 1000);
  player.update({ timeline: "media", position: 10, paused: true, rate: 1, anchorTime: 1000 });
  await vi.advanceTimersByTimeAsync(0);
  player.update({ timeline: "media", position: 24, paused: true, rate: 1, anchorTime: 1000 });
  player.close(); resolveRead(state);
  await player.serialize(async () => {});
  expect(patch).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
