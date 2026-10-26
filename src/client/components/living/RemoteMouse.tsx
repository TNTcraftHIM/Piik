import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { REMOTE_TOUCH_HOLD_MS, type RemoteTouchpad } from "../../remote-control/touchpad";
import type { PicturePoint } from "../../media/video-geometry";
import type { RoomPreferences } from "../../lib/room-preferences";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { useSurfaceDocument } from "../../ui/panel-window";
import { PLAYER_CONTROLS_IDLE_MS } from "../../ui/control-timing";

export function placeRemotePointer(layer: HTMLDivElement, x: number, y: number): void {
  layer.style.setProperty("--remote-x", `${x}px`);
  layer.style.setProperty("--remote-y", `${y}px`);
}

export function remotePointerRoom(layer: HTMLDivElement | null): { right: number; bottom: number } | null {
  if (!layer) return null;
  const cursor = layer.querySelector<SVGSVGElement>(".lr-remote-touch-cursor");
  if (!cursor) return null;
  const point = cursor.getBoundingClientRect();
  const mouse = layer.querySelector<HTMLElement>(".lr-remote-mouse-widget.is-expanded")?.getBoundingClientRect();
  return { right: Math.max(point.width, mouse ? mouse.right - point.left : 0),
    bottom: Math.max(point.height, mouse ? mouse.bottom - point.top : 0) };
}

type MouseMode = "mini" | "expanded" | "left" | "right" | "top" | "bottom";
type MouseContact = { x: number; y: number; moved: boolean; kind: "widget" | "pointer"; button?: 0 | 2 };
type MouseWheel = { id: number; x: number; y: number; phase: "pending" | "scroll" | "middle"; timer: ReturnType<typeof setTimeout> | null };

export function RemoteMouse({ pointer, positionRef, pointAt, touchMode }: {
  pointer: RemoteTouchpad; positionRef: RefObject<HTMLDivElement | null>;
  pointAt: (clientX: number, clientY: number) => PicturePoint | null;
  touchMode: RoomPreferences["remoteTouchMode"];
}) {
  const { t } = useCopy();
  const owner = useSurfaceDocument();
  const id = useId();
  const [mode, setMode] = useState<MouseMode>("mini");
  const expanded = mode === "expanded";
  const [held, setHeld] = useState<number[]>([]);
  const contacts = useRef(new Map<number, MouseContact>());
  const wheel = useRef<MouseWheel | null>(null);
  const widget = useRef<HTMLDivElement>(null);
  const mini = useRef<HTMLButtonElement>(null);
  const focusMini = useRef(false);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);
  const heldButtons = () => [...contacts.current.values()].flatMap(contact => contact.button === undefined ? [] : [contact.button]);
  const syncHeld = () => setHeld([...heldButtons(), ...(wheel.current?.phase === "middle" ? [1] : [])]);
  const finishWheel = useCallback((cancelled: boolean) => {
    const current = wheel.current;
    if (!current) return;
    wheel.current = null;
    if (current.timer !== null) clearTimeout(current.timer);
    if (current.phase === "middle") pointer.button(1, false);
    else if (!cancelled && current.phase === "pending") {
      pointer.button(1, true); pointer.button(1, false);
    }
  }, [pointer]);
  const clearIdle = useCallback(() => {
    if (idle.current !== null) clearTimeout(idle.current);
    idle.current = null;
  }, []);
  const park = useCallback(() => {
    clearIdle();
    const layer = positionRef.current, element = widget.current;
    if (!layer || !element || contacts.current.size || mini.current?.matches(":focus-visible")) return;
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
    for (const contact of contacts.current.values()) {
      if (contact.kind === "widget" && contact.moved) suppressClick.current = true;
    }
    for (const button of new Set(heldButtons())) pointer.button(button, false);
    finishWheel(true);
    widget.current?.removeAttribute("data-dragging");
    contacts.current.clear(); wheel.current = null; setHeld([]);
  }, [pointer, clearIdle, finishWheel]);
  useLayoutEffect(() => () => pointer.setVirtualMouse(false), [pointer]);
  useLayoutEffect(() => {
    if (!expanded) pointer.setVirtualMouse(touchMode === "trackpad");
    pointer.refresh();
  }, [pointer, expanded, touchMode]);
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
    release(); pointer.setVirtualMouse(touchMode === "trackpad"); focusMini.current = true; setMode("mini");
  };
  const finish = (id: number, cancelled = false) => {
    const current = contacts.current.get(id);
    if (current) {
      contacts.current.delete(id);
      if (current.button !== undefined && !heldButtons().includes(current.button)) pointer.button(current.button, false);
      if (current.kind === "widget") {
        widget.current?.removeAttribute("data-dragging");
        suppressClick.current = current.moved || cancelled;
        if (current.moved && !cancelled) park();
      }
    }
    if (wheel.current?.id === id) finishWheel(cancelled);
    syncHeld();
  };
  const capture = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return false;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    return true;
  };
  const button = (value: 0 | 2, className: string) => <button type="button" className={className}
    aria-label={t(value === 0 ? "remote.mouseLeft" : "remote.mouseRight")}
    aria-pressed={held.includes(value)}
    onPointerDown={event => {
      if (!capture(event)) return;
      const alreadyHeld = heldButtons().includes(value);
      contacts.current.set(event.pointerId, { x: event.clientX, y: event.clientY, moved: false, kind: "pointer", button: value });
      if (!alreadyHeld) pointer.button(value, true);
      syncHeld();
    }}
    onClick={event => {
      if (event.detail === 0 && !held.includes(value)) {
        pointer.button(value, true); pointer.button(value, false);
      }
    }}><span aria-hidden="true">{value === 0 ? "L" : "R"}</span></button>;
  return <div ref={positionRef} className={`lr-remote-mouse${expanded ? " has-virtual-mouse" : ""}`} role="group" aria-label={t("remote.mouse")}
    onPointerDown={event => event.stopPropagation()}
    onPointerMove={event => {
      event.stopPropagation();
      const current = contacts.current.get(event.pointerId);
      if (current) {
        const dx = event.clientX - current.x, dy = event.clientY - current.y;
        if (!current.moved && Math.hypot(dx, dy) <= 4) return;
        current.moved = true; current.x = event.clientX; current.y = event.clientY;
        if (current.kind === "widget") moveWidget(dx, dy);
        else pointer.moveBy(dx, dy);
      } else if (wheel.current?.id === event.pointerId) {
        const current = wheel.current;
        const dx = event.clientX - current.x, dy = event.clientY - current.y;
        if (current.phase === "pending" && Math.hypot(dx, dy) <= 4) return;
        if (current.phase === "pending") current.phase = "scroll";
        current.x = event.clientX; current.y = event.clientY;
        if (current.timer !== null) { clearTimeout(current.timer); current.timer = null; }
        if (current.phase === "middle") pointer.moveBy(dx, dy);
        else pointer.wheel(dy);
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
    {(expanded || touchMode === "trackpad") && <svg className="lr-remote-touch-cursor" viewBox="0 0 24 28" aria-hidden="true">
      <path d="M2 2v21l6-6 5 9 4-2-5-9h9Z" />
    </svg>}
    <div ref={widget} className={`lr-remote-mouse-widget${expanded ? " is-expanded" : ""}`}
      data-docked={mode !== "mini" && !expanded ? mode : undefined}>
      <button ref={mini} type="button" className="lr-remote-mouse-mini" aria-expanded={expanded}
        aria-controls={id} aria-label={t("remote.mouseExpand")} aria-description={t("remote.mouseReposition")}
        inert={expanded} aria-hidden={expanded}
        onPointerDown={event => {
          if (contacts.current.size || !capture(event)) return;
          clearIdle(); suppressClick.current = false; setMode("mini");
          contacts.current.set(event.pointerId, { x: event.clientX, y: event.clientY, moved: false, kind: "widget" });
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
        <button type="button" className="lr-remote-mouse-wheel" aria-label={t("remote.mouseWheel")}
          aria-description={t("remote.mouseScroll")} aria-pressed={held.includes(1)}
          onPointerDown={event => {
            if (wheel.current || !capture(event)) return;
            const current: MouseWheel = { id: event.pointerId, x: event.clientX, y: event.clientY, phase: "pending", timer: null };
            wheel.current = current;
            current.timer = setTimeout(() => {
              current.timer = null; current.phase = "middle";
              pointer.button(1, true); syncHeld();
            }, REMOTE_TOUCH_HOLD_MS);
          }}
          onClick={event => {
            if (event.detail === 0 && !held.includes(1)) { pointer.button(1, true); pointer.button(1, false); }
          }}
          onKeyDown={event => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault(); pointer.wheel(event.key === "ArrowUp" ? -40 : 40);
          }} />
        <div className="lr-remote-mouse-body" role="group" tabIndex={0} aria-label={t("remote.mouseMove")}
          onPointerDown={event => {
            if (capture(event)) {
              contacts.current.set(event.pointerId, { x: event.clientX, y: event.clientY, moved: false, kind: "pointer" });
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
