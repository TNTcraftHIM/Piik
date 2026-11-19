import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import type { RemoteTouchpad } from "../../remote-control/touchpad";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";

export function RemoteDirectionPad({ pointer, onLeftStick }: { pointer: RemoteTouchpad; onLeftStick?: (x: number, y: number) => void }) {
  const { t } = useCopy();
  const [open, setOpen] = useState(false);
  const pad = useRef<HTMLDivElement>(null);
  const contact = useRef<number | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const analog = keyboard ? undefined : onLeftStick;
  const label = t(analog ? "remote.leftStick" : "remote.directionPad");
  const thumb = useRef<HTMLElement>(null);
  const release = useCallback(() => {
    contact.current = null;
    if (analog) analog(0, 0);
    else pointer.direction(0, 0);
    pad.current?.style.removeProperty("--stick-x");
    pad.current?.style.removeProperty("--stick-y");
  }, [pointer, analog]);
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
    if (analog) analog(x / radius, y / radius);
    else pointer.direction(x, y);
  }
  function end(e: PointerEvent<HTMLDivElement>) {
    if (contact.current !== e.pointerId) return;
    release();
  }
  return <div className="lr-remote-direction">
    <button type="button" className="lr-btn is-compact" aria-label={label} aria-expanded={open}
      onClick={() => setOpen(!open)}><Glyph name="gamepad" size={20} /></button>
    {open && <div ref={pad} className="lr-remote-stick" role="group" aria-label={label}
      onPointerDown={e => {
        if (contact.current !== null || e.button !== 0) return;
        e.preventDefault();
        contact.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        move(e);
      }} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
      {(!analog ? ["W", "A", "S", "D"] : ["↑", "←", "↓", "→"]).map(value => <span key={value}>{value}</span>)}<i ref={thumb} />
    </div>}
    {open && onLeftStick && <button type="button" className="lr-chip" aria-pressed={keyboard}
      onClick={() => setKeyboard(!keyboard)}>WASD</button>}
  </div>;
}
