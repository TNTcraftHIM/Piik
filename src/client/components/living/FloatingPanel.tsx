import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from "react";
import { useCopy } from "../../ui/copy";
import { Glyph, type GlyphName } from "../../ui/icons";
import "./floating-panel.css";

const PANEL_SIZES = { default: { width: 420, height: 560 }, large: { width: 560, height: 680 } };
const COMPACT_SIZES = { default: { width: 304, height: undefined }, large: { width: 380, height: 460 } };
type PanelGesture = "move" | "nw" | "se";
type PanelChange = { x: number; y: number } | { rect: DOMRect; corner: "nw" | "se"; dx: number; dy: number };

/** Native visibility owns the shell; content owns its session, draft and reading position. */
export function FloatingPanel({ id, trigger, title, icon, compact = false, anchorOnOpen = false, className = "", children, onOpenChange }: {
  id: string; trigger: string | RefObject<HTMLElement | null>; title: string; icon: GlyphName; compact?: boolean; className?: string;
  anchorOnOpen?: boolean;
  children: ReactNode; onOpenChange?: (open: boolean) => void;
}) {
  const { t, vis } = useCopy();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const positionMenu = useRef<HTMLDetailsElement>(null);
  const sizes = compact ? COMPACT_SIZES : PANEL_SIZES;
  const position = useRef({ x: 1, y: 1 });
  const preferredSize = useRef(sizes.default);
  const placePanel = useRef<((change?: PanelChange) => void) | null>(null);
  const gesture = useRef<{ pointerId: number; x: number; y: number; rect: DOMRect; kind: PanelGesture } | null>(null);
  const suppressDragClick = useRef(false);
  const getTrigger = () => typeof trigger === "string" ? document.getElementById(trigger) : trigger.current;
  const focusTrigger = () => {
    const element = getTrigger();
    if (element?.isConnected) element.focus({ preventScroll: true });
  };

  function startGesture(event: PointerEvent<HTMLElement>, kind: PanelGesture) {
    if (!event.isPrimary || event.button !== 0 || !panelRef.current) return;
    if (kind === "move" && (event.target as Element).closest("button, .lr-floating-positions")) return;
    panelRef.current.getAnimations().forEach(animation => animation.finish());
    gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      rect: panelRef.current.getBoundingClientRect(), kind };
    // Capture on the summary preserves its native click/keyboard activation.
    const handle = (event.target as Element).closest<HTMLElement>("summary") ?? event.currentTarget;
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
  }
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
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
    const hideOnEscape = (event: KeyboardEvent) => {
      // Inner native surfaces consume Escape first, even after focus moves out.
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing ||
        document.querySelector('[popover="auto"]:popover-open, dialog:modal')) return;
      // Native top-layer order follows opening, not DOM order. Consume one
      // close request even when chat and the reaction palette are both open.
      const panels = [...document.querySelectorAll<HTMLElement>(".lr-floating-panel:popover-open")];
      if (!panels.length) return;
      const topmost = panels.reduce((top, next) => Number(next.dataset.openedAt) >= Number(top.dataset.openedAt) ? next : top);
      if (topmost !== panel) return;
      event.preventDefault();
      const restoreFocus = panel.contains(document.activeElement);
      panel.hidePopover();
      if (restoreFocus) focusTrigger();
    };
    placePanel.current = place;
    place();
    // Contextual palettes start beside their invoker, then use the same free
    // movement owner. Retargeting an open palette must not undo a user's drag.
    const anchor = anchorOnOpen && getTrigger()?.getBoundingClientRect();
    if (anchor) {
      const top = (viewport?.offsetTop ?? 0) + 12;
      const bottom = top + (viewport?.height ?? document.documentElement.clientHeight) - 24;
      const below = anchor.bottom + 8;
      const headroom = anchor.top - top >= panel.offsetHeight + 136 ? 128 : 0;
      place({ x: anchor.x + anchor.width / 2 - panel.offsetWidth / 2,
        y: below + panel.offsetHeight <= bottom ? below : anchor.top - panel.offsetHeight - 8 - headroom });
    }
    viewport?.addEventListener("resize", resize);
    viewport?.addEventListener("scroll", resize);
    window.addEventListener("resize", resize);
    // Content-sized palettes still fit after a target, language or status change.
    const observer = new ResizeObserver(resize);
    observer.observe(panel);
    document.addEventListener("keydown", hideOnEscape);
    return () => {
      placePanel.current = null;
      gesture.current = null;
      viewport?.removeEventListener("resize", resize);
      viewport?.removeEventListener("scroll", resize);
      window.removeEventListener("resize", resize);
      observer.disconnect();
      document.removeEventListener("keydown", hideOnEscape);
    };
  }, [open, trigger, compact, anchorOnOpen]);

  return (<section id={id} ref={panelRef} popover="manual" role="dialog" tabIndex={-1} className={`lr-floating-surface lr-floating-panel ${className}`}
      style={sizes.default}
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
        const open = event.newState === "open";
        setOpen(open);
        onOpenChange?.(open);
        if (open) {
          event.currentTarget.dataset.openedAt = String(performance.now());
          // Opening to read must not summon a phone's keyboard.
          event.currentTarget.focus({ preventScroll: true });
        } else {
          if (positionMenu.current) positionMenu.current.open = false;
          if (event.currentTarget.contains(document.activeElement)) focusTrigger();
        }
      }}>
      <header className="lr-floating-header" role="group" tabIndex={0} aria-label={t("floating.move")}
          aria-describedby={`${id}-move-hint`}
          onPointerDown={event => startGesture(event, "move")}
          onKeyDown={event => {
            if (event.target !== event.currentTarget || !event.key.startsWith("Arrow") || !panelRef.current) return;
            event.preventDefault();
            const rect = panelRef.current.getBoundingClientRect();
            placePanel.current?.({ x: rect.left + (event.key === "ArrowLeft" ? -24 : event.key === "ArrowRight" ? 24 : 0),
              y: rect.top + (event.key === "ArrowUp" ? -24 : event.key === "ArrowDown" ? 24 : 0) });
          }}>
        <span className="lr-floating-title"><Glyph name="grip" size={17} />
          {vis ? <Glyph name={icon} size={18} /> : <b>{title}</b>}</span>
        <span id={`${id}-move-hint`} className="visually-hidden">{t("floating.moveHint")}</span>
        <details ref={positionMenu} className="lr-floating-position"
          onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.open = false; }}
          onKeyDown={event => {
            if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing || !event.currentTarget.open) return;
            event.stopPropagation(); event.currentTarget.open = false;
            event.currentTarget.querySelector("summary")?.focus();
          }}>
          <summary aria-label={t("floating.position")}><Glyph name="move" size={16} />{!vis && <span>{t("floating.position")}</span>}</summary>
          <div className="lr-floating-positions" role="group" aria-label={t("floating.position")}>
            {(["topLeft", "topRight", "bottomLeft", "bottomRight"] as const).map((corner, index) => {
              const x = index % 2, y = Math.floor(index / 2);
              return <button key={corner} type="button" aria-label={t(`floating.position.${corner}`)} onClick={() => {
                position.current = { x, y }; placePanel.current?.();
                if (positionMenu.current) { positionMenu.current.open = false; positionMenu.current.querySelector("summary")?.focus(); }
              }}>
                <svg viewBox="0 0 28 22" width="28" height="22" aria-hidden="true">
                  <rect x="1" y="1" width="26" height="20" rx="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <rect x={x ? 16 : 4} y={y ? 12 : 4} width="8" height="6" rx="1.5" fill="currentColor" />
                </svg>{!vis && <span>{t(`floating.position.${corner}`)}</span>}
              </button>;
            })}
            {(["default", "large"] as const).map(size => <button key={size} type="button" className="lr-floating-size"
              onClick={() => {
                preferredSize.current = sizes[size]; placePanel.current?.();
                if (positionMenu.current) { positionMenu.current.open = false; positionMenu.current.querySelector("summary")?.focus(); }
              }} aria-label={t(`floating.size.${size}`)}>
              <Glyph name={size === "large" ? "expand" : "contract"} size={18} />{!vis && <span>{t(`floating.size.${size}`)}</span>}
            </button>)}
          </div>
        </details>
        <button type="button" className="lr-popover-close" aria-label={t("common.close")} onClick={() => {
          panelRef.current?.hidePopover(); focusTrigger();
        }}><Glyph name="x" size={16} /></button>
      </header>
      {children}
      {(["nw", "se"] as const).map(corner => <span key={corner} className={`lr-floating-resize is-${corner}`}
        role="group" tabIndex={0} aria-label={t("floating.resize")} aria-describedby={`${id}-resize-hint`}
        onPointerDown={event => startGesture(event, corner)} onKeyDown={event => {
          if (!event.key.startsWith("Arrow") || !panelRef.current) return;
          event.preventDefault();
          placePanel.current?.({ rect: panelRef.current.getBoundingClientRect(), corner,
            dx: event.key === "ArrowLeft" ? -24 : event.key === "ArrowRight" ? 24 : 0,
            dy: event.key === "ArrowUp" ? -24 : event.key === "ArrowDown" ? 24 : 0 });
        }}><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 12 12 3M8 12l4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg></span>)}
      <span id={`${id}-resize-hint`} className="visually-hidden">{t("floating.resizeHint")}</span>
    </section>);
}
