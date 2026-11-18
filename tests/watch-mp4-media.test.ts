import { afterEach, expect, test, vi } from "vitest";
import type { Movie, Track } from "mp4box";
import { canReadWatchMp4, isWatchMp4, WatchMp4Media } from "../src/client/channel/watch-mp4-media";
import { HTMLVideoMedia, canReceivePeerWatch, createPeerWatchMedia } from "../src/client/channel/watch-media";
import { limitWatchReads, type WatchByteReader, type WatchByteResult } from "../src/client/channel/watch-resource";

const runtime = vi.hoisted(() => ({ parsers: [] as unknown[], malformed: false, oversized: false }));
vi.mock("mp4box", () => ({
  MP4BoxBuffer: { fromArrayBuffer: (bytes: ArrayBuffer, fileStart: number) => Object.assign(bytes, { fileStart }) },
  createFile: () => {
    const handle = Object.freeze({}), samples = Array.from({ length: 32 }, (_, i) => ({ cts: i, timescale: 1, is_sync: i % 2 === 0, size: runtime.oversized ? Number.MAX_SAFE_INTEGER : 1 }));
    const parser = {
      onReady: undefined as ((info: Movie) => void) | undefined, onError: undefined as ((module: string, message: string) => void) | undefined,
      onSegment: undefined as ((id: number, user: unknown, bytes: ArrayBuffer, sampleNumber: number) => void) | undefined,
      initialized: false, started: false, sample: 0,
      appendBuffer: vi.fn((bytes: ArrayBuffer & { fileStart: number }) => {
        if (runtime.malformed) { parser.onError?.("ISOFile", "invalid owned fixture"); return bytes.fileStart + bytes.byteLength; }
        if (!parser.initialized) {
          parser.initialized = true;
          parser.onReady?.({ duration: 24, timescale: 1, videoTracks: [{ id: 1, codec: "avc1.42c00c", type: "video" } as Track], audioTracks: [] } as unknown as Movie);
        }
        if (parser.started) parser.onSegment?.(1, null, new Uint8Array([1]).buffer, ++parser.sample);
        return bytes.fileStart + bytes.byteLength;
      }),
      getTrackById: vi.fn(() => handle), getTrackSamplesInfo: vi.fn(() => samples),
      releaseSample: vi.fn((track, index) => { expect(track).toBe(handle); expect(index).toBeLessThan(samples.length); return 1; }),
      getAllocatedSampleDataSize: () => 0, setSegmentOptions: vi.fn(), initializeSegmentation: () => ({ buffer: new Uint8Array([0]).buffer }),
      start: () => { parser.started = true; }, stop: () => { parser.started = false; },
      seek: vi.fn((time: number) => { parser.sample = 0; return { offset: Math.floor(time * 1000), time }; }), flush: vi.fn(),
    };
    runtime.parsers.push(parser); return parser;
  },
}));

type Parser = { releaseSample: ReturnType<typeof vi.fn>; seek: ReturnType<typeof vi.fn> };
class Ranges {
  values: [number, number][] = [];
  get length() { return this.values.length; }
  start(i: number) { return this.values[i][0]; }
  end(i: number) { return this.values[i][1]; }
}
class Buffer extends EventTarget {
  updating = false;
  buffered = new Ranges();
  appendBuffer = vi.fn((_bytes: ArrayBuffer) => {
    Source.last.readyState = "open";
    this.updating = true;
    queueMicrotask(() => { this.buffered.values = [[0, 2]]; this.updating = false; this.dispatchEvent(new Event("updateend")); });
  });
  remove = vi.fn((start: number, end: number) => {
    expect(this.updating).toBe(false);
    Source.last.readyState = "open";
    this.updating = true;
    queueMicrotask(() => {
      this.buffered.values = this.buffered.values.flatMap(([a, b]): [number, number][] =>
        start <= a && end >= b ? [] : [[end > a && end < b ? end : a, b]]);
      this.updating = false; this.dispatchEvent(new Event("updateend"));
    });
  });
}
class Source extends EventTarget {
  static last: Source;
  static isTypeSupported = vi.fn(() => true);
  readyState = "closed"; duration = 0; buffer = new Buffer();
  constructor() { super(); Source.last = this; }
  addSourceBuffer = vi.fn(() => this.buffer);
  endOfStream = vi.fn(() => { this.readyState = "ended"; });
}
class Video extends EventTarget {
  value = ""; position = 0; readyState = 2; error = null; duration = 24; paused = true; ended = false; playbackRate = 1;
  get src() { return this.value; }
  set src(value: string) { this.value = value; if (value.startsWith("blob:")) queueMicrotask(() => { Source.last.readyState = "open"; Source.last.dispatchEvent(new Event("sourceopen")); }); }
  get buffered() { return Source.last?.buffer.buffered ?? new Ranges(); }
  get currentTime() { return this.position; }
  set currentTime(value: number) { this.position = value; this.dispatchEvent(new Event("seeking")); }
  pause = vi.fn(() => { this.paused = true; }); play = vi.fn(async () => { this.paused = false; });
  removeAttribute = vi.fn(() => { this.value = ""; }); load = vi.fn(); remove = vi.fn();
}
const id = "11111111-1111-4111-8111-111111111111";
const first: WatchByteResult = { bytes: new Uint8Array(65536), totalSize: 300000, mimeType: "video/mp4", eof: false };
function setup() {
  const video = new Video();
  vi.stubGlobal("MediaSource", Source); vi.stubGlobal("document", { createElement: () => video });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:owned-mp4"); vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  return video;
}
function worker() {
  const register = vi.fn(async () => {});
  vi.stubGlobal("location", { origin: "https://piik.test" }); vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("navigator", { serviceWorker: Object.assign(new EventTarget(), { controller: { scriptURL: "https://piik.test/watch-media-worker.js" }, register }) });
  return register;
}
afterEach(() => { runtime.parsers.length = 0; runtime.malformed = false; runtime.oversized = false; Source.isTypeSupported.mockReturnValue(true); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("actual MP4 MIME/ftyp facts are separate from generic file and container support", () => {
  setup(); expect(canReadWatchMp4()).toBe(true);
  expect(isWatchMp4(first)).toBe(true);
  expect(isWatchMp4({ ...first, mimeType: "video/webm" })).toBe(false);
  const bytes = new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
  expect(isWatchMp4({ ...first, mimeType: "application/octet-stream", bytes })).toBe(true);
  vi.stubGlobal("MediaSource", undefined); expect(canReadWatchMp4()).toBe(false);
});

test("closing while the MP4 module loads does not acquire a media source or parser", async () => {
  const video = setup(), failed = vi.fn();
  const media = new WatchMp4Media(video as unknown as HTMLVideoElement, id, vi.fn(), first, new AbortController().signal, failed);
  const opening = media.open();
  media.close();
  await expect(opening).rejects.toMatchObject({ name: "AbortError" });
  expect(runtime.parsers).toHaveLength(0);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(failed).not.toHaveBeenCalled();
});

test("retiring MP4 cancels its four adjacent reads, removes listeners and releases samples", async () => {
  const video = setup(), signals: AbortSignal[] = [], failed = vi.fn();
  const read: WatchByteReader = async (_id, _offset, _length, signal) => {
    signals.push(signal); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  const media = new WatchMp4Media(video as unknown as HTMLVideoElement, id, limitWatchReads(read), first, new AbortController().signal, failed);
  await media.open(); await vi.waitFor(() => expect(signals).toHaveLength(4));
  media.close(); await vi.waitFor(() => expect(signals.every(signal => signal.aborted)).toBe(true));
  expect((runtime.parsers[0] as Parser).releaseSample).toHaveBeenCalledTimes(32);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:owned-mp4"); expect(video.value).toBe("");
  video.currentTime = 20; await Promise.resolve(); expect(failed).not.toHaveBeenCalled();
});

test("backward seek releases old partial samples and resets only the adapter's release cursor", async () => {
  const video = setup(), read: WatchByteReader = async (_id, offset, length) => ({ ...first, bytes: new Uint8Array(Math.min(length, first.totalSize! - offset)), eof: offset + length >= first.totalSize! });
  const media = new WatchMp4Media(video as unknown as HTMLVideoElement, id, limitWatchReads(read), first, new AbortController().signal, vi.fn());
  await media.open(); const parser = runtime.parsers[0] as Parser;
  await vi.waitFor(() => expect(Source.last.endOfStream).toHaveBeenCalled());
  const releasedBefore = parser.releaseSample.mock.calls.length;
  video.currentTime = 20;
  await vi.waitFor(() => expect(parser.seek).toHaveBeenCalledWith(20, true));
  await vi.waitFor(() => expect(Source.last.endOfStream).toHaveBeenCalledTimes(2));
  video.currentTime = 4;
  await vi.waitFor(() => expect(parser.seek).toHaveBeenCalledWith(4, true));
  await vi.waitFor(() => expect(Source.last.endOfStream).toHaveBeenCalledTimes(3));
  expect(parser.releaseSample.mock.calls.slice(releasedBefore).filter(call => call[1] === 0).length).toBe(2);
  media.close();
});

test("back-buffer pruning survives input EOF and retires with the same playback operation", async () => {
  const video = setup(), read = vi.fn<WatchByteReader>(async (_id, offset, length) => ({
    ...first, bytes: new Uint8Array(Math.min(length, first.totalSize! - offset)), eof: offset + length >= first.totalSize!,
  }));
  const failed = vi.fn();
  const media = new WatchMp4Media(video as unknown as HTMLVideoElement, id, limitWatchReads(read), first, new AbortController().signal, failed);
  await media.open();
  await vi.waitFor(() => expect(Source.last.endOfStream).toHaveBeenCalledOnce());
  const readsAtEof = read.mock.calls.length;
  Source.last.buffer.buffered.values = [[0, 64]];
  video.position = 59.2; video.dispatchEvent(new Event("timeupdate"));
  await vi.waitFor(() => expect(Source.last.buffer.remove).toHaveBeenCalledWith(0, 28));
  await vi.waitFor(() => expect(Source.last.endOfStream).toHaveBeenCalledTimes(2));
  expect(video.buffered.values).toEqual([[28, 64]]);
  expect(read).toHaveBeenCalledTimes(readsAtEof);
  media.close(); video.position = 63; video.dispatchEvent(new Event("timeupdate"));
  await Promise.resolve();
  expect(Source.last.buffer.remove).toHaveBeenCalledOnce(); expect(failed).not.toHaveBeenCalled();
});

test("known codec capability rejection can retain the original SW/native URL path", async () => {
  const video = setup(), register = worker(); Source.isTypeSupported.mockReturnValue(false);
  const read = vi.fn<WatchByteReader>(async () => first);
  const media = createPeerWatchMedia({ resourceId: id, format: "file" }, read);
  await media.read();
  expect(register).toHaveBeenCalledOnce(); expect(video.src).toContain("/__watch-media/");
  expect(URL.revokeObjectURL).toHaveBeenCalledOnce(); media.close();
});

test("non-MP4 native-playable files keep SW; a malformed MP4 never retries another adapter", async () => {
  setup(); const register = worker();
  const webm = createPeerWatchMedia({ resourceId: id, format: "file" }, async () => ({ ...first, mimeType: "video/webm" }));
  await webm.read(); expect(runtime.parsers).toHaveLength(0); expect(register).toHaveBeenCalledOnce(); webm.close();
  register.mockClear(); runtime.malformed = true;
  const mp4 = createPeerWatchMedia({ resourceId: id, format: "file" }, async () => first);
  await expect(mp4.ready(new AbortController().signal)).rejects.toThrow("watch_mp4_parse_failed");
  expect(register).not.toHaveBeenCalled(); mp4.close();
});

test("Reader I/O errors stay source errors instead of falling through to SW", async () => {
  setup(); const register = worker(); const error = new Error("watch_source_retired");
  const media: HTMLVideoMedia = createPeerWatchMedia({ resourceId: id, format: "file" }, async () => { throw error; });
  expect(canReceivePeerWatch("file")).toBe(true);
  await expect(media.ready(new AbortController().signal)).rejects.toBe(error);
  expect(register).not.toHaveBeenCalled(); media.close();
});

test("a sample outside the MSE budget fails before segmentation or an alternate adapter", async () => {
  setup(); const register = worker(); runtime.oversized = true;
  const media = createPeerWatchMedia({ resourceId: id, format: "file" }, async () => first);
  await expect(media.ready(new AbortController().signal)).rejects.toThrow("watch_resource_limit");
  expect(Source.last.addSourceBuffer).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled(); media.close();
});

test.each([false, true])("MP4 module load failure never falls through to the URL adapter (%s)", async cancelled => {
  vi.resetModules();
  let rejectLoad!: (error: Error) => void;
  const loading = new Promise<never>((_, reject) => { rejectLoad = reject; });
  const load = vi.fn(() => loading);
  vi.doMock("mp4box", load);
  try {
    const { createPeerWatchMedia: createMedia } = await import("../src/client/channel/watch-media");
    setup(); const register = worker(), lifetime = new AbortController();
    const media = createMedia({ resourceId: id, format: "file" }, async () => first);
    const failure = expect(media.ready(lifetime.signal)).rejects.toMatchObject(cancelled ? { name: "AbortError" } : { message: "watch_media_unsupported" });
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    if (cancelled) lifetime.abort();
    rejectLoad(new Error("Failed to fetch dynamically imported module: /assets/mp4box.js"));
    await failure;
    expect(runtime.parsers).toHaveLength(0);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    media.close();
  } finally { vi.doUnmock("mp4box"); vi.resetModules(); }
});
