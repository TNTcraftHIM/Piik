import { useEffect, useRef, useState } from "react";
import { z } from "zod";

export const appUpdateSchema = z.object({
  state: z.enum(["unavailable", "idle", "downloading", "ready", "installing", "failed"]),
  reason: z.enum(["unsupported-platform", "untrusted-build", "unmanaged-installation", "updater-unavailable"]).optional(),
  operationId: z.string().optional(), version: z.string().optional(), revision: z.string().optional(),
  receivedBytes: z.number().nonnegative().optional(), totalBytes: z.number().positive().optional(),
  source: z.enum(["github", "atomgit"]).optional(), error: z.string().optional(),
});
export type AppUpdateView = z.infer<typeof appUpdateSchema>;
export type AppUpdateAction = { action: "download"; version: string; revision: string }
  | { action: "cancel" | "install"; operationId: string };

/** The App owns the operation; this page only observes it and sends explicit commands. */
export function useAppUpdate() {
  const [view, setView] = useState<AppUpdateView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ operationId?: string }>();
  const generation = useRef(0);
  const pending = useRef(false);
  const mounted = useRef(false);
  const observedInstalling = useRef(false);
  const [refresh, setRefresh] = useState(0);
  function acceptView(next: AppUpdateView) {
    // A fresh runtime retires the installation operation and serves the new UI bundle.
    const restarted = observedInstalling.current && !next.operationId && (next.state === "idle" || next.state === "unavailable");
    observedInstalling.current = next.state === "installing";
    setView(next);
    if (restarted) window.location.reload();
  }
  useEffect(() => {
    mounted.current = true;
    let current = true;
    let reading = false;
    let observing = view?.state === "downloading" || view?.state === "installing";
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function read() {
      if (reading || pending.current) return;
      clearTimeout(timer);
      reading = true;
      const started = generation.current;
      try {
        const response = await fetch("/api/client-launcher/update", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error();
        const next = appUpdateSchema.parse(await response.json());
        if (current && started === generation.current && !pending.current) {
          observing = next.state === "downloading" || next.state === "installing";
          acceptView(next);
        }
      } catch { /* A lost observation never changes the App-owned operation. */ }
      finally { reading = false; if (current && observing) timer = setTimeout(read, 1000); }
    }
    void read();
    const onFocus = () => { void read(); };
    window.addEventListener("focus", onFocus);
    return () => {
      current = false; mounted.current = false; clearTimeout(timer); controller.abort();
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);
  async function act(command: AppUpdateAction) {
    if (pending.current) return;
    const started = ++generation.current;
    pending.current = true;
    setBusy(true); setError(undefined);
    try {
      const response = await fetch("/api/client-launcher/update", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command),
      });
      if (!response.ok) throw new Error();
      const next = appUpdateSchema.parse(await response.json());
      if (mounted.current && started === generation.current) acceptView(next);
    } catch {
      if (mounted.current && started === generation.current) setError({ operationId: command.action === "download" ? undefined : command.operationId });
    }
    finally {
      pending.current = false;
      if (mounted.current) { setBusy(false); setRefresh(value => value + 1); }
    }
  }
  return { view, busy, error: !!error && error.operationId === view?.operationId, act };
}
