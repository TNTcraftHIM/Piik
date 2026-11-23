import { useLayoutEffect, useRef, type RefObject } from "react";
import { useSurfaceDocument } from "../../ui/panel-window";
import { surfaceViewport } from "../../ui/window-appearance";

// Native popovers own visibility, dismissal and focus. This only places a
// menu beside its anchor, within the document displaying it.
export function useAnchoredPopover(
  trigger: RefObject<HTMLElement | null>, panel: RefObject<HTMLElement | null>,
  { side = "below", align = "end", maxHeight = Infinity, preferredHeight, minVisibleHeight = Infinity, enabled = true,
    closeWhenAnchorClipped = false }: {
    side?: "above" | "below"; align?: "start" | "end" | "center";
    maxHeight?: number; preferredHeight?: number; minVisibleHeight?: number; enabled?: boolean; closeWhenAnchorClipped?: boolean;
  } = {},
) {
  const ownerDocument = useSurfaceDocument();
  const reposition = useRef<(() => void) | null>(null);
  // A React layout change can move the anchor without resizing it.
  useLayoutEffect(() => {
    if (panel.current?.matches(":popover-open")) reposition.current?.();
  });
  useLayoutEffect(() => {
    const menu = panel.current;
    if (!enabled || !menu) return;
    const view = menu.ownerDocument.defaultView;
    if (!view) return;
    const viewport = view.visualViewport;
    const place = () => {
      // The anchor may belong to a parent whose ref is attached after this
      // child's layout effect. Read it when opening, not when subscribing.
      const anchor = trigger.current;
      if (!anchor || !menu.matches(":popover-open")) return;
      const rect = anchor.getBoundingClientRect();
      const bounds = surfaceViewport(menu.ownerDocument);
      const left = bounds.left + 8, top = bounds.top + 8;
      const right = bounds.right - 8, bottom = bounds.bottom - 8;
      // Placement insets do not make a visible anchor offscreen.
      const anchorOutside = rect.bottom < (viewport?.offsetTop ?? 0) || rect.top > bounds.bottom
        || rect.right < bounds.left || rect.left > bounds.right;
      // A keyboard can cover the anchor while its popover still owns input.
      // Keep that editing surface placed in view; a removed trigger still closes it.
      if (!anchor.getClientRects().length || (anchorOutside && (closeWhenAnchorClipped || !menu.contains(menu.ownerDocument.activeElement)))) {
        menu.hidePopover();
        return;
      }
      const above = Math.max(0, rect.top - top - 8), below = Math.max(0, bottom - rect.bottom - 8);
      // Expanding the live scrollport to measure content would clamp its scroll offset.
      menu.style.maxWidth = `${right - left}px`;
      const height = Math.min(preferredHeight ?? menu.scrollHeight, maxHeight);
      // Scrollable palettes can prefer their requested side without requiring
      // every row to fit; compact menus retain the full-content threshold.
      const visibleHeight = Math.min(height, minVisibleHeight);
      const openAbove = side === "above" ? above >= visibleHeight || above > below : below < visibleHeight && above > below;
      const beside = openAbove ? above : below;
      menu.style.maxHeight = `${Math.min(maxHeight, bottom - top, beside >= visibleHeight ? beside : bottom - top)}px`;
      menu.classList.toggle("is-above", openAbove);
      const x = align === "start" ? rect.left : align === "center" ? rect.left + (rect.width - menu.offsetWidth) / 2 : rect.right - menu.offsetWidth;
      menu.style.left = `${Math.max(left, Math.min(x, right - menu.offsetWidth))}px`;
      const y = openAbove ? rect.top - menu.offsetHeight - 8 : rect.bottom + 8;
      menu.style.top = `${Math.max(top, Math.min(y, bottom - menu.offsetHeight))}px`;
    };
    // The containing panel may reposition itself in the same resize. Measure
    // after its layout owner has finished, including content/translation changes.
    let frame = 0;
    const schedule = () => {
      view.cancelAnimationFrame(frame);
      frame = view.requestAnimationFrame(place);
    };
    reposition.current = schedule;
    const observer = new ResizeObserver(schedule);
    // The trigger can leave a scrollport while it is still inside the viewport.
    const visibility = closeWhenAnchorClipped ? new view.IntersectionObserver(entries => {
      if (!entries.at(-1)?.isIntersecting && menu.matches(":popover-open")) menu.hidePopover();
    }) : null;
    const toggled = () => {
      observer.disconnect();
      visibility?.disconnect();
      view.cancelAnimationFrame(frame);
      if (!menu.matches(":popover-open")) return;
      place(); observer.observe(menu);
      const anchor = trigger.current;
      if (anchor) {
        observer.observe(anchor);
        visibility?.observe(anchor);
      }
      const parentPopover = anchor?.closest("[popover]");
      if (parentPopover) observer.observe(parentPopover);
    };
    // `toggle` is queued by the browser; position before the first painted frame.
    menu.addEventListener("beforetoggle", schedule);
    menu.addEventListener("toggle", toggled);
    view.addEventListener("resize", schedule);
    view.addEventListener("scroll", schedule, true);
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    toggled();
    return () => {
      reposition.current = null;
      observer.disconnect();
      visibility?.disconnect();
      view.cancelAnimationFrame(frame);
      menu.removeEventListener("beforetoggle", schedule);
      menu.removeEventListener("toggle", toggled);
      view.removeEventListener("resize", schedule);
      view.removeEventListener("scroll", schedule, true);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
    };
  }, [trigger, panel, side, align, maxHeight, preferredHeight, minVisibleHeight, enabled, closeWhenAnchorClipped, ownerDocument]);
}
