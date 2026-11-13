import { useLayoutEffect, useRef, type ComponentProps } from "react";

/** The shared selection surface follows its item across rows and size changes. */
export function WrappingSegmentedControl({ children, className = "", ...props }: ComponentProps<"div">) {
  const control = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = control.current!;
    const selected = element.querySelector<HTMLElement>(".is-selected");
    if (!selected) return;
    const measure = () => {
      // Include tooltip offset parents without measuring opening or press transforms.
      let x = 0, y = 0;
      for (let item: HTMLElement | null = selected; item && item !== element; item = item.offsetParent as HTMLElement | null) {
        x += item.offsetLeft;
        y += item.offsetTop;
      }
      element.style.setProperty("--lr-selection-x", `${x}px`);
      element.style.setProperty("--lr-selection-y", `${y}px`);
      element.style.setProperty("--lr-selection-width", `${selected.offsetWidth}px`);
      element.style.setProperty("--lr-selection-height", `${selected.offsetHeight}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(selected);
    return () => observer.disconnect();
  }, [children]);
  return <div {...props} ref={control} className={`lr-toggle is-wrapping ${className}`}>{children}</div>;
}
