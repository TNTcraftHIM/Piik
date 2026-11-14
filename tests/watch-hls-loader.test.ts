import Hls, { type LoaderCallbacks, type LoaderConfiguration, type LoaderContext } from "hls.js";
import { afterEach, expect, test, vi } from "vitest";
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
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, length === 1 ? 5 : delay);
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
  await vi.advanceTimersByTimeAsync(5);
  expect(reader.active()).toBe(4); expect(reader.calls.slice(1).map(c => c.offset)).toEqual([123, 65659, 131195, 196731]);
  await vi.advanceTimersByTimeAsync(20);
  expect(cb.onSuccess).toHaveBeenCalledOnce(); expect(cb.onError).not.toHaveBeenCalled();
  expect(new Uint8Array(cb.onSuccess.mock.calls[0][0].data as ArrayBuffer)).toEqual(bytes.slice(123, 300123));
  expect(reader.peak()).toBe(4); expect(reader.calls.every(c => c.length <= 65536)).toBe(true);
  expect(loader.stats.loaded).toBe(300000); expect(loader.stats.total).toBe(300000);
  expect(loader.stats.loading.end - loader.stats.loading.first).toBe(20);
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
  second.load(context(), config(10, 50), other);
  await vi.advanceTimersByTimeAsync(49); expect(other.onTimeout).not.toHaveBeenCalled();
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
    if (length === 1) return result(0, 1);
    return new Promise((resolve, reject) => {
      pending.push({ offset, length, resolve, signal });
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const lifetime = new AbortController(), Loader = createWatchHlsLoader(read, lifetime.signal), cb = callbacks();
  new Loader(Hls.DefaultConfig).load(context(0, 200000), config(), cb);
  await vi.waitFor(() => expect(pending).toHaveLength(4));
  for (const part of pending.toReversed()) part.resolve(result(part.offset, part.length));
  await vi.waitFor(() => expect(cb.onSuccess).toHaveBeenCalledOnce());
  expect(new Uint8Array(cb.onSuccess.mock.calls[0][0].data as ArrayBuffer)).toEqual(bytes.slice(0, 200000));
  pending.length = 0;
  const siblings = Array.from({ length: 2 }, () => ({ loader: new Loader(Hls.DefaultConfig), cb: callbacks() }));
  for (const item of siblings) item.loader.load(context(), config(), item.cb);
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
