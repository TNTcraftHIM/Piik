import { useCallback, useState } from "react";
import { useSurfaceDocument } from "../ui/panel-window";

/** Measure the panel's border box in local CSS pixels, before zoom or transforms. */
export function useElementWidth(initialWidth = 640) {
  const view = useSurfaceDocument()?.defaultView;
  const [width, setWidth] = useState(initialWidth);
  const ref = useCallback((element: HTMLElement | null) => {
    if (!element || !view) return;
    const measure = () => {
      const next = element.offsetWidth;
      if (next > 0) setWidth(next);
    };
    measure();
    const observer = new view.ResizeObserver(measure);
    observer.observe(element, { box: "border-box" });
    return () => observer.disconnect();
  }, [view]);
  return [ref, width] as const;
}
