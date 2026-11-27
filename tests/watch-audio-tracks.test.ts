import { afterEach, expect, test, vi } from "vitest";
import { HTMLVideoMedia } from "../src/client/channel/watch-media";
import { PageSuppliedMedia } from "../src/client/channel/watch-page-media";
import { WatchPlayer } from "../src/client/channel/watch-playback";
import { AppPage } from "../src/client/channel/app-link";
import * as watchResource from "../src/client/channel/watch-resource";

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
  const video = Object.assign(new EventTarget(), { pause() {}, load() {}, removeAttribute() {}, remove() {} });
  vi.stubGlobal("document", { createElement: () => video });
  vi.spyOn(watchResource, "openWatchResource").mockResolvedValue({ url: "https://fixture.test/video", close: vi.fn() });
  const select = vi.fn(() => video.dispatchEvent(new Event("audiotracks")));
  const hls = { audioTracks: [{ name: "中文", lang: "zh" }], audioTrack: 0, setAudioOption: select, destroy: vi.fn() };
  const dispose = vi.fn(), page = new AppPage(crypto.randomUUID(), "https://fixture.test/page", vi.fn(), dispose, vi.fn());
  const provider = new PageSuppliedMedia(page, { sessionId: crypto.randomUUID(), resourceId: crypto.randomUUID(), format: "file" });
  page.close();
  (provider as unknown as { hls: typeof hls }).hls = hls;
  const patch = vi.spyOn(provider, "patch");
  const changed = vi.fn(), publish = vi.fn(async () => {}), player = new WatchPlayer("room", true, provider, changed);
  player.activate(publish);
  try {
    expect(provider.audioTracks()).toEqual([{ id: 0, name: "中文", language: "zh", selected: true }]);
    provider.selectAudioTrack(0);
    await player.serialize(async () => {});
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ name: "中文", lang: "zh" }));
    expect(changed).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled(); expect(patch).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled();
  } finally { player.close(); }
});
