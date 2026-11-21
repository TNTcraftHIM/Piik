import { useCallback, useEffect, useRef, type PointerEvent } from "react";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";

export function RemoteDirectionPad({ right = false, keyboard, open, toggleOpen, toggleMapping, onMove }: {
  right?: boolean; keyboard: boolean; open: boolean; toggleOpen(): void; toggleMapping?: () => void; onMove(x: number, y: number): void;
}) {
  const { t } = useCopy();

  const pad = useRef<HTMLDivElement>(null);
  const contact = useRef<number | null>(null);
  const label = t(right ? (keyboard ? "remote.mouseStick" : "remote.rightStick") : (keyboard ? "remote.directionPad" : "remote.leftStick"));
  const thumb = useRef<HTMLElement>(null);
  const release = useCallback(() => {
    contact.current = null;
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
  }
  return <div className="lr-remote-direction" data-side={right ? "right" : "left"}>
    <button type="button" className="lr-btn is-compact" aria-label={label} aria-expanded={open}
      onClick={toggleOpen}><Glyph name="gamepad" size={20} /><span aria-hidden="true">{right ? "R" : "L"}</span></button>
    {open && <div ref={pad} className="lr-remote-stick" role="group" aria-label={label}
      onPointerDown={e => {
        if (contact.current !== null || e.button !== 0) return;
        e.preventDefault();
        contact.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        move(e);
      }} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
      {(!right && keyboard ? ["W", "A", "S", "D"] : ["↑", "←", "↓", "→"]).map(value => <span key={value}>{value}</span>)}<i ref={thumb} />
    </div>}
    {open && toggleMapping && <button type="button" className="lr-chip" aria-label={t(keyboard ? "remote.switchToGamepad" : "remote.switchToKeyboardMouse")}
      onClick={toggleMapping}>{t(keyboard ? "remote.keyboardMouseMode" : "remote.gamepadMode")} ⇄</button>}
  </div>;
}
