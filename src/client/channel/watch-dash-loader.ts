import type shaka from "shaka-player";
import {
  mediaFragmentBytes,
  mediaManifestBytes,
} from "../../shared/media-resource";
import { limitWatchReads, type WatchByteReader } from "./watch-resource";
import { readWatchWindows } from "./watch-read-windows";

// Per-player Shaka manifest/segment requests, distinct from the shared read-window pool.
const MAX_DASH_REQUESTS = 4;

/** One Shaka player binds one opaque Native resource graph; no origin URLs cross this adapter. */
export function attachWatchDashReader(
  library: typeof shaka,
  player: shaka.Player,
  read: WatchByteReader,
  lifetime: AbortSignal,
) {
  const scheme = `piikwatch${crypto.randomUUID().replaceAll("-", "")}`,
    base = `${scheme}://source/`;
  const bounded = limitWatchReads(read),
    requests = new Set<AbortController>();
  const unavailable = () => new Error("watch_source_unavailable");
  const parse = (
    uri: string,
    type: shaka.net.NetworkingEngine.RequestType,
    request: shaka.extern.Request,
  ): string => {
    const url = new URL(uri);
    if (
      url.protocol !== `${scheme}:` ||
      url.hostname !== "source" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(url.pathname) ||
      ![
        library.net.NetworkingEngine.RequestType.MANIFEST,
        library.net.NetworkingEngine.RequestType.SEGMENT,
      ].includes(type) ||
      request.method !== "GET" ||
      request.body ||
      request.allowCrossSiteCredentials
    )
      throw unavailable();
    return url.pathname.slice(1);
  };
  const filter: shaka.extern.RequestFilter = (type, request) => {
    for (const uri of request.uris) parse(uri, type, request);
  };
  const network = player.getNetworkingEngine()!;
  network.registerRequestFilter(filter);
  const plugin: shaka.extern.SchemePlugin = (uri, request, type, progress) => {
    const controller = new AbortController(),
      signal = AbortSignal.any([lifetime, controller.signal]);
    const work = (async (): Promise<shaka.extern.Response> => {
      const id = parse(uri, type, request);
      signal.throwIfAborted();
      if (requests.size >= MAX_DASH_REQUESTS)
        throw new Error("watch_read_busy");
      requests.add(controller);
      try {
        const first = await bounded(id, 0, 1, signal);
        signal.throwIfAborted();
        const size = first.totalSize;
        if (size === null || !Number.isSafeInteger(size) || size < 0)
          throw unavailable();
        const range = Object.entries(request.headers).find(
          ([key]) => key.toLowerCase() === "range",
        )?.[1];
        let start = 0,
          end = size;
        if (range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(range);
          if (!match) throw unavailable();
          start = Number(match[1]);
          end = match[2] ? Number(match[2]) + 1 : size;
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            end > size ||
            start >= end
          )
            throw unavailable();
        }
        const budget =
          type === library.net.NetworkingEngine.RequestType.MANIFEST
            ? mediaManifestBytes()
            : mediaFragmentBytes();
        if (end - start > budget) throw new Error("watch_resource_limit");
        const bytes = new Uint8Array(end - start),
          began = performance.now();
        let done = 0,
          progressedAt = began;
        for await (const part of readWatchWindows(
          bounded,
          id,
          { start, end, size },
          signal,
        )) {
          bytes.set(part.bytes, part.offset - start);
          done += part.bytes.length;
          const now = performance.now();
          progress(now - progressedAt, part.bytes.length, bytes.length - done);
          progressedAt = now;
        }
        signal.throwIfAborted();
        return {
          uri,
          originalUri: uri,
          originalRequest: request,
          data: bytes.buffer,
          headers: { "content-type": first.mimeType },
          status: range ? 206 : 200,
          timeMs: performance.now() - began,
          fromCache: false,
        };
      } finally {
        requests.delete(controller);
      }
    })();
    return new library.util.AbortableOperation(work, () => {
      controller.abort();
      return work.then(
        () => {},
        () => {},
      );
    });
  };
  library.net.NetworkingEngine.registerScheme(
    scheme,
    plugin,
    library.net.NetworkingEngine.PluginPriority.APPLICATION,
  );
  const close = () => {
    for (const controller of requests) controller.abort();
    network.unregisterRequestFilter(filter);
    library.net.NetworkingEngine.unregisterScheme(scheme);
    lifetime.removeEventListener("abort", close);
  };
  lifetime.addEventListener("abort", close, { once: true });
  return { url: (id: string) => base + id, close };
}
