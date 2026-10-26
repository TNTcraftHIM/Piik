import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteTouchpad } from "../../remote-control/touchpad";
import { useCopy } from "../../ui/copy";
import { useSurfaceDocument } from "../../ui/panel-window";

export function RemoteMouse({ pointer }: { pointer: RemoteTouchpad }) {
  const { t, vis } = useCopy();
  const owner = useSurfaceDocument();
  const contacts = useRef(new Map<number, number>());
  const wheel = useRef<{ id: number; y: number } | null>(null);
  const [held, setHeld] = useState<number[]>([]);
  const release = useCallback(() => {
    for (const button of new Set(contacts.current.values())) pointer.button(button, false);
    contacts.current.clear(); wheel.current = null; setHeld([]);
  }, [pointer]);
  useEffect(() => {
    if (!owner) return;
    const hidden = () => { if (owner.hidden) release(); };
    owner.defaultView?.addEventListener("blur", release);
    owner.addEventListener("visibilitychange", hidden);
    return () => {
      owner.defaultView?.removeEventListener("blur", release);
      owner.removeEventListener("visibilitychange", hidden);
      release();
    };
  }, [release, owner]);
  const up = (id: number) => {
    const button = contacts.current.get(id);
    if (button === undefined) return;
    contacts.current.delete(id);
    if (![...contacts.current.values()].includes(button)) pointer.button(button, false);
    setHeld([...contacts.current.values()]);
  };
  return <><div className="lr-remote-mouse" role="group" aria-label={t("remote.mouse")}
    onContextMenu={event => event.preventDefault()}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) release(); }}>
    {([0, 1, 2] as const).map(button => <button key={button} type="button" className={`lr-chip${held.includes(button) ? " is-selected" : ""}`}
      aria-label={t(button === 0 ? "remote.mouseLeft" : button === 1 ? "remote.mouseMiddle" : "remote.mouseRight")}
      aria-pressed={held.includes(button)}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
        contacts.current.set(event.pointerId, button); pointer.button(button, true);
        setHeld([...contacts.current.values()]);
      }}
      onPointerUp={event => up(event.pointerId)}
      onPointerCancel={event => up(event.pointerId)}
      onLostPointerCapture={event => up(event.pointerId)}
      onClick={event => {
        if (event.detail === 0 && !held.includes(button)) {
          pointer.button(button, true); pointer.button(button, false);
        }
      }}>{vis ? ["L", "M", "R"][button] : t(button === 0 ? "remote.mouseLeft" : button === 1 ? "remote.mouseMiddle" : "remote.mouseRight")}</button>)}
    <div className="lr-chip lr-remote-mouse-wheel" role="group" tabIndex={0} aria-label={t("remote.mouseWheel")}
      onPointerDown={event => {
        if (event.button !== 0 || wheel.current) return;
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
        wheel.current = { id: event.pointerId, y: event.clientY };
      }}
      onPointerMove={event => {
        const previous = wheel.current;
        if (!previous || previous.id !== event.pointerId) return;
        pointer.wheel(event.clientY - previous.y); previous.y = event.clientY;
      }}
      onPointerUp={event => { if (wheel.current?.id === event.pointerId) wheel.current = null; }}
      onPointerCancel={event => { if (wheel.current?.id === event.pointerId) wheel.current = null; }}
      onLostPointerCapture={event => { if (wheel.current?.id === event.pointerId) wheel.current = null; }}
      onKeyDown={event => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault(); event.stopPropagation(); pointer.wheel(event.key === "ArrowUp" ? -40 : 40);
      }}><span aria-hidden="true">↕</span>{!vis && <span>{t("remote.mouseWheel")}</span>}</div>
  </div>{!vis && <p>{t("remote.mouseHelp")}</p>}</>;
}
