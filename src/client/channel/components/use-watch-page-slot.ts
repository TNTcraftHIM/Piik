import { useLayoutEffect, useRef, useState } from "react";

import { useSurfaceDocument } from "../../ui/panel-window";

type PageBounds = { x: number; y: number; width: number; height: number };
declare global {
  interface Window {
    piikMountWatchPage?: (pageId: string, bounds: PageBounds | null) => Promise<boolean>;
  }
}

/** The main shell positions its local AppPage child in content-viewport CSS pixels. */
export function useWatchPageSlot(pageId: string | undefined) {
  const owner = useSurfaceDocument();
  const slot = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  useLayoutEffect(() => {
    setMounted(false);
    const node = slot.current;
    const mount = window.piikMountWatchPage;
    if (!node || !pageId || !mount || owner !== document || node.ownerDocument !== document) return;
    let closed = false, revision = 0, previous: string | undefined;
    const update = () => {
      const rect = node.getBoundingClientRect();
      const visible = document.visibilityState === "visible" && node.checkVisibility()
        && !document.querySelector("dialog[open], :popover-open");
      const left = Math.max(0, Math.ceil(rect.left)), top = Math.max(0, Math.ceil(rect.top));
      const right = Math.min(window.innerWidth, Math.floor(rect.right)), bottom = Math.min(window.innerHeight, Math.floor(rect.bottom));
      const bounds = visible && right > left && bottom > top &&
        [[left, top], [right - 1, top], [left, bottom - 1], [right - 1, bottom - 1]].every(([x,y]) => document.elementFromPoint(x,y) === node)
        ? { x: left, y: top, width: right - left, height: bottom - top } : null;
      const key = JSON.stringify(bounds);
      if (key === previous) return;
      previous = key;
      if (!bounds && revision === 0) return;
      const request = ++revision;
      void mount(pageId, bounds).then(ok => {
        if (!closed && request === revision) setMounted(!!bounds && ok);
      }, () => { if (!closed && request === revision) setMounted(false); });
    };
    const listeners = new AbortController();
    const options = { capture: true, signal: listeners.signal };
    for (const event of ["scroll", "resize", "toggle", "visibilitychange", "fullscreenchange"]) window.addEventListener(event, update, options);
    const resize = new ResizeObserver(update);
    resize.observe(node);
    const intersection = new IntersectionObserver(update);
    intersection.observe(node);
    const mutation = new MutationObserver(update);
    mutation.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open", "hidden", "inert", "class"] });
    update();
    return () => {
      closed = true;
      listeners.abort(); resize.disconnect(); intersection.disconnect(); mutation.disconnect();
      if (revision) void mount(pageId, null).catch(() => {});
    };
  }, [pageId, owner]);
  return { slot, mounted };
}
