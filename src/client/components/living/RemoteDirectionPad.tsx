import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { useCopy } from "../../ui/copy";
import { PLAYER_CONTROLS_IDLE_MS } from "../../ui/control-timing";
import { Glyph } from "../../ui/icons";

export function RemoteDirectionPad({ right = false, touchOnly = false, keyboard, open, toggleOpen, onMove }: {
  right?: boolean; touchOnly?: boolean; keyboard: boolean; open: boolean; toggleOpen(): void; onMove(x: number, y: number): void;
}) {
  const { t } = useCopy();

  const group = useRef<HTMLDivElement>(null);
  const pad = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLElement>(null);
  const contact = useRef<number | null>(null);
  const [docked, setDocked] = useState(false);
  const parked = docked && !touchOnly;
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const park = useCallback(() => {
    clearTimeout(idle.current);
    if (touchOnly) return;
    idle.current = setTimeout(() => {
      if (contact.current === null && !group.current?.querySelector(":focus-visible")) setDocked(true);
    }, PLAYER_CONTROLS_IDLE_MS);
  }, [touchOnly]);
  useEffect(() => {
    if (!parked) park();
    return () => clearTimeout(idle.current);
  }, [park, open, parked]);
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
    if (!open || parked) return;
    const doc = pad.current!.ownerDocument;
    const visibility = () => { if (doc.hidden) release(); };
    doc.defaultView?.addEventListener("blur", release);
    doc.addEventListener("visibilitychange", visibility);
    return () => {
      doc.defaultView?.removeEventListener("blur", release);
      doc.removeEventListener("visibilitychange", visibility);
      release();
    };
  }, [release, open, parked, touchOnly]);
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
  return <div ref={group} onFocus={() => clearTimeout(idle.current)} onBlur={park}
    onPointerDownCapture={() => clearTimeout(idle.current)} onPointerUpCapture={park} onPointerCancelCapture={park}
    data-docked={parked || touchOnly ? (right ? "right" : "left") : undefined} data-touch-only={touchOnly || undefined}
    className="lr-remote-direction" data-side={right ? "right" : "left"}>
    <button type="button" className={parked || touchOnly ? "lr-remote-stick-wake" : "lr-btn is-compact"} aria-label={label} aria-expanded={open && !parked}
      onClick={() => parked ? setDocked(false) : toggleOpen()}><Glyph name="gamepad" size={20} /><span aria-hidden="true">{right ? "R" : "L"}</span></button>
    {open && !parked && <div ref={pad} className="lr-remote-stick" role="group" aria-label={label}
      onPointerDown={e => {
        if (contact.current !== null || e.button !== 0 || (touchOnly && e.pointerType !== "touch")) return;
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
  </div>;
}
