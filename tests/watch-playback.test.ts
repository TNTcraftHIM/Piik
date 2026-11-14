import { HTMLVideoMedia, AppPageMedia, type AppPagePort } from "../src/client/channel/watch-media";
import { afterEach, expect, test, vi } from "vitest";
import { WatchPlayer } from "../src/client/channel/watch-playback";

class Video extends EventTarget {
  currentTime = 0; duration = 120; playbackRate = 1; paused = true; ended = false; readyState = 0;
  src = ""; error = null; volume = 1; muted = false;
  denied = false;
  play = vi.fn(async () => { if (this.denied) throw new DOMException("Playback denied", "NotAllowedError"); this.paused = false; });
  pause() { this.paused = true; }
  removeAttribute() { this.src = ""; }
  load = vi.fn();
  remove = vi.fn();
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test("late metadata and manual autoplay retry use the latest domain anchor; sound remains local", async () => {
  vi.useFakeTimers();
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const video = new Video();
  vi.stubGlobal("document", { createElement: () => video });
  const player = new WatchPlayer("room", false, new HTMLVideoMedia("https://media.test/video.mp4"), vi.fn());
  try {
    player.calibrate(5100, 80, 120);
    player.update({ position: 10, anchorTime: 5100, paused: false, rate: 2 });
    now = 2100; video.readyState = 2; video.denied = true;
    await player.ready();
    video.dispatchEvent(new Event("loadedmetadata"));
    await player.serialize(async () => {});
    expect(video.currentTime).toBe(14);
    expect(player.blocked).toBe(true);
    video.volume = 0.2; now = 4100; video.denied = false;
    await player.resume();
    expect(video.currentTime).toBe(18);
    expect(video.volume).toBe(0.2);
    expect(player.blocked).toBe(false);
    player.update({ position: 3, anchorTime: 9100, paused: true, rate: 0.5 });
    await player.resume();
    expect(video.currentTime).toBe(3);
    expect(video.paused).toBe(true);
    video.currentTime = 3.2;
    player.update({ position: 3, anchorTime: 9100, paused: true, rate: 0.5 });
    expect(video.currentTime).toBe(3.2);
  } finally { player.close(); }
  expect(video.src).toBe("");
  expect(vi.getTimerCount()).toBe(0);
});

test("admitted creator native playback events are serialized and use integer domain milliseconds", async () => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockReturnValue(100.75);
  const video = new Video(); video.readyState = 2;
  vi.stubGlobal("document", { createElement: () => video });
  const player = new WatchPlayer("room", true, new HTMLVideoMedia("https://media.test/video.mp4"), vi.fn());
  const send = vi.fn(async (_playback: unknown) => {});
  try {
    video.dispatchEvent(new Event("pause"));
    player.calibrate(5000, 80.25, 100.75);
    player.activate(send);
    video.currentTime = 20;
    video.dispatchEvent(new Event("seeked"));
    video.dispatchEvent(new Event("pause"));
    await player.serialize(async () => {});
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ position: 20, paused: true, rate: 1, anchorTime: 5010 });
    video.paused = false;
    video.dispatchEvent(new Event("play"));
    await player.serialize(async () => {});
    expect(send).toHaveBeenCalledTimes(2);
    video.paused = true; video.currentTime = 120;
    video.dispatchEvent(new Event("ended"));
    await player.serialize(async () => {});
    expect(send).toHaveBeenLastCalledWith({ position: 120, paused: true, rate: 1, anchorTime: 5010 });
  } finally { player.close(); }
});

test("creator acknowledgements never seek; retiring suppresses queued sends", async () => {
  vi.useFakeTimers();
  const video = new Video(); video.readyState = 2; video.currentTime = 25;
  vi.stubGlobal("document", { createElement: () => video });
  const player = new WatchPlayer("room", true, new HTMLVideoMedia("https://media.test/video.mp4"), vi.fn());
  player.calibrate(5000, 0, 0);
  player.update({ position: 2, anchorTime: 5000, paused: true, rate: 1 });
  expect(video.currentTime).toBe(25);
  const send = vi.fn(async () => {});
  const pending = player.serialize(send);
  player.close(); await pending;
  expect(send).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("candidate cancellation releases its load listeners and deadline", async () => {
  vi.useFakeTimers();
  const video = new Video();
  vi.stubGlobal("document", { createElement: () => video });
  const player = new WatchPlayer("room", true, new HTMLVideoMedia("https://media.test/video.mp4"), vi.fn());
  const cancel = new AbortController();
  const pending = player.ready(cancel.signal);
  cancel.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  player.close();
  expect(vi.getTimerCount()).toBe(0);
});

test("creator playing reanchors initial start and buffer recovery even at the same media position", async () => {
  vi.useFakeTimers();
  const clock = vi.spyOn(performance, "now").mockReturnValue(100);
  const video = new Video(); video.readyState = 2; video.currentTime = 20; video.paused = false;
  vi.stubGlobal("document", { createElement: () => video });
  const player = new WatchPlayer("room", true, new HTMLVideoMedia("https://media.test/video.mp4"), vi.fn());
  const send = vi.fn(async (_playback: unknown) => {});
  try {
    player.calibrate(5000, 100, 100);
    player.activate(send);
    video.dispatchEvent(new Event("play"));
    await player.serialize(async () => {});
    clock.mockReturnValue(1100);
    video.dispatchEvent(new Event("playing"));
    await player.serialize(async () => {});
    expect(send).toHaveBeenLastCalledWith({ position: 20, paused: false, rate: 1, anchorTime: 6000 });
    clock.mockReturnValue(3100);
    video.dispatchEvent(new Event("playing"));
    await player.serialize(async () => {});
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith({ position: 20, paused: false, rate: 1, anchorTime: 8000 });
  } finally { player.close(); }
});

test('App player samples asynchronous reads in the local monotonic domain and retires a pending open', async () => {
  vi.useFakeTimers();
  let now = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  let complete!: (value: { position: number; paused: boolean; rate: number; duration: number; readyState: number; ended: boolean }) => void;
  const port: AppPagePort = { read: () => new Promise(resolve => { complete = resolve; }), patch: vi.fn(async () => {}),
    listen: () => () => {}, focus: vi.fn(async () => {}), close: vi.fn() };
  const media = new AppPageMedia(port);
  const player = new WatchPlayer('room', true, media, vi.fn());
  try {
    player.calibrate(5000, 100, 100);
    await media.opening;
    const sampling = player.sample();
    await Promise.resolve();
    now = 300;
    complete({ position: 12, paused: false, rate: 1, duration: 60, readyState: 4, ended: false });
    await expect(sampling).resolves.toMatchObject({ position: 12, anchorTime: 5100 });
  } finally { player.close(); }
  expect(port.close).toHaveBeenCalledTimes(1);
  let opened!: (value: AppPagePort) => void;
  const pendingMedia = new AppPageMedia(() => new Promise(resolve => { opened = resolve; }));
  const pendingPlayer = new WatchPlayer('room', false, pendingMedia, vi.fn());
  await Promise.resolve();
  pendingPlayer.close();
  opened(port);
  await expect(pendingMedia.opening).rejects.toMatchObject({ name: 'AbortError' });
  expect(port.close).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

test('native owner progress reuses the observation tick without publishing playback', async () => {
  vi.useFakeTimers();
  let position = 12;
  const port: AppPagePort = { read: async () => ({ position, paused: false, rate: 1, duration: 60, readyState: 4, ended: false }),
    patch: vi.fn(async () => {}), listen: () => () => {}, focus: vi.fn(async () => {}), close: vi.fn() };
  const player = new WatchPlayer('room', true, new AppPageMedia(port), vi.fn());
  const send = vi.fn(async () => {});
  try {
    await player.ready(); player.calibrate(5000, 100, 100); player.activate(send);
    expect(player.mediaState?.position).toBe(12);
    position = 13;
    await vi.advanceTimersByTimeAsync(1000);
    expect(player.mediaState?.position).toBe(13);
    expect(send).not.toHaveBeenCalled();
  } finally { player.close(); }
});
