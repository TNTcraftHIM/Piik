import type { WatchByteReader } from "./watch-resource";

export const WATCH_READ_SIZE = 65536;
export const WATCH_READ_AHEAD = 4;

/** Four adjacent windows share the caller's player-wide read limiter. */
export async function* readWatchWindows(read: WatchByteReader, resourceId: string,
  range: { start: number; end: number; size: number }, signal: AbortSignal,
  received?: (length: number) => void): AsyncGenerator<{ offset: number; bytes: Uint8Array }> {
  const controller = new AbortController();
  const reading = AbortSignal.any([signal, controller.signal]);
  const windows: Promise<{ offset: number; bytes: Uint8Array }>[] = [];
  let position = range.start;
  const fill = () => {
    while (!reading.aborted && windows.length < WATCH_READ_AHEAD && position < range.end) {
      const offset = position, length = Math.min(WATCH_READ_SIZE, range.end - offset);
      const pending = read(resourceId, offset, length, reading).then(result => {
        reading.throwIfAborted();
        if (result.totalSize !== range.size || result.bytes.byteLength !== length) throw new Error("watch_media_truncated");
        received?.(length);
        return { offset, bytes: result.bytes };
      });
      // Prefetched failures are consumed in byte order, even when replies arrive out of order.
      void pending.catch(() => {});
      windows.push(pending); position += length;
    }
  };
  try {
    fill();
    while (windows.length) {
      const window = await windows.shift()!;
      reading.throwIfAborted(); fill();
      yield window;
    }
  } finally { controller.abort(); }
}
