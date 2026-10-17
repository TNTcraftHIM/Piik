import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import type { InputTransport } from "../../remote-control/input-route";
import { RemoteInputSession, picturePoint, pictureRect, type RemoteInputState, type RemoteInputEvent } from "../../remote-control/input-session";
import { RemoteTouchpad } from "../../remote-control/touchpad";
import { RemoteKeyboard } from "./RemoteKeyboard";
import { Btn } from "./primitives";
import { videoFullscreenState, type FullscreenVideo } from "./video-fullscreen";
import "./remote-control.css";

// The video keeps its existing media owner. This temporary surface handles
// input only while its current routed endpoint holds a local App grant.
export function RemoteControl({ channel, videoRef, available }: {
  channel: InputTransport | null; videoRef: RefObject<HTMLVideoElement | null>;
  available: boolean;
}) {
  const { t, vis } = useCopy();
  const [state, setState] = useState<RemoteInputState | null>(null);
  const [locked, setLocked] = useState(false);
  const [lockFailed, setLockFailed] = useState(false);
  const [inline, setInline] = useState(true);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [touch, setTouch] = useState(false);
  const session = useRef<RemoteInputSession | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  const cursor = useRef<SVGSVGElement | null>(null);
  const touchpad = useRef<RemoteTouchpad | null>(null);
  const active = state?.state === "active" && available && inline && channel?.readyState === "open";
  const controlled = (state?.state === "active" || state?.state === "suspended") && available && inline && channel?.readyState === "open";
  const input = (event: RemoteInputEvent) => session.current?.input(event);
  const reset = useCallback(() => { touchpad.current?.reset(); session.current?.input({ type: "reset" }); }, []);
  const closeKeyboard = () => {
    reset(); setKeyboardOpen(false); surface.current?.focus({ preventScroll: true });
  };
  const release = useCallback(() => {
    reset();
    if (document.pointerLockElement === surface.current && surface.current) document.exitPointerLock();
    session.current?.release();
  }, [reset]);

  useEffect(() => {
    setState(null);
    setPasswordOpen(false); setPassword("");
    if (!channel) return;
    const current = new RemoteInputSession(channel, setState);
    session.current = current;
    return () => {
      current.dispose(); session.current = null;
    };
  }, [channel]);
  useEffect(() => {
    if (controlled || state?.mode !== "password" || !available || !inline) {
      setPasswordOpen(false); setPassword("");
    }
  }, [controlled, state?.mode, available, inline]);
  useEffect(() => {
    if (!available || !inline) release();
  }, [available, inline, channel, release]);
  useEffect(() => {
    const video = videoRef.current;
    if (!active || !video) { setKeyboardOpen(false); setTouch(false); return; }
    const updateCursor = () => {
      const picture = pictureRect(video);
      const rect = surface.current?.getBoundingClientRect();
      if (!picture || !rect || !cursor.current) return;
      cursor.current.style.left = `${picture.left - rect.left + current.position.x * picture.width}px`;
      cursor.current.style.top = `${picture.top - rect.top + current.position.y * picture.height}px`;
    };
    const current = new RemoteTouchpad(
      () => pictureRect(video),
      event => session.current?.input(event),
      delta => session.current?.scroll(delta, 0),
      updateCursor,
    );
    touchpad.current = current;
    // Layout changes and decoded aspect-ratio changes share the input geometry.
    const observer = new ResizeObserver(updateCursor);
    observer.observe(video);
    video.addEventListener("resize", updateCursor);
    return () => {
      observer.disconnect(); video.removeEventListener("resize", updateCursor);
      current.reset(); touchpad.current = null;
    };
  }, [active, channel, videoRef]);
  useEffect(() => {
    const video = videoRef.current as FullscreenVideo | null;
    if (!video) return;
    // Native PiP/fullscreen moves the picture away from the page's input surface.
    // DOM fullscreen retains that surface and can continue controlling normally.
    const syncPresentation = () => setInline(document.pictureInPictureElement !== video &&
      video.webkitPresentationMode !== "picture-in-picture" && !videoFullscreenState(video).nativeActive);
    const events = ["enterpictureinpicture", "leavepictureinpicture", "webkitpresentationmodechanged", "webkitbeginfullscreen", "webkitendfullscreen"];
    syncPresentation();
    video.addEventListener("pause", release);
    events.forEach(event => video.addEventListener(event, syncPresentation));
    return () => {
      video.removeEventListener("pause", release);
      events.forEach(event => video.removeEventListener(event, syncPresentation));
    };
  }, [release, videoRef]);
  useEffect(() => {
    if (!controlled) return;
    const element = surface.current;
    element?.focus({ preventScroll: true });
    const wheel = (event: WheelEvent) => { event.preventDefault(); session.current?.scroll(event.deltaY, event.deltaMode); };
    element?.addEventListener("wheel", wheel, { passive: false });
    // Release can land outside the picture after a drag. Observe it for this
    // grant only; the native owner ignores buttons it never pressed.
    const mouseUp = (event: MouseEvent) => session.current?.input({ type: "button", button: event.button, down: false });
    window.addEventListener("mouseup", mouseUp, true);
    const hidden = () => { if (document.hidden) release(); };
    const lockChanged = () => {
      reset(); setLocked(document.pointerLockElement === element);
      if (document.pointerLockElement === element) { setLockFailed(false); element?.focus({ preventScroll: true }); }
    };
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", hidden);
    document.addEventListener("pointerlockchange", lockChanged);
    return () => {
      element?.removeEventListener("wheel", wheel);
      window.removeEventListener("mouseup", mouseUp, true);
      window.removeEventListener("blur", reset);
      document.removeEventListener("visibilitychange", hidden);
      document.removeEventListener("pointerlockchange", lockChanged);
      if (document.pointerLockElement === element) document.exitPointerLock();
      setLocked(false); setLockFailed(false);
    };
  }, [controlled, channel, release, reset]);

  if (!channel || channel.readyState !== "open" || !state || state.mode === "off") return null;
  const point = (clientX: number, clientY: number) => {
    const video = videoRef.current;
    return video ? picturePoint(video, clientX, clientY) : null;
  };
  const buttonTitle = controlled ? "remote.stop" : state.state === "pending" ? "remote.cancel" : "remote.request";
  const touchControls = touch || matchMedia("(pointer: coarse)").matches;
  const statusIcon = state.reason === "busy" ? "users" : state.reason === "password" || state.state === "failed" ? "alert"
    : state.state === "suspended" ? "pause" : "clock";
  const parent = videoRef.current?.parentElement;
  return <>
    <Btn icon="mouse" title={!inline ? "remote.inlineRequired" : state.state === "unavailable" ? "remote.unavailable" : buttonTitle}
      hint={controlled || state.state === "pending" ? "hint-remote-stop" : "hint-remote-control"}
      pressed={controlled} disabled={!available || !inline || state.state === "unavailable"}
      onClick={() => {
        if (controlled || state.state === "pending") release();
        else if (state.mode === "password") setPasswordOpen(open => !open);
        else session.current?.request();
      }} />
    {controlled && <Btn icon="keyboard" title="remote.keyboard" hint="hint-remote-keyboard"
      hintText={touchControls ? "remote.touchHelp" : undefined} expanded={keyboardOpen} disabled={!active}
      onClick={() => { if (keyboardOpen) closeKeyboard(); else { reset(); setKeyboardOpen(true); } }} />}
    {parent && (controlled || state.state === "pending" || state.state === "failed" || state.reason || passwordOpen) && createPortal(<>
      {passwordOpen && <form className="lr-remote-password" onSubmit={event => {
        event.preventDefault(); session.current?.request(password); setPassword("");
      }} onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); setPasswordOpen(false); setPassword(""); release(); }
      }}>
        <div className="lr-remote-panel-header">
          <strong><Glyph name="key" size={18} />{vis ? null : t("remote.password")}</strong>
          <button type="button" className="lr-popover-close" aria-label={t("common.cancel")}
            onClick={() => { setPasswordOpen(false); setPassword(""); release(); }}>
            <Glyph name="x" size={17} />
          </button>
        </div>
        <div className="lr-remote-policy-actions">
          <label className="lr-input">
            <input type="password" required autoFocus autoComplete="off" maxLength={128}
              value={password} aria-label={t("remote.password")} disabled={state.state === "pending"}
              onChange={event => setPassword(event.target.value)} />
          </label>
          <Btn icon="check" title="remote.request" type="submit" disabled={!password || state.state === "pending"} />
        </div>
        {state.reason && <p role="status"><Glyph name={statusIcon} size={16} />
          <span className={vis ? "visually-hidden" : undefined}>{t(`remote.reason.${state.reason}`)}</span></p>}
      </form>}
      {controlled && <div ref={surface} className={`lr-remote-input-surface${active ? "" : " is-suspended"}`} tabIndex={0}
        aria-label={t("remote.surface")} role="application"
        onContextMenu={event => event.preventDefault()}
        onAuxClick={event => event.preventDefault()}
        onPointerMove={event => {
          if (event.pointerType === "touch") {
            event.preventDefault(); event.stopPropagation();
            touchpad.current?.move(event.pointerId, event.clientX, event.clientY); return;
          }
          setTouch(false);
          if (document.pointerLockElement === surface.current) {
            input({ type: "relative", dx: event.movementX, dy: event.movementY });
          } else {
            const position = point(event.clientX, event.clientY);
            if (position) {
              input({ type: "move", ...position });
              if (touchpad.current) touchpad.current.position = position;
            }
          }
        }}
        onPointerDown={event => {
          if (document.pointerLockElement !== surface.current) event.currentTarget.setPointerCapture(event.pointerId);
          if (event.pointerType === "touch") {
            event.preventDefault(); event.stopPropagation(); setTouch(true);
            surface.current?.focus({ preventScroll: true });
            touchpad.current?.down(event.pointerId, event.clientX, event.clientY);
          }
        }}
        onPointerUp={event => {
          if (event.pointerType === "touch") {
            event.preventDefault(); event.stopPropagation(); touchpad.current?.up(event.pointerId);
          }
        }}
        onClick={event => { event.preventDefault(); event.stopPropagation(); }}
        onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); }}
        // Pointer down/up report the first/last mouse button only. Mouse events
        // preserve chords such as holding right to aim while left clicks fire.
        onMouseDown={event => {
          if (event.button > 4) return;
          event.preventDefault(); surface.current?.focus({ preventScroll: true });
          if (document.pointerLockElement === surface.current) { input({ type: "button", button: event.button, down: true }); return; }
          const position = point(event.clientX, event.clientY);
          if (position) { input({ type: "move", ...position }); input({ type: "button", button: event.button, down: true }); }
        }}
        onPointerCancel={reset}
        onLostPointerCapture={event => {
          if (event.pointerType === "touch") touchpad.current?.cancel(event.pointerId);
          // Normal mouse-up also releases capture. It must not release a key
          // still held for movement or a keyboard/mouse chord.
          else if (event.buttons !== 0) reset();
        }}
        onBlur={reset}
        onKeyDown={event => {
          event.preventDefault(); event.stopPropagation();
          if (event.code === "F10" && event.ctrlKey && event.altKey) { release(); return; }
          if (!event.nativeEvent.isComposing) input({ type: "key", code: event.code, down: true });
        }}
        onKeyUp={event => { event.preventDefault(); event.stopPropagation(); input({ type: "key", code: event.code, down: false }); }}>
        <svg ref={cursor} className="lr-remote-touch-cursor" viewBox="0 0 24 28" aria-hidden="true" style={{ display: touch ? undefined : "none" }}>
          <path d="M2 2v21l6-6 5 9 4-2-5-9h9Z" />
        </svg>
      </div>}
      {active && keyboardOpen && <RemoteKeyboard input={input} touch={touchControls}
        mouseControl={!touchControls && "requestPointerLock" in HTMLElement.prototype && <span className="lr-remote-game-mouse"><Btn icon="gamepad"
          title={lockFailed ? "remote.lockFailed" : locked ? "remote.releaseMouse" : "remote.gameMouse"}
          cap={locked ? "remote.releaseMouse" : "remote.gameMouse"} pressed={locked}
          hint={locked ? "hint-remote-mouse-release" : "hint-remote-mouse-lock"}
          hintText={lockFailed ? "remote.lockFailed" : locked ? "remote.unlockMouse" : "remote.gameMouseHelp"}
          hintTone={lockFailed ? "warn" : undefined}
          onClick={() => void (async () => {
            if (locked) document.exitPointerLock();
            else try { await surface.current?.requestPointerLock(); setKeyboardOpen(false); } catch { setLockFailed(true); }
          })()} /></span>}
        close={closeKeyboard} />}
      {!active && !passwordOpen && <div className="lr-remote-input-status" role="status">
        <Glyph name={statusIcon} size={18} />
        <span className={vis ? "visually-hidden" : undefined}>{t(state.reason ? `remote.reason.${state.reason}` : state.state === "suspended" ? "remote.suspended" : state.state === "failed" ? "remote.failed"
          : state.mode === "ask" ? "remote.pending" : "remote.connecting")}</span>
      </div>}
    </>, parent)}
  </>;
}
