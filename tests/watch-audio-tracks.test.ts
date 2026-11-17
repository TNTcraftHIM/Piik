import { afterEach, expect, test, vi } from "vitest";
import { HTMLVideoMedia, type WatchMedia, type WatchMediaEvent } from "../src/client/channel/watch-media";
import { PageSuppliedMedia } from "../src/client/channel/watch-page-media";
import { WatchPlayer } from "../src/client/channel/watch-playback";
import { AppPage } from "../src/client/channel/app-link";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("audio choices disclose display metadata only and a stale invalid choice does not change the player", () => {
  const video = Object.assign(new EventTarget(), { pause() {}, load() {}, removeAttribute() {}, remove() {} });
  vi.stubGlobal("document", { createElement: () => video });
  const media = new HTMLVideoMedia("https://fixture.test/video", "file");
  const hls = { audioTracks: [{ name: "English", lang: "en", channels: "2", url: "https://private.test/audio?grant=secret", groupId: "changing-group" }], audioTrack: 0, setAudioOption: vi.fn(), destroy: vi.fn() };
  (media as unknown as { hls: typeof hls }).hls = hls;
  expect(media.audioTracks()).toEqual([{ id: 0, name: "English", language: "en", channels: "2", selected: true }]);
  media.selectAudioTrack(1); media.selectAudioTrack(-1); media.selectAudioTrack(0.5);
  expect(hls.audioTrack).toBe(0);
  expect(hls.setAudioOption).not.toHaveBeenCalled();
  media.selectAudioTrack(0);
  expect(hls.setAudioOption).toHaveBeenCalledExactlyOnceWith({ name: "English", lang: "en", channels: "2", flushImmediate: true,
    assocLang: undefined, characteristics: undefined, audioCodec: undefined });
  media.close(); media.selectAudioTrack(0); expect(hls.destroy).toHaveBeenCalledOnce();
});

test("local audio changes refresh the owner UI without publishing shared playback or changing its page authority", async () => {
  let notify!: (event: WatchMediaEvent) => void;
  const select = vi.fn((_: number) => notify("audiotracks")), tracks = [{ id: 1, name: "中文", language: "zh", selected: true }];
  const main = { audioTracks: () => tracks, selectAudioTrack: select, read: async () => ({ position: 12, paused: true, rate: 1, readyState: 4, duration: 24, ended: false, buffered: [] }),
    ready: async () => {}, patch: vi.fn(), listen: (callback: (event: WatchMediaEvent) => void) => { notify = callback; return () => {}; }, close: vi.fn() } satisfies WatchMedia;
  const dispose = vi.fn(), page = new AppPage(crypto.randomUUID(), "https://fixture.test/page", vi.fn(), dispose, vi.fn());
  const provider = new PageSuppliedMedia(page, main as unknown as HTMLVideoMedia, { sessionId: crypto.randomUUID(), resourceId: crypto.randomUUID(), format: "hls" });
  const changed = vi.fn(), publish = vi.fn(async () => {}), player = new WatchPlayer("room", true, provider, changed);
  player.activate(publish);
  try {
    expect(provider.audioTracks()).toBe(tracks); provider.selectAudioTrack(1);
    await player.serialize(async () => {});
    expect(select).toHaveBeenCalledWith(1); expect(changed).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled(); expect(main.patch).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled();
  } finally { player.close(); }
});
