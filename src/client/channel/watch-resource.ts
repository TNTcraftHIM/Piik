export interface WatchByteResult {
  mimeType: string;
  totalSize: number | null;
  bytes: Uint8Array;
  eof: boolean;
}
export type WatchByteReader = (resourceId: string, offset: number, length: number, signal: AbortSignal) => Promise<WatchByteResult>;
export interface WatchResourceLease { url: string; close(): void }

/** All media requests in one player share four source reads. */
export function limitWatchReads(read: WatchByteReader): WatchByteReader {
  let active = 0;
  const waiting = new Set<() => void>();
  return async (resourceId, offset, length, signal) => {
    await new Promise<void>((resolve, reject) => {
      const start = () => { signal.removeEventListener("abort", abort); active++; resolve(); };
      const abort = () => { waiting.delete(start); reject(signal.reason); };
      if (signal.aborted) { reject(signal.reason); return; }
      if (active < 4) start();
      else { waiting.add(start); signal.addEventListener("abort", abort, { once: true }); }
    });
    try { signal.throwIfAborted(); return await read(resourceId, offset, length, signal); }
    finally {
      active--;
      const next = waiting.values().next().value;
      if (next) { waiting.delete(next); next(); }
    }
  };
}

export function canReadWatchResources(): boolean {
  return globalThis.isSecureContext === true && "serviceWorker" in navigator && typeof MessageChannel !== "undefined" && typeof ReadableStream !== "undefined";
}

const workerPath = "/watch-media-worker.js";
const resourceIdPattern = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;

/** A page owns the reader lease; the worker holds only the current fetch's port. */
export async function openWatchResource(resourceId: string, read: WatchByteReader, signal: AbortSignal): Promise<WatchResourceLease> {
  signal.throwIfAborted();
  if (!canReadWatchResources()) throw new Error("watch_peer_requires_secure_context");
  if (!resourceIdPattern.test(resourceId)) throw new Error("watch_media_failed");
  await new Promise<void>((resolve, reject) => {
    let finished = false, registered = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      navigator.serviceWorker.removeEventListener("controllerchange", check);
      error ? reject(error) : resolve();
    };
    const abort = () => finish(signal.reason);
    const check = () => {
      if (registered && navigator.serviceWorker.controller?.scriptURL === new URL(workerPath, location.origin).href) finish();
    };
    signal.addEventListener("abort", abort, { once: true });
    navigator.serviceWorker.addEventListener("controllerchange", check);
    if (signal.aborted) { abort(); return; }
    // Registration belongs to the Browser and cannot be aborted, but its caller can retire.
    // A late completion must not start a controller wait or acquire a media lease.
    void navigator.serviceWorker.register(workerPath, { scope: "/" }).then(() => {
      if (finished) return;
      registered = true;
      timer = setTimeout(() => finish(new Error("watch_peer_unavailable")), 10000);
      check();
    }, () => finish(new Error("watch_peer_unavailable")));
  });
  signal.throwIfAborted();
  const leaseId = crypto.randomUUID(), requests = new Set<AbortController>();
  let closed = false;
  const readBounded = limitWatchReads(read);
  const message = (event: MessageEvent) => {
    if (event.source !== navigator.serviceWorker.controller || event.data?.type !== "watch_resource_open" || event.data.leaseId !== leaseId) return;
    const port = event.ports[0], id: unknown = event.data.resourceId;
    if (!port) return;
    // Four fetches can each hold four 64 KiB windows (1 MiB); source reads share four slots.
    if (requests.size >= 4) { port.postMessage({ error: "watch_media_failed" }); port.close(); return; }
    const request = new AbortController();
    requests.add(request);
    let pendingReads = 0;
    let advertisedSize: number | null = null;
    const close = () => request.abort();
    request.signal.addEventListener("abort", () => {
      requests.delete(request);
      port.postMessage({ error: "watch_media_failed" }); port.close();
    }, { once: true });
    port.onmessage = async ({ data }) => {
      if (data?.type === "cancel") { close(); return; }
      if (closed || typeof id !== "string" || !resourceIdPattern.test(id)) { close(); return; }
      const offset = data?.type === "stat" ? 0 : data?.offset;
      const length = data?.type === "stat" ? 1 : data?.length;
      if (pendingReads >= 4 || !Number.isSafeInteger(data?.id) || !["stat", "read"].includes(data?.type) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 65536) { close(); return; }
      pendingReads++;
      try {
        // The reader owns route readiness and its response deadline; the port owns cancellation.
        const result = await readBounded(id, offset, length, request.signal);
        request.signal.throwIfAborted();
        if (result.bytes.byteLength > length || (result.totalSize !== null && (!Number.isSafeInteger(result.totalSize) || result.totalSize < 0))) throw new Error("watch_media_failed");
        if (data.type === "stat") {
          advertisedSize = result.totalSize;
          port.postMessage({ id: data.id, size: advertisedSize, mimeType: result.mimeType });
        } else {
          if (result.totalSize !== advertisedSize) throw new Error("watch_media_changed");
          const bytes = new Uint8Array(result.bytes).buffer;
          port.postMessage({ id: data.id, bytes }, [bytes]);
        }
      } catch { close(); } finally { pendingReads--; }
    };
  };
  navigator.serviceWorker.addEventListener("message", message);
  const close = () => {
    if (closed) return;
    closed = true; signal.removeEventListener("abort", close);
    navigator.serviceWorker.removeEventListener("message", message);
    for (const request of requests) request.abort();
  };
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) { close(); signal.throwIfAborted(); }
  return { url: `/__watch-media/${leaseId}/${resourceId}`, close };
}
