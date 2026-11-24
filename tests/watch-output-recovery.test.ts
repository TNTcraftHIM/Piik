import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { AppPage } from "../src/client/channel/app-link";
import { ChannelWatchVideo } from "../src/client/channel/components/ChannelMedia";
import { HTMLVideoMedia } from "../src/client/channel/watch-media";
import { PageSuppliedMedia } from "../src/client/channel/watch-page-media";
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

it("offers output recovery for the actual video of a page-supplied player", async () => {
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
  const page = new AppPage(crypto.randomUUID(), "https://source.test/player", vi.fn(), vi.fn(), vi.fn());
  const media = new PageSuppliedMedia(page, new HTMLVideoMedia(() => new Promise(() => {})),
    { sessionId: crypto.randomUUID(), resourceId: crypto.randomUUID(), format: "file" });
  const player = new WatchPlayer("fixture", false, media, vi.fn());
  const render = () => renderToStaticMarkup(createElement(ChannelWatchVideo, {
    player, owned: false, paused: true, label: "Page", presentation: "full", disabled: false,
    website: true, originalPageAvailable: true, theaterMode: false, onToggleTheater: vi.fn(),
    onPlayback: vi.fn(), onResume: vi.fn(), onFocusWindow: vi.fn(),
  }));
  try {
    await vi.waitFor(() => expect(playbackOutput.failed).toBe(true));
    expect(render()).toContain("c3-watch-output");
    await playbackOutput.choose("alternate");
    expect(render()).not.toContain("c3-watch-output");
    expect(render()).toContain(t("en", "watch.waiting"));
  } finally {
    player.close();
    await playbackOutput.choose("");
    vi.unstubAllGlobals();
  }
});
