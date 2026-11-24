import type { ISOFile, Movie, Track } from "mp4box";
import { readWatchWindows, WATCH_READ_AHEAD, WATCH_READ_SIZE } from "./watch-read-windows";
import type { WatchByteReader, WatchByteResult } from "./watch-resource";
import { watchElementFailure } from "./watch-media-failure";

// MP4 buffering keeps the limits originally taken from hls.js 1.7.4.
const MAX_BUFFER_BYTES = 60_000_000;
const MAX_FORWARD_BUFFER_SECONDS = 30;

export function canReadWatchMp4(): boolean {
  return typeof MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function";
}

/** Content facts select MP4; a generic file source is not a container declaration. */
export function isWatchMp4(first: WatchByteResult): boolean {
  if (/^(?:video|audio|application)\/mp4(?:;|$)/i.test(first.mimeType)) return true;
  const bytes = first.bytes, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 12 <= bytes.length;) {
    const size = view.getUint32(offset);
    if (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) === "ftyp" && size >= 16) return true;
    if (size < 8 || offset + size > bytes.length) break;
    offset += size;
  }
  return false;
}

function waitEvent(target: EventTarget, type: string, signal: AbortSignal, start?: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { target.removeEventListener(type, done); signal.removeEventListener("abort", abort); };
    const done = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(signal.reason); };
    target.addEventListener(type, done, { once: true }); signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else { try { start?.(); } catch (error) { cleanup(); reject(error); } }
  });
}

interface Append { trackId: number; sampleNumber: number; bytes: ArrayBuffer }

/** GPAC owns MP4 indexing/fragmentation; this player owns its single MSE buffer. */
export class WatchMp4Media {
  private lifetime = new AbortController();
  private signal: AbortSignal;
  private operation = new AbortController();
  private work: Promise<void> = Promise.resolve();
  private opening: { resolve(): void; reject(error: unknown): void } | null = null;
  private mp4box?: typeof import("mp4box");
  private parser: ISOFile | null = null;
  private mediaSource?: MediaSource;
  private buffer?: SourceBuffer;
  private url?: string;
  private tracks: Track[] = [];
  private released = new Map<number, number>();
  private appends: Append[] = [];
  private appendBytes = 0;
  private seek = () => {
    const time = this.video.currentTime;
    for (let i = 0; i < this.video.buffered.length; i++)
      if (time >= this.video.buffered.start(i) && time <= this.video.buffered.end(i)) return;
    if (this.buffer) this.start(time);
  };
  private mediaError = () => this.fail(new Error(watchElementFailure(this.video.error) ?? "watch_media_failed"));
  private retire = () => this.close();

  constructor(private video: HTMLVideoElement, private resourceId: string, private read: WatchByteReader,
    private first: WatchByteResult, lifetime: AbortSignal, private failed: (error: Error) => void) {
    this.signal = AbortSignal.any([this.lifetime.signal, lifetime]);
    this.signal.addEventListener("abort", this.retire, { once: true });
  }

  async open(): Promise<void> {
    this.signal.throwIfAborted();
    if (!canReadWatchMp4()) throw new Error("watch_mp4_mse_unavailable");
    if (this.first.totalSize === null || !Number.isSafeInteger(this.first.totalSize) || this.first.totalSize < this.first.bytes.length)
      throw new Error("watch_media_size_unavailable");
    const mp4box = await import("mp4box").catch(error => {
      this.signal.throwIfAborted();
      throw new Error("watch_media_unsupported", { cause: error });
    });
    this.signal.throwIfAborted();
    this.mp4box = mp4box;
    const mediaSource = this.mediaSource = new MediaSource();
    this.url = URL.createObjectURL(mediaSource);
    await waitEvent(mediaSource, "sourceopen", this.signal, () => { this.video.src = this.url!; });
    this.signal.throwIfAborted();
    this.parser = this.mp4box.createFile(false);
    this.parser.onError = (module, message) => this.fail(new Error("watch_mp4_parse_failed", { cause: new Error(`${module}: ${message}`) }));
    this.parser.onReady = info => this.metadata(info);
    this.parser.onSegment = (trackId, _user, bytes, sampleNumber) => {
      this.appends.push({ trackId, sampleNumber, bytes }); this.appendBytes += bytes.byteLength;
    };
    this.video.addEventListener("seeking", this.seek);
    this.video.addEventListener("error", this.mediaError);
    await new Promise<void>((resolve, reject) => { this.opening = { resolve, reject }; this.start(); });
  }

  private metadata(info: Movie): void {
    if (this.lifetime.signal.aborted || !this.parser || !this.mediaSource) return;
    this.tracks = [info.videoTracks[0], info.audioTracks[0]].filter((track): track is Track => !!track);
    const mime = `video/mp4; codecs="${this.tracks.map(track => track.codec).join(",")}"`;
    if (!this.tracks.length || !MediaSource.isTypeSupported(mime)) { this.fail(new Error("watch_mp4_mse_unavailable")); return; }
    if (this.tracks.some(track => this.parser!.getTrackSamplesInfo(track.id).some(sample => sample.size > MAX_BUFFER_BYTES))) {
      this.fail(new Error("watch_resource_limit")); return;
    }
    try {
      this.buffer = this.mediaSource.addSourceBuffer(mime);
      this.buffer.addEventListener("error", this.mediaError);
      if (info.duration > 0) this.mediaSource.duration = info.duration / info.timescale;
      for (const track of this.tracks) this.parser.setSegmentOptions(track.id, null, { nbSamples: 30, rapAlignement: false });
      const init = this.parser.initializeSegmentation();
      this.appends.push({ trackId: 0, sampleNumber: 0, bytes: init.buffer }); this.appendBytes += init.buffer.byteLength;
      this.parser.start();
    } catch (error) {
      this.fail(error instanceof DOMException && error.name === "NotSupportedError" ? new Error("watch_mp4_mse_unavailable", { cause: error }) : error);
    }
  }

  private start(position?: number): void {
    const previous = this.work;
    this.operation.abort();
    const operation = this.operation = new AbortController();
    const signal = AbortSignal.any([this.signal, operation.signal]);
    this.work = (async () => {
      await previous;
      signal.throwIfAborted();
      const parser = this.parser!;
      let offset = 0;
      if (position !== undefined) {
        parser.stop(); this.appends = []; this.appendBytes = 0;
        if (this.buffer!.updating) await waitEvent(this.buffer!, "updateend", signal);
        this.releaseAll();
        if (this.buffer!.buffered.length) {
          await waitEvent(this.buffer!, "updateend", signal, () => this.buffer!.remove(0, Infinity));
        }
        offset = parser.seek(position, true).offset;
        parser.start();
      }
      await this.pump(offset, signal, position === undefined);
    })().catch(error => { if (!signal.aborted) this.fail(error); });
  }

  private async pump(offset: number, signal: AbortSignal, initial: boolean): Promise<void> {
    const parser = this.parser!, size = this.first.totalSize!;
    const { MP4BoxBuffer } = this.mp4box!;
    let parseBytes = 0;
    if (initial) {
      offset = parser.appendBuffer(MP4BoxBuffer.fromArrayBuffer(this.first.bytes.slice().buffer, 0));
      parseBytes = this.first.bytes.length;
      if (parser.getAllocatedSampleDataSize() + this.appendBytes > MAX_BUFFER_BYTES) throw new Error("watch_resource_limit");
      await this.drain(signal);
    }
    while (offset < size) {
      let next = offset;
      for await (const window of readWatchWindows(this.read, this.resourceId, { start: offset, end: size, size }, signal)) {
        await this.backpressure(signal);
        next = parser.appendBuffer(MP4BoxBuffer.fromArrayBuffer(window.bytes.slice().buffer, window.offset));
        if (!this.buffer) parseBytes += window.bytes.length;
        if (parseBytes > MAX_BUFFER_BYTES || parser.getAllocatedSampleDataSize() + this.appendBytes > MAX_BUFFER_BYTES)
          throw new Error("watch_resource_limit");
        await this.drain(signal);
        // A metadata-tail read can return to an earlier media offset without ending playback.
        const end = window.offset + window.bytes.length;
        // Keep the adjacent pipeline for small interleaving gaps already covered by its windows.
        if (next < end || next >= end + WATCH_READ_AHEAD * WATCH_READ_SIZE) break;
      }
      signal.throwIfAborted(); offset = next;
    }
    parser.flush(); await this.drain(signal);
    if (this.mediaSource?.readyState === "open") this.mediaSource.endOfStream();
    if (this.opening) throw new Error("watch_mp4_parse_failed");
    // Input EOF does not end buffer ownership: playback can still leave old media behind.
    while (!this.video.ended) {
      await waitEvent(this.video, "timeupdate", signal);
      await this.prune(signal);
      // SourceBuffer.remove reopens an ended MediaSource; keep its input complete.
      if (this.mediaSource?.readyState === "open") this.mediaSource.endOfStream();
    }
  }

  private async drain(signal: AbortSignal): Promise<void> {
    const buffer = this.buffer;
    if (!buffer) return;
    while (this.appends.length) {
      signal.throwIfAborted();
      if (buffer.updating) await waitEvent(buffer, "updateend", signal);
      const append = this.appends.shift()!; this.appendBytes -= append.bytes.byteLength;
      await waitEvent(buffer, "updateend", signal, () => buffer.appendBuffer(append.bytes));
      if (append.trackId) this.release(append.trackId, append.sampleNumber);
    }
    if (this.opening) { this.opening.resolve(); this.opening = null; }
  }

  private async backpressure(signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      await this.prune(signal);
      let ahead = 0;
      for (let i = 0; i < this.video.buffered.length; i++)
        if (this.video.currentTime >= this.video.buffered.start(i) && this.video.currentTime <= this.video.buffered.end(i))
          ahead = this.video.buffered.end(i) - this.video.currentTime;
      if (ahead < MAX_FORWARD_BUFFER_SECONDS) break;
      await waitEvent(this.video, "timeupdate", signal);
    }
  }

  private async prune(signal: AbortSignal): Promise<void> {
    const buffer = this.buffer;
    if (!buffer) return;
    const cutoff = this.video.currentTime - 30;
    if (cutoff <= 0 || !buffer.buffered.length) return;
    // Removing through dependent frames can evict future video; trim only at an earlier RAP.
    const videoTrack = this.tracks.find(track => track.type === "video");
    let before = cutoff;
    if (videoTrack) {
      before = 0;
      for (const sample of this.parser!.getTrackSamplesInfo(videoTrack.id)) {
        const time = sample.cts / sample.timescale;
        if (time > cutoff) break;
        if (sample.is_sync) before = time;
      }
    }
    if (before > buffer.buffered.start(0) + 0.001) {
      if (buffer.updating) await waitEvent(buffer, "updateend", signal);
      await waitEvent(buffer, "updateend", signal, () => buffer.remove(0, before));
    }
  }

  private release(trackId: number, sampleNumber: number): void {
    const parser = this.parser!, track = parser.getTrackById(trackId);
    for (let i = this.released.get(trackId) ?? 0; i < sampleNumber; i++) parser.releaseSample(track, i);
    this.released.set(trackId, sampleNumber);
  }

  private releaseAll(): void {
    if (!this.parser) return;
    for (const track of this.tracks) this.release(track.id, this.parser.getTrackSamplesInfo(track.id).length);
    this.released.clear();
  }

  private fail(reason: unknown): void {
    if (this.lifetime.signal.aborted) return;
    const error = reason instanceof Error ? reason : new Error("watch_media_failed");
    const opening = this.opening; this.opening = null; opening?.reject(error);
    this.close();
    if (!opening) this.failed(error);
  }

  close(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    this.signal.removeEventListener("abort", this.retire);
    this.opening?.reject(new DOMException("Cancelled", "AbortError")); this.opening = null;
    this.video.removeEventListener("seeking", this.seek); this.video.removeEventListener("error", this.mediaError);
    this.parser?.stop(); this.releaseAll(); this.parser = null;
    this.appends = []; this.appendBytes = 0;
    if (this.buffer) this.buffer.removeEventListener("error", this.mediaError);
    if (this.url) { this.video.removeAttribute("src"); this.video.load(); URL.revokeObjectURL(this.url); }
    this.buffer = undefined; this.mediaSource = undefined;
  }
}
