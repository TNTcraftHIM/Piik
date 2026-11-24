import Hls from "hls.js";
import { afterEach, expect, test, vi } from "vitest";
import { AppPageMedia, canReceivePeerWatch, createResourceWatchMedia, HTMLVideoMedia, type WatchMediaEvent, type WatchMediaState } from "../src/client/channel/watch-media";
import { M3U8Parser, watchHlsFailure } from "../src/client/channel/watch-hls";
import { channelErrorPresentation } from "../src/client/channel/error-presentation";
import { t } from "../src/client/ui/copy";
import { WatchPlayer } from "../src/client/channel/watch-playback";

function video() {
  return Object.assign(new EventTarget(), { src: "", readyState: 0, buffered: { length: 0, start: vi.fn(), end: vi.fn() }, error: null,
    pause: vi.fn(), load: vi.fn(), remove: vi.fn(), removeAttribute: vi.fn() });
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("a native-only HLS creator requires an ended media playlist and keeps proven VOD", async () => {
  vi.spyOn(Hls, "isSupported").mockReturnValue(false);
  const v = Object.assign(video(), { currentTime: 0, duration: 120, paused: true, playbackRate: 1, readyState: 2 });
  vi.stubGlobal("document", { createElement: () => v });
  const base = "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment.ts\n";
  const fetcher = vi.fn(async () => new Response(base + "#EXT-X-ENDLIST\n"));
  vi.stubGlobal("fetch", fetcher);
  const vod = new HTMLVideoMedia("https://media.test/vod.m3u8", "hls");
  await expect(vod.read()).resolves.toMatchObject({ readyState: 2 }); expect(v.src).toContain("vod.m3u8"); vod.close();
  fetcher.mockImplementation(async () => new Response(base));
  const live = new HTMLVideoMedia("https://media.test/live.m3u8", "hls");
  await expect(live.read()).rejects.toThrow("watch_live_timeline_unsupported"); live.close();
  fetcher.mockImplementation(async () => new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nvariant.m3u8\n"));
  const master = new HTMLVideoMedia("https://media.test/master.m3u8", "hls");
  await expect(master.read()).rejects.toThrow("watch_source_inspection_unavailable"); master.close();
});

test("closing after native HLS inspection prevents assigning a retired source", async () => {
  vi.spyOn(Hls, "isSupported").mockReturnValue(false);
  const v = video();
  vi.stubGlobal("document", { createElement: () => v });
  vi.stubGlobal("fetch", async () => new Response("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n"));
  const parse = M3U8Parser.parseLevelPlaylist;
  const validation = vi.spyOn(M3U8Parser, "parseLevelPlaylist").mockImplementation((...args) => {
    const details = parse.apply(M3U8Parser, args);
    queueMicrotask(() => media.close());
    return details;
  });
  const media = new HTMLVideoMedia("https://media.test/vod.m3u8", "hls");
  await media.read();
  expect(validation).toHaveBeenCalledOnce();
  expect(v.remove).toHaveBeenCalledOnce();
  expect(v.src).toBe("");
});

test("an opaque manifest accepts a normal GET and cancels its body after inspecting the prefix", async () => {
  vi.spyOn(Hls, "isSupported").mockReturnValue(false);
  const v = video(); vi.stubGlobal("document", { createElement: () => v });
  const cancel = vi.fn(), stream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("#EXTM3U\n".padEnd(1024))); }, cancel,
  });
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => new Headers(init.headers).has("range")
    ? new Response(null, { status: 416 }) : new Response(stream));
  vi.stubGlobal("fetch", fetcher);
  const viewer = new HTMLVideoMedia("https://media.test/opaque", undefined, "program");
  await expect(viewer.read()).rejects.toThrow("watch_live_timeline_unsupported");
  expect(cancel).toHaveBeenCalledOnce();
  viewer.close();
});

test("failed format inspection remains unknown for a creator while explicit files and declared viewers remain usable", async () => {
  vi.spyOn(Hls, "isSupported").mockReturnValue(false);
  const v = Object.assign(video(), { currentTime: 0, duration: 120, paused: true, playbackRate: 1, readyState: 2 });
  vi.stubGlobal("document", { createElement: () => v });
  const fetcher = vi.fn(async () => { throw new TypeError("Failed to fetch"); }); vi.stubGlobal("fetch", fetcher);
  const unknown = new HTMLVideoMedia("https://media.test/opaque");
  await expect(unknown.read()).rejects.toThrow("watch_source_inspection_unavailable"); unknown.close();
  fetcher.mockClear();
  const file = new HTMLVideoMedia("https://media.test/known-file", "file");
  await expect(file.read()).resolves.toMatchObject({ readyState: 2 }); expect(fetcher).not.toHaveBeenCalled(); file.close();
  const viewer = new HTMLVideoMedia("https://media.test/opaque", undefined, "media");
  await expect(viewer.read()).resolves.toMatchObject({ readyState: 2 }); viewer.close();
});

test.each([[2, "watch_media_unavailable"], [3, "watch_media_decode_failed"], [4, "watch_media_unplayable"]])(
  "MediaError code %s reaches the player as %s without exposing the platform message", async (code, expected) => {
    const v = video(); vi.stubGlobal("document", { createElement: () => v });
    const media = new HTMLVideoMedia("https://media.test/private?grant=secret", "file");
    const player = new WatchPlayer("room", false, media, vi.fn());
    Object.defineProperty(v, "error", { value: { code, message: "https://media.test/private?grant=secret" } });
    try {
      v.dispatchEvent(new Event("error"));
      await vi.waitFor(() => expect(player.error).toBe(expected));
      await expect(media.ready(new AbortController().signal)).rejects.toThrow(expected);
      if (code === 4) {
        for (const lang of ["en", "zh", "zh-Hant", "ja", "ko"] as const) {
          const failure = channelErrorPresentation(player.error, key => t(lang, key));
          expect(failure.message).toBe(t(lang, "watch.sourceUnplayable"));
          expect(failure.connectionHelp).toBe(false);
        }
      }
    } finally { player.close(); }
  });

test.each([401, 403])("HLS HTTP %s presents the source access failure", code => {
  const error = watchHlsFailure({ type: Hls.ErrorTypes.NETWORK_ERROR, details: Hls.ErrorDetails.FRAG_LOAD_ERROR,
    response: { url: "https://private.invalid/?token=secret", code, data: undefined, text: "private response" } });
  expect(channelErrorPresentation(error, key => t("en", key)).message).toBe(t("en", "watch.mediaAccessDenied"));
});

test("fatal HLS facts distinguish codec support and input loading without guessing decode", () => {
  expect(watchHlsFailure({ type: Hls.ErrorTypes.MEDIA_ERROR, details: Hls.ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR })).toBe("watch_media_unsupported");
  expect(watchHlsFailure({ type: Hls.ErrorTypes.NETWORK_ERROR, details: Hls.ErrorDetails.FRAG_LOAD_TIMEOUT })).toBe("watch_media_unavailable");
  expect(watchHlsFailure({ type: Hls.ErrorTypes.NETWORK_ERROR, details: Hls.ErrorDetails.MANIFEST_PARSING_ERROR })).toBe("watch_invalid_manifest");
  expect(watchHlsFailure({ type: Hls.ErrorTypes.MEDIA_ERROR, details: Hls.ErrorDetails.BUFFER_APPEND_ERROR })).toBe("watch_media_failed");
});

test("a browser registration refusal reaches readiness as a page capability failure", async () => {
  const v = video(); vi.stubGlobal("document", { createElement: () => v });
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("navigator", { serviceWorker: Object.assign(new EventTarget(), { register: async () => {
    throw new DOMException("An SSL certificate error occurred when fetching the script.", "SecurityError");
  } }) });
  const media = createResourceWatchMedia({ resourceId: "11111111-1111-4111-8111-111111111111", format: "file" }, vi.fn(), { hlsDeadlineOwner: "reader" });
  const waiting = media.ready(new AbortController().signal);
  await expect(waiting).rejects.toThrow("watch_peer_unavailable"); media.close();
});

test("readiness cancellation remains immediate while setup is pending", async () => {
  vi.useFakeTimers(); const v = video(); vi.stubGlobal("document", { createElement: () => v });
  const media = new HTMLVideoMedia(() => new Promise(() => {}), "file"), lifetime = new AbortController();
  const waiting = media.ready(lifetime.signal); const check = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  lifetime.abort(); await check; expect(vi.getTimerCount()).toBe(0); media.close();
});

test("a slow resource setup and later media event complete without an invented readiness failure", async () => {
  vi.useFakeTimers(); const v = video(); vi.stubGlobal("document", { createElement: () => v });
  let finish!: (resource: { url: string; close(): void }) => void;
  const media = new HTMLVideoMedia(() => new Promise(resolve => { finish = resolve; }), "file");
  const waiting = media.ready(new AbortController().signal);
  let ready = false; void waiting.then(() => { ready = true; });
  await vi.advanceTimersByTimeAsync(30000); expect(ready).toBe(false);
  finish({ url: "https://media.test/video", close() {} });
  await vi.advanceTimersByTimeAsync(30000); expect(ready).toBe(false);
  v.readyState = 2; v.dispatchEvent(new Event("loadeddata"));
  await waiting; media.close(); expect(vi.getTimerCount()).toBe(0);
});

test("HLS can receive through the Reader when Service Workers are unavailable", async () => {
  vi.spyOn(Hls, "isSupported").mockReturnValue(true);
  vi.stubGlobal("isSecureContext", false); vi.stubGlobal("navigator", {});
  expect(canReceivePeerWatch("hls", Hls.isSupported())).toBe(true); expect(canReceivePeerWatch("file")).toBe(false);
  vi.spyOn(Hls, "isSupported").mockReturnValue(false);
  expect(canReceivePeerWatch("hls", Hls.isSupported())).toBe(false);
  const v = video(); vi.stubGlobal("document", { createElement: () => v });
  const media = createResourceWatchMedia({ resourceId: "11111111-1111-4111-8111-111111111111", format: "hls" }, vi.fn(), { hlsDeadlineOwner: "reader" });
  await expect(media.ready(new AbortController().signal)).rejects.toThrow("watch_peer_requires_secure_context"); media.close();
});

test("peer HLS preserves controlled Reader failure boundaries without publishing arbitrary response text", () => {
  for (const code of ["watch_path_unavailable", "watch_media_timeout", "watch_source_failed"]) {
    const error = { type: Hls.ErrorTypes.NETWORK_ERROR, details: Hls.ErrorDetails.MANIFEST_LOAD_ERROR,
      response: { url: "https://watch-media.invalid/resource", code: 0, data: undefined, text: code } };
    expect(watchHlsFailure(error, true)).toBe(code);
    expect(watchHlsFailure(error)).toBe("watch_media_unavailable");
  }
  expect(watchHlsFailure({ type: Hls.ErrorTypes.NETWORK_ERROR, details: Hls.ErrorDetails.FRAG_LOAD_ERROR,
    response: { url: "https://watch-media.invalid/resource", code: 0, data: undefined, text: "https://private.invalid/?token=secret" } }, true)).toBe("watch_media_unavailable");
});

test("App error during readiness rejects immediately even when its pending state read succeeds", async () => {
  vi.useFakeTimers();
  let emit!: (event: WatchMediaEvent) => void, resolveRead!: (state: WatchMediaState) => void;
  const media = new AppPageMedia({
    read: () => new Promise(resolve => { resolveRead = resolve; }), patch: async () => {}, focus: async () => {}, close() {},
    listen(listener) { emit = listener; return () => {}; },
  });
  try {
    await media.opening;
    const waiting = media.ready(new AbortController().signal);
    const rejected = expect(waiting).rejects.toThrow("watch_media_failed");
    await vi.advanceTimersByTimeAsync(0);
    emit("error");
    resolveRead({ position: 0, paused: true, rate: 1, duration: 60, readyState: 4, ended: false, buffered: [[0, 60]] });
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  } finally { media.close(); }
});
