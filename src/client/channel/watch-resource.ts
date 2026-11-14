export interface WatchByteResult {
  mimeType: string;
  totalSize: number | null;
  bytes: Uint8Array;
  eof: boolean;
}
export type WatchByteReader = (resourceId: string, offset: number, length: number, signal: AbortSignal) => Promise<WatchByteResult>;
export interface WatchResourceLease { url: string; close(): void }

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
  await navigator.serviceWorker.register(workerPath, { scope: "/" });
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      navigator.serviceWorker.removeEventListener("controllerchange", check);
      error ? reject(error) : resolve();
    };
    const abort = () => finish(signal.reason);
    const check = () => {
      if (navigator.serviceWorker.controller?.scriptURL === new URL(workerPath, location.origin).href) finish();
    };
    const timer = setTimeout(() => finish(new Error("watch_media_failed")), 10000);
    signal.addEventListener("abort", abort, { once: true });
    navigator.serviceWorker.addEventListener("controllerchange", check);
    if (signal.aborted) abort(); else check();
  });
  signal.throwIfAborted();
  const leaseId = crypto.randomUUID(), requests = new Set<AbortController>();
  let closed = false, activeReads = 0;
  const message = (event: MessageEvent) => {
    if (event.source !== navigator.serviceWorker.controller || event.data?.type !== "watch_resource_open" || event.data.leaseId !== leaseId) return;
    const port = event.ports[0], id: unknown = event.data.resourceId;
    if (!port) return;
    const request = new AbortController();
    requests.add(request);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    const close = () => request.abort();
    request.signal.addEventListener("abort", () => {
      clearTimeout(timer); requests.delete(request);
      port.postMessage({ error: "watch_media_failed" }); port.close();
    }, { once: true });
    port.onmessage = async ({ data }) => {
      if (data?.type === "cancel") { close(); return; }
      if (closed || typeof id !== "string" || !resourceIdPattern.test(id)) { close(); return; }
      const offset = data?.type === "stat" ? 0 : data?.offset;
      const length = data?.type === "stat" ? 1 : data?.length;
      if (reading || !["stat", "read"].includes(data?.type) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 65536 || activeReads >= 4) { close(); return; }
      reading = true; activeReads++; timer = setTimeout(close, 20500);
      try {
        const result = await read(id, offset, length, request.signal);
        request.signal.throwIfAborted();
        if (result.bytes.byteLength > length || (result.totalSize !== null && (!Number.isSafeInteger(result.totalSize) || result.totalSize < 0))) throw new Error("watch_media_failed");
        if (data.type === "stat") port.postMessage({ size: result.totalSize, mimeType: result.mimeType });
        else {
          const bytes = new Uint8Array(result.bytes).buffer;
          port.postMessage({ bytes }, [bytes]);
        }
      } catch { close(); } finally { clearTimeout(timer); reading = false; activeReads--; }
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
