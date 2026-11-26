import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { playbackFailure } from "../src/client/media/viewer-playback.ts";
import { ChannelVideo } from "../src/client/channel/components/ChannelMedia";
import { ChannelStage, type ChannelStageProps } from "../src/client/channel/components/ChannelStage";
import { PlaybackControlsView } from "../src/client/components/living/PlaybackControls";
import { PlaybackSettings } from "../src/client/components/living/PlaybackSettings";
import { setCopy } from "../src/client/ui/copy";
import { en } from "../src/client/locales/en";
import { useHostPreviewPlayback } from "../src/client/components/living/use-host-preview-playback";

const previewHooks = vi.hoisted(() => ({ active: false, cleanup: [] as (() => void)[] }));
vi.mock("../src/client/components/living/HostRemoteControl", () => ({
  HostRemoteControl: () => createElement("button", { id: "input-permission" }),
}));

vi.mock("react", async importOriginal => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react,
    useRef: (value: unknown) => previewHooks.active ? { current: value } : react.useRef(value),
    useState: (value: unknown) => previewHooks.active ? [value, () => {}] : react.useState(value),
    useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
      if (!previewHooks.active) return react.useEffect(effect, deps);
      const cleanup = effect();
      if (cleanup) previewHooks.cleanup.push(cleanup);
    },
  };
});

describe("Viewer playback binding", () => {
  it("distinguishes canceled playback from autoplay denial and actual failures", () => {
    expect(playbackFailure(new DOMException("Paused", "AbortError"))).toBeNull();
    expect(playbackFailure({ name: "AbortError" })).toBeNull();
    expect(playbackFailure(new DOMException("Blocked", "NotAllowedError"))).toBe("autoplay-blocked");
    expect(playbackFailure(new DOMException("Unsupported", "NotSupportedError"))).toBe("playback-failed");
    expect(playbackFailure(new Error("decode failed"))).toBe("playback-failed");
    expect(playbackFailure(null)).toBe("playback-failed");
  });

});

describe("Playback audio controls", () => {
  it("retires local share settings when the room hides its retained screen", () => {
    const source: ChannelStageProps["sources"][number] = {
      kind: "screen", id: "screen", userId: "self", name: "Me", roomName: "Room",
      source: { kind: "screen", name: "Own screen" }, title: null, owned: true, audience: [], subscribed: true,
      localSource: true, paused: false, stream: {} as MediaStream, shareControls: () => createElement("button", { id: "share-settings" }),
      remoteControl: { mode: "ask", platform: "windows", canSetStopShortcut: false, requests: [] },
    };
    const render = (hidden: boolean) => renderToStaticMarkup(createElement(ChannelStage, {
      companion: "none", theaterMode: [false, vi.fn()], sources: [{ ...source, hidden }], focusedId: null, canSubscribe: true,
      onFocus: vi.fn(), onWatch: vi.fn(), onUnwatch: vi.fn(), onPause: vi.fn(), onStop: vi.fn(),
      onInputPolicy: vi.fn(), onInputDecide: vi.fn(), onInputSimultaneous: vi.fn(), onInputShortcut: vi.fn(),
    }));
    expect(render(false)).toContain('id="share-settings"');
    const background = render(true);
    expect(background).not.toContain('id="share-settings"');
    expect(background).toContain('id="input-permission"');
    expect(background).toContain('data-publication-id="screen"');
    expect(background).toContain("<video");
  });

  it("keeps source sound in publishing controls and allows immediate mute while capture is busy", () => {
    setCopy({ lang: "zh" });
    const stream = { id: "mixed", getAudioTracks: () => [{ kind: "audio", readyState: "live" }] } as unknown as MediaStream;
    const sourceAudio = { hasAudio: false, available: false, level: 1, muted: false, busy: false, canMute: true, onChange: vi.fn() };
    const source = { kind: "screen" as const, id: "screen", userId: "self", name: "Me", roomName: "Room", source: { kind: "screen" as const, name: "Own screen" },
      title: null, owned: true, localSource: true, audience: [], subscribed: true, paused: false, stream };
    const render = (sound = sourceAudio) => renderToStaticMarkup(createElement(ChannelStage, { companion: "none", theaterMode: [false, vi.fn()],
      sources: [{ ...source, sourceAudio: sound }], focusedId: null, canSubscribe: true,
      onFocus: vi.fn(), onWatch: vi.fn(), onUnwatch: vi.fn(), onPause: vi.fn(), onStop: vi.fn(),
      onInputPolicy: vi.fn(), onInputDecide: vi.fn(), onInputSimultaneous: vi.fn(), onInputShortcut: vi.fn(),
    }));
    const html = render();
    expect(html).toContain('aria-label="Own screen的分享控制"');
    expect(html.split("<footer>")[0]).not.toContain("所有观众");
    expect(html).not.toContain('class="c3-mini-volume"');
    expect(html.match(/<button\b[^>]*aria-label="分享源没有音频"[^>]*>/)?.[0]).toContain("disabled");

    const live = { ...sourceAudio, hasAudio: true, available: true };
    const silent = render({ ...live, muted: true, level: 0 });
    const silentRange = silent.match(/<input\b[^>]*type="range"[^>]*>/)![0];
    expect(silentRange).not.toContain("disabled");
    expect(silentRange).toContain('aria-valuetext="0%"');
    expect(silent).toContain('aria-label="恢复所有观众的分享声音"');
    const busy = render({ ...live, busy: true });
    expect(busy.match(/<button\b[^>]*aria-label="关闭所有观众的分享声音"[^>]*>/)?.[0]).not.toContain("disabled");
    const pendingUnmute = render({ ...live, busy: true, muted: true });
    expect(pendingUnmute.match(/<button\b[^>]*aria-label="恢复所有观众的分享声音"[^>]*>/)?.[0]).toContain("disabled");
  });

  it("gives the shared volume slider the same no-audio label as its button", () => {
    setCopy({ lang: "zh" });
    const noop = () => {};
    const html = renderToStaticMarkup(createElement(PlaybackControlsView, {
      audio: { level: 1, muted: false, boostAvailable: true }, paused: false, hasAudio: false, canPlay: true,
      sharingAudio: true, audioControlAvailable: false, theaterMode: false,
      fullscreen: { supported: false, ready: false, active: false },
      picture: { supported: false, active: false, failed: false, toggle: async () => {} },
      togglePlayback: noop, toggleFullscreen: noop, toggleMute: noop, setLevel: noop, onToggleTheater: noop,
    }));
    const range = html.match(/<input\b[^>]*type="range"[^>]*>/)![0];
    expect(range).toContain('aria-label="分享源没有音频"');
    expect(range).toContain('aria-valuetext="分享源没有音频"');
    expect(range).toContain("disabled");
  });
});

describe("Local source playback", () => {
  it.each([
    { owned: false, localSource: true },
    { owned: true, localSource: true },
    { owned: false, localSource: false },
  ])("keeps native sound controls scoped to local capture ($owned/$localSource)", ({ owned, localSource }) => {
    const view = Object.assign(new EventTarget(), { piikNativeActive: true });
    const owner = Object.assign(new EventTarget(), {
      defaultView: view, visibilityState: "visible", hasFocus: () => true,
      pictureInPictureElement: null as unknown,
    });
    const video = Object.assign(new EventTarget(), {
      ownerDocument: owner, muted: false, paused: false,
      pause: vi.fn(() => { video.paused = true; video.dispatchEvent(new Event("pause")); }),
      play: vi.fn(async () => { video.paused = false; video.dispatchEvent(new Event("play")); }),
    });
    previewHooks.active = true;
    try {
      useHostPreviewPlayback({ current: video as unknown as HTMLVideoElement }, owned ? {} as MediaStream : null, true, localSource);
      video.muted = false;
      video.dispatchEvent(new Event("volumechange"));
      expect(video.muted).toBe(localSource);
      expect(video.pause).toHaveBeenCalledTimes(0);
      view.piikNativeActive = false;
      view.dispatchEvent(new Event("piik-window-activity"));
      expect(video.pause).toHaveBeenCalledTimes(owned ? 1 : 0);
      view.piikNativeActive = true;
      view.dispatchEvent(new Event("piik-window-activity"));
      expect(video.play).toHaveBeenCalledTimes(owned ? 1 : 0);
      owner.visibilityState = "hidden";
      owner.dispatchEvent(new Event("visibilitychange"));
      expect(video.pause).toHaveBeenCalledTimes(owned ? 2 : 0);

      // Native PiP keeps an owned preview playing while its page is hidden.
      owner.pictureInPictureElement = video;
      video.dispatchEvent(new Event("enterpictureinpicture"));
      view.piikNativeActive = false;
      view.dispatchEvent(new Event("piik-window-activity"));
      expect(video.play).toHaveBeenCalledTimes(owned ? 2 : 0);
      expect(video.paused).toBe(false);
      video.muted = false;
      video.dispatchEvent(new Event("volumechange"));
      expect(video.muted).toBe(localSource);
    } finally {
      for (const cleanup of previewHooks.cleanup.splice(0).reverse()) cleanup();
      previewHooks.active = false;
    }
    // A retired element must not keep the local-source sound restriction.
    video.muted = false;
    video.dispatchEvent(new Event("volumechange"));
    expect(video.muted).toBe(false);
  });

  it("keeps owned=false/localSource=true silent and a remote same-user source unowned", () => {
    setCopy({ lang: "en" });
    const stream = { id: "same-machine", getAudioTracks: () => [{ readyState: "live" }] } as unknown as MediaStream;
    const html = renderToStaticMarkup(createElement(ChannelVideo, {
      stream, owned: false, localSource: true, label: "Local source", theaterMode: false, onToggleTheater: vi.fn(),
    }));
    expect(html).toContain("<video");
    expect(html).not.toContain('class="c3-mini-volume"');
    expect(html).not.toContain("No audio in this share");
    const source = { kind: "screen" as const, id: "screen", userId: "self", name: "Me", roomName: "Room", source: { kind: "screen" as const, name: null },
      title: null, owned: false, localSource: true, audience: [], subscribed: true, paused: false, stream };
    const props: ChannelStageProps = { companion: "none", theaterMode: [false, vi.fn()], sources: [source], focusedId: null, canSubscribe: true,
      onFocus: vi.fn(), onWatch: vi.fn(), onUnwatch: vi.fn(), onPause: vi.fn(), onStop: vi.fn(),
      onInputPolicy: vi.fn(), onInputDecide: vi.fn(), onInputSimultaneous: vi.fn(), onInputShortcut: vi.fn() };
    const local = renderToStaticMarkup(createElement(ChannelStage, props));
    expect(local).toContain("Local preview");
    expect(local).toContain('aria-label="Stop watching Shared screen"');
    expect(local).not.toContain('aria-label="Stop sharing');
    const remote = renderToStaticMarkup(createElement(ChannelStage, { ...props, sources: [{ ...source, localSource: false }] }));
    expect(remote).not.toContain("Local preview");
    expect(remote).toContain('class="c3-mini-volume"');
    expect(remote).toContain('aria-label="Stop watching Shared screen"');
  });
});

describe("Screen delivery result", () => {
  it("shows the watch failure without replacing an existing picture or changing its controls", () => {
    setCopy({ lang: "en" });
    const source = { kind: "screen" as const, audience: [], id: "screen", userId: "friend", name: "Friend", roomName: "Room", source: { kind: "screen" as const, name: null }, title: null, owned: false, localSource: false,
      subscribed: true, paused: false, deliveryFailed: true };
    const props: ChannelStageProps = { companion: "none", theaterMode: [false, vi.fn()], sources: [source], focusedId: null, canSubscribe: true,
      onFocus: vi.fn(), onWatch: vi.fn(), onUnwatch: vi.fn(), onPause: vi.fn(), onStop: vi.fn(),
      onInputPolicy: vi.fn(), onInputDecide: vi.fn(), onInputSimultaneous: vi.fn(), onInputShortcut: vi.fn() };
    const failed = renderToStaticMarkup(createElement(ChannelStage, props));
    expect(failed).toContain("Picture delivery failed. Retrying.");
    expect(failed).toContain('aria-label="Picture help"');
    expect(failed).not.toContain("Connecting picture");
    expect(failed).toContain('aria-label="Stop watching Shared screen"');

    for (const [playbackError, copy] of [[3, en["screen.decodeFailed"]], [4, en["screen.unplayable"]]] as const) {
      const result = renderToStaticMarkup(createElement(ChannelStage, { ...props, onRetryPicture: vi.fn(),
        sources: [{ ...source, waitingForInput: true, deliveryFailed: false, playbackError }] }));
      expect(result).toContain(copy);
      expect(result).toContain('aria-label="Retry picture"');
      expect(result).toContain('aria-label="Picture help"');
      expect(result).not.toContain(en["screen.deliveryRetry"]);
    }

    const stream = { id: "retained", getAudioTracks: () => [] } as unknown as MediaStream;
    const retained = renderToStaticMarkup(createElement(ChannelStage, { ...props, sources: [{ ...source, stream }] }));
    expect(retained).toContain("<video");
    expect(retained).not.toContain("Picture delivery failed");
    expect(retained).toContain('aria-label="Stop watching Shared screen"');
    const paused = renderToStaticMarkup(createElement(ChannelStage, { ...props, sources: [{ ...source, paused: true }] }));
    expect(paused).not.toContain("Picture delivery failed");
    expect(paused).not.toContain('aria-label="Picture help"');
    const pausedWithStream = renderToStaticMarkup(createElement(ChannelStage, { ...props, sources: [{ ...source, stream, paused: true }] }));
    expect(pausedWithStream).toContain(en["host.pauseNotice"]);
    expect(pausedWithStream).not.toContain(en["screen.waitingPicture"]);
    expect(pausedWithStream).toContain("<video");
    expect(retained).not.toContain(en["host.pauseNotice"]);

    const reconnecting = renderToStaticMarkup(createElement(ChannelStage, { ...props, canSubscribe: false }));
    expect(reconnecting).not.toContain('aria-label="Picture help"');
    const retrying = renderToStaticMarkup(createElement(ChannelStage, { ...props, sources: [{ ...source, pending: true }] }));
    expect(retrying).not.toContain('aria-label="Picture help"');
  });
});

describe("Picture surface between flows", () => {
  const stream = (id: string) => ({ id, getAudioTracks: () => [] }) as unknown as MediaStream;
  const incumbent = { flowId: "incumbent", stream: stream("incumbent"), selected: true, switchReady: false };
  const candidate = { flowId: "candidate", stream: stream("candidate"), selected: false, switchReady: false };
  const source = { kind: "screen" as const, audience: [], id: "screen", userId: "friend", name: "Friend", roomName: "Room",
    source: { kind: "screen" as const, name: null }, title: null, owned: false, localSource: false, subscribed: true, paused: false, waitingForInput: true };
  const render = (patch: Partial<ChannelStageProps["sources"][number]>) => renderToStaticMarkup(createElement(ChannelStage, {
    companion: "none", theaterMode: [false, vi.fn()], sources: [{ ...source, ...patch } as ChannelStageProps["sources"][number]], focusedId: null, canSubscribe: true,
    onFocus: vi.fn(), onWatch: vi.fn(), onUnwatch: vi.fn(), onRetryPicture: vi.fn(), onPause: vi.fn(), onStop: vi.fn(),
    onInputPolicy: vi.fn(), onInputDecide: vi.fn(), onInputSimultaneous: vi.fn(), onInputShortcut: vi.fn(),
  }));

  it("keeps the surface and its candidate while no flow is selected", () => {
    setCopy({ lang: "en" });
    const steps = [
      { stream: incumbent.stream, inputs: [incumbent, candidate] },
      { stream: undefined, inputs: [candidate] },
      { stream: candidate.stream, inputs: [{ ...candidate, selected: true }] },
    ];
    for (const step of steps) {
      const html = render(step);
      expect(html).toMatch(/<video[^>]*data-flow-id="candidate"/);
      expect(html).not.toContain("c3-monitor-wait");
      expect(html).toContain('aria-label="Stop watching Shared screen"');
    }
    // Mounted without a selection, the candidate prepares unseen behind the surface's own status.
    const unselected = render(steps[1]);
    expect(unselected).toMatch(/<video[^>]*data-selected="false"/);
    expect(unselected).not.toMatch(/<video[^>]*data-selected="true"/);
    expect(unselected).toContain(en["screen.waitingPicture"]);
  });

  it("releases the surface when the candidate's picture is unwatched and keeps the waiting states without any input", () => {
    setCopy({ lang: "en" });
    const unwatched = render({ subscribed: false, inputs: [candidate] });
    expect(unwatched).not.toContain("<video");
    expect(unwatched).toContain('class="c3-monitor-offer"');
    for (const inputs of [undefined, []]) {
      const waiting = render({ inputs });
      expect(waiting).not.toContain("<video");
      expect(waiting).toContain(en["screen.waitingPicture"]);
    }
    const failed = render({ inputs: [], waitingForInput: false, deliveryFailed: true });
    expect(failed).toContain(en["screen.deliveryRetry"]);
    expect(failed).toContain('aria-label="Retry picture"');
  });
});

it("defers buffering controls until playback settings opens", () => {
  setCopy({ lang: "en" });
  const stream = { id: "buffer-ui", getAudioTracks: () => [] } as unknown as MediaStream;
  const props = { stream, owned: false, localSource: false, label: "Screen", theaterMode: false, onToggleTheater: vi.fn(),
    buffering: { target: 725, status: "unsupported" as const, onChange: vi.fn() } };
  const remote = renderToStaticMarkup(createElement(ChannelVideo, props));
  expect(remote).toContain('aria-label="Playback settings"');
  expect(remote).not.toContain('aria-label="Playback buffering"');
});

it("shows the manual buffer target and browser limitations in playback settings", () => {
  setCopy({ lang: "en" });
  const buffering = { target: 725, status: "unsupported" as const, onChange: vi.fn() };
  const remote = renderToStaticMarkup(createElement(PlaybackSettings, { buffering, reconnect: null }));
  expect(remote).toContain('aria-label="Playback buffering"');
  expect(remote).toContain('name="screen-buffer-target"');
  expect(remote).toContain('max="4000"');
  expect(remote).toContain('value="725"');
  expect(remote).toContain("This browser cannot set the playback buffer target.");
  expect(remote).toContain('aria-label="Increase playback buffering"');
  expect(remote).toContain("Total buffer target");
  expect(remote).toContain(en["playback.bufferHint"]);
  const automatic = renderToStaticMarkup(createElement(PlaybackSettings, { buffering: { ...buffering, target: null }, reconnect: null }));
  expect(automatic).not.toContain('name="screen-buffer-target"');
});
