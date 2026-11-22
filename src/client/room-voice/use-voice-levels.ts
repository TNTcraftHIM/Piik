import { useEffect, useState } from "react";
import { useSurfaceDocument } from "../ui/panel-window";

const empty: ReadonlyMap<string, number> = new Map();
type ReadLevels = () => Promise<ReadonlyMap<string, number>>;

function equalLevels(previous: ReadonlyMap<string, number>, next: ReadonlyMap<string, number>): boolean {
  if (previous.size !== next.size) return false;
  for (const [id, level] of next) if (previous.get(id) !== level) return false;
  return true;
}

/** Meter observations belong to the visible surface, not the media lifetime. */
export function useVoiceLevels(read: ReadLevels, enabled: boolean, displayDocument?: Document | null): ReadonlyMap<string, number> {
  const surface = useSurfaceDocument();
  const owner = displayDocument ?? surface;
  const [sample, setSample] = useState<{ read: ReadLevels; levels: ReadonlyMap<string, number> }>({ read, levels: empty });
  useEffect(() => {
    const view = owner?.defaultView;
    if (!enabled || !owner || !view) return;
    const publish = (levels: ReadonlyMap<string, number>) => {
      setSample(previous => previous.read === read && equalLevels(previous.levels, levels) ? previous : { read, levels });
    };
    let stop = () => {};
    const refresh = () => {
      stop();
      publish(empty);
      if (owner.visibilityState !== "visible") return;
      let active = true, timer: number;
      const update = async () => {
        try { const levels = await read(); if (active) publish(levels); }
        catch { if (active) publish(empty); }
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
