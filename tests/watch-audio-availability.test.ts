import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { ChannelWatchVideo } from "../src/client/channel/components/ChannelMedia";
import { WatchDashMedia } from "../src/client/channel/watch-dash-media";
import { HTMLVideoMedia, type WatchMedia } from "../src/client/channel/watch-media";
import { PageSuppliedMedia } from "../src/client/channel/watch-page-media";
import { AppPage } from "../src/client/channel/app-link";
import type { WatchPlayer } from "../src/client/channel/watch-playback";
import { setCopy } from "../src/client/ui/copy";

afterEach(() => vi.unstubAllGlobals());

test("only a known silent source hides local volume for either role; unknown page or file audio preserves it", () => {
  setCopy({ lang: "en" }); vi.stubGlobal("document", { fullscreenEnabled: false });
  const video = { readyState: 4, videoWidth: 320, parentElement: null };
  const render = (availability: boolean | undefined, owned: boolean) => {
    const player = { video, presentation: { kind: "video", element: video }, media: { audioAvailable: () => availability },
      mediaState: { readyState: 4 }, waitingForPicture: false, error: null } as unknown as WatchPlayer;
    return renderToStaticMarkup(createElement(ChannelWatchVideo, { player, owned, paused: true, label: "Owned", presentation: "full",
      theaterMode: false, onToggleTheater: vi.fn(), onPlayback: vi.fn(), onResume: vi.fn(), disabled: false, website: true,
      originalPageAvailable: false, onFocusWindow: vi.fn() }));
  };
  for (const owned of [false, true]) {
    const silent = render(false, owned);
    expect(silent).toContain("No audio in this share"); expect(silent).not.toContain('class="c3-mini-volume"'); expect(silent).not.toContain('role="alert"');
    for (const availability of [undefined, true]) {
      expect(render(availability, owned)).toContain('class="c3-mini-volume"');
      expect(render(availability, owned)).not.toContain("No audio in this share");
    }
    if (owned) expect(silent).toContain('aria-label="Playback speed for everyone"');
  }
});

test("DASH audio uses the active public variant and PageSuppliedMedia delegates without treating unknown as absent", () => {
  const dash = new WatchDashMedia({} as HTMLVideoElement, "root", vi.fn(), new AbortController().signal, vi.fn());
  const variants = vi.fn(() => [] as { active: boolean; audioId: number | null; audioCodec: string | null }[]);
  (dash as unknown as { player: { getVariantTracks: typeof variants } }).player = { getVariantTracks: variants };
  expect(dash.audioAvailable()).toBeUndefined();
  variants.mockReturnValue([{ active: false, audioId: null, audioCodec: null }]); expect(dash.audioAvailable()).toBeUndefined();
  variants.mockReturnValue([{ active: true, audioId: null, audioCodec: null }, { active: false, audioId: 2, audioCodec: "mp4a.40.2" }]);
  expect(dash.audioAvailable()).toBe(false);
  variants.mockReturnValue([{ active: true, audioId: 0, audioCodec: "mp4a.40.2" }]); expect(dash.audioAvailable()).toBe(true);
  variants.mockReturnValue([{ active: true, audioId: null, audioCodec: "mp4a.40.2" }]); expect(dash.audioAvailable()).toBe(true);
  const video = Object.assign(new EventTarget(), { pause() {}, load() {}, remove() {}, removeAttribute() {} });
  vi.stubGlobal("document", { createElement: () => video });
  const main = new HTMLVideoMedia("https://fixture.test/file.mp4", "file");
  const page = new AppPage(crypto.randomUUID(), "https://fixture.test/page", vi.fn(), vi.fn(), vi.fn());
  const supplied = new PageSuppliedMedia(page, main, { sessionId: crypto.randomUUID(), resourceId: crypto.randomUUID(), format: "file" });
  try {
    expect((main as WatchMedia).audioAvailable?.()).toBeUndefined(); expect(supplied.audioAvailable()).toBeUndefined();
    (main as unknown as { dash: WatchDashMedia }).dash = dash;
    variants.mockReturnValue([{ active: true, audioId: null, audioCodec: null }]); expect(supplied.audioAvailable()).toBe(false);
  } finally { (main as unknown as { dash?: WatchDashMedia }).dash = undefined; supplied.close(); }
});
