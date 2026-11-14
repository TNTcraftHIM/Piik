import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChannelWatchVideo } from "../src/client/channel/components/ChannelMedia";
import { ChannelStage, type WatchStageSource } from "../src/client/channel/components/ChannelStage";
import type { WatchPlayer } from "../src/client/channel/watch-playback";
import { setCopy } from "../src/client/ui/copy";

describe("Webpage watch presentation", () => {
  it.each([true, false])("shows the independent webpage's real controls without a fake video (owner: %s)", owned => {
    setCopy({ lang: "en", vis: false });
    const player = { video: null, blocked: false, error: null,
      mediaState: { position: 42, duration: 240, paused: true, rate: 1.5, readyState: 4, ended: false } } as unknown as WatchPlayer;
    const html = renderToStaticMarkup(createElement(ChannelWatchVideo, {
      player, owned, paused: true, label: "video.example/watch/evening", presentation: "full", disabled: false,
      website: true, theaterMode: false, onToggleTheater: vi.fn(), onPlayback: vi.fn(), onResume: vi.fn(), onFocusWindow: vi.fn(),
    }));
    expect(html).toContain("This video uses a separate webpage window");
    expect(html).toContain('aria-label="Return to playback window"');
    expect(html).not.toContain("<video");
    expect(html).not.toContain('aria-label="Picture in picture"');
    expect(html).not.toContain('aria-label="Mute"');
    expect(html.match(/class="c3-mini-controls\b/g)).toHaveLength(1);
    expect(html.includes('aria-label="Playback for everyone"')).toBe(owned);
    expect(html.includes('aria-label="Playback progress for everyone"')).toBe(owned);
    if (owned) expect(html).toContain('max="240"');
  });

  it("offers manual App viewing only when the website has no Browser candidate", () => {
    setCopy({ lang: "en", vis: false });
    const source: WatchStageSource = { kind: "watch", id: "activity", userId: "friend", name: "Bo", title: "video.example/watch/evening",
      roomName: "Friday", owned: false, subscribed: false, paused: true, website: true, browserSource: false,
      onRoom: vi.fn(), onJoin: vi.fn(), onLeave: vi.fn(), onStop: vi.fn(), onResume: vi.fn(), onPlayback: vi.fn(), onFocusWindow: vi.fn(), onAppWatch: vi.fn() };
    const render = (value: WatchStageSource) => renderToStaticMarkup(createElement(ChannelStage, { sources: [value], focusedId: null, canSubscribe: true,
      onFocus: vi.fn(), onWatch: vi.fn(), onUnwatch: vi.fn(), onPause: vi.fn(), onStop: vi.fn(),
      onInputPolicy: vi.fn(), onInputDecide: vi.fn(), onInputSimultaneous: vi.fn(), onInputShortcut: vi.fn() }));
    expect(render(source)).toContain('aria-label="Watch in App"');
    const browser = render({ ...source, browserSource: true });
    expect(browser).toContain('aria-label="Watch"');
    expect(browser).not.toContain('aria-label="Watch in App"');
    const disconnected = render({ ...source, onAppWatch: undefined });
    expect(disconnected).toContain("Connect Piik App");
    expect(disconnected).not.toContain('aria-label="Watch in App"');
  });
});
