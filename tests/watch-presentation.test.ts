import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChannelWatchVideo, WatchPeerAction } from "../src/client/channel/components/ChannelMedia";
import { ChannelStage, SourceAudience, type WatchStageSource } from "../src/client/channel/components/ChannelStage";
import { WatchPlayer } from "../src/client/channel/watch-playback";
import { setCopy, t, type Lang } from "../src/client/ui/copy";
import { ChannelSettingsError } from "../src/client/channel/components/ChannelSettingsDialog";
import { channelErrorPresentation } from "../src/client/channel/error-presentation";
import { locales } from "../src/client/locales";
import { WatchSourceDialog } from "../src/client/channel/components/ChannelShareControl";
import type { ChannelController } from "../src/client/channel/types";

vi.mock("../src/client/channel/components/ChannelSettingsDialog", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/client/channel/components/ChannelSettingsDialog")>();
  return { ...actual, ChannelSettingsDialog: ({ children }: { children: ReactNode }) => createElement("div", null, children) };
});

const watchButtonClicks = vi.hoisted(() => new Map<string, () => void>());
vi.mock("../src/client/components/living/primitives", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/client/components/living/primitives")>();
  return { ...actual, Btn: (props: Parameters<typeof actual.Btn>[0]) => {
    if ((props.title === "watch.play" || props.title === "watch.pause" || props.title === "watch.forward.direct") && props.onClick) {
      const click = props.onClick;
      watchButtonClicks.set(props.title, click);
    }
    return createElement(actual.Btn, props);
  } };
});

function withWatchDocument(render: () => string): string {
  vi.stubGlobal("document", {});
  try { return render(); } finally { vi.unstubAllGlobals(); }
}

function watchTimeReadout(html: string): string | undefined {
  return html.match(/<span class="c3-watch-time"[^>]*>(.*?)<\/span>/)?.[1].replace(/<[^>]+>/g, "");
}

describe("Webpage watch presentation", () => {
  it("reserves a native slot only for a full stage with a local page and shell bridge", () => {
    const render = (pageId?: string, nativeStage = true, selected = true) => renderToStaticMarkup(createElement(ChannelWatchVideo, {
      player: { video: null, media: { page: { id: pageId, selectedCandidateId: selected ? "selected" : undefined } }, presentation: { kind: "external" } } as unknown as WatchPlayer,
      owned: false, paused: true, label: "Original page", presentation: "full", disabled: false,
      website: true, originalPageAvailable: true, theaterMode: false, onToggleTheater: vi.fn(),
      nativeStage, onPlayback: vi.fn(), onResume: vi.fn(), onFocusWindow: vi.fn(),
    }));
    withWatchDocument(() => {
      vi.stubGlobal("window", {});
      expect(render("local")).not.toContain("c3-watch-native-slot");
      window.piikMountWatchPage = vi.fn();
      expect(render("local")).toContain("c3-watch-native-slot");
      expect(render()).not.toContain("c3-watch-native-slot");
      expect(render("local", false)).not.toContain("c3-watch-native-slot");
      expect(render("local", true, false)).not.toContain("c3-watch-native-slot");
      return "";
    });
  });
  it("switches an original webpage to its direct URL without a peer offer", () => {
    setCopy({ lang: "en" });
    const onDirect = vi.fn();
    const html = withWatchDocument(() => renderToStaticMarkup(createElement(ChannelWatchVideo, {
      player: { video: null, presentation: { kind: "external" }, media: {} } as unknown as WatchPlayer,
      owned: false, paused: false, label: "Page", presentation: "full", theaterMode: false, disabled: false,
      website: true, originalPageAvailable: true, onFocusWindow: vi.fn(), onToggleTheater: vi.fn(),
      onResume: vi.fn(), onPlayback: vi.fn(), receiving: { peerAvailable: false, peerSupported: true,
        mode: "direct", browserSource: true, onDirect, onPeer: vi.fn() },
    })));
    const direct = html.match(/<button[^>]*aria-label="Play directly from website"[^>]*>/)?.[0];
    expect(direct).toBeDefined();
    expect(direct).toContain('aria-pressed="false"');
    expect(direct).not.toContain("disabled");
    watchButtonClicks.get("watch.forward.direct")?.();
    expect(onDirect).toHaveBeenCalledOnce();
  });
  it.each(["video", "embed", "external"] as const)("offers the viewer original page in playback settings for %s", kind => {
    setCopy({ lang: "en" });
    const render = (owned: boolean, available: boolean, error: string | null = null) => withWatchDocument(() =>
      renderToStaticMarkup(createElement(ChannelWatchVideo, {
        player: { presentation: { kind }, video: kind === "video" ? {} : null, media: {}, error } as unknown as WatchPlayer,
        owned, paused: false, label: "Source", presentation: "full", disabled: false, website: true,
        originalPageAvailable: available, onAppWatch: vi.fn(), onFocusWindow: vi.fn(), theaterMode: false,
        onToggleTheater: vi.fn(), onPlayback: vi.fn(), onResume: vi.fn(),
      })));
    const label = t("en", "watch.openPage");
    const html = render(false, true);
    if (kind === "external") expect(html).not.toContain(label);
    else {
      expect(html.slice(html.indexOf("c3-watch-receiving"))).toContain(label);
      const failed = render(false, true, "watch_media_failed");
      expect(failed.slice(failed.indexOf("c3-watch-receiving"))).not.toContain(label);
      expect(failed).toContain(label);
    }
    expect(render(true, true)).not.toContain(label);
    expect(render(false, false)).not.toContain(label);
  });

  it.each(["video", "external"])("allows the sharer to pause a buffering %s after the room clock stops", kind => {
    setCopy({ lang: "en" });
    watchButtonClicks.clear();
    const video = kind === "video" ? { paused: false } : null;
    const player = { video, presentation: { kind, ...(video && { element: video }) }, media: {},
      mediaState: { paused: false, position: 12, duration: 120, rate: 1 }, error: null } as unknown as WatchPlayer;
    const onPlayback = vi.fn();
    const html = withWatchDocument(() => renderToStaticMarkup(createElement(ChannelWatchVideo, {
      player, owned: true, paused: true, label: "Buffering source", presentation: "full", disabled: false,
      website: false, originalPageAvailable: false, theaterMode: false, onToggleTheater: vi.fn(),
      onPlayback, onResume: vi.fn(), onFocusWindow: vi.fn(),
    })));
    expect(html).toContain('aria-label="' + t("en", "watch.pause") + '"');
    watchButtonClicks.get("watch.pause")?.();
    expect(onPlayback).toHaveBeenCalledExactlyOnceWith({ paused: true });
  });

  it("keeps shared seek and speed with the sharer while viewers see read-only progress", () => {
    setCopy({ lang: "en" });
    const player = { video: null, presentation: { kind: "external" }, media: {},
      mediaState: { position: 12, duration: 120, rate: 1 }, error: null } as unknown as WatchPlayer;
    const render = (owned: boolean) => renderToStaticMarkup(createElement(ChannelWatchVideo, {
      player, owned, paused: true, label: "Owned source", presentation: "full", disabled: false,
      website: true, originalPageAvailable: true, theaterMode: false, onToggleTheater: vi.fn(),
      onPlayback: vi.fn(), onResume: vi.fn(), onFocusWindow: vi.fn(),
      receiving: { peerAvailable: true, peerSupported: true, mode: "direct", browserSource: true, onPeer: vi.fn(), onDirect: vi.fn() },
    }));
    const owner = render(true), viewer = render(false);
    expect(owner).toContain('aria-label="Playback progress for everyone"');
    expect(owner).toContain('aria-valuetext="0:12 / 2:00"');
    expect(watchTimeReadout(viewer)).toBe("0:12 / 2:00");
    expect(owner).toMatch(/popover="auto"[\s\S]*<select[^>]*aria-label="Playback speed for everyone"/);
    expect(viewer).toMatch(/<progress[^>]*max="120"[^>]*value="12"/);
    expect(viewer).not.toContain('type="range"');
    expect(viewer).toContain("Playback follows the sharer. Volume only affects you.");
    expect(viewer).not.toContain('aria-label="Playback progress for everyone"');
    expect(viewer).not.toContain('aria-label="Playback speed for everyone"');
  });
  it("labels program-time playback by distance from its live edge, not an elapsed epoch", () => {
    setCopy({ lang: "en" });
    const epoch = 1794744000;
    const player = { video: null, presentation: { kind: "external" }, media: {}, error: null,
      mediaState: { position: epoch + 10, duration: null, rate: 1,
        live: { active: true, seekable: [[epoch, epoch + 30]], syncPosition: epoch + 27 } } } as unknown as WatchPlayer;
    const html = renderToStaticMarkup(createElement(ChannelWatchVideo, {
      player, owned: true, paused: true, label: "Live source", presentation: "full", disabled: false,
      website: true, originalPageAvailable: true, theaterMode: false, onToggleTheater: vi.fn(),
      onPlayback: vi.fn(), onResume: vi.fn(), onFocusWindow: vi.fn(),
    }));
    expect(html).toContain(`aria-valuetext="${t("en", "watch.liveDelay", { seconds: "20" })}"`);
    expect(html).not.toContain(' / ');
  });
  it.each([
    { appConnected: false, pagePlayer: false, connectAdvice: true },
    { appConnected: true, pagePlayer: false, connectAdvice: false },
    { appConnected: true, pagePlayer: true, connectAdvice: false },
  ])("uses the connected App's webpage capability in source advice: %j", ({ appConnected, pagePlayer, connectAdvice }) => {
    setCopy({ lang: "en" });
    const channel = { appConnected, pagePlayer, pending: new Set(), watchPage: () => undefined,
      watchEmbed: () => undefined, sourceSelectionCommitting: () => false } as unknown as ChannelController;
    const html = renderToStaticMarkup(createElement(WatchSourceDialog, { channel, roomId: "room", onClose: vi.fn() }));
    expect(html.includes(t("en", "watch.connectApp"))).toBe(connectAdvice);
    expect(html.includes('aria-label="Open webpage and select video"')).toBe(pagePlayer);
    expect(html).toContain('aria-label="Play direct video URL"');
  });

  it.each([
    ["https://video.test/example.MP4?quality=hd", true, true],
    ["https://video.test/stream.m3u8?token=signed", true, true],
    ["https://video.test/stream.mpd?token=signed", true, true],
    ["https://video.test/stream.mpd?token=signed", true, false],
    ["https://video.test/watch?id=42", false, true],
  ] as const)("chooses the default playback entry for %s (direct %s, App connected %s)", (initialURL, direct, appConnected) => {
    setCopy({ lang: "en" });
    const channel = { appConnected, pagePlayer: appConnected, pending: new Set(), watchPage: () => undefined,
      watchEmbed: () => undefined, sourceSelectionCommitting: () => false } as unknown as ChannelController;
    const html = renderToStaticMarkup(createElement(WatchSourceDialog, {
      channel, roomId: "room", initialURL, onClose: vi.fn(),
    }));
    expect(html).toMatch(direct ? /type="submit"[^>]*aria-label="Play direct video URL"/ : /type="submit"[^>]*aria-label="Open webpage and select video"/);
    if (appConnected) {
      expect(html).toMatch(direct ? /type="button"[^>]*aria-label="Open webpage and select video"/ : /type="button"[^>]*aria-label="Play direct video URL"/);
    } else {
      expect(html.match(/<button[^>]*aria-label="Play direct video URL"[^>]*>/)?.[0]).not.toContain("disabled");
      expect(html).not.toContain(t("en", "watch.connectApp"));
    }
  });

  it("disables playback for a non-HTTP URL with a playlist extension", () => {
    setCopy({ lang: "en" });
    const channel = { appConnected: true, pagePlayer: true, pending: new Set(), watchPage: () => undefined,
      watchEmbed: () => undefined, sourceSelectionCommitting: () => false } as unknown as ChannelController;
    const html = renderToStaticMarkup(createElement(WatchSourceDialog, {
      channel, roomId: "room", initialURL: "ftp://video.test/stream.m3u8", onClose: vi.fn(),
    }));
    expect(html).toMatch(/type="submit"[^>]*aria-label="Open webpage and select video"[^>]*disabled=""/);
    expect(html).toMatch(/type="button"[^>]*aria-label="Play direct video URL"[^>]*disabled=""/);
  });

  it.each([[undefined, true, true], ["watch", true, false], [undefined, false, false]] as const)(
    "shows playback source selection for an eligible creator candidate (%s, %s)",
    (activityId, hasURL, expected) => {
      setCopy({ lang: "en" });
      const channel = { pending: new Set(), sourceSelectionCommitting: () => false, watchEmbed: () => undefined,
        watchPage: () => ({ candidates: [{ id: "video", url: hasURL ? "https://video.test/video.mp4" : undefined }] }),
      } as unknown as ChannelController;
      const html = renderToStaticMarkup(createElement(WatchSourceDialog, { channel, roomId: "room", activityId, onClose: vi.fn() }));
      expect(html.includes('aria-label="Choose playback source"')).toBe(expected);
    },
  );

  it.each([true, false])("offers original-page sharing with access guidance for a direct candidate=%s", direct => {
    setCopy({ lang: "en" });
    const channel = { appConnected: true, pagePlayer: true, pending: new Set(), watchEmbed: () => undefined,
      sourceSelectionCommitting: () => false, watchPage: () => ({ url: "https://video.test/player", candidates: [],
        watchSources: { choices: direct ? [{ id: "video", name: "Owned video", displayURL: "https://video.test/video.mp4", format: "file" }] : [], indexed: [], mpd: [] } }),
    } as unknown as ChannelController;
    const html = renderToStaticMarkup(createElement(WatchSourceDialog, { channel, roomId: "room", onClose: vi.fn() }));
    expect(html).toContain(t("en", "watch.browserSource.originalHelp"));
    const originalPage = html.match(/<button[^>]*aria-label="Sync video on its webpage"[^>]*>/)?.[0];
    expect(originalPage).toBeDefined();
    expect(originalPage).not.toContain("disabled");
    expect(html.includes(`aria-label="${t("en", "watch.forward.direct")}"`)).toBe(direct);
    expect(html.includes(`aria-label="${t("en", "watch.forward.shareFile")}"`)).toBe(direct);
    expect(html.includes(t("en", "watch.forward.shareFileHelp"))).toBe(direct);
  });


  it.each([
    [["watch_live_hls_unsupported", "watch_media_encryption_unsupported", "watch_media_encoding_unsupported", "watch_media_range_unsupported", "watch_media_size_unavailable", "watch_manifest_extension_unsupported", "watch_manifest_limit", "watch_resource_limit", "watch_mp4_parse_failed", "watch_indexed_unsupported", "invalid_watch_index"], "watch.forward.unsupported", false],
    [["watch_media_decode_failed"], "watch.decodeFailed", false],
    [["watch_source_inspection_unavailable"], "watch.sourceAccessRequired", false],
    [["watch_media_unsupported", "watch_mp4_mse_unavailable"], "watch.playbackUnsupported", false],
    [["watch_page_unavailable", "watch_page_closed", "page_player_closed"], "watch.forward.sourceUnavailable", false],
    [["watch_invalid_manifest", "watch_media_credentials_unavailable", "watch_media_unavailable", "watch_media_changed", "watch_media_truncated", "invalid_watch_range_response", "watch_resource_unavailable", "watch_source_unavailable", "watch_source_failed", "watch_source_changed", "watch_source_retired"], "watch.forward.sourceUnavailable", false],
    [["watch_source_busy", "watch_read_busy"], "watch.forward.busy", false],
    [["watch_media_timeout"], "watch.forward.readTimeout", false],
    [["watch_source_already_active"], "watch.forward.active", false],
    [["watch_peer_requires_secure_context"], "watch.forward.secure", false],
    [["watch_peer_unavailable"], "watch.forward.failed", false],
    [["watch_path_unavailable"], "channel.error.roomCommunicationFailed", true],
  ] as const)("presents %j with actionable copy from %s", (errors, key, connectionHelp) => {
    for (const lang of Object.keys(locales) as Lang[]) {
      for (const error of errors) {
        expect(channelErrorPresentation(error, key => t(lang, key))).toEqual({ message: t(lang, key), connectionHelp });
      }
    }
  });

  it("shows source reading failures in the existing action error panel", () => {
    setCopy({ lang: "en" });
    const html = renderToStaticMarkup(createElement(ChannelSettingsError, { error: "watch_media_credentials_unavailable" }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not read this video source");
    expect(html).not.toMatch(/sign-in|original webpage|Connect Piik App/);
    expect(html).not.toContain("identity");
  });

  it("explains a peer decoder failure without suggesting a room connection fault", () => {
    setCopy({ lang: "en" });
    const player = { video: null, presentation: { kind: "external" }, media: {},
      blocked: false, error: "watch_media_decode_failed", mediaState: null } as unknown as WatchPlayer;
    const html = renderToStaticMarkup(createElement(ChannelWatchVideo, {
      player, owned: false, paused: true, label: "Video", presentation: "full", disabled: false, website: true, originalPageAvailable: true,
      theaterMode: false, onToggleTheater: vi.fn(), onPlayback: vi.fn(), onResume: vi.fn(), onFocusWindow: vi.fn(),
      receiving: { peerAvailable: true, peerSupported: true, mode: "peer", browserSource: true, onPeer: vi.fn(), onDirect: vi.fn() },
    }));
    expect(html).toContain("could not decode"); expect(html).not.toContain("Check the room connection");
    expect(channelErrorPresentation("https://media.test/private?grant=secret", key => locales.en.copy[key]).message).not.toContain("secret");
  });

  it("offers peer reception only for an enabled source and a supported browser", () => {
    setCopy({ lang: "en" });
    const receiving = { peerAvailable: true, peerSupported: true, mode: "direct" as const, browserSource: true, onPeer: vi.fn(), onDirect: vi.fn() };
    const render = (patch = {}) => renderToStaticMarkup(createElement(WatchPeerAction, { receiving: { ...receiving, ...patch } }));
    expect(render()).toContain('aria-label="Receive from sharer"');
    expect(render({ peerAvailable: false })).toBe("");
    expect(render({ mode: "peer" })).toBe("");
    expect(render({ mode: "peer", failed: true })).toContain('aria-label="Retry"');
    expect(render({ mode: "peer", failed: true, peerAvailable: false })).toMatch(/<button\b[^>]*disabled/);
    expect(render({ peerSupported: false })).toContain("trusted HTTPS address");
    expect(render({ peerSupported: false })).not.toContain("<button");
  });

  it("lets a browser viewer retry a failed direct source in place", () => {
    setCopy({ lang: "en" });
    const player = { video: null, presentation: { kind: "embed" }, media: {}, error: "watch_media_unavailable" } as unknown as WatchPlayer;
    const html = renderToStaticMarkup(createElement(ChannelWatchVideo, {
      player, owned: false, paused: true, label: "Source", presentation: "full", disabled: false,
      website: false, originalPageAvailable: false, theaterMode: false, onToggleTheater: vi.fn(),
      onPlayback: vi.fn(), onResume: vi.fn(), onFocusWindow: vi.fn(),
      receiving: { peerAvailable: false, peerSupported: true, mode: "direct", browserSource: true, failed: true,
        onPeer: vi.fn(), onDirect: vi.fn() },
    }));
    expect(html).toContain('aria-label="Retry"');
    expect(html).not.toContain('aria-label="Receive from sharer"');
  });

  it.each(["watch_source_inspection_unavailable", "watch_media_unavailable", "watch_media_unsupported"])(
    "keeps %s factual when this platform has no original-page capability", error => {
      setCopy({ lang: "en" });
      const player = { video: null, presentation: { kind: "embed" }, media: {}, error } as unknown as WatchPlayer;
      const html = renderToStaticMarkup(createElement(ChannelWatchVideo, {
        player, owned: false, paused: true, label: "Source", presentation: "full", disabled: false, website: true, originalPageAvailable: false,
        theaterMode: false, onToggleTheater: vi.fn(), onPlayback: vi.fn(), onResume: vi.fn(), onFocusWindow: vi.fn(),
      }));
      expect(html).toContain('role="alert"');
      expect(html).not.toMatch(/App|original webpage|sign-in|CORS|authentication/);
    });

  it("offers an already available peer source without also asking the viewer to connect App", () => {
    setCopy({ lang: "en" });
    const player = { video: null, presentation: { kind: "embed" }, media: {}, error: "watch_media_unavailable" } as unknown as WatchPlayer;
    const receiving = { peerAvailable: true, peerSupported: true, mode: "direct" as const, browserSource: true, failed: true, onPeer: vi.fn(), onDirect: vi.fn() };
    const render = (onAppWatch?: () => void) => renderToStaticMarkup(createElement(ChannelWatchVideo, {
      player, owned: false, paused: true, label: "Source", presentation: "full", disabled: false, website: true, originalPageAvailable: true,
      theaterMode: false, onToggleTheater: vi.fn(), onPlayback: vi.fn(), onResume: vi.fn(), onFocusWindow: vi.fn(), receiving, onAppWatch,
    }));
    expect(render()).toContain('aria-label="Receive from sharer"');
    expect(render()).not.toContain("Connect Piik App");
    expect(render(vi.fn())).toContain('aria-label="Open webpage and select video"');
  });

  it("an owner's failure returns to its retained provider instead of offering a viewer-only watch", () => {
    setCopy({ lang: "en" });
    const player = { video: null, presentation: { kind: "embed" }, media: { page: {} }, error: "watch_media_unavailable" } as unknown as WatchPlayer;
    const html = renderToStaticMarkup(createElement(ChannelWatchVideo, {
      player, owned: true, paused: true, label: "Source", presentation: "full", disabled: false, website: true, originalPageAvailable: true,
      theaterMode: false, onToggleTheater: vi.fn(), onPlayback: vi.fn(), onResume: vi.fn(), onFocusWindow: vi.fn(), onAppWatch: vi.fn(),
    }));
    expect(html).toContain('aria-label="Return to playback window"');
    expect(html).not.toContain('aria-label="Open webpage and select video"');
    expect(html).not.toContain("Connect Piik App");
  });
  it("does not treat a metadata sample or a decoded but unpainted video as a visible picture", () => {
    setCopy({ lang: "en" });
    vi.stubGlobal("document", { fullscreenEnabled: false });
    try {
      const render = (patch = {}) => {
        const player = { video: { readyState: 0, parentElement: null }, media: {}, mediaState: null, blocked: false, error: null, ...patch };
        return renderToStaticMarkup(createElement(ChannelWatchVideo, {
          player: Object.setPrototypeOf({ ...player, presentation: { kind: "video", element: player.video } }, WatchPlayer.prototype) as WatchPlayer,
          owned: false, paused: true, label: "Preparing", presentation: "full", disabled: false,
          website: false, originalPageAvailable: false, theaterMode: false, onToggleTheater: vi.fn(), onPlayback: vi.fn(), onResume: vi.fn(), onFocusWindow: vi.fn(),
        }));
      };
      expect(render()).toContain('role="status"');
      expect(render()).toContain("Preparing video");
      expect(render({ mediaState: { readyState: 4 } })).toContain("Preparing video");
      expect(render({ video: { readyState: 4, videoWidth: 640, parentElement: null } })).toContain("Preparing video");
      expect(render({ video: { readyState: 4, videoWidth: 640, parentElement: null }, hasPresentedFrame: true })).not.toContain("Preparing video");
      expect(render({ video: { readyState: 4, videoWidth: 0, parentElement: null } })).not.toContain("Preparing video");
      const frame = { video: { readyState: 2, videoWidth: 640, paused: true, parentElement: null }, hasPresentedFrame: true };
      expect(render(frame)).not.toContain('role="status">Ended<');
      expect(render({ ...frame, video: { ...frame.video, ended: true } })).toContain('role="status">Ended<');
      expect(render({ blocked: true })).not.toContain("Preparing video");
      expect(render({ error: "watch_media_failed" })).not.toContain("Preparing video");
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([true, false])("shows the independent webpage's real controls without a fake video (owner: %s)", owned => {
    setCopy({ lang: "en" });
    const player = { video: null, presentation: { kind: "external" }, media: {}, blocked: false, error: null,
      mediaState: { position: 42, duration: 240, paused: true, rate: 1.5, readyState: 4, ended: false, buffered: [[0, 60]] } } as unknown as WatchPlayer;
    const html = renderToStaticMarkup(createElement(ChannelWatchVideo, {
      player, owned, paused: true, label: "video.example/watch/evening", presentation: "full", disabled: false,
      website: true, originalPageAvailable: true, theaterMode: false, onToggleTheater: vi.fn(), onPlayback: vi.fn(), onResume: vi.fn(), onFocusWindow: vi.fn(),
    }));
    expect(html).toContain("This video uses a separate webpage window");
    expect(html).toContain('aria-label="Return to playback window"');
    expect(html).not.toContain("<video");
    expect(html).not.toContain('aria-label="Picture in picture"');
    expect(html).not.toContain('aria-label="Mute"');
    expect(html).toContain(`role="group" aria-label="${t("en", "playback.controls")}"`);
    expect(html.includes('aria-label="Playback for everyone"')).toBe(owned);
    expect(html.includes('aria-label="Playback progress for everyone"')).toBe(owned);
    expect(watchTimeReadout(html)).toBe("0:42 / 4:00");
    if (owned) expect(html).toMatch(/<input[^>]*type="range"[^>]*max="240"/);
    else {
      expect(html).toMatch(/<progress[^>]*max="240"[^>]*value="42"/);
      expect(html).not.toContain('type="range"');
    }
  });

  it("offers direct playback first and keeps the App and sharer paths visible when available", () => {
    setCopy({ lang: "en" });
    const source: WatchStageSource = { kind: "watch", id: "activity", userId: "friend", name: "Bo", title: "video.example/watch/evening",
      roomName: "Friday", audience: [], owned: false, subscribed: false, paused: true, website: true, originalPageAvailable: true, browserSource: false,
      onRoom: vi.fn(), onJoin: vi.fn(), onLeave: vi.fn(), onStop: vi.fn(), onResume: vi.fn(), onPlayback: vi.fn(), onFocusWindow: vi.fn(), onAppWatch: vi.fn() };
    const render = (value: WatchStageSource) => renderToStaticMarkup(createElement(ChannelStage, { theaterMode: [false, vi.fn()], sources: [value], focusedId: null, canSubscribe: true,
      onFocus: vi.fn(), onWatch: vi.fn(), onUnwatch: vi.fn(), onPause: vi.fn(), onStop: vi.fn(),
      onInputPolicy: vi.fn(), onInputDecide: vi.fn(), onInputSimultaneous: vi.fn(), onInputShortcut: vi.fn() }));
    expect(render(source)).toContain('aria-label="Open webpage and select video"');
    const browser = render({ ...source, browserSource: true });
    expect(browser).toContain('aria-label="Watch"');
    expect(browser).not.toContain('aria-label="Open webpage and select video"');
    const offline = { ...source, browserSource: true, available: false };
    expect(render(offline)).toMatch(/<button[^>]*aria-label="Watch"[^>]*disabled/);
    for (const owned of [true, false]) {
      const label = owned ? "End watch together" : "Leave watch together";
      const action = (pending: boolean) => render({ ...offline, owned, subscribed: !owned, pending })
        .match(new RegExp('<button[^>]*aria-label="' + label + '"[^>]*>'))?.[0];
      expect(action(false)).toBeDefined();
      expect(action(false)).not.toContain("disabled");
      expect(action(true)).toContain("disabled");
    }
    const program = render({ ...source, onAppWatch: undefined, originalPageAvailable: false });
    expect(program).not.toContain("Connect Piik App");
    expect(program).not.toContain('aria-label="Open webpage and select video"');
    const disconnected = render({ ...source, onAppWatch: undefined });
    expect(disconnected).toContain(t("en", "watch.connectApp"));
    expect(disconnected).not.toContain('aria-label="Open webpage and select video"');
    const receiving = { peerAvailable: true, peerSupported: true, mode: "direct" as const, browserSource: false, onPeer: vi.fn(), onDirect: vi.fn() };
    const unsupported = { ...source, onAppWatch: undefined, originalPageAvailable: false, originalPageUnavailable: t("en", "watch.pageUnsupported") };
    expect(render(unsupported)).toContain(t("en", "watch.pageUnsupported"));
    expect(render(unsupported)).not.toContain("Connect Piik App");
    expect(render({ ...unsupported, browserSource: true })).not.toContain(t("en", "watch.pageUnsupported"));
    expect(render({ ...unsupported, receiving })).not.toContain(t("en", "watch.pageUnsupported"));
    const appAndForwarded = render({ ...source, receiving });
    expect(appAndForwarded).toContain('aria-label="Open webpage and select video"');
    expect(appAndForwarded).toContain('aria-label="Receive from sharer"');
    expect(appAndForwarded).not.toContain('aria-label="Watch"');
    const forwarded = render({ ...source, onAppWatch: undefined, receiving });
    expect(forwarded).toContain('aria-label="Watch"');
    expect(forwarded).not.toContain('aria-label="Receive from sharer"');
    expect(forwarded).not.toContain("Connect Piik App");
    expect(forwarded).not.toContain('aria-label="Open webpage and select video"');
    const directAndForwarded = render({ ...source, browserSource: true, receiving: { ...receiving, browserSource: true } });
    expect(directAndForwarded).toContain('aria-label="Watch"');
    expect(directAndForwarded).not.toContain('aria-label="Receive from sharer"');
    const insecure = render({ ...source, onAppWatch: undefined, receiving: { ...receiving, peerSupported: false } });
    expect(insecure).toContain(t("en", "watch.forward.secure"));
    expect(insecure).not.toContain('aria-label="Watch"');
  });
});

it("counts watch joins without claiming screen delivery readiness", () => {
  setCopy({ lang: "en" });
  const person = { userId: "friend", name: "Bo" };
  const joined = renderToStaticMarkup(createElement(SourceAudience, { people: [person], joined: true }));
  expect(joined).toContain('aria-label="Joined this watch: 1"');
  expect(joined).toContain("Joined this watch");
  expect(joined).not.toContain("Connecting");
  const preparing = renderToStaticMarkup(createElement(SourceAudience, { people: [{ ...person, state: "preparing" }] }));
  expect(preparing).toContain('aria-label="Viewers: 0 watching"');
});


it("keeps return-to-source reachable for a healthy main player only while it retains its Native page", () => {
  setCopy({ lang: "en" });
  vi.stubGlobal("document", { fullscreenEnabled: false });
  try {
    const video = { readyState: 4, parentElement: null };
    const render = (owned: boolean, page?: object) => renderToStaticMarkup(createElement(ChannelWatchVideo, {
      player: { video, presentation: { kind: "video", element: video }, media: { page }, mediaState: {readyState:4}, blocked: false, error: null } as unknown as WatchPlayer,
      owned, paused: true, label: "Prepared source", presentation: "full", disabled: false, website: true, originalPageAvailable: true,
      theaterMode: false, onToggleTheater: vi.fn(), onPlayback: vi.fn(), onResume: vi.fn(), onFocusWindow: vi.fn(),
    }));
    expect(render(true, {})).toContain('aria-label="Return to opened webpage"');
    expect(render(true)).not.toContain('aria-label="Return to opened webpage"');
    expect(render(false, {})).not.toContain('aria-label="Return to opened webpage"');
  } finally { vi.unstubAllGlobals(); }
});


it.each([
  { awaitingRoute: true, deliveryFailed: false, paused: false, label: "screen.waitingRoute" },
  { awaitingRoute: false, deliveryFailed: false, paused: false, label: "screen.connectingPicture" },
  { awaitingRoute: true, deliveryFailed: true, paused: false, label: "screen.deliveryRetry" },
  { awaitingRoute: true, deliveryFailed: true, paused: true, label: "host.pauseNotice" },
] as const)("shows $label for a subscribed screen without a playable stream", ({ awaitingRoute, deliveryFailed, paused, label }) => {
  setCopy({ lang: "en" });
  const html = renderToStaticMarkup(createElement(ChannelStage, { theaterMode: [false, vi.fn()],
    sources: [{ kind: "screen", id: "picture", userId: "friend", name: "Friend", roomName: "Room",
      source: { kind: "screen", name: "Owned picture" }, title: null, owned: false, localSource: false,
      subscribed: true, paused, audience: [], awaitingRoute, deliveryFailed }],
    focusedId: null, canSubscribe: true, onFocus() {}, onWatch() {}, onUnwatch() {}, onRetryPicture() {}, onPause() {}, onStop() {},
    onInputPolicy: async () => {}, onInputDecide: async () => {}, onInputSimultaneous: async () => {}, onInputShortcut: async () => ({ key: 1, available: false }),
  }));
  expect(html).toContain('data-publication-id="picture"');
  expect(html.includes('data-failed="true"')).toBe(deliveryFailed && !paused);
  expect(html).toContain(t("en", label));
  expect(html.includes('aria-label="' + t("en", "screen.retryPicture") + '"')).toBe(!paused && (deliveryFailed || !awaitingRoute));
  expect(html).not.toContain(t("en", "channel.previewPage.reconnecting"));
});
