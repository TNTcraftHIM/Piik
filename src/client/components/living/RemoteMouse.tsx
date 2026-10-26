import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import type { RemoteTouchpad } from "../../remote-control/touchpad";
import type { PicturePoint } from "../../media/video-geometry";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { useSurfaceDocument } from "../../ui/panel-window";
import { PLAYER_CONTROLS_IDLE_MS } from "../../ui/control-timing";

export function placeRemotePointer(layer: HTMLDivElement, x: number, y: number): void {
  layer.style.setProperty("--remote-x", `${x}px`);
  layer.style.setProperty("--remote-y", `${y}px`);
}

type MouseMode = "mini" | "expanded" | "left" | "right" | "top" | "bottom";
type MouseDrag = { id: number; x: number; y: number; moved: boolean; kind: "widget" | "pointer" };

export function RemoteMouse({ pointer, positionRef, pointAt }: {
  pointer: RemoteTouchpad; positionRef: RefObject<HTMLDivElement | null>;
  pointAt: (clientX: number, clientY: number) => PicturePoint | null;
}) {
  const { t } = useCopy();
  const owner = useSurfaceDocument();
  const id = useId();
  const [mode, setMode] = useState<MouseMode>("mini");
  const expanded = mode === "expanded";
  const [held, setHeld] = useState<number[]>([]);
  const contacts = useRef(new Map<number, number>());
  const drag = useRef<MouseDrag | null>(null);
  const wheel = useRef<{ id: number; y: number } | null>(null);
  const widget = useRef<HTMLDivElement>(null);
  const mini = useRef<HTMLButtonElement>(null);
  const focusMini = useRef(false);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);
  const clearIdle = useCallback(() => {
    if (idle.current !== null) clearTimeout(idle.current);
    idle.current = null;
  }, []);
  const park = useCallback(() => {
    clearIdle();
    const layer = positionRef.current, element = widget.current;
    if (!layer || !element || drag.current || mini.current?.matches(":focus-visible")) return;
    const side = element.offsetLeft <= 14 ? "left"
      : element.offsetLeft + element.offsetWidth >= layer.clientWidth - 14 ? "right"
      : element.offsetTop <= 14 ? "top"
      : element.offsetTop + element.offsetHeight >= layer.clientHeight - 14 ? "bottom" : null;
    if (side) idle.current = setTimeout(() => {
      idle.current = null;
      element.style.setProperty(side === "left" || side === "right" ? "--mouse-x" : "--mouse-y",
        side === "left" || side === "top" ? "0%" : "100%");
      setMode(side);
    }, PLAYER_CONTROLS_IDLE_MS);
  }, [clearIdle, positionRef]);
  const moveWidget = (dx: number, dy: number) => {
    const layer = positionRef.current, element = widget.current;
    if (!layer || !element) return;
    const x = Math.max(0, Math.min(1, (element.offsetLeft + element.offsetWidth / 2 + dx) / layer.clientWidth));
    const y = Math.max(0, Math.min(1, (element.offsetTop + element.offsetHeight / 2 + dy) / layer.clientHeight));
    element.style.setProperty("--mouse-x", `${x * 100}%`);
    element.style.setProperty("--mouse-y", `${y * 100}%`);
  };
  const release = useCallback(() => {
    clearIdle();
    if (drag.current?.kind === "widget" && drag.current.moved) suppressClick.current = true;
    for (const button of new Set(contacts.current.values())) pointer.button(button, false);
    widget.current?.removeAttribute("data-dragging");
    contacts.current.clear(); drag.current = null; wheel.current = null; setHeld([]);
  }, [pointer, clearIdle]);
  useLayoutEffect(() => () => pointer.setVirtualMouse(false), [pointer]);
  useLayoutEffect(() => {
    if (mode === "mini") {
      if (focusMini.current) { mini.current?.focus({ preventScroll: true }); focusMini.current = false; }
      park();
    }
    return clearIdle;
  }, [mode, owner, park, clearIdle]);
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
  const expand = () => {
    const bounds = widget.current?.getBoundingClientRect();
    release();
    pointer.setVirtualMouse(true, bounds ? pointAt(bounds.left, bounds.top) : null);
    setMode("expanded");
  };
  const minimize = () => {
    const layer = positionRef.current, element = widget.current;
    if (layer && element) {
      element.style.setProperty("--mouse-x", `${element.offsetLeft / layer.clientWidth * 100}%`);
      element.style.setProperty("--mouse-y", `${element.offsetTop / layer.clientHeight * 100}%`);
    }
    release(); pointer.setVirtualMouse(false); focusMini.current = true; setMode("mini");
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
      const current = drag.current;
      drag.current = null;
      widget.current?.removeAttribute("data-dragging");
      if (current.kind === "widget") {
        suppressClick.current = current.moved || cancelled;
        if (current.moved && !cancelled) park();
      }
    }
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
  return <div ref={positionRef} className={`lr-remote-mouse${expanded ? " has-virtual-mouse" : ""}`} role="group" aria-label={t("remote.mouse")}
    onPointerDown={event => event.stopPropagation()}
    onPointerMove={event => {
      event.stopPropagation();
      const current = drag.current;
      if (current?.id === event.pointerId) {
        const dx = event.clientX - current.x, dy = event.clientY - current.y;
        if (!current.moved && Math.hypot(dx, dy) <= 4) return;
        current.moved = true; current.x = event.clientX; current.y = event.clientY;
        if (current.kind === "widget") moveWidget(dx, dy);
        else pointer.moveBy(dx, dy);
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
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape" && expanded) {
        event.preventDefault(); minimize();
      }
    }} onKeyUp={event => event.stopPropagation()}
    onFocus={event => event.stopPropagation()}
    onBlur={event => {
      event.stopPropagation();
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) release();
    }}>
    {expanded && <svg className="lr-remote-touch-cursor" viewBox="0 0 24 28" aria-hidden="true">
      <path d="M2 2v21l6-6 5 9 4-2-5-9h9Z" />
    </svg>}
    <div ref={widget} className={`lr-remote-mouse-widget${expanded ? " is-expanded" : ""}`}
      data-docked={mode !== "mini" && !expanded ? mode : undefined}>
      <button ref={mini} type="button" className="lr-remote-mouse-mini" aria-expanded={expanded}
        aria-controls={id} aria-label={t("remote.mouseExpand")} aria-description={t("remote.mouseReposition")}
        inert={expanded} aria-hidden={expanded}
        onPointerDown={event => {
          if (drag.current || !capture(event)) return;
          clearIdle(); suppressClick.current = false; setMode("mini");
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, kind: "widget" };
          widget.current?.setAttribute("data-dragging", "");
        }}
        onClick={event => {
          if (suppressClick.current && event.detail > 0) { suppressClick.current = false; return; }
          expand();
        }}
        onKeyDown={event => {
          const dx = event.key === "ArrowLeft" ? -10 : event.key === "ArrowRight" ? 10 : 0;
          const dy = event.key === "ArrowUp" ? -10 : event.key === "ArrowDown" ? 10 : 0;
          if (dx || dy) { event.preventDefault(); clearIdle(); setMode("mini"); moveWidget(dx, dy); }
        }} />
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
              drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, kind: "pointer" };
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
    <button type="button" className="lr-remote-mouse-minimize" aria-label={t("remote.mouseCollapse")}
      onClick={minimize} inert={!expanded} aria-hidden={!expanded}>
      <Glyph name="chevron" size={18} />
    </button>
  </div>;
}
