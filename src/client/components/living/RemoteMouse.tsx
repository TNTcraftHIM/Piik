import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import type { RemoteTouchpad } from "../../remote-control/touchpad";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { useSurfaceDocument } from "../../ui/panel-window";

export function placeRemoteMouse(layer: HTMLDivElement, x: number, y: number): void {
  layer.style.setProperty("--remote-x", `${x}px`);
  layer.style.setProperty("--remote-y", `${y}px`);
  if (!layer.hasAttribute("data-mouse-interacting")) layer.dataset.mouseSide = x < layer.clientWidth / 2 ? "right" : "left";
}

export function RemoteMouse({ pointer, positionRef }: {
  pointer: RemoteTouchpad; positionRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useCopy();
  const owner = useSurfaceDocument();
  const [expanded, setExpanded] = useState(false);
  const [held, setHeld] = useState<number[]>([]);
  const contacts = useRef(new Map<number, number>());
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const wheel = useRef<{ id: number; y: number } | null>(null);
  const shell = useRef<HTMLDivElement>(null);
  const previousBounds = useRef<DOMRect | null>(null);
  const animation = useRef<Animation | null>(null);
  const cancelMotion = useCallback(() => { animation.current?.cancel(); animation.current = null; previousBounds.current = null; }, []);
  const syncInteraction = useCallback(() => {
    positionRef.current?.toggleAttribute("data-mouse-interacting", contacts.current.size > 0 || drag.current !== null || wheel.current !== null);
  }, [positionRef]);
  const release = useCallback(() => {
    cancelMotion();
    for (const button of new Set(contacts.current.values())) pointer.button(button, false);
    contacts.current.clear(); drag.current = null; wheel.current = null; syncInteraction(); setHeld([]);
  }, [pointer, cancelMotion, syncInteraction]);
  useLayoutEffect(() => {
    const before = previousBounds.current;
    previousBounds.current = null;
    const element = shell.current;
    if (!before || !element || !owner?.defaultView ||
        owner.defaultView.matchMedia("(prefers-reduced-motion: reduce)").matches ||
        element.closest("[data-reduced-motion], [data-comic-reduced-motion]")) return;
    const after = element.getBoundingClientRect();
    if (!after.width || !after.height) return;
    const current = element.animate([
      { transform: `translate(${before.left - after.left}px, ${before.top - after.top}px) scale(${before.width / after.width}, ${before.height / after.height})` },
      { transform: "none" },
    ], { duration: 160, easing: "ease-out" });
    animation.current = current;
    return () => { current.cancel(); if (animation.current === current) animation.current = null; };
  }, [expanded, owner]);
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
    const before = shell.current?.getBoundingClientRect() ?? null;
    release(); previousBounds.current = before; setExpanded(value => !value);
  };
  const finish = (id: number, cancelled = false) => {
    const button = contacts.current.get(id);
    if (button !== undefined) {
      contacts.current.delete(id);
      if (![...contacts.current.values()].includes(button)) pointer.button(button, false);
      setHeld([...contacts.current.values()]);
    }
    if (wheel.current?.id === id) wheel.current = null;
    if (drag.current?.id === id) {
      const tap = !cancelled && !drag.current.moved;
      drag.current = null;
      if (tap) toggle();
    }
    syncInteraction();
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
      contacts.current.set(event.pointerId, value); syncInteraction(); pointer.button(value, true);
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
    onLostPointerCapture={event => { event.stopPropagation(); finish(event.pointerId, true); }}
    onMouseDown={event => event.stopPropagation()} onMouseUp={event => event.stopPropagation()}
    onMouseMove={event => event.stopPropagation()}
    onClick={event => { event.preventDefault(); event.stopPropagation(); }}
    onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); }}
    onAuxClick={event => { event.preventDefault(); event.stopPropagation(); }}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}
    onFocus={event => event.stopPropagation()}
    onBlur={event => {
      event.stopPropagation();
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) release();
    }}>
    <span className="lr-remote-mouse-hotspot" aria-hidden="true" />
    <div ref={shell} className={`lr-remote-mouse-shell${expanded ? " is-expanded" : ""}`}>
      {expanded && <>
        {button(0, "lr-remote-mouse-left")}{button(2, "lr-remote-mouse-right")}
        <div className="lr-remote-mouse-axis">
          <div className="lr-remote-mouse-wheel" role="group" tabIndex={0} aria-label={t("remote.mouseWheel")} aria-description={t("remote.mouseScroll")}
            onPointerDown={event => {
              if (!wheel.current && capture(event)) {
                wheel.current = { id: event.pointerId, y: event.clientY }; syncInteraction();
              }
            }}
            onKeyDown={event => {
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              event.preventDefault(); pointer.wheel(event.key === "ArrowUp" ? -40 : 40);
            }} />
          {button(1, "lr-remote-mouse-middle")}
        </div>
      </>}
      <button type="button" className="lr-remote-mouse-body" aria-expanded={expanded}
        aria-label={t(expanded ? "remote.mouseCollapse" : "remote.mouseExpand")} aria-description={t("remote.mouseMove")}
        onPointerDown={event => {
          if (!drag.current && capture(event)) {
            cancelMotion(); drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false }; syncInteraction();
          }
        }}
        onClick={event => { if (event.detail === 0) toggle(); }}
        onKeyDown={event => {
          const movement = event.key === "ArrowLeft" ? [-10, 0] : event.key === "ArrowRight" ? [10, 0]
            : event.key === "ArrowUp" ? [0, -10] : event.key === "ArrowDown" ? [0, 10] : null;
          if (movement) { event.preventDefault(); pointer.moveBy(movement[0], movement[1]); }
        }}>
        {expanded && <Glyph name="grip" size={18} />}
      </button>
    </div>
  </div>;
}
