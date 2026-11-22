const deferredModuleFailures = new WeakSet<object>();
let installed = false;

/** Vite emits the original import error as the preload event payload. */
export function installDeferredModuleFailureTracking(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("vite:preloadError", event => {
    const payload = (event as Event & { payload?: unknown }).payload;
    if (payload && (typeof payload === "object" || typeof payload === "function"))
      deferredModuleFailures.add(payload);
  });
}

export function isDeferredModuleFailure(error: unknown): boolean {
  return !!error && (typeof error === "object" || typeof error === "function")
    && deferredModuleFailures.has(error);
}
