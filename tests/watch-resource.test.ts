import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, test, vi } from "vitest";
import { HTMLVideoMedia, createPeerWatchMedia, waitForWatchMedia, type WatchMediaEvent } from "../src/client/channel/watch-media";
import { openWatchResource } from "../src/client/channel/watch-resource";

const rootId = "11111111-1111-4111-8111-111111111111";
const leaseId = "22222222-2222-4222-8222-222222222222";

function pendingRegistration() {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const registration = new Promise((yes, no) => { resolve = yes; reject = no; });
  const serviceWorker = Object.assign(new EventTarget(), {
    controller: null as null | { scriptURL: string }, register: vi.fn(() => registration),
  });
  const add = vi.spyOn(serviceWorker, "addEventListener"), remove = vi.spyOn(serviceWorker, "removeEventListener");
  vi.stubGlobal("navigator", { serviceWorker });
  vi.stubGlobal("location", { origin: "https://owned.test" });
  vi.stubGlobal("isSecureContext", true);
  return { serviceWorker, resolve, reject, add, remove };
}

test.each(["resolve", "reject"] as const)("cancellation settles before register %s and late completion cannot acquire a reader", async late => {
  vi.useFakeTimers();
  const registration = pendingRegistration(), cancel = new AbortController(), read = vi.fn(), outcome = vi.fn();
  try {
    const pending = openWatchResource(rootId, read, cancel.signal).then(value => outcome(value), error => outcome(error));
    await vi.advanceTimersByTimeAsync(30000);
    expect(outcome).not.toHaveBeenCalled();
    cancel.abort(); await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toHaveBeenCalledOnce();
    expect(outcome.mock.calls[0][0].name).toBe("AbortError");
    expect(registration.remove).toHaveBeenCalledWith("controllerchange", expect.any(Function));
    if (late === "resolve") registration.resolve({});
    else registration.reject(new Error("owned late network error"));
    await pending; await vi.advanceTimersByTimeAsync(20000);
    expect(read).not.toHaveBeenCalled();
    expect(registration.add.mock.calls.some(([type]) => type === "message")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally { cancel.abort(); registration.resolve({}); vi.useRealTimers(); vi.unstubAllGlobals(); }
});

test("registration failure rejects and successful registration waits for its matching controller", async () => {
  const cancel = new AbortController();
  try {
    const failed = pendingRegistration();
    const bad = openWatchResource(rootId, vi.fn(), cancel.signal);
    const rejected = expect(bad).rejects.toThrow("watch_peer_unavailable");
    failed.reject(new Error("script unavailable")); await rejected;
    const registration = pendingRegistration();
    const opening = openWatchResource(rootId, vi.fn(), cancel.signal);
    let resolved = false; void opening.then(() => { resolved = true; });
    registration.resolve({}); await Promise.resolve();
    registration.serviceWorker.controller = { scriptURL: "https://owned.test/unrelated.js" };
    registration.serviceWorker.dispatchEvent(new Event("controllerchange"));
    await Promise.resolve(); expect(resolved).toBe(false);
    registration.serviceWorker.controller = { scriptURL: "https://owned.test/watch-media-worker.js" };
    registration.serviceWorker.dispatchEvent(new Event("controllerchange"));
    const lease = await opening; expect(lease.url).toContain(rootId);
    lease.close();
    expect(registration.remove.mock.calls.some(([type]) => type === "message")).toBe(true);
  } finally { cancel.abort(); vi.unstubAllGlobals(); }
});

function worker(holdReads = false, size = 100000, clientReady = Promise.resolve(), pageMessage?: (value: unknown, ports: MessagePort[]) => void) {
  const listeners = new Map<string, (event: unknown) => void>();
  const reads: unknown[] = [];
  const opened = vi.fn();
  const replies: (() => void)[] = [];
  let cancelled = false;
  runInNewContext(readFileSync(new URL("../public/watch-media-worker.js", import.meta.url), "utf8"), {
    URL, Response, MessageChannel, ReadableStream, ArrayBuffer, Uint8Array, setTimeout, clearTimeout,
    self: { location: { origin: "https://piik.test" }, addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
      clients: { get: async (id: string) => {
        await clientReady;
        return id === "owner-page" ? { url: "https://piik.test/", postMessage: (_value: unknown, ports: MessagePort[]) => {
        opened();
        if (pageMessage) { pageMessage(_value, ports); return; }
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
      } } : undefined; } } },
  });
  return { reads, replies, opened, cancelled: () => cancelled, fetch: (range?: string, method = "GET", clientId = "owner-page", path = `/__watch-media/${leaseId}/${rootId}`, destination: RequestDestination = "", signal?: AbortSignal) => {
    let response: Promise<Response> | undefined;
    const request = new Request(`https://piik.test${path}`, { method, headers: range ? { range } : {}, signal });
    Object.defineProperty(request, "destination", { value: destination });
    listeners.get("fetch")!({ clientId, request,
      respondWith: (value: Promise<Response>) => { response = value; } });
    return response;
  } };
}

describe("page-owned virtual media HTTP", () => {
  test.each(["complete", "close"] as const)("both bridges retain a route-waiting read beyond 25 seconds until its owner says %s", async ending => {
    vi.useFakeTimers();
    const controller = { scriptURL: "https://piik.test/watch-media-worker.js" };
    const serviceWorker = Object.assign(new EventTarget(), { controller, register: async () => {} });
    vi.stubGlobal("navigator", { serviceWorker });
    vi.stubGlobal("location", { origin: "https://piik.test" });
    vi.stubGlobal("isSecureContext", true);
    const lifetime = new AbortController();
    let release!: () => void, readerSignal!: AbortSignal, first = true;
    const lease = await openWatchResource(rootId, async (_id, offset, length, signal) => {
      if (first) {
        first = false; readerSignal = signal;
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return { mimeType: "video/mp4", totalSize: 4, bytes: new Uint8Array([11, 22, 33, 44].slice(offset, offset + length)), eof: offset + length >= 4 };
    }, lifetime.signal);
    const w = worker(false, 4, Promise.resolve(), (data, ports) => {
      serviceWorker.dispatchEvent(Object.assign(new Event("message"), { source: controller, data, ports }));
    });
    try {
      const pending = w.fetch("bytes=1-2", "GET", "owner-page", lease.url)!;
      let settled = false; void pending.then(() => { settled = true; });
      await vi.waitFor(() => expect(readerSignal).toBeDefined());
      await vi.advanceTimersByTimeAsync(25000);
      expect(settled).toBe(false); expect(readerSignal.aborted).toBe(false);
      if (ending === "complete") {
        release();
        const response = await pending;
        expect(response.status).toBe(206);
        expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([22, 33]);
      } else {
        lease.close();
        expect(readerSignal.aborted).toBe(true);
        expect((await pending).status).toBe(410);
      }
    } finally { lease.close(); lifetime.abort(); vi.useRealTimers(); vi.unstubAllGlobals(); }
  });
  test("cancelling during client lookup does not open a late page request", async () => {
    let found!: () => void;
    const clientReady = new Promise<void>(resolve => { found = resolve; });
    const lifetime = new AbortController(), w = worker(false, 100000, clientReady);
    const pending = w.fetch(undefined, "HEAD", "owner-page", undefined, "", lifetime.signal)!;
    lifetime.abort(); found();
    expect((await pending).status).toBe(410);
    expect(w.opened).not.toHaveBeenCalled();
    expect(w.reads).toEqual([]);
  });
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
  const read = vi.fn();
  const serviceWorker = Object.assign(new EventTarget(), { register: () => new Promise<void>(resolve => { registered = resolve; }) });
  const listener = vi.spyOn(serviceWorker, "addEventListener"), removeListener = vi.spyOn(serviceWorker, "removeEventListener");
  const video = Object.assign(new EventTarget(), { src: "", pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn(), remove: vi.fn() });
  vi.stubGlobal("document", { createElement: () => video }); vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("navigator", { serviceWorker });
  try {
    const media = createPeerWatchMedia({ resourceId: rootId, format: "file" }, read);
    media.close(); registered(); await Promise.resolve(); await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
    expect(listener.mock.calls.some(([type]) => type === "message")).toBe(false);
    expect(removeListener).toHaveBeenCalledWith("controllerchange", expect.any(Function));
    expect(video.src).toBe("");
  } finally { vi.unstubAllGlobals(); }
});

test("peer readiness abort retires its pending setup reader after a long route wait", async () => {
  vi.useFakeTimers();
  const video = Object.assign(new EventTarget(), { src: "", readyState: 0, buffered: { length: 0 },
    pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn(), remove: vi.fn() });
  vi.stubGlobal("document", { createElement: () => video });
  vi.stubGlobal("MediaSource", { isTypeSupported: () => true });
  let readerSignal!: AbortSignal;
  const reader = vi.fn((_resource, _offset, _length, signal: AbortSignal) => {
    readerSignal = signal;
    return new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const media = createPeerWatchMedia({ resourceId: rootId, format: "file" }, reader);
  const closeEvent = vi.fn(); video.addEventListener("closed", closeEvent);
  const cancel = new AbortController();
  try {
    const ready = media.ready(cancel.signal);
    const rejected = expect(ready).rejects.toMatchObject({ name: "AbortError" });
    void rejected.catch(() => {});
    await vi.advanceTimersByTimeAsync(0); expect(reader).toHaveBeenCalledTimes(1);
    let settled = false; void ready.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(30000); expect(settled).toBe(false); expect(readerSignal.aborted).toBe(false);
    cancel.abort();
    await rejected;
    expect(readerSignal.aborted).toBe(true);
    expect(video.removeAttribute).toHaveBeenCalledWith("src");
    expect(closeEvent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20000); expect(reader).toHaveBeenCalledTimes(1);
  } finally { media.close(); vi.unstubAllGlobals(); vi.useRealTimers(); }
  expect(video.remove).toHaveBeenCalled();
});

test.each(["ready", "error"] as const)("readiness follows actual %s after prolonged loading instead of a generic deadline", async outcome => {
  vi.useFakeTimers();
  let loaded!: () => void;
  let changed!: (event: WatchMediaEvent) => void, readyState = 0;
  const setup = new Promise<void>(resolve => { loaded = resolve; });
  const media = { read: vi.fn(async () => ({ position: 0, paused: true, rate: 1, duration: null,
    readyState, buffered: null, ended: false })), listen: vi.fn((listener: (event: WatchMediaEvent) => void) => { changed = listener; return vi.fn(); }) };
  const cancel = new AbortController();
  try {
    const ready = waitForWatchMedia(media, cancel.signal, setup);
    let settled = false; void ready.then(() => { settled = true; }, () => { settled = true; });
    void ready.catch(() => {});
    await vi.advanceTimersByTimeAsync(30000); expect(settled).toBe(false); expect(media.read).not.toHaveBeenCalled();
    loaded(); await vi.advanceTimersByTimeAsync(30000); expect(settled).toBe(false);
    if (outcome === "ready") { readyState = 2; changed("loadeddata"); await expect(ready).resolves.toBeUndefined(); }
    else { changed("error"); await expect(ready).rejects.toThrow("watch_media_failed"); }
    expect(vi.getTimerCount()).toBe(0);
  } finally { cancel.abort(); vi.useRealTimers(); }
});

test("cancelled setup cannot arm a decoder deadline when it resolves late", async () => {
  vi.useFakeTimers();
  let loaded!: () => void;
  const setup = new Promise<void>(resolve => { loaded = resolve; });
  const media = { read: vi.fn(), listen: vi.fn(() => vi.fn()) }, cancel = new AbortController();
  try {
    const ready = waitForWatchMedia(media, cancel.signal, setup);
    const failed = expect(ready).rejects.toMatchObject({ name: "AbortError" });
    cancel.abort(); await failed; loaded(); await vi.advanceTimersByTimeAsync(30000);
    expect(media.read).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
