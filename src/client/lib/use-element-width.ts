import { useCallback, useRef, useState } from "react";
import { useSurfaceDocument } from "../ui/panel-window";

/** Observe the panel's border box in local CSS pixels, before zoom or transforms. */
function useWidthObserver(onWidth: (width: number) => void) {
  const view = useSurfaceDocument()?.defaultView;
  return useCallback((element: HTMLElement | null) => {
    if (!element || !view) return;
    const measure = () => {
      const width = element.offsetWidth;
      if (width > 0) onWidth(width);
    };
    measure();
    const observer = new view.ResizeObserver(measure);
    observer.observe(element, { box: "border-box" });
    return () => observer.disconnect();
  }, [view, onWidth]);
}

export function useElementWidth(initialWidth = 640) {
  const [width, setWidth] = useState(initialWidth);
  return [useWidthObserver(setWidth), width] as const;
}

export function useElementWidthLayout<T extends Record<string, boolean>>(initialWidth: () => number, layoutFor: (width: number) => T) {
  const [layout, setLayout] = useState(() => layoutFor(initialWidth()));
  const current = useRef(layout);
  const update = useCallback((width: number) => {
    const next = layoutFor(width);
    for (const key in next) {
      if (next[key] !== current.current[key]) {
        current.current = next;
        setLayout(next);
        return;
      }
    }
  }, [layoutFor]);
  return [useWidthObserver(update), layout] as const;
}
