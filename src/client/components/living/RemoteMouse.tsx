import { useCallback, useEffect, useId, useRef, useState, type PointerEvent, type RefObject } from "react";
import type { RemoteTouchpad } from "../../remote-control/touchpad";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { useSurfaceDocument } from "../../ui/panel-window";

export function placeRemotePointer(layer: HTMLDivElement, x: number, y: number): void {
  layer.style.setProperty("--remote-x", `${x}px`);
  layer.style.setProperty("--remote-y", `${y}px`);
}

export function RemoteMouse({ pointer, positionRef }: {
  pointer: RemoteTouchpad; positionRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useCopy();
  const owner = useSurfaceDocument();
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [held, setHeld] = useState<number[]>([]);
  const contacts = useRef(new Map<number, number>());
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const wheel = useRef<{ id: number; y: number } | null>(null);
  const handle = useRef<HTMLButtonElement>(null);
  const release = useCallback(() => {
    for (const button of new Set(contacts.current.values())) pointer.button(button, false);
    contacts.current.clear(); drag.current = null; wheel.current = null; setHeld([]);
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
  const toggle = () => {
    release(); setExpanded(value => !value);
  };
  const finish = (id: number) => {
    const button = contacts.current.get(id);
    if (button !== undefined) {
      contacts.current.delete(id);
      if (![...contacts.current.values()].includes(button)) pointer.button(button, false);
      setHeld([...contacts.current.values()]);
    }
    if (wheel.current?.id === id) wheel.current = null;
    if (drag.current?.id === id) drag.current = null;
  };
  const capture = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return false;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    return true;
  };
  const button = (value: 0 | 1 | 2, className: string) => <button type="button" className={className}
    aria-label={t(value === 0 ? "remote.mouseLeft" : value === 1 ? "remote.mouseMiddle" : "remote.mouseRight")}
    aria-pressed={held.includes(value)}
    onPointerDown={event => {
      if (!capture(event)) return;
      contacts.current.set(event.pointerId, value); pointer.button(value, true);
      setHeld([...contacts.current.values()]);
    }}
    onClick={event => {
      if (event.detail === 0 && !held.includes(value)) {
        pointer.button(value, true); pointer.button(value, false);
      }
    }}><span aria-hidden="true">{["L", "M", "R"][value]}</span></button>;
  return <div ref={positionRef} className="lr-remote-mouse" role="group" aria-label={t("remote.mouse")}
    onPointerDown={event => event.stopPropagation()}
    onPointerMove={event => {
      event.stopPropagation();
      const current = drag.current;
      if (current?.id === event.pointerId) {
        const dx = event.clientX - current.x, dy = event.clientY - current.y;
        if (!current.moved && Math.hypot(dx, dy) <= 4) return;
        current.moved = true; current.x = event.clientX; current.y = event.clientY;
        pointer.moveBy(dx, dy);
      } else if (wheel.current?.id === event.pointerId) {
        pointer.wheel(event.clientY - wheel.current.y); wheel.current.y = event.clientY;
      }
    }}
    onPointerUp={event => { event.stopPropagation(); finish(event.pointerId); }}
    onPointerCancel={event => { event.stopPropagation(); release(); }}
    onLostPointerCapture={event => { event.stopPropagation(); finish(event.pointerId); }}
    onMouseDown={event => event.stopPropagation()} onMouseUp={event => event.stopPropagation()}
    onMouseMove={event => event.stopPropagation()}
    onClick={event => { event.preventDefault(); event.stopPropagation(); }}
    onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); }}
    onAuxClick={event => { event.preventDefault(); event.stopPropagation(); }}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape" && expanded) {
        event.preventDefault(); release(); setExpanded(false); handle.current?.focus({ preventScroll: true });
      }
    }} onKeyUp={event => event.stopPropagation()}
    onFocus={event => event.stopPropagation()}
    onBlur={event => {
      event.stopPropagation();
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) release();
    }}>
    <svg className="lr-remote-touch-cursor" viewBox="0 0 24 28" aria-hidden="true">
      <path d="M2 2v21l6-6 5 9 4-2-5-9h9Z" />
    </svg>
    <div className={`lr-remote-mouse-dock${expanded ? " is-expanded" : ""}`}>
      <button ref={handle} type="button" className="lr-remote-mouse-handle" aria-expanded={expanded}
        aria-controls={id} aria-label={t(expanded ? "remote.mouseCollapse" : "remote.mouseExpand")} onClick={toggle}>
        <Glyph name={expanded ? "chevron" : "mouse"} size={18} />
      </button>
      <div id={id} className="lr-remote-mouse-shell" inert={!expanded} aria-hidden={!expanded}>
        {button(0, "lr-remote-mouse-left")}{button(2, "lr-remote-mouse-right")}
        <div className="lr-remote-mouse-axis">
          <div className="lr-remote-mouse-wheel" role="group" tabIndex={0} aria-label={t("remote.mouseWheel")} aria-description={t("remote.mouseScroll")}
            onPointerDown={event => {
              if (!wheel.current && capture(event)) {
                wheel.current = { id: event.pointerId, y: event.clientY };
              }
            }}
            onKeyDown={event => {
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              event.preventDefault(); pointer.wheel(event.key === "ArrowUp" ? -40 : 40);
            }} />
          {button(1, "lr-remote-mouse-middle")}
        </div>
        <div className="lr-remote-mouse-body" role="group" tabIndex={0} aria-label={t("remote.mouseMove")}
          onPointerDown={event => {
            if (!drag.current && capture(event)) {
              drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
            }
          }}
          onKeyDown={event => {
            const movement = event.key === "ArrowLeft" ? [-10, 0] : event.key === "ArrowRight" ? [10, 0]
              : event.key === "ArrowUp" ? [0, -10] : event.key === "ArrowDown" ? [0, 10] : null;
            if (movement) { event.preventDefault(); pointer.moveBy(movement[0], movement[1]); }
          }}>
          <Glyph name="grip" size={18} />
        </div>
      </div>
    </div>
  </div>;
}
