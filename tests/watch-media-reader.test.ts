import Hls from "hls.js";
import { afterEach, expect, test, vi } from "vitest";
import { canReceivePeerWatch, createPeerWatchMedia, HTMLVideoMedia } from "../src/client/channel/watch-media";

function video() {
  return Object.assign(new EventTarget(), { src: "", readyState: 0, buffered: { length: 0, start: vi.fn(), end: vi.fn() }, error: null,
    pause: vi.fn(), load: vi.fn(), remove: vi.fn(), removeAttribute: vi.fn() });
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
