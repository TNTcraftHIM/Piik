import { useLayoutEffect, type RefObject } from "react";

// Native popovers own visibility, dismissal and focus. This only places an
// end-aligned menu beside its invoker, within the document displaying it.
export function useAnchoredPopover(
  trigger: RefObject<HTMLElement | null>, panel: RefObject<HTMLElement | null>,
  { side = "below", maxHeight = Infinity, enabled = true }: {
    side?: "above" | "below"; maxHeight?: number; enabled?: boolean;
  } = {},
) {
  useLayoutEffect(() => {
    const anchor = trigger.current, menu = panel.current;
    if (!enabled || !anchor || !menu) return;
    const view = menu.ownerDocument.defaultView;
    if (!view) return;
    const viewport = view.visualViewport;
    const place = () => {
      if (!menu.matches(":popover-open")) return;
      const rect = anchor.getBoundingClientRect();
      const left = (viewport?.offsetLeft ?? 0) + 8, top = (viewport?.offsetTop ?? 0) + 8;
      const right = left + (viewport?.width ?? view.innerWidth) - 16;
      const bottom = top + (viewport?.height ?? view.innerHeight) - 16;
      if (!anchor.getClientRects().length || rect.bottom < top || rect.top > bottom || rect.right < left || rect.left > right) {
        menu.hidePopover();
        return;
      }
      const above = Math.max(0, rect.top - top - 8), below = Math.max(0, bottom - rect.bottom - 8);
      const height = Math.min(menu.scrollHeight, maxHeight);
      const openAbove = side === "above" ? above >= height || above > below : below < height && above > below;
      menu.style.maxWidth = `${right - left}px`;
      menu.style.maxHeight = `${Math.min(maxHeight, openAbove ? above : below)}px`;
      menu.classList.toggle("is-above", openAbove);
      menu.style.left = `${Math.max(left, Math.min(rect.right - menu.offsetWidth, right - menu.offsetWidth))}px`;
      menu.style.top = `${Math.max(top, openAbove ? rect.top - menu.offsetHeight - 8 : rect.bottom + 8)}px`;
    };
    // The containing panel may reposition itself in the same resize. Measure
    // after its layout owner has finished, including content/translation changes.
    let frame = 0;
    const schedule = () => {
      view.cancelAnimationFrame(frame);
      frame = view.requestAnimationFrame(place);
    };
    const observer = new ResizeObserver(schedule);
    const toggled = () => {
      observer.disconnect();
      view.cancelAnimationFrame(frame);
      if (!menu.matches(":popover-open")) return;
      place(); observer.observe(menu); observer.observe(anchor);
      const parentPopover = anchor.closest("[popover]");
      if (parentPopover) observer.observe(parentPopover);
    };
    menu.addEventListener("toggle", toggled);
    view.addEventListener("resize", schedule);
    view.addEventListener("scroll", schedule, true);
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    toggled();
    return () => {
      observer.disconnect();
      view.cancelAnimationFrame(frame);
      menu.removeEventListener("toggle", toggled);
      view.removeEventListener("resize", schedule);
      view.removeEventListener("scroll", schedule, true);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
    };
  }, [trigger, panel, side, maxHeight, enabled]);
}
