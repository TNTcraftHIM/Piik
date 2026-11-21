import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { useCopy } from "../../ui/copy";
import { PLAYER_CONTROLS_IDLE_MS } from "../../ui/control-timing";
import { Glyph } from "../../ui/icons";

type Position = { x: number; y: number };
const DRAG_SLOP_PX = 4;
const KEYBOARD_STEP_PX = 10;

export function RemoteDirectionPad({ right = false, touchOnly = false, keyboard, open, toggleOpen, onMove, readPosition, onPositionChange }: {
  right?: boolean; touchOnly?: boolean; keyboard: boolean; open: boolean; toggleOpen(): void; onMove(x: number, y: number): void;
  readPosition?(): Position | undefined; onPositionChange?(position: Position): void;
}) {
  const { t } = useCopy();

  const group = useRef<HTMLDivElement>(null);
  const pad = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLElement>(null);
  const contact = useRef<number | null>(null);
  const side = right ? "right" : "left";
  const [position, setPosition] = useState(() => readPosition?.());
  const drag = useRef<{ id: number; x: number; y: number; origin: Position; last?: Position } | null>(null);
  const skipPointerClick = useRef(false);
  const [docked, setDocked] = useState(false);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const park = useCallback(() => {
    clearTimeout(idle.current);
    idle.current = setTimeout(() => {
      if (contact.current === null && !drag.current && !group.current?.querySelector(":focus-visible")) setDocked(true);
    }, PLAYER_CONTROLS_IDLE_MS);
  }, []);
  useEffect(() => {
    park();
    return () => clearTimeout(idle.current);
  }, [park]);
  const label = t(right ? (keyboard ? "remote.mouseStick" : "remote.rightStick") : (keyboard ? "remote.directionPad" : "remote.leftStick"));
  const release = useCallback(() => {
    if (contact.current === null) return;
    contact.current = null;
    const element = pad.current;
    element?.removeAttribute("data-contact");
    onMove(0, 0);
    pad.current?.style.removeProperty("--stick-x");
    pad.current?.style.removeProperty("--stick-y");
  }, [onMove]);
  useEffect(() => {
    if (!open) return;
    const doc = pad.current!.ownerDocument;
    const visibility = () => { if (doc.hidden) release(); };
    doc.defaultView?.addEventListener("blur", release);
    doc.addEventListener("visibilitychange", visibility);
    return () => {
      doc.defaultView?.removeEventListener("blur", release);
      doc.removeEventListener("visibilitychange", visibility);
      release();
    };
  }, [release, open]);
  function move(e: PointerEvent<HTMLDivElement>) {
    if (contact.current !== e.pointerId) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) * 2 / rect.width - 1;
    const y = (e.clientY - rect.top) * 2 / rect.height - 1;
    const travel = (e.currentTarget.clientWidth - thumb.current!.offsetWidth) / 2;
    const radius = Math.max(1, Math.hypot(x, y));
    const scale = travel / radius;
    e.currentTarget.style.setProperty("--stick-x", x * scale + "px");
    e.currentTarget.style.setProperty("--stick-y", y * scale + "px");
    onMove(x / radius, y / radius);
  }
  function end(e: PointerEvent<HTMLDivElement>) {
    if (contact.current !== e.pointerId) return;
    release();
    park();
  }
  function shift(dx: number, dy: number, origin?: Position): Position {
    const element = group.current!, bounds = element.parentElement!.getBoundingClientRect(), rect = element.getBoundingClientRect();
    const axis = (pixels: number, delta: number, travel: number, start: number | undefined) =>
      travel > 0 ? Math.max(0, Math.min(1, (start ?? pixels / travel) + delta / travel)) : start ?? 0;
    return { x: axis(rect.left - bounds.left, dx, bounds.width - rect.width, origin?.x),
      y: axis(rect.top - bounds.top, dy, bounds.height - rect.height, origin?.y) };
  }
  function finishDrag(e: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || e.pointerId !== current.id) return;
    drag.current = null;
    const style = group.current!.style;
    style.removeProperty("--stick-grab-x");
    style.removeProperty("--stick-grab-top");
    skipPointerClick.current = Boolean(current.last) || e.type !== "pointerup";
    if (current.last) { setDocked(false); onPositionChange?.(current.last); }
    park();
  }
  return <div className="lr-remote-stick-area"><div ref={group} onFocus={() => clearTimeout(idle.current)} onBlur={park}
    onPointerDownCapture={() => clearTimeout(idle.current)} onPointerUpCapture={park} onPointerCancelCapture={park}
    data-docked={docked ? (right ? "right" : "left") : undefined} data-touch-only={touchOnly || undefined}
    className="lr-remote-direction" data-side={side} data-positioned={position ? "" : undefined}
    style={{ "--stick-px": position?.x, "--stick-py": position?.y } as CSSProperties}>
    <button type="button" className={docked ? "lr-remote-stick-wake" : `lr-btn is-compact${open ? " is-on" : ""}`} aria-label={label} aria-expanded={open}
      aria-description={t("remote.stickReposition")}
      onPointerDown={e => {
        if (e.button !== 0 || drag.current) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        skipPointerClick.current = false;
        const origin = shift(0, 0), style = group.current!.style;
        style.setProperty("--stick-grab-x", String(origin.x));
        style.setProperty("--stick-grab-top", `calc(${origin.y} * var(--stick-travel-y))`);
        drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, origin };
      }}
      onPointerMove={e => {
        const current = drag.current;
        if (current?.id !== e.pointerId) return;
        const dx = e.clientX - current.x, dy = e.clientY - current.y;
        if (!current.last && Math.hypot(dx, dy) <= DRAG_SLOP_PX) return;
        current.last = shift(dx, dy, current.origin);
        setPosition(current.last);
      }}
      onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={finishDrag}
      onKeyDown={e => {
        const dx = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
        const dy = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
        if (!dx && !dy) return;
        e.preventDefault();
        const next = shift(dx * KEYBOARD_STEP_PX, dy * KEYBOARD_STEP_PX);
        setDocked(false); setPosition(next); onPositionChange?.(next);
      }}
      onClick={e => {
        if (e.detail > 0 && skipPointerClick.current) return;
        setDocked(false); toggleOpen(); park();
      }}><Glyph name="gamepad" size={20} /><span aria-hidden="true">{right ? "R" : "L"}</span></button>
    {open && <div ref={pad} className="lr-remote-stick" role="group" aria-label={label}
      onPointerDown={e => {
        if (contact.current !== null || e.button !== 0) return;
        e.preventDefault();
        contact.current = e.pointerId;
        e.currentTarget.setAttribute("data-contact", "");
        e.currentTarget.setPointerCapture(e.pointerId);
        move(e);
      }} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
      onClick={event => {
        // Keep mobile tap targeting on the pad when the mouse button is nearby.
        event.preventDefault();
      }}>
      {(!right && keyboard ? ["W", "A", "S", "D"] : ["↑", "←", "↓", "→"]).map(value => <span key={value}>{value}</span>)}<i ref={thumb} />
    </div>}
  </div></div>;
}
