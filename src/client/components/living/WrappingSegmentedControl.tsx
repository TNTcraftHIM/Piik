import { useLayoutEffect, useRef, type ComponentProps } from "react";

/** The shared selection surface follows its item across rows and size changes. */
export function WrappingSegmentedControl({ children, className = "", ...props }: ComponentProps<"div">) {
  const control = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = control.current!;
    const selected = element.querySelector<HTMLElement>(".is-selected");
    if (!selected) return;
    const measure = () => {
      const bounds = element.getBoundingClientRect(), item = selected.getBoundingClientRect();
      element.style.setProperty("--lr-selection-x", `${item.left - bounds.left - element.clientLeft}px`);
      element.style.setProperty("--lr-selection-y", `${item.top - bounds.top - element.clientTop}px`);
      element.style.setProperty("--lr-selection-width", `${item.width}px`);
      element.style.setProperty("--lr-selection-height", `${item.height}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(selected);
    return () => observer.disconnect();
  }, [children]);
  return <div {...props} ref={control} className={`lr-toggle is-wrapping ${className}`}>{children}</div>;
}
