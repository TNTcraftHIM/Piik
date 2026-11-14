import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChannelWatchVideo, WatchPeerAction } from "../src/client/channel/components/ChannelMedia";
import { ChannelStage, type WatchStageSource } from "../src/client/channel/components/ChannelStage";
import type { WatchPlayer } from "../src/client/channel/watch-playback";
import { setCopy } from "../src/client/ui/copy";
import { ChannelSettingsError } from "../src/client/channel/components/ChannelSettingsDialog";
import { channelErrorPresentation } from "../src/client/channel/error-presentation";
import { locales } from "../src/client/locales";

describe("Webpage watch presentation", () => {
  it.each([
    [["watch_live_hls_unsupported", "watch_media_encryption_unsupported", "watch_media_encoding_unsupported", "watch_media_range_unsupported", "watch_media_size_unavailable", "watch_manifest_extension_unsupported", "watch_manifest_limit", "watch_resource_limit"], "watch.forward.unsupported", false],
    [["watch_invalid_manifest", "watch_media_credentials_unavailable", "watch_media_unavailable", "watch_media_changed", "watch_media_truncated", "invalid_watch_range_response", "watch_resource_unavailable", "watch_source_unavailable", "watch_source_failed", "watch_source_changed", "watch_source_retired"], "watch.forward.sourceUnavailable", false],
    [["watch_source_busy", "watch_read_busy"], "watch.forward.busy", false],
    [["watch_source_already_active"], "watch.forward.active", false],
    [["watch_peer_requires_secure_context", "watch_peer_unavailable"], "watch.forward.secure", false],
    [["watch_path_unavailable"], "channel.error.roomCommunicationFailed", true],
  ] as const)("presents %j with actionable copy from %s", (errors, key, connectionHelp) => {
    for (const locale of Object.values(locales)) {
      for (const error of errors) {
        expect(channelErrorPresentation(error, key => locale.copy[key])).toEqual({ message: locale.copy[key], connectionHelp });
      }
    }
  });

  it("shows source reading failures in the existing action error panel", () => {
    setCopy({ lang: "en" });
    const html = renderToStaticMarkup(createElement(ChannelSettingsError, { error: "watch_media_credentials_unavailable" }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Check sign-in and playback on the original webpage in the App");
    expect(html).not.toContain("identity");
  });

  it("offers peer reception only for an enabled source and a supported browser", () => {
    setCopy({ lang: "en" });
    const receiving = { peerAvailable: true, peerSupported: true, mode: "direct" as const, browserSource: true, onPeer: vi.fn(), onDirect: vi.fn() };
    const render = (patch = {}) => renderToStaticMarkup(createElement(WatchPeerAction, { receiving: { ...receiving, ...patch } }));
    expect(render()).toContain('aria-label="Receive from sharer"');
    expect(render({ peerAvailable: false })).toBe("");
    expect(render({ mode: "peer" })).toBe("");
    expect(render({ mode: "peer", failed: true })).toContain('aria-label="Receive from sharer"');
    expect(render({ mode: "peer", failed: true, peerAvailable: false })).toMatch(/<button\b[^>]*disabled/);
    expect(render({ peerSupported: false })).toContain("trusted HTTPS address");
    expect(render({ peerSupported: false })).not.toContain("<button");
  });
  it.each([true, false])("shows the independent webpage's real controls without a fake video (owner: %s)", owned => {
    setCopy({ lang: "en" });
    const player = { video: null, blocked: false, error: null,
      mediaState: { position: 42, duration: 240, paused: true, rate: 1.5, readyState: 4, ended: false, buffered: [[0, 60]] } } as unknown as WatchPlayer;
    const html = renderToStaticMarkup(createElement(ChannelWatchVideo, {
      player, owned, paused: true, label: "video.example/watch/evening", presentation: "full", disabled: false,
      website: true, theaterMode: false, onToggleTheater: vi.fn(), onPlayback: vi.fn(), onResume: vi.fn(), onFocusWindow: vi.fn(),
    }));
    expect(html).toContain("This video uses a separate webpage window");
    expect(html).toContain('aria-label="Return to playback window"');
    expect(html).not.toContain("<video");
    expect(html).not.toContain('aria-label="Picture in picture"');
    expect(html).not.toContain('aria-label="Mute"');
    expect(html.match(/class="c3-mini-controls\b/g) ?? []).toHaveLength(owned ? 1 : 0);
    expect(html.includes('aria-label="Playback for everyone"')).toBe(owned);
    expect(html.includes('aria-label="Playback progress for everyone"')).toBe(owned);
    if (owned) expect(html).toContain('max="240"');
  });

  it("offers manual App viewing only when the website has no Browser candidate", () => {
    setCopy({ lang: "en" });
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
