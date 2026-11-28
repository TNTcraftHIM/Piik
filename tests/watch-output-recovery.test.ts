import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { AppPage } from "../src/client/channel/app-link";
import { ChannelWatchVideo } from "../src/client/channel/components/ChannelMedia";
import * as watchResource from "../src/client/channel/watch-resource";
import { PageSuppliedMedia } from "../src/client/channel/watch-page-media";
import { HTMLVideoMedia } from "../src/client/channel/watch-media";
import { WatchPlayer } from "../src/client/channel/watch-playback";
import { playbackOutput } from "../src/client/media/playback-output";
import { setCopy, t } from "../src/client/ui/copy";

// Read the output store's client snapshot with the static renderer.
vi.mock("react", async importOriginal => {
  const react = await importOriginal<typeof import("react")>();
  const { playbackOutput } = await import("../src/client/media/playback-output");
  return {
    ...react,
    useSyncExternalStore: ((subscribe, getSnapshot, getServerSnapshot) =>
      react.useSyncExternalStore(subscribe, getSnapshot, subscribe === playbackOutput.subscribe ? getSnapshot : getServerSnapshot)
    ) as typeof react.useSyncExternalStore,
  };
});

it.each([false, true])("offers output recovery for a page-supplied player with a presented frame: %s", async presented => {
  setCopy({ lang: "en" });
  const video = Object.assign(new EventTarget(), {
    readyState: 0, paused: true, ended: false, duration: 0, currentTime: 0,
    pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn(), remove: vi.fn(),
    setSinkId: vi.fn(async (id: string) => {
      if (id === "missing") throw new DOMException("Device went away", "NotFoundError");
    }),
  });
  vi.stubGlobal("document", { createElement: () => video });
  Object.assign(video, { ownerDocument: document });
  vi.stubGlobal("HTMLMediaElement", class { setSinkId = video.setSinkId; });
  await playbackOutput.choose("missing");
  const open = vi.spyOn(watchResource, "openWatchResource").mockImplementation(() => new Promise(() => {}));
  const page = new AppPage(crypto.randomUUID(), "https://source.test/player", vi.fn(), vi.fn(), vi.fn());
  const media = new PageSuppliedMedia(page, { sessionId: crypto.randomUUID(), resourceId: crypto.randomUUID(), format: "file" });
  page.close();
  const player = new WatchPlayer("fixture", false, media, vi.fn());
  const render = () => renderToStaticMarkup(createElement(ChannelWatchVideo, {
    player, owned: false, paused: true, label: "Page", presentation: "full", disabled: false,
    website: true, originalPageAvailable: true, theaterMode: false, onToggleTheater: vi.fn(),
    onPlayback: vi.fn(), onResume: vi.fn(), onFocusWindow: vi.fn(),
  }));
  try {
    await vi.waitFor(() => expect(playbackOutput.failed).toBe(true));
    expect(render()).toContain("c3-watch-output");
    if (presented) {
      Object.assign(video, { readyState: 4, videoWidth: 1280 });
      player.presentFrame();
      expect(player.waitingForPicture).toBe(false);
      expect(render()).toContain("c3-watch-output");
    }
    await playbackOutput.choose("alternate");
    expect(render()).not.toContain("c3-watch-output");
    expect(render().includes(t("en", "watch.waiting"))).toBe(!presented);
  } finally {
    player.close();
    open.mockRestore();
    await playbackOutput.choose("");
    vi.unstubAllGlobals();
  }
});

it("cancels deferred viewer playback when the room pauses before output is ready", async () => {
  let releaseOutput!: () => void;
  const output = new Promise<void>(resolve => { releaseOutput = resolve; });
  const video = Object.assign(new EventTarget(), {
    readyState: 4, paused: true, ended: false, duration: 60, currentTime: 0, playbackRate: 1, buffered: { length: 0 },
    setSinkId: vi.fn(() => output), play: vi.fn(async () => {}), pause: vi.fn(),
    removeAttribute: vi.fn(), load: vi.fn(), remove: vi.fn(),
  });
  vi.stubGlobal("document", { createElement: () => video });
  await playbackOutput.choose("headphones");
  const media = new HTMLVideoMedia("https://source.test/watch.mp4", "file");
  const patch = vi.spyOn(media, "patch");
  const player = new WatchPlayer("fixture", false, media, vi.fn());
  const playing = { timeline: "media" as const, paused: false, position: 0, rate: 1, anchorTime: 1000 };
  try {
    player.calibrate(1000, performance.now());
    player.update(playing);
    await player.serialize(async () => {});
    expect(patch).toHaveBeenCalledWith(expect.objectContaining({ paused: false }));
    expect(video.play).not.toHaveBeenCalled();

    player.update({ ...playing, paused: true });
    await player.serialize(async () => {});
    releaseOutput();
    await playbackOutput.choose("");
    expect(video.play).not.toHaveBeenCalled();
  } finally {
    releaseOutput();
    player.close();
    await playbackOutput.choose("");
    vi.unstubAllGlobals();
  }
});
