import { afterEach, expect, test, vi } from "vitest";
import { HTMLVideoMedia } from "../src/client/channel/watch-media";
import { WatchPlayer } from "../src/client/channel/watch-playback";
import { ChannelSession } from "../src/client/channel/session";
import type { WatchMediaState, WatchMedia } from "../src/client/channel/watch-media";

class Video extends EventTarget {
  currentTime = 6;
  duration = 6.021333;
  playbackRate = 1;
  readyState = 1;
  paused = true;
  ended = false;
  error: MediaError | null = null;
  src = "";
  get buffered() { return { length: 1, start: () => 0, end: () => 5.802666 }; }
  play = vi.fn(async () => { this.paused = false; });
  pause() { this.paused = true; }
  removeAttribute() { this.src = ""; }
  load = vi.fn();
  remove = vi.fn();
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test("Viewer accepts a late shared clock at metadata while current-frame readiness remains pending", async () => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockReturnValue(1000);
  const video = new Video();
  vi.stubGlobal("document", { createElement: () => video });
  const media = new HTMLVideoMedia("https://owned.test/fixture.mp4", "file");
  const player = new WatchPlayer("owned", false, media, () => {});
  let ready = false;
  const opening = player.ready().then(() => { ready = true; });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toBe(false);
    expect(player.hasPresentedFrame).toBe(false);
    player.update({ timeline: "media", position: 0, rate: 1, paused: false, anchorTime: 1000 });
    player.calibrate(1000, 1000, 1000);
    await player.serialize(async () => {});
    expect(video.currentTime).toBe(0);
    expect(video.play).toHaveBeenCalled();
    expect(ready).toBe(false);
    vi.mocked(performance.now).mockReturnValue(1277);
    video.readyState = 2;
    video.dispatchEvent(new Event("loadeddata"));
    await opening;
    expect(ready).toBe(true);
    expect(video.currentTime).toBe(0);
    expect(player.hasPresentedFrame).toBe(false);
    expect(player.error).toBeNull();
  } finally { player.close(); await opening.catch(() => {}); }
  expect(vi.getTimerCount()).toBe(0);
});

test("Creator late first-decode failure never publishes or stops its current source", async () => {
  vi.useFakeTimers();
  const video = new Video();
  vi.stubGlobal("window", { localStorage: { getItem: () => null } });
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("location", { origin: "https://owned.test", hash: "" });
  vi.stubGlobal("history", { state: null });
  vi.stubGlobal("document", { createElement: () => video });
  const session = new ChannelSession();
  const oldClose = vi.fn(), stopTrack = vi.fn();
  const oldState: WatchMediaState = { position: 1, duration: 6, paused: false, rate: 1, readyState: 4, ended: false, buffered: [[0, 6]] };
  const oldMedia: WatchMedia = { read: async () => oldState, ready: async () => {}, patch: async () => {}, listen: () => () => {}, close: oldClose };
  const incumbent = new WatchPlayer("owned", true, oldMedia, () => {});
  const players = new Map([["old-watch", incumbent]]);
  const selection = { controller: new AbortController(), committing: false };
  const request = vi.fn(async () => {}), stopScreen = vi.fn(async () => {});
  const view = session.getSnapshot();
  Object.assign(session, { watchPlayers: players, request, stopScreen,
    view: { ...view, state: { publications: [], channel: { rooms: [] } } },
    sourceSelections: new Map([["owned", selection]]),
    screenShares: new Map([["owned", { id: "old-screen" }]]),
    local: new Map([["old-screen", { stream: { getTracks: () => [{ stop: stopTrack }] } }]]) });
  const media = new HTMLVideoMedia("https://owned.test/new.mp4", "file");
  const owner = session as unknown as { commitWatch(room: string, source: unknown, media: WatchMedia, selection: unknown): Promise<void> };
  const opening = owner.commitWatch("owned", { kind: "media", url: "https://owned.test/new.mp4" }, media, selection);
  const rejected = expect(opening).rejects.toThrow("watch_media_decode_failed");
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(request).not.toHaveBeenCalled();
    expect(selection.committing).toBe(false);
    video.error = { code: 3, message: "owned first-frame decode failure" } as MediaError;
    video.dispatchEvent(new Event("error"));
    await rejected;
    expect(request).not.toHaveBeenCalled();
    expect(players.get("old-watch")).toBe(incumbent);
    expect(oldClose).not.toHaveBeenCalled();
    expect(stopScreen).not.toHaveBeenCalled();
    expect(stopTrack).not.toHaveBeenCalled();
    expect(video.src).toBe("");
  } finally { incumbent.close(); selection.controller.abort(); media.close(); }
  expect(vi.getTimerCount()).toBe(0);
});
