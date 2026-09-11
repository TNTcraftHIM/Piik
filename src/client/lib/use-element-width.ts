import { useLayoutEffect, useRef, useState } from "react";

/** Measure the actual panel, including when its parent changes without a viewport resize. */
export function useElementWidth(initialWidth = 640) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initialWidth);
  useLayoutEffect(() => {
    const element = ref.current;
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
