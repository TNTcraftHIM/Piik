import { useEffect, useState } from "react";
import { useSurfaceDocument } from "../ui/panel-window";

const empty: ReadonlyMap<string, number> = new Map();
type ReadLevels = () => Promise<ReadonlyMap<string, number>>;

/** Meter observations belong to the visible surface, not the media lifetime. */
export function useVoiceLevels(read: ReadLevels, enabled: boolean, displayDocument?: Document | null): ReadonlyMap<string, number> {
  const surface = useSurfaceDocument();
  const owner = displayDocument ?? surface;
  const [sample, setSample] = useState<{ read: ReadLevels; levels: ReadonlyMap<string, number> }>({ read, levels: empty });
  useEffect(() => {
    const view = owner?.defaultView;
    if (!enabled || !owner || !view) return;
    let stop = () => {};
    const refresh = () => {
      stop();
      setSample({ read, levels: empty });
      if (owner.visibilityState !== "visible") return;
      let active = true, timer: number;
      const update = async () => {
        try { const levels = await read(); if (active) setSample({ read, levels }); }
        catch { if (active) setSample({ read, levels: empty }); }
        finally { if (active) timer = view.setTimeout(() => void update(), 150); }
      };
      stop = () => { active = false; view.clearTimeout(timer); };
      void update();
    };
    owner.addEventListener("visibilitychange", refresh);
    refresh();
    return () => { stop(); owner.removeEventListener("visibilitychange", refresh); };
  }, [read, enabled, owner]);
  return enabled && sample.read === read ? sample.levels : empty;
}
