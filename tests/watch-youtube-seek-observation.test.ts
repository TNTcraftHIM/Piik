import { afterEach, expect, test, vi } from "vitest";
import { WatchPlayer } from "../src/client/channel/watch-playback";

class Element {
  isConnected = false;
  children: Element[] = [];
  src = "";
  title = "";
  className = "";
  append(child: Element) { this.children.push(child); child.isConnected = this.isConnected; }
  remove() { this.isConnected = false; }
}

class Player {
  state = 5;
  position = 0;
  rate = 1;
  destroyed = false;
  seeks: number[] = [];
  constructor(readonly frame: Element, readonly options: { events: Record<string, (event: { data: number }) => void> }) {
    players.push(this);
  }
  fire(name: string, data = 0) { this.options.events[name]?.({ data }); }
  getVideoUrl() { return "https://www.youtube.com/watch?v=M7lc1UVf-VE"; }
  getCurrentTime() { return this.position; }
  getDuration() { return 120; }
  getPlayerState() { return this.state; }
  getPlaybackRate() { return this.rate; }
  getAvailablePlaybackRates() { return [1, 1.5]; }
  playVideo() { this.state = 1; this.fire("onStateChange", 1); }
  pauseVideo() { this.state = 2; this.fire("onStateChange", 2); }
  seekTo(position: number) { this.seeks.push(position); this.state = 3; this.fire("onStateChange", 3); }
  setPlaybackRate(rate: number) { this.rate = rate; this.fire("onPlaybackRateChange", rate); }
  destroy() { this.destroyed = true; this.frame.remove(); }
}

let players: Player[] = [];
async function setup() {
  vi.resetModules();
  players = [];
  const head = new Element();
  head.isConnected = true;
  vi.stubGlobal("window", { YT: { Player } });
  vi.stubGlobal("location", { origin: "https://piik.test" });
  vi.stubGlobal("document", { head, documentElement: { moveBefore() {} }, createElement: () => new Element() });
  const { YouTubeMedia } = await import("../src/client/channel/watch-youtube-media");
  const media = new YouTubeMedia("M7lc1UVf-VE");
  (media.presentation.element as unknown as Element).isConnected = true;
  media.presentation.setVisible(true);
  await Promise.resolve();
  await Promise.resolve();
  players[0].fire("onReady");
  players[0].playVideo();
  await media.ready(new AbortController().signal);
  return { media, sdk: players[0], YouTubeMedia };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("a shared YouTube seek can buffer beyond ten seconds without blocking a newer host seek", async () => {
  vi.useFakeTimers();
  const { media, sdk } = await setup();
  const player = new WatchPlayer("owned", false, media, () => {});
  await player.ready();
  player.calibrate(performance.now(), performance.now());
  player.update({ timeline: "media", position: 30, paused: false, rate: 1, anchorTime: performance.now() });
  await vi.advanceTimersByTimeAsync(100);
  expect(sdk.seeks).toEqual([30]);

  player.update({ timeline: "media", position: 60, paused: false, rate: 1, anchorTime: performance.now() });
  await vi.advanceTimersByTimeAsync(100);
  expect(sdk.seeks.at(-1)).toBe(60);
  await vi.advanceTimersByTimeAsync(11000);
  expect(player.error).toBeNull();
  sdk.position = 60;
  sdk.playVideo();
  await vi.advanceTimersByTimeAsync(1000);
  expect(player.error).toBeNull();
  player.close();
});

test("a dispatched YouTube seek does not invent a seeked event before the platform observes position", async () => {
  vi.useFakeTimers();
  const { media } = await setup();
  const events: string[] = [];
  media.listen(event => events.push(event));
  let settled = false;
  const pending = media.patch({ position: 30 }).then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(100);
  expect(settled).toBe(true);
  await pending;
  expect(events).not.toContain("seeked");
  expect((await media.read()).position).toBe(0);
  media.close();
});

test("accepted play and rate commands do not invent state or block a newer pause", async () => {
  vi.useFakeTimers();
  const { media, sdk } = await setup();
  sdk.pauseVideo();
  const issued: string[] = [];
  sdk.playVideo = () => { issued.push("play"); };
  sdk.setPlaybackRate = () => { issued.push("rate"); };
  const pause = sdk.pauseVideo.bind(sdk);
  sdk.pauseVideo = () => { issued.push("pause"); pause(); };
  const player = new WatchPlayer("owned", true, media, () => {});
  await player.ready();
  let finished = false;
  const first = player.patch({ paused: false, rate: 1.5 }).then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(100);
  expect(finished).toBe(true);
  await first;
  expect(await media.read()).toMatchObject({ paused: true, rate: 1 });
  await player.patch({ paused: true });
  expect(issued).toEqual(["rate", "play", "pause"]);
  await vi.advanceTimersByTimeAsync(12000);
  expect(player.error).toBeNull();
  player.close();
});

test("platform denial remains visible and cancelling an unmounted source leaves another source intact", async () => {
  vi.useFakeTimers();
  // Make the removed handoff deadline observable under the same controlled clock.
  vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), milliseconds);
    return controller.signal;
  });
  const { media, sdk, YouTubeMedia } = await setup();
  const other = new YouTubeMedia("M7lc1UVf-VE");
  const cancelled = other.waitForPresentation(new AbortController().signal)
    .then(() => "resolved", error => error.name);
  await vi.advanceTimersByTimeAsync(6000);
  other.close();
  expect(await cancelled).toBe("AbortError");
  expect(sdk.destroyed).toBe(false);

  const player = new WatchPlayer("owned", false, media, () => {});
  await player.ready();
  sdk.playVideo = () => sdk.fire("onAutoplayBlocked");
  await player.patch({ paused: false });
  expect(player.blocked).toBe(true);
  sdk.fire("onError", 150);
  await vi.advanceTimersByTimeAsync(0);
  expect(player.error).toBe("watch_media_unavailable");
  player.close();
});
