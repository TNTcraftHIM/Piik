import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { ChannelWatchVideo } from "../src/client/channel/components/ChannelMedia";
import type { WatchPlayer } from "../src/client/channel/watch-playback";
import { setCopy } from "../src/client/ui/copy";

afterEach(() => vi.unstubAllGlobals());

test("personal HLS choices follow local capability for both roles and use distinct localized labels", () => {
  vi.stubGlobal("document", { fullscreenEnabled: false, documentElement: { lang: "en" } });
  const video = { readyState: 4, videoWidth: 320, parentElement: null };
  const tracks = [{ id: 0, name: "Original", language: "en", channels: "2", selected: true },
    { id: 1, name: "原声", language: "zh", channels: "2", selected: false },
    { id: 2, name: "Commentary", language: "en", channels: "2", selected: false }];
  const render = (owned: boolean, choices = tracks) => {
    const player = { video, presentation: { kind: "video", element: video }, media: { audioTracks: () => choices }, waitingForPicture: false,
      error: null, mediaState: { readyState: 4 } } as unknown as WatchPlayer;
    return renderToStaticMarkup(createElement(ChannelWatchVideo, { player, owned, paused: true, label: "Fixture", presentation: "full",
      theaterMode: false, onToggleTheater: vi.fn(), onPlayback: vi.fn(), onResume: vi.fn(), disabled: false,
      website: true, originalPageAvailable: false, onFocusWindow: vi.fn() }));
  };
  setCopy({ lang: "en" });
  const english = render(false);
  expect(english).toContain("English · 2 channels — Original"); expect(english).toContain("English · 2 channels — Commentary");
  expect(english).toContain("Chinese · 2 channels"); expect(english).not.toMatch(/groupId|https?:\/\/|grant=/);
  expect(render(true)).toContain("Audio track for me");
  for (const owned of [false, true]) expect(render(owned, [])).not.toContain("Audio track for me");
  expect(render(false, [tracks[0]])).toMatch(/aria-label="Audio track for me"[^>]*disabled/);
  setCopy({ lang: "zh" }); const chinese = render(false);
  expect(chinese).toContain("英语 · 2 声道 — Original"); expect(chinese).toContain("中文 · 2 声道");
});
