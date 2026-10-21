import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useCopy } from "../../ui/copy";
import { Glyph, type GlyphName } from "../../ui/icons";
import { usePanelWindow, panelWindowAPI, SurfaceDocument } from "../../ui/panel-window";
import { Tooltip } from "./Tooltip";
import "./floating-panel.css";

const PANEL_SIZE = { width: 420, height: 560 };
const COMPACT_SIZE = { width: 304, height: undefined };
type PanelGesture = "move" | "nw" | "se";
type PanelChange = { x: number; y: number } | { rect: DOMRect; corner: "nw" | "se"; dx: number; dy: number };

/** Native visibility owns the shell; content owns its session, draft and reading position. */
export function FloatingPanel({ id, trigger, title, icon, compact = false, anchorOnOpen = false, detachable = false, className = "", children, onOpenChange }: {
  id: string; trigger: string | RefObject<HTMLElement | null>; title: string; icon: GlyphName; compact?: boolean; className?: string;
  anchorOnOpen?: boolean;
  detachable?: boolean;
  children: ReactNode; onOpenChange?: (open: boolean, ownerDocument: Document) => void;
}) {
  const { t, vis } = useCopy();
  const [open, setOpen] = useState(false);
  const panelWindow = usePanelWindow(detachable);
  const { container, slot, surfaceDocument, detached } = panelWindow;
  const panelRef = useRef<HTMLElement>(null);
  const defaultSize = compact ? COMPACT_SIZE : PANEL_SIZE;
  const position = useRef({ x: 1, y: 1 });
  const preferredSize = useRef(defaultSize);
  const placePanel = useRef<((change?: PanelChange) => void) | null>(null);
  const gesture = useRef<{ pointerId: number; x: number; y: number; rect: DOMRect; kind: PanelGesture } | null>(null);
  const suppressDragClick = useRef(false);
  const getTrigger = () => typeof trigger === "string" ? document.getElementById(trigger) : trigger.current;
  const focusTrigger = () => {
    const element = getTrigger();
    if (element?.isConnected) element.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const owner = panel.ownerDocument;
    const hideOutsideFullscreen = () => {
      if (!owner.fullscreenElement || owner.fullscreenElement.contains(panel)) return false;
      // A room tool outside the fullscreen subtree must not cover the picture.
      // Adoption already hides its popover, so report the closed state even
      // when the browser has no further toggle event to deliver on return.
      panel.hidePopover();
      setOpen(false);
      onOpenChange?.(false, owner);
      return true;
    };
    // Adoption removes native popovers from the old document's top layer.
    if (surfaceDocument && !hideOutsideFullscreen()) panel.showPopover();
    owner.addEventListener("fullscreenchange", hideOutsideFullscreen);
    return () => owner.removeEventListener("fullscreenchange", hideOutsideFullscreen);
  }, [surfaceDocument]);

  useLayoutEffect(() => {
    if (!surfaceDocument) return;
    if (surfaceDocument !== document) surfaceDocument.title = `${title} · Piik`;
  }, [surfaceDocument, title]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    const owner = panel.ownerDocument;
    const hideOnEscape = (event: KeyboardEvent) => {
      // Inner guidance/disclosures consume Escape before the containing window.
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing ||
        owner.querySelector('[popover="auto"]:popover-open, dialog:modal')) return;
      const panels = [...owner.querySelectorAll<HTMLElement>(".lr-floating-panel:popover-open")];
      if (!panels.length) return;
      const topmost = panels.reduce((top, next) => Number(next.dataset.openedAt) >= Number(top.dataset.openedAt) ? next : top);
      if (topmost !== panel) return;
      event.preventDefault();
      if (owner !== document) { owner.defaultView?.close(); return; }
      const restoreFocus = panel.contains(owner.activeElement);
      panel.hidePopover();
      if (restoreFocus) focusTrigger();
    };
    owner.addEventListener("keydown", hideOnEscape);
    return () => owner.removeEventListener("keydown", hideOnEscape);
  }, [open, surfaceDocument]);

  function startGesture(event: PointerEvent<HTMLElement>, kind: PanelGesture) {
    if (!event.isPrimary || event.button !== 0 || !panelRef.current) return;
    if (kind === "move" && (event.target as Element).closest("button")) return;
    panelRef.current.getAnimations().forEach(animation => animation.finish());
    gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      rect: panelRef.current.getBoundingClientRect(), kind };
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel || detached) return;
    // The visual viewport keeps the composer above a phone's keyboard without
    // resizing the living room or taking ownership of scrolling/focus.
    const viewport = window.visualViewport;
    const place = (change?: PanelChange) => {
      const layout = document.documentElement;
      const width = viewport?.width ?? layout.clientWidth, height = viewport?.height ?? layout.clientHeight;
      const maxWidth = Math.max(0, width - 24), maxHeight = Math.max(0, height - 24);
      const left = (viewport?.offsetLeft ?? 0) + 12, top = (viewport?.offsetTop ?? 0) + 12;
      let point = change && "x" in change ? change : undefined;
      if (change && "corner" in change) {
        const { rect, corner, dx, dy } = change;
        const nw = corner === "nw";
        // Hold the opposite corner steady; viewport changes only constrain the
        // rendered size, while deliberate resizing writes the room UI preference.
        const availableWidth = nw ? rect.right - left : left + maxWidth - rect.left;
        const availableHeight = nw ? rect.bottom - top : top + maxHeight - rect.top;
        const w = Math.min(availableWidth, Math.max(Math.min(compact ? 264 : 320, maxWidth), rect.width + (nw ? -dx : dx)));
        const h = Math.min(availableHeight, Math.max(Math.min(compact ? 240 : 360, maxHeight), rect.height + (nw ? -dy : dy)));
        preferredSize.current = { width: w, height: h };
        point = { x: nw ? rect.right - w : rect.left, y: nw ? rect.bottom - h : rect.top };
      }
      panel.style.width = `${Math.min(preferredSize.current.width, maxWidth)}px`;
      panel.style.maxHeight = `${maxHeight}px`;
      const preferredHeight = preferredSize.current.height;
      panel.style.height = preferredHeight === undefined ? "auto" : `${Math.min(preferredHeight, maxHeight)}px`;
      const freeX = Math.max(0, maxWidth - panel.offsetWidth), freeY = Math.max(0, maxHeight - panel.offsetHeight);
      // Keep the chosen relative position when the keyboard or viewport changes.
      // Only deliberate movement writes it; a narrow viewport must not erase it.
      if (point) {
        if (freeX) position.current.x = Math.max(0, Math.min(1, (point.x - left) / freeX));
        if (freeY) position.current.y = Math.max(0, Math.min(1, (point.y - top) / freeY));
      }
      panel.style.inset = `${top + freeY * position.current.y}px auto auto ${left + freeX * position.current.x}px`;
    };
    const resize = () => place();
    placePanel.current = place;
    place();
    // Contextual palettes start beside their invoker, then use the same free
    // movement owner. Retargeting an open palette must not undo a user's drag.
    const anchor = anchorOnOpen && getTrigger()?.getBoundingClientRect();
    if (anchor) {
      const top = (viewport?.offsetTop ?? 0) + 12;
      const bottom = top + (viewport?.height ?? document.documentElement.clientHeight) - 24;
      const below = anchor.bottom + 8;
      place({ x: anchor.x + anchor.width / 2 - panel.offsetWidth / 2,
        y: below + panel.offsetHeight <= bottom ? below : anchor.top - panel.offsetHeight - 8 });
    }
    viewport?.addEventListener("resize", resize);
    viewport?.addEventListener("scroll", resize);
    window.addEventListener("resize", resize);
    // Content changes keep the chosen top-left corner; viewport changes above
    // retain relative placement. Both still constrain the panel to the viewport.
    const observer = new ResizeObserver(() => place({ x: panel.offsetLeft, y: panel.offsetTop }));
    observer.observe(panel);
    return () => {
      placePanel.current = null;
      gesture.current = null;
      viewport?.removeEventListener("resize", resize);
      viewport?.removeEventListener("scroll", resize);
      window.removeEventListener("resize", resize);
      observer.disconnect();
    };
  }, [open, trigger, compact, anchorOnOpen, detached]);

  const panel = <SurfaceDocument.Provider value={surfaceDocument}>
    <section id={id} ref={panelRef} popover="manual" role="dialog" tabIndex={-1} className={`lr-floating-surface lr-floating-panel ${className}`}
      style={defaultSize}
      aria-label={title}
      onPointerDownCapture={() => { suppressDragClick.current = false; }}
      onPointerMove={event => {
        const drag = gesture.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
        if (!suppressDragClick.current && Math.hypot(dx, dy) < 4) return;
        suppressDragClick.current = true;
        placePanel.current?.(drag.kind === "move" ? { x: drag.rect.left + dx, y: drag.rect.top + dy }
          : { rect: drag.rect, corner: drag.kind, dx, dy });
      }}
      onLostPointerCapture={() => { gesture.current = null; }}
      onPointerCancel={() => { suppressDragClick.current = false; }}
      onClickCapture={event => {
        if (suppressDragClick.current && event.detail > 0) { event.preventDefault(); event.stopPropagation(); }
        suppressDragClick.current = false;
      }}
      onToggle={event => {
        // React delivers nested details/popover toggles to this handler too.
        // Only this panel's native visibility owns its positioning lifetime.
        if (event.target !== event.currentTarget) return;
        const owner = event.currentTarget.ownerDocument;
        // The adopted panel remains open; an old-document close is not a user action.
        const open = event.currentTarget.matches(":popover-open") || owner !== document;
        setOpen(open);
        onOpenChange?.(open, owner);
        if (open) {
          event.currentTarget.dataset.openedAt = String(performance.now());
          // Opening to read must not summon a phone's keyboard.
          event.currentTarget.focus({ preventScroll: true });
        } else {
          panelWindow.close();
          if (event.currentTarget.contains(document.activeElement)) focusTrigger();
        }
      }}>
      <header className="lr-floating-header" role="group" tabIndex={detached ? undefined : 0} aria-label={detached ? title : t("floating.move")}
          aria-describedby={detached ? undefined : `${id}-move-hint`}
          onPointerDown={detached ? undefined : event => startGesture(event, "move")}
          onKeyDown={event => {
            if (detached || event.target !== event.currentTarget || !event.key.startsWith("Arrow") || !panelRef.current) return;
            event.preventDefault();
            const rect = panelRef.current.getBoundingClientRect();
            placePanel.current?.({ x: rect.left + (event.key === "ArrowLeft" ? -24 : event.key === "ArrowRight" ? 24 : 0),
              y: rect.top + (event.key === "ArrowUp" ? -24 : event.key === "ArrowDown" ? 24 : 0) });
          }}>
        <span className="lr-floating-title">{!detached && <Glyph name="grip" size={17} />}
          {vis ? <Glyph name={icon} size={18} /> : <b>{title}</b>}</span>
        <span id={`${id}-move-hint`} className="visually-hidden">{t("floating.moveHint")}</span>
        {detachable && !detached && panelWindowAPI(typeof window === "undefined" ? null : window) &&
          <Tooltip kind="hint-window-detach" place="below" text={vis ? undefined : t("floating.detach")}>
            <button type="button" className="lr-btn is-dense is-quiet lr-popover-close" disabled={panelWindow.opening}
              aria-label={t("floating.detach")} onClick={() => { void panelWindow.open(); }}>
              <Glyph name="pip" size={18} />
            </button>
          </Tooltip>}
        {!detached && <button type="button" className="lr-btn is-dense is-quiet lr-popover-close" aria-label={t("common.close")} onClick={() => {
          panelRef.current?.hidePopover(); focusTrigger();
        }}><Glyph name="x" size={16} /></button>}
      </header>
      {panelWindow.failed && <p className="lr-floating-error" role="status">{t("floating.detachFailed")}</p>}
      {children}
      {!detached && (["nw", "se"] as const).map(corner => <span key={corner} className={`lr-floating-resize is-${corner}`}
        role="group" tabIndex={0} aria-label={t("floating.resize")} aria-describedby={`${id}-resize-hint`}
        onPointerDown={event => startGesture(event, corner)} onKeyDown={event => {
          if (!event.key.startsWith("Arrow") || !panelRef.current) return;
          event.preventDefault();
          placePanel.current?.({ rect: panelRef.current.getBoundingClientRect(), corner,
            dx: event.key === "ArrowLeft" ? -24 : event.key === "ArrowRight" ? 24 : 0,
            dy: event.key === "ArrowUp" ? -24 : event.key === "ArrowDown" ? 24 : 0 });
        }}><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 12 12 3M8 12l4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg></span>)}
      <span id={`${id}-resize-hint`} className="visually-hidden">{t("floating.resizeHint")}</span>
    </section></SurfaceDocument.Provider>;
  // The stable portal target moves between documents without remounting content.
  return container ? <span ref={slot} style={{ display: "contents" }}>{createPortal(panel, container)}</span> : panel;
}
