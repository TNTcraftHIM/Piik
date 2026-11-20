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
      let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
      let right = Math.min(window.innerWidth, rect.right), bottom = Math.min(window.innerHeight, rect.bottom);
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.overflowX === "visible" && style.overflowY === "visible") continue;
        const box = parent.getBoundingClientRect();
        if (style.overflowX !== "visible") {
          left = Math.max(left, box.left + parent.clientLeft);
          right = Math.min(right, box.left + parent.clientLeft + parent.clientWidth);
        }
        if (style.overflowY !== "visible") {
          top = Math.max(top, box.top + parent.clientTop);
          bottom = Math.min(bottom, box.top + parent.clientTop + parent.clientHeight);
        }
      }
      left = Math.ceil(left); top = Math.ceil(top);
      right = Math.floor(right); bottom = Math.floor(bottom);
      const visible = document.visibilityState === "visible" && node.checkVisibility() && !node.closest("[inert]")
        && !document.querySelector("dialog[open], :popover-open");
      const bounds = visible && right > left && bottom > top
        ? { x: left, y: top, width: right - left, height: bottom - top } : null;
      const key = JSON.stringify(bounds);
      if (key === previous) return;
      previous = key;
      if (!bounds && revision === 0) return;
      const request = ++revision;
      void mount(pageId, bounds).then(ok => {
        if (!closed && request === revision) {
          if (!ok && bounds) previous = undefined;
          setMounted(!!bounds && ok);
        }
      }, () => { if (!closed && request === revision) { previous = undefined; setMounted(false); } });
    };
    const listeners = new AbortController();
    const options = { capture: true, signal: listeners.signal };
    for (const event of ["scroll", "resize", "toggle", "visibilitychange", "fullscreenchange"]) window.addEventListener(event, update, options);
    const resize = new ResizeObserver(update);
    resize.observe(node);
    const intersection = new IntersectionObserver(update);
    intersection.observe(node);
    const mutation = new MutationObserver(records => {
      if (records.some(record => record.type === "attributes" || [...record.addedNodes, ...record.removedNodes]
        .some(node => node instanceof Element && (node.matches("dialog, [popover]") || node.querySelector("dialog, [popover]"))))) update();
    });
    mutation.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open", "hidden", "inert", "class"] });
    update();
    return () => {
      closed = true;
      listeners.abort(); resize.disconnect(); intersection.disconnect(); mutation.disconnect();
      if (revision) void mount(pageId, null).catch(() => {});
    };
  }, [pageId, owner]);
  return { slot, mounted };
}
