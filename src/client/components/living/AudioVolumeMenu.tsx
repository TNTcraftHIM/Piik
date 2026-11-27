import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useLayerHistory } from "../../ui/layer-history";
import { AudioVolumeControl } from "./AudioVolumeControl";
import { HOVER_ENTER_MS, HOVER_EXIT_GRACE_MS } from "./Tooltip";
import { useTouchHold } from "./use-touch-hold";
import { useAnchoredPopover } from "./use-anchored-popover";
import { useSurfaceDocument } from "../../ui/panel-window";
import { useCopy, type CopyKey } from "../../ui/copy";

const TOUCH_HOLD_TOLERANCE_PX = 8;

// The icon keeps its direct mute action; its attached slider never reflows the row.
export function AudioVolumeMenu({ volume, onVolume, label, heading, disabled, children, max }: {
  volume: number; onVolume: (volume: number) => void; label: CopyKey;
  heading?: string; disabled?: boolean; children: ReactNode;
  max?: number;
}) {
  const { t } = useCopy();
  const ownerDocument = useSurfaceDocument(), view = ownerDocument?.defaultView;
  const anchor = useRef<HTMLSpanElement>(null), panel = useRef<HTMLDivElement>(null);
  const [explicitlyOpen, setExplicitlyOpen] = useState(false);
  useLayerHistory(panel, explicitlyOpen);
  const enter = useRef<number | null>(null), leave = useRef<number | null>(null);
  const hold = useTouchHold(view, TOUCH_HOLD_TOLERANCE_PX);
  const held = useRef(false);
  useAnchoredPopover(anchor, panel, { side: "above", align: "center" });
  const clear = () => {
    hold.cancel();
    if (enter.current !== null) view?.clearTimeout(enter.current);
    if (leave.current !== null) view?.clearTimeout(leave.current);
    enter.current = leave.current = null;
  };
  const close = () => { clear(); if (panel.current?.matches(":popover-open")) panel.current.hidePopover(); };
  const open = () => {
    clear();
    if (!disabled && panel.current && !panel.current.matches(":popover-open")) {
      panel.current.showPopover({ source: anchor.current?.querySelector("button") ?? anchor.current! });
    }
  };
  const openExplicitly = () => {
    open();
    setExplicitlyOpen(panel.current?.matches(":popover-open") === true);
  };
  useLayoutEffect(() => {
    const menu = panel.current;
    return () => { clear(); if (menu?.matches(":popover-open")) menu.hidePopover(); };
  }, [ownerDocument]);
  useLayoutEffect(() => { if (disabled) close(); }, [disabled]);
  return <span ref={anchor} className="lr-audio-volume-menu"
    onPointerEnter={event => {
      if (event.pointerType === "touch" || event.buttons || disabled) return;
      clear();
      if (!panel.current?.matches(":popover-open")) enter.current = view?.setTimeout(open, HOVER_ENTER_MS) ?? null;
    }}
    onPointerLeave={event => {
      if (event.pointerType === "touch") return;
      clear();
      if (event.buttons) return;
      const focused = ownerDocument?.activeElement;
      if (focused && event.currentTarget.contains(focused) && focused.matches(":focus-visible")) return;
      leave.current = view?.setTimeout(close, HOVER_EXIT_GRACE_MS) ?? null;
    }}
    onFocusCapture={event => {
      if (!event.currentTarget.contains(event.relatedTarget) && event.target.matches(":focus-visible")) open();
    }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}
    onPointerDownCapture={event => {
      clear(); held.current = false;
      if (disabled || event.pointerType !== "touch" || panel.current?.contains(event.target as Node)) return;
      hold.start(event, () => {
        held.current = true;
        openExplicitly();
      });
    }}
    onPointerMoveCapture={hold.move}
    onPointerCancel={() => { clear(); held.current = false; }}
    onPointerUpCapture={event => {
      clear();
      if (held.current) {
        event.preventDefault();
        return;
      }
      const inside = [anchor.current, panel.current].some(element => {
        const rect = element?.getBoundingClientRect();
        return rect && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      });
      if (!inside) close();
    }}
    onClickCapture={event => {
      if (held.current) {
        held.current = false; event.preventDefault(); event.stopPropagation();
        // Native auto-popover dismissal finishes at pointer-up. The held
        // gesture's click restores the slider without activating mute.
        openExplicitly();
      }
    }}
    onKeyDownCapture={() => { held.current = false; }}
    onContextMenu={event => {
      if (!disabled && !panel.current?.contains(event.target as Node)) { event.preventDefault(); openExplicitly(); }
    }}>
    {children}
    <div ref={panel} popover="auto" role="dialog" aria-label={heading ?? t(label)}
      onToggle={event => { if (event.target === event.currentTarget && event.newState === "closed") setExplicitlyOpen(false); }}
      className="lr-floating-surface lr-audio-settings lr-audio-volume-popover">
      {heading && <b>{heading}</b>}
      <AudioVolumeControl volume={volume} onVolume={onVolume} label={label} max={max} />
    </div>
  </span>;
}
