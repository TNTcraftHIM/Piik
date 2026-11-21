import type { HlsConfig, Loader, LoaderCallbacks, LoaderConfiguration, LoaderContext, LoaderStats } from "hls.js";
import { mediaFragmentBytes, mediaManifestBytes } from "../../shared/media-resource";
import { limitWatchReads, type WatchByteReader } from "./watch-resource";
import { readWatchWindows, WATCH_READ_SIZE } from "./watch-read-windows";

// hls.js resolves rewritten UUID basenames here; these URLs never enter fetch().
const resourceOrigin = "https://watch-media.invalid";
const resourcePath = /^\/[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
export function watchHlsUrl(resourceId: string): string { return `${resourceOrigin}/${resourceId}`; }

export type WatchHlsDeadlineOwner = "loader" | "reader";

/** One player's HLS requests share the same four source-read slots as virtual HTTP. */
export function createWatchHlsLoader(sourceRead: WatchByteReader, lifetime: AbortSignal,
  deadlineOwner: WatchHlsDeadlineOwner = "loader"): HlsConfig["loader"] {
  const read = limitWatchReads(sourceRead);
  const requests = new Set<Loader<LoaderContext>>();
  return class WatchHlsLoader implements Loader<LoaderContext> {
    context: LoaderContext | null = null;
    stats: LoaderStats = { aborted: false, loaded: 0, total: 0, retry: 0, chunkCount: 0, bwEstimate: 0,
      loading: { start: 0, first: 0, end: 0 }, parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 } };
    private controller = new AbortController();
    private callbacks: LoaderCallbacks<LoaderContext> | null = null;
    private timer?: ReturnType<typeof setTimeout>;
    private finished = false;
    private cancel = () => this.abort();

    load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>): void {
      this.context = context; this.callbacks = callbacks;
      this.stats.loading.start = performance.now();
      if (requests.size >= 4) {
        this.finished = true;
        callbacks.onError({ code: 0, text: "watch_read_busy" }, context, null, this.stats); return;
      }
      requests.add(this);
      lifetime.addEventListener("abort", this.cancel, { once: true });
      if (lifetime.aborted) { this.abort(); return; }
      const timeout = () => {
        if (!this.finish()) return;
        this.stats.aborted = true;
        this.controller.abort(); callbacks.onTimeout(this.stats, context, null);
      };
      const { maxTimeToFirstByteMs, maxLoadTimeMs } = config.loadPolicy;
      const arm = (duration: number) => {
        clearTimeout(this.timer);
        // Room readers can wait for a route before sending the first Pull and own their response deadline.
        if (deadlineOwner === "loader" && Number.isFinite(duration)) this.timer = setTimeout(timeout, Math.max(0, duration));
      };
      arm(Math.min(maxTimeToFirstByteMs, maxLoadTimeMs));
      void this.read(context, () => {
        this.stats.loading.first = performance.now();
        arm(maxLoadTimeMs - (this.stats.loading.first - this.stats.loading.start));
      }).then(data => {
        if (!this.finish()) return;
        const stats = this.stats;
        stats.loading.end = performance.now();
        const elapsed = stats.loading.end - stats.loading.start;
        stats.bwEstimate = elapsed > 0 ? stats.loaded * 8000 / elapsed : 0;
        callbacks.onProgress?.(stats, context, data, null);
        callbacks.onSuccess({ url: context.url, code: 200, data }, stats, context, null);
      }, error => {
        if (!this.finish()) return;
        this.controller.abort();
        callbacks.onError({ code: 0, text: error instanceof Error ? error.message : "watch_media_failed" }, context, null, this.stats);
      });
    }

    private async read(context: LoaderContext, first: () => void): Promise<string | ArrayBuffer> {
      const url = new URL(context.url);
      if (url.origin !== resourceOrigin || !resourcePath.test(url.pathname) || url.search || url.hash)
        throw new Error("watch_resource_unavailable");
      const id = url.pathname.slice(1), signal = this.controller.signal;
      // hls.js uses rangeEnd=0 for ordinary whole-resource requests.
      const requestedEnd = context.rangeEnd === 0 ? undefined : context.rangeEnd;
      const start = requestedEnd === undefined ? 0 : context.rangeStart ?? 0;
      if (!Number.isSafeInteger(start) || start < 0 || requestedEnd !== undefined && (!Number.isSafeInteger(requestedEnd) || requestedEnd <= start))
        throw new Error("invalid_watch_range");
      // A live playlist is one atomic response; stat-then-range reads could mix revisions.
      const text = context.responseType !== "arraybuffer";
      const firstLength = Math.min(WATCH_READ_SIZE, (requestedEnd ?? Infinity) - start);
      const initial = await read(id, start, firstLength, signal);
      signal.throwIfAborted(); first();
      const size = initial.totalSize;
      if (size === null || !Number.isSafeInteger(size) || size < 0) throw new Error("watch_media_size_unavailable");
      const end = requestedEnd ?? size;
      if (end > size || start > end) throw new Error("watch_media_truncated");
      if (end - start > (text ? mediaManifestBytes() : mediaFragmentBytes())) throw new Error("watch_resource_limit");
      const bytes = new Uint8Array(end - start);
      this.stats.total = bytes.length;
      if (initial.bytes.length !== Math.min(end - start, firstLength) || (text && (start !== 0 || initial.eof !== (initial.bytes.length === size))))
        throw new Error("watch_media_truncated");
      bytes.set(initial.bytes);
      const next = start + initial.bytes.length;
      this.stats.loaded = initial.bytes.length;
      for await (const window of readWatchWindows(read, id, { start: next, end, size }, signal, length => { this.stats.loaded += length; }))
        bytes.set(window.bytes, window.offset - start);
      return context.responseType === "arraybuffer" ? bytes.buffer : new TextDecoder().decode(bytes);
    }

    private finish(): boolean {
      if (this.finished) return false;
      this.finished = true; clearTimeout(this.timer);
      requests.delete(this);
      lifetime.removeEventListener("abort", this.cancel);
      return true;
    }
    abort(): void {
      if (!this.finish()) return;
      this.stats.aborted = true; this.controller.abort();
      if (this.context) this.callbacks?.onAbort?.(this.stats, this.context, null);
    }
    destroy(): void { this.callbacks = null; this.abort(); this.context = null; }
  };
}
