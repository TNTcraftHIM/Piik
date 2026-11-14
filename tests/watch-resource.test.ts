import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, test, vi } from "vitest";
import { HTMLVideoMedia, createPeerWatchMedia } from "../src/client/channel/watch-media";
import { openWatchResource } from "../src/client/channel/watch-resource";

const rootId = "11111111-1111-4111-8111-111111111111";
const leaseId = "22222222-2222-4222-8222-222222222222";

function worker(holdReads = false, size = 100000) {
  const listeners = new Map<string, (event: unknown) => void>();
  const reads: unknown[] = [];
  const replies: (() => void)[] = [];
  let cancelled = false;
  runInNewContext(readFileSync(new URL("../public/watch-media-worker.js", import.meta.url), "utf8"), {
    URL, Response, MessageChannel, ReadableStream, ArrayBuffer, Uint8Array, setTimeout, clearTimeout,
    self: { location: { origin: "https://piik.test" }, addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
      clients: { get: async (id: string) => id === "owner-page" ? { url: "https://piik.test/", postMessage: (_value: unknown, ports: MessagePort[]) => {
        const port = ports[0];
        port.onmessage = ({ data }) => {
          if (data.type === "stat") port.postMessage({ id: data.id, size, mimeType: "video/mp4" });
          if (data.type === "read") {
            const { id, ...range } = data; reads.push(range);
            const reply = () => { const bytes = new Uint8Array(data.length).fill(Math.floor(data.offset / 65536) + 1).buffer; port.postMessage({ id, bytes }, [bytes]); };
            if (holdReads) replies.push(reply); else reply();
          }
          if (data.type === "cancel") { cancelled = true; port.close(); }
        };
      } } : undefined } },
  });
  return { reads, replies, cancelled: () => cancelled, fetch: (range?: string, method = "GET", clientId = "owner-page", path = `/__watch-media/${leaseId}/${rootId}`, destination: RequestDestination = "") => {
    let response: Promise<Response> | undefined;
    const request = new Request(`https://piik.test${path}`, { method, headers: range ? { range } : {} });
    Object.defineProperty(request, "destination", { value: destination });
    listeners.get("fetch")!({ clientId, request,
      respondWith: (value: Promise<Response>) => { response = value; } });
    return response;
  } };
}

describe("page-owned virtual media HTTP", () => {
  test("normal, bounded and suffix ranges use proper HTTP headers and bounded windows", async () => {
    const w = worker();
    const response = await w.fetch("bytes=123-99999", "GET", "owner-page", `/__watch-media/${leaseId}/${rootId}`, "video")!;
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 123-99999/100000");
    expect((await response.arrayBuffer()).byteLength).toBe(99877);
    expect(w.reads).toEqual([{ type: "read", offset: 123, length: 65536 }, { type: "read", offset: 65659, length: 34341 }]);
    const suffix = await w.fetch("bytes=-2")!;
    expect(suffix.headers.get("content-range")).toBe("bytes 99998-99999/100000");
    expect((await suffix.arrayBuffer()).byteLength).toBe(2);
    const full = await w.fetch()!;
    expect(full.status).toBe(200); expect((await full.arrayBuffer()).byteLength).toBe(100000);
  });
  test("HEAD does not read media; invalid ranges, foreign clients and unrelated paths fail at their boundary", async () => {
    const w = worker();
    const head = await w.fetch("bytes=10-20", "HEAD")!;
    expect(head.status).toBe(200); expect(head.headers.get("content-length")).toBe("100000");
    expect(w.reads).toEqual([]);
    for (const range of ["bytes=100000-", "bytes=9-3", "bytes=-0", "bytes=0-1,3-4"]) expect((await w.fetch(range)!).status).toBe(416);
    expect((await w.fetch(undefined, "GET", "other-page")!).status).toBe(403);
    expect((await w.fetch(undefined, "GET", "owner-page", `/__watch-media/${leaseId}/${rootId}`, "document")!).status).toBe(403);
    expect(w.fetch(undefined, "GET", "owner-page", "/prototype/channel/rooms")).toBeUndefined();
  });
  test("stream cancel closes all four windows without prefetching a fifth", async () => {
    const w = worker(false, 6 * 65536), response = await w.fetch()!, reader = response.body!.getReader();
    expect(w.reads).toEqual([]);
    await reader.read(); await reader.cancel();
    await vi.waitFor(() => expect(w.cancelled()).toBe(true));
    expect(w.reads).toEqual(Array.from({ length: 4 }, (_, index) => ({ type: "read", offset: index * 65536, length: 65536 })));
  });
  test("adjacent reads overlap but out-of-order replies preserve byte order", async () => {
    const w = worker(true, 4 * 65536), response = await w.fetch()!, reader = response.body!.getReader();
    const first = reader.read();
    await vi.waitFor(() => expect(w.replies).toHaveLength(4));
    for (const index of [3, 1, 2, 0]) w.replies[index]();
    expect((await first).value).toEqual(new Uint8Array(65536).fill(1));
    for (const value of [2, 3, 4]) expect((await reader.read()).value).toEqual(new Uint8Array(65536).fill(value));
    expect((await reader.read()).done).toBe(true);
  });
});

test("fetches share four source slots and cancel releases queued siblings without retiring another fetch", async () => {
  const controller = { scriptURL: "https://piik.test/watch-media-worker.js" };
  const worker = Object.assign(new EventTarget(), { controller, register: async () => {} });
  vi.stubGlobal("navigator", { serviceWorker: worker });
  vi.stubGlobal("location", { origin: "https://piik.test" });
  vi.stubGlobal("isSecureContext", true);
  const signals: AbortSignal[] = [], offsets: number[] = [], ports: MessagePort[] = [];
  const lifetime = new AbortController();
  const lease = await openWatchResource(rootId, async (_id, offset, _length, signal) => {
    signals.push(signal); offsets.push(offset);
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }, lifetime.signal);
  try {
    for (let fetch = 0; fetch < 3; fetch++) {
      const { port1, port2 } = new MessageChannel(); ports.push(port2);
      const event = new Event("message");
      Object.assign(event, { source: controller, ports: [port1], data: { type: "watch_resource_open", leaseId: lease.url.split("/")[2], resourceId: rootId } });
      worker.dispatchEvent(event);
      for (let window = 0; window < (fetch === 0 ? 4 : 2); window++) port2.postMessage({ id: window + 1, type: "read", offset: (fetch === 0 ? 0 : fetch * 2 + 2) + window, length: 1 });
      if (fetch === 0) await vi.waitFor(() => expect(signals).toHaveLength(4));
    }
    // Later fetches wait instead of being rejected while the first owns all four slots.
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(offsets).toEqual([0, 1, 2, 3]);
    ports[0].postMessage({ type: "cancel" });
    await vi.waitFor(() => expect(offsets).toEqual([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(signals.map(signal => signal.aborted)).toEqual([true, true, true, true, false, false, false, false]);
    lease.close();
    expect(signals.every(signal => signal.aborted)).toBe(true);
  } finally { lifetime.abort(); for (const port of ports) port.close(); vi.unstubAllGlobals(); }
});

test("closing during bounded direct format detection cancels I/O and cannot attach a late source", async () => {
  const video = Object.assign(new EventTarget(), { playsInline: false, preload: "", src: "", pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn(), remove: vi.fn() });
  let signal: AbortSignal | undefined;
  let finish!: (value: Response) => void;
  vi.stubGlobal("document", { createElement: () => video });
  vi.stubGlobal("fetch", vi.fn((_url, options) => { signal = options.signal; return new Promise<Response>(resolve => { finish = resolve; }); }));
  try {
    const media = new HTMLVideoMedia("https://media.test/no-extension");
    media.close(); expect(signal?.aborted).toBe(true);
    finish(new Response("#EXTM3U\n", { headers: { "content-type": "application/vnd.apple.mpegurl" } }));
    await Promise.resolve(); await Promise.resolve();
    expect(video.src).toBe("");
  } finally { vi.unstubAllGlobals(); }
});

test("a server ignoring the direct sniff range is canceled after the bounded header", async () => {
  let cancelled = false;
  const video = Object.assign(new EventTarget(), { readyState: 2, buffered: { length: 0 }, src: "", pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn(), remove: vi.fn() });
  vi.stubGlobal("document", { createElement: () => video });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(65536)); }, cancel() { cancelled = true; },
  }))));
  const media = new HTMLVideoMedia("https://media.test/ordinary");
  try {
    await media.read(); expect(cancelled).toBe(true); expect(video.src).toBe("https://media.test/ordinary");
  } finally { media.close(); vi.unstubAllGlobals(); }
});

test("closing while service-worker registration is pending leaves no reader lease", async () => {
  let registered!: () => void;
  const listener = vi.fn(), read = vi.fn();
  const video = Object.assign(new EventTarget(), { src: "", pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn(), remove: vi.fn() });
  vi.stubGlobal("document", { createElement: () => video }); vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("navigator", { serviceWorker: { register: () => new Promise<void>(resolve => { registered = resolve; }), addEventListener: listener } });
  try {
    const media = createPeerWatchMedia({ resourceId: rootId, format: "file" }, read);
    media.close(); registered(); await Promise.resolve(); await Promise.resolve();
    expect(read).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled(); expect(video.src).toBe("");
  } finally { vi.unstubAllGlobals(); }
});
