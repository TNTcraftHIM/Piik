import Hls, { type LoaderCallbacks, type LoaderConfiguration, type LoaderContext } from "hls.js";
import { afterEach, expect, test, vi } from "vitest";
vi.mock("../src/shared/media-resource", () => ({
  mediaFragmentBytes: () => 60000000,
  mediaManifestBytes: () => 1048576,
}));
import { createWatchHlsLoader, watchHlsUrl } from "../src/client/channel/watch-hls-loader";
import { type WatchByteReader, type WatchByteResult } from "../src/client/channel/watch-resource";

const id = "11111111-1111-4111-8111-111111111111";
const bytes = Uint8Array.from({ length: 400000 }, (_, i) => i % 251);
const result = (offset: number, length: number): WatchByteResult => ({ bytes: bytes.slice(offset, offset + length), totalSize: bytes.length, eof: offset + length >= bytes.length, mimeType: "video/mp2t" });
const config = (first = 1000, total = 5000): LoaderConfiguration => ({ loadPolicy: { maxTimeToFirstByteMs: first, maxLoadTimeMs: total, timeoutRetry: null, errorRetry: null }, timeout: total, maxRetry: 0, retryDelay: 0, maxRetryDelay: 0 });
const context = (rangeStart = 0, rangeEnd = 0): LoaderContext => ({ url: watchHlsUrl(id), responseType: "arraybuffer", rangeStart, rangeEnd } as LoaderContext);
const callbacks = () => ({ onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn(), onAbort: vi.fn(), onProgress: vi.fn() }) satisfies LoaderCallbacks<LoaderContext>;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function delayedReader(delay = 10) {
  let active = 0, peak = 0;
  const calls: { offset: number; length: number; signal: AbortSignal }[] = [];
  const read: WatchByteReader = async (_id, offset, length, signal) => {
    calls.push({ offset, length, signal }); active++; peak = Math.max(peak, active);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, delay);
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
      });
      return result(offset, length);
    } finally { active--; }
  };
  return { read, calls, active: () => active, peak: () => peak };
}

test("HLS ranges use four overlapping 64KiB windows and real byte/time statistics", async () => {
  vi.useFakeTimers(); vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  const reader = delayedReader(), lifetime = new AbortController();
  const Loader = createWatchHlsLoader(reader.read, lifetime.signal), loader = new Loader(Hls.DefaultConfig), cb = callbacks();
  loader.load(context(123, 300123), config(), cb);
  await vi.advanceTimersByTimeAsync(0);
  expect(reader.calls.map(c => c.offset)).toEqual([123]);
  await vi.advanceTimersByTimeAsync(10);
  expect(reader.active()).toBe(4); expect(reader.calls.slice(1).map(c => c.offset)).toEqual([65659, 131195, 196731, 262267]);
  await vi.advanceTimersByTimeAsync(10);
  expect(cb.onSuccess).toHaveBeenCalledOnce(); expect(cb.onError).not.toHaveBeenCalled();
  expect(new Uint8Array(cb.onSuccess.mock.calls[0][0].data as ArrayBuffer)).toEqual(bytes.slice(123, 300123));
  expect(reader.peak()).toBe(4); expect(reader.calls.every(c => c.length <= 65536)).toBe(true);
  expect(loader.stats.loaded).toBe(300000); expect(loader.stats.total).toBe(300000);
  expect(loader.stats.loading.end - loader.stats.loading.first).toBe(10);
  expect(loader.stats.bwEstimate).toBe(120000000); expect(vi.getTimerCount()).toBe(0);
});

test("concurrent HLS fetches share four source slots and a fifth fetch reports busy", async () => {
  vi.useFakeTimers(); const reader = delayedReader(20), lifetime = new AbortController();
  const Loader = createWatchHlsLoader(reader.read, lifetime.signal);
  const loads = Array.from({ length: 5 }, () => ({ loader: new Loader(Hls.DefaultConfig), cb: callbacks() }));
  for (const { loader, cb } of loads) loader.load(context(), config(), cb);
  expect(loads[4].cb.onError.mock.calls[0][0].text).toBe("watch_read_busy");
  await vi.advanceTimersByTimeAsync(5); expect(reader.peak()).toBe(4);
  loads[0].loader.abort();
  await vi.advanceTimersByTimeAsync(300);
  expect(loads[0].cb.onAbort).toHaveBeenCalledOnce(); expect(loads[0].cb.onSuccess).not.toHaveBeenCalled();
  expect(loads.slice(1, 4).every(x => x.cb.onSuccess.mock.calls.length === 1)).toBe(true);
  expect(reader.peak()).toBe(4); expect(reader.active()).toBe(0); expect(vi.getTimerCount()).toBe(0);
});

test("first-byte and overall deadlines cancel Reader I/O without late callbacks", async () => {
  vi.useFakeTimers(); vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  const reader = delayedReader(100), lifetime = new AbortController(), Loader = createWatchHlsLoader(reader.read, lifetime.signal);
  const loader = new Loader(Hls.DefaultConfig), cb = callbacks();
  loader.load(context(), config(3, 50), cb);
  await vi.advanceTimersByTimeAsync(3);
  expect(cb.onTimeout).toHaveBeenCalledOnce(); expect(reader.calls[0].signal.aborted).toBe(true);
  const second = new Loader(Hls.DefaultConfig), other = callbacks();
  second.load(context(), config(110, 150), other);
  await vi.advanceTimersByTimeAsync(149); expect(other.onTimeout).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(other.onTimeout).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(200);
  expect(other.onSuccess).not.toHaveBeenCalled(); expect(other.onError).not.toHaveBeenCalled();
  expect(reader.active()).toBe(0); expect(vi.getTimerCount()).toBe(0);
});

test("destroy suppresses callbacks and late replies", async () => {
  let release!: (value: WatchByteResult) => void;
  const read = vi.fn<WatchByteReader>(() => new Promise(resolve => { release = resolve; }));
  const lifetime = new AbortController(), Loader = createWatchHlsLoader(read, lifetime.signal), loader = new Loader(Hls.DefaultConfig), cb = callbacks();
  loader.load(context(), config(), cb); await Promise.resolve();
  loader.destroy(); release(result(0, 1));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(read.mock.calls[0][3].aborted).toBe(true);
  expect(cb.onSuccess).not.toHaveBeenCalled(); expect(cb.onError).not.toHaveBeenCalled(); expect(cb.onAbort).not.toHaveBeenCalled();
});

test("out-of-order windows preserve media bytes and lifetime stop cancels sibling fetches", async () => {
  const pending: { offset: number; length: number; resolve(value: WatchByteResult): void; signal: AbortSignal }[] = [];
  const read: WatchByteReader = async (_id, offset, length, signal) => {
    return new Promise((resolve, reject) => {
      pending.push({ offset, length, resolve, signal });
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const lifetime = new AbortController(), Loader = createWatchHlsLoader(read, lifetime.signal), cb = callbacks();
  new Loader(Hls.DefaultConfig).load(context(0, 300000), config(), cb);
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  const first = pending.shift()!;
  first.resolve(result(first.offset, first.length));
  await vi.waitFor(() => expect(pending).toHaveLength(4));
  for (const part of pending.toReversed()) part.resolve(result(part.offset, part.length));
  await vi.waitFor(() => expect(cb.onSuccess).toHaveBeenCalledOnce());
  expect(new Uint8Array(cb.onSuccess.mock.calls[0][0].data as ArrayBuffer)).toEqual(bytes.slice(0, 300000));
  pending.length = 0;
  const siblings = Array.from({ length: 2 }, () => ({ loader: new Loader(Hls.DefaultConfig), cb: callbacks() }));
  for (const item of siblings) item.loader.load(context(), config(), item.cb);
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  for (const part of pending.splice(0)) part.resolve(result(part.offset, part.length));
  await vi.waitFor(() => expect(pending).toHaveLength(4));
  lifetime.abort();
  await vi.waitFor(() => expect(pending.every(part => part.signal.aborted)).toBe(true));
  for (const item of siblings) {
    expect(item.cb.onAbort).toHaveBeenCalledOnce(); expect(item.cb.onSuccess).not.toHaveBeenCalled(); expect(item.cb.onError).not.toHaveBeenCalled();
  }
});

test("only admitted UUID locators reach the Reader and source errors retain their reason", async () => {
  const read = vi.fn<WatchByteReader>(async () => { throw new Error("watch_source_retired"); });
  const lifetime = new AbortController(), Loader = createWatchHlsLoader(read, lifetime.signal), cb = callbacks();
  new Loader(Hls.DefaultConfig).load({ ...context(), url: "https://origin.test/media.ts" }, config(), cb);
  await vi.waitFor(() => expect(cb.onError).toHaveBeenCalledOnce()); expect(read).not.toHaveBeenCalled();
  const source = callbacks(); new Loader(Hls.DefaultConfig).load(context(), config(), source);
  await vi.waitFor(() => expect(source.onError).toHaveBeenCalledOnce());
  expect(source.onError.mock.calls[0][0].text).toBe("watch_source_retired");
});

test("each live playlist reload consumes one complete atomic window without a stat read", async () => {
  const manifests = ["#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:100\n", "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:101\n"];
  const read = vi.fn<WatchByteReader>(async () => {
    const bytes = new TextEncoder().encode(manifests.shift()!);
    return { bytes, totalSize: bytes.length, eof: true, mimeType: "application/vnd.apple.mpegurl" };
  });
  const lifetime = new AbortController(), Loader = createWatchHlsLoader(read, lifetime.signal);
  for (const sequence of [100, 101]) {
    const cb = callbacks(); new Loader(Hls.DefaultConfig).load({ ...context(), responseType: "text" }, config(), cb);
    await vi.waitFor(() => expect(cb.onSuccess).toHaveBeenCalledOnce());
    expect(cb.onSuccess.mock.calls[0][0].data).toContain(`SEQUENCE:${sequence}`);
  }
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls.every(([, offset, length]) => offset === 0 && length === 65536)).toBe(true);
});

test("large immutable VOD playlists keep the first window and read only the remainder", async () => {
  const read = vi.fn<WatchByteReader>(async (_id, offset, length) => result(offset, length));
  const lifetime = new AbortController(), Loader = createWatchHlsLoader(read, lifetime.signal), cb = callbacks();
  new Loader(Hls.DefaultConfig).load({ ...context(), responseType: "text" }, config(), cb);
  await vi.waitFor(() => expect(cb.onSuccess).toHaveBeenCalledOnce());
  expect(read.mock.calls.slice(0, 2).map(([, offset]) => offset)).toEqual([0, 65536]);
  expect(cb.onSuccess.mock.calls[0][0].data).toBe(new TextDecoder().decode(bytes));
});

test.each([
  { responseType: "arraybuffer", size: 60000001, statLength: 65536 },
  { responseType: "text", size: 1048577, statLength: 65536 },
] as const)("HLS rejects an oversized $responseType before reading its body", async ({ responseType, size, statLength }) => {
  const read = vi.fn<WatchByteReader>(async (_id, _offset, length) => {
    if (read.mock.calls.length > 1) throw new Error("unexpected_body_read");
    return { bytes: new Uint8Array(length), totalSize: size, eof: false, mimeType: "application/octet-stream" };
  });
  const lifetime = new AbortController(), Loader = createWatchHlsLoader(read, lifetime.signal), cb = callbacks();
  new Loader(Hls.DefaultConfig).load({ ...context(), responseType }, config(), cb);
  await vi.waitFor(() => expect(cb.onError).toHaveBeenCalledOnce());
  expect(cb.onError.mock.calls[0][0]).toEqual({ code: 0, text: "watch_resource_limit" });
  expect(cb.onSuccess).not.toHaveBeenCalled();
  expect(read.mock.calls.map(([, offset, length]) => [offset, length])).toEqual([[0, statLength]]);
});

test("HLS keeps small byte ranges from a file larger than the fragment budget", async () => {
  const size = 128 * 1024 * 1024;
  const read = vi.fn<WatchByteReader>(async (_id, offset, length) => ({
    bytes: Uint8Array.from({ length }, (_, i) => (offset + i) % 251),
    totalSize: size, eof: offset + length === size, mimeType: "video/mp4",
  }));
  const lifetime = new AbortController(), Loader = createWatchHlsLoader(read, lifetime.signal), cb = callbacks();
  new Loader(Hls.DefaultConfig).load(context(310, 553), config(), cb);
  await vi.waitFor(() => expect(cb.onSuccess).toHaveBeenCalledOnce());
  expect(new Uint8Array(cb.onSuccess.mock.calls[0][0].data as ArrayBuffer))
    .toEqual(Uint8Array.from({ length: 243 }, (_, i) => (310 + i) % 251));
  expect(read.mock.calls.map(([, offset, length]) => [offset, length])).toEqual([[310, 243]]);
  expect(cb.onError).not.toHaveBeenCalled();
});
