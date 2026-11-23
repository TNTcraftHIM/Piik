import { useCallback, useState } from "react";
import { useSurfaceDocument } from "../ui/panel-window";

/** Measure the actual panel, including when its parent changes without a viewport resize. */
export function useElementWidth(initialWidth = 640) {
  const view = useSurfaceDocument()?.defaultView;
  const [width, setWidth] = useState(initialWidth);
  const ref = useCallback((element: HTMLElement | null) => {
    if (!element || !view) return;
    const measure = () => {
      const next = Math.round(element.getBoundingClientRect().width);
      if (next > 0) setWidth(next);
    };
    measure();
    const observer = new view.ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [view]);
  return [ref, width] as const;
}
