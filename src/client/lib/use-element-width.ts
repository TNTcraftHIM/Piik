import { useCallback, useState } from "react";

/** Measure the actual panel, including when its parent changes without a viewport resize. */
export function useElementWidth(initialWidth = 640) {
  const [width, setWidth] = useState(initialWidth);
  const ref = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    const measure = () => {
      const next = Math.round(element.getBoundingClientRect().width);
      if (next > 0) setWidth(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}
