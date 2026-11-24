import { afterEach, expect, test, vi } from "vitest";
import { HTMLVideoMedia } from "../src/client/channel/watch-media";
import { WatchPlayer } from "../src/client/channel/watch-playback";
import { preparePortableWatchMedia } from "../src/client/channel/watch-page-media";
import { AppPage } from "../src/client/channel/app-link";

class Video extends EventTarget {
  private position = 0;
  get currentTime() { return this.position; }
  set currentTime(value: number) { this.position = value; this.readyState = 1; }
  duration = 6.021333;
  readyState = 2;
  paused = true;
  playbackRate = 1;
  ended = false;
  error: MediaError | null = null;
  src = "";
  get buffered() { return { length: 1, start: () => 0, end: () => 5.802666 }; }
  pause() { this.paused = true; }
  play = vi.fn(async () => { this.paused = false; });
  load = vi.fn();
  remove = vi.fn();
  removeAttribute() { this.src = ""; }
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test("Creator reuses this media's proven initial data after the original page position moves to EOF", async () => {
  vi.useFakeTimers();
  const video = new Video();
  vi.stubGlobal("document", { createElement: () => video });
  const page = new AppPage(crypto.randomUUID(), "https://owned.test/page", async command => command.type === "page_read"
    ? { position: 6.021333, duration: 6.021333, paused: true, rate: 1, readyState: 4, ended: true, buffered: [[0, 6.021333]] } : null,
    () => {}, () => {});
  const lifetime = new AbortController();
  const media = await preparePortableWatchMedia(page, "https://owned.test/clip.mp4", lifetime.signal, "file");
  const player = new WatchPlayer("owned", true, media, () => {});
  let admitted = false;
  const admitting = player.ready(lifetime.signal).then(() => { admitted = true; });
  try {
    expect(video.currentTime).toBe(6.021333);
    expect(video.readyState).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(admitted).toBe(true);
    await admitting;
    expect(player.hasPresentedFrame).toBe(false);
    expect(player.error).toBeNull();
  } finally { lifetime.abort(); player.close(); page.close(); await admitting.catch(() => {}); }
  expect(vi.getTimerCount()).toBe(0);
});

test("reused data readiness still rejects an observed decode failure before Creator admission", async () => {
  vi.useFakeTimers();
  const video = new Video();
  vi.stubGlobal("document", { createElement: () => video });
  const media = new HTMLVideoMedia("https://owned.test/clip.mp4", "file");
  await media.ready(new AbortController().signal);
  video.currentTime = 6;
  video.error = { code: 3, message: "owned later decode error" } as MediaError;
  const player = new WatchPlayer("owned", true, media, () => {});
  try { await expect(player.ready()).rejects.toThrow("watch_media_decode_failed"); }
  finally { player.close(); }
  expect(vi.getTimerCount()).toBe(0);
});

test("a pending platform play never prevents a later Creator seek and playback is confirmed only by events", async () => {
  vi.useFakeTimers();
  const video = new Video();
  let rejectPlay!: (error: Error) => void;
  video.play.mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectPlay = reject; }));
  vi.stubGlobal("document", { createElement: () => video });
  const media = new HTMLVideoMedia("https://owned.test/clip.mp4", "file");
  const player = new WatchPlayer("owned", true, media, () => {});
  try {
    await player.ready();
    player.blockedReason = "autoplay";
    await player.play();
    expect(player.blocked).toBe(true);
    expect(video.currentTime).toBe(0);
    await player.patch({ position: 3, paused: true });
    expect(video.currentTime).toBe(3);
    rejectPlay(new DOMException("play interrupted by pause", "AbortError"));
    await vi.advanceTimersByTimeAsync(0);
    expect(player.error).toBeNull();
    video.dispatchEvent(new Event("playing"));
    expect(player.blocked).toBe(false);
  } finally { player.close(); }
  expect(vi.getTimerCount()).toBe(0);
});

test("platform autoplay denial remains explicit and a retired late failure cannot revive playback", async () => {
  vi.useFakeTimers();
  const video = new Video();
  video.play.mockRejectedValueOnce(new DOMException("gesture required", "NotAllowedError"));
  vi.stubGlobal("document", { createElement: () => video });
  const media = new HTMLVideoMedia("https://owned.test/clip.mp4", "file"), changed = vi.fn();
  const player = new WatchPlayer("owned", true, media, changed);
  try {
    await player.ready(); await player.play();
    await vi.advanceTimersByTimeAsync(0);
    expect(player.blocked).toBe(true);
    let rejectPlay!: (error: Error) => void;
    video.play.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectPlay = reject; }));
    await player.play(); player.close();
    const notifications = changed.mock.calls.length;
    rejectPlay(new Error("late platform failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(player.error).toBeNull();
    expect(changed.mock.calls.length).toBe(notifications);
  } finally { player.close(); }
  expect(vi.getTimerCount()).toBe(0);
});
