export type DownloadOutcome = "requested" | "dispatched" | "started" | "saved" | "cancelled" | "failed";
declare global { interface Window { piikNativeDownloads?: boolean } }
interface DownloadOptions {
  document?: Document;
  signal?: AbortSignal;
  outcome?(state: DownloadOutcome): void;
}

/** Saving belongs to the platform. Only the requesting document observes its result. */
export function downloadBlob(blob: Blob, filename: string, options: DownloadOptions = {}): void {
  const owner = options.document ?? document;
  const view = owner.defaultView as (Window & Pick<typeof globalThis, "URL">) | null;
  if (!view || view.closed) throw new Error("download_unavailable");
  options.signal?.throwIfAborted();
  const native = view.piikNativeDownloads === true;
  const url = view.URL.createObjectURL(blob);
  const link = owner.createElement("a");
  link.href = url; link.download = filename;
  const close = () => {
    link.removeEventListener("piik-native-download", result);
    view.removeEventListener("pagehide", close);
    options.signal?.removeEventListener("abort", close);
    link.remove();
  };
  const result = (event: Event) => {
    const state: unknown = (event as CustomEvent).detail;
    if (state !== "started" && state !== "saved" && state !== "cancelled" && state !== "failed") return;
    if (state !== "started") close();
    options.outcome?.(state);
  };
  try {
    if (native && options.outcome) {
      link.hidden = true; link.dataset.piikDownload = "";
      link.addEventListener("piik-native-download", result);
      view.addEventListener("pagehide", close, { once: true });
      options.signal?.addEventListener("abort", close, { once: true });
      owner.body.append(link);
      options.outcome("requested");
    }
    options.signal?.throwIfAborted();
    link.click();
    if (!native) options.outcome?.("dispatched");
  } catch (error) { close(); throw error; }
  finally { view.setTimeout(() => view.URL.revokeObjectURL(url), 0); }
}
