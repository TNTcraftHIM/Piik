/** Retire the caller immediately; a late permission grant still owns real tracks. */
export async function acquireMediaStream(start: () => Promise<MediaStream>, signal?: AbortSignal): Promise<MediaStream> {
  signal?.throwIfAborted();
  const pending = start();
  return new Promise((resolve, reject) => {
    const abort = () => { signal?.removeEventListener("abort", abort); reject(signal!.reason); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    pending.then(stream => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) stream.getTracks().forEach(track => track.stop());
      else resolve(stream);
    }, error => {
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
  });
}
