import Hls from "hls.js";
import { afterEach, expect, test, vi } from "vitest";
import { AppPageMedia, canReceivePeerWatch, createPeerWatchMedia, HTMLVideoMedia, type WatchMediaEvent, type WatchMediaState } from "../src/client/channel/watch-media";
import { watchHlsFailure } from "../src/client/channel/watch-media-failure";
import { channelErrorPresentation } from "../src/client/channel/error-presentation";
import { t } from "../src/client/ui/copy";
import { WatchPlayer } from "../src/client/channel/watch-playback";

function video() {
  return Object.assign(new EventTarget(), { src: "", readyState: 0, buffered: { length: 0, start: vi.fn(), end: vi.fn() }, error: null,
    pause: vi.fn(), load: vi.fn(), remove: vi.fn(), removeAttribute: vi.fn() });
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test.each([[2, "watch_media_unavailable"], [3, "watch_media_decode_failed"], [4, "watch_media_unsupported"]])(
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
          expect(failure.message).toBe(t(lang, "watch.playbackUnsupported"));
          expect(failure.connectionHelp).toBe(false);
        }
      }
    } finally { player.close(); }
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
  vi.stubGlobal("navigator", { serviceWorker: { register: async () => {
    throw new DOMException("An SSL certificate error occurred when fetching the script.", "SecurityError");
  } } });
  const media = createPeerWatchMedia({ resourceId: "11111111-1111-4111-8111-111111111111", format: "file" }, vi.fn());
  const waiting = media.ready(new AbortController().signal);
  await expect(waiting).rejects.toThrow("watch_peer_unavailable"); media.close();
});

test("readiness cancellation remains immediate while setup is pending", async () => {
  vi.useFakeTimers(); const v = video(); vi.stubGlobal("document", { createElement: () => v });
  const media = new HTMLVideoMedia(() => new Promise(() => {}), "file"), lifetime = new AbortController();
  const waiting = media.ready(lifetime.signal); const check = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  lifetime.abort(); await check; expect(vi.getTimerCount()).toBe(0); media.close();
});

test("setup and media readiness share the original twenty-second deadline", async () => {
  vi.useFakeTimers(); const v = video(); vi.stubGlobal("document", { createElement: () => v });
  let finish!: (resource: { url: string; close(): void }) => void;
  const media = new HTMLVideoMedia(() => new Promise(resolve => { finish = resolve; }), "file");
  const waiting = media.ready(new AbortController().signal); const check = expect(waiting).rejects.toThrow("watch_media_failed");
  await vi.advanceTimersByTimeAsync(19000); finish({ url: "https://media.test/video", close() {} });
  await vi.advanceTimersByTimeAsync(1000); await check; media.close(); expect(vi.getTimerCount()).toBe(0);
});

test("HLS can receive through the Reader when Service Workers are unavailable", async () => {
  vi.spyOn(Hls, "isSupported").mockReturnValue(true);
  vi.stubGlobal("isSecureContext", false); vi.stubGlobal("navigator", {});
  expect(canReceivePeerWatch("hls")).toBe(true); expect(canReceivePeerWatch("file")).toBe(false);
  vi.spyOn(Hls, "isSupported").mockReturnValue(false);
  expect(canReceivePeerWatch("hls")).toBe(false);
  const v = video(); vi.stubGlobal("document", { createElement: () => v });
  const media = createPeerWatchMedia({ resourceId: "11111111-1111-4111-8111-111111111111", format: "hls" }, vi.fn());
  await expect(media.ready(new AbortController().signal)).rejects.toThrow("watch_peer_requires_secure_context"); media.close();
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
