import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useCopy, type CopyKey } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import type { InputTransport } from "../../remote-control/input-route";
import { RemoteInputSession, type RemoteInputState, type RemoteInputEvent } from "../../remote-control/input-session";
import { RemoteTouchpad } from "../../remote-control/touchpad";
import { RemoteViewport } from "../../remote-control/viewport";
import { matchesRemoteShortcut } from "../../remote-control/protocol";
import { readRoomPreferences, saveRoomPreferences } from "../../lib/room-preferences";
import { RemoteKeyboard } from "./RemoteKeyboard";
import { Btn } from "./primitives";
import { videoFullscreenState, type FullscreenVideo } from "./video-fullscreen";
import { picturePoint, pictureRect, rotatePicturePoint, rotatePictureDelta, videoRotation, type VideoFit, type VideoRotation } from "../../media/video-geometry";
import "./remote-control.css";

// The video keeps its existing media owner. This temporary surface handles
// input only while its current routed endpoint holds a local App grant.
export function RemoteControl({ channel, videoRef, available, pictureFit, pictureRotation = 0 }: {
  channel: InputTransport | null; videoRef: RefObject<HTMLVideoElement | null>;
  available: boolean;
  pictureFit?: VideoFit;
  pictureRotation?: VideoRotation;
}) {
  const { t, vis } = useCopy();
  const [state, setState] = useState<RemoteInputState | null>(null);
  const [locked, setLocked] = useState(false);
  const [lockFailed, setLockFailed] = useState(false);
  const [presentation, setPresentation] = useState<"playing" | "paused" | "external">("paused");
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [keyboardDocument, setKeyboardDocument] = useState<Document | null>(null);
  const keyboardDetached = Boolean(keyboardDocument && keyboardDocument !== document);
  const [touch, setTouch] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [releaseKey, setReleaseKey] = useState(() => readRoomPreferences().remoteReleaseKey);
  const session = useRef<RemoteInputSession | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  const cursor = useRef<SVGSVGElement | null>(null);
  const touchpad = useRef<RemoteTouchpad | null>(null);
  const viewport = useRef<RemoteViewport | null>(null);
  const canControl = available && presentation === "playing";
  const active = state?.state === "active" && canControl && channel?.readyState === "open";
  const controlled = (state?.state === "active" || state?.state === "suspended") && canControl && channel?.readyState === "open";
  const input = useCallback((event: RemoteInputEvent) => session.current?.input(event), []);
  const reset = useCallback(() => { touchpad.current?.reset(); session.current?.input({ type: "reset" }); }, []);
  const closeKeyboard = () => {
    reset(); setKeyboardOpen(false); setKeyboardDocument(null); surface.current?.focus({ preventScroll: true });
  };
  const keyboardSurfaceChanged = useCallback((owner: Document) => {
    reset(); setKeyboardDocument(owner);
  }, [reset]);
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
    if (controlled || state?.mode !== "password" || !canControl) {
      setPasswordOpen(false); setPassword("");
    }
  }, [controlled, state?.mode, canControl]);
  useEffect(() => {
    if (!available) release();
  }, [available, channel, release]);
  useEffect(() => {
    if (!active) { touchpad.current?.reset(); setKeyboardOpen(false); setKeyboardDocument(null); }
  }, [active]);
  useEffect(() => {
    const video = videoRef.current;
    const element = surface.current;
    if (!controlled || !video || !element) { setTouch(false); return; }
    const updateCursor = () => {
      const picture = pictureRect(video);
      const rect = surface.current?.getBoundingClientRect();
      if (!picture || !rect || !cursor.current) return;
      const position = rotatePicturePoint(current.position, videoRotation(video));
      cursor.current.style.left = `${picture.left - rect.left + position.x * picture.width}px`;
      cursor.current.style.top = `${picture.top - rect.top + position.y * picture.height}px`;
    };
    const view = new RemoteViewport(video, element, zoomed => {
      setZoomed(zoomed);
      current.position = view.visiblePosition(current.position);
      updateCursor();
    });
    viewport.current = view;
    const current = new RemoteTouchpad(
      () => {
        const picture = pictureRect(video);
        return picture && { ...picture, rotation: videoRotation(video) };
      },
      event => session.current?.input(event),
      delta => session.current?.scroll(delta, 0),
      updateCursor,
      view,
    );
    touchpad.current = current;
    // Layout changes and decoded aspect-ratio changes share the input geometry.
    const refresh = () => view.refresh();
    const observer = new ResizeObserver(refresh);
    observer.observe(video);
    video.addEventListener("resize", refresh);
    return () => {
      observer.disconnect(); video.removeEventListener("resize", refresh);
      current.reset(); view.reset(); touchpad.current = null; viewport.current = null;
    };
  }, [controlled, channel, videoRef]);
  useEffect(() => { viewport.current?.refresh(); }, [pictureFit]);
  useEffect(() => {
    reset(); viewport.current?.reset(); viewport.current?.refresh();
  }, [pictureRotation, reset]);
  useEffect(() => {
    const video = videoRef.current as FullscreenVideo | null;
    if (!video) return;
    // Native PiP/fullscreen moves the picture away from the page's input surface.
    // DOM fullscreen retains that surface and can continue controlling normally.
    const syncPresentation = () => {
      const external = document.pictureInPictureElement === video ||
        video.webkitPresentationMode === "picture-in-picture" || videoFullscreenState(video).nativeActive;
      const current = external ? "external" : video.paused || video.ended ? "paused" : "playing";
      // Invalidate the request as well as its grant before a late approval arrives.
      if (current !== "playing") release();
      setPresentation(current);
    };
    const events = ["play", "pause", "ended", "emptied", "enterpictureinpicture", "leavepictureinpicture", "webkitpresentationmodechanged", "webkitbeginfullscreen", "webkitendfullscreen"];
    syncPresentation();
    events.forEach(event => video.addEventListener(event, syncPresentation));
    return () => {
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
    const lockChanged = () => {
      reset(); setLocked(document.pointerLockElement === element);
      if (document.pointerLockElement === element) { setLockFailed(false); element?.focus({ preventScroll: true }); }
    };
    window.addEventListener("blur", reset);
    document.addEventListener("pointerlockchange", lockChanged);
    return () => {
      element?.removeEventListener("wheel", wheel);
      window.removeEventListener("mouseup", mouseUp, true);
      window.removeEventListener("blur", reset);
      document.removeEventListener("pointerlockchange", lockChanged);
      if (document.pointerLockElement === element) document.exitPointerLock();
      setLocked(false); setLockFailed(false);
    };
  }, [controlled, channel, release, reset]);
  useEffect(() => {
    if (!controlled) return;
    const owners = [...new Set([document, ...(keyboardDocument ? [keyboardDocument] : [])])];
    const hidden = () => {
      reset();
      // A visible detached keyboard is still an attended input surface.
      if (owners.every(owner => owner.hidden || owner.defaultView?.closed)) release();
    };
    owners.forEach(owner => owner.addEventListener("visibilitychange", hidden));
    hidden();
    return () => owners.forEach(owner => owner.removeEventListener("visibilitychange", hidden));
  }, [controlled, keyboardDocument, release, reset]);
  useEffect(() => {
    if (!controlled) return;
    const owners = [...new Set([document, ...(keyboardDocument ? [keyboardDocument] : [])])];
    const stop = (event: KeyboardEvent) => {
      if (!matchesRemoteShortcut(event, releaseKey)) return;
      event.preventDefault(); event.stopImmediatePropagation(); release();
    };
    owners.forEach(owner => owner.addEventListener("keydown", stop, true));
    return () => owners.forEach(owner => owner.removeEventListener("keydown", stop, true));
  }, [controlled, keyboardDocument, release, releaseKey]);

  if (!channel || channel.readyState !== "open" || !state || state.mode === "off") return null;
  const point = (clientX: number, clientY: number) => {
    const video = videoRef.current;
    return video ? picturePoint(video, clientX, clientY) : null;
  };
  const buttonTitle = controlled ? "remote.stop" : state.state === "pending" ? "remote.cancel" : "remote.request";
  const touchControls = touch || matchMedia("(pointer: coarse)").matches;
  const statusIcon = state.reason === "busy" ? "users" : state.reason === "password" || state.state === "failed" ? "alert"
    : state.state === "suspended" ? "pause" : "clock";
  const feedback: CopyKey | undefined = state.reason ? `remote.reason.${state.reason}`
    : state.state === "suspended" ? "remote.suspended" : state.state === "failed" ? "remote.failed"
    : state.state === "pending" ? state.mode === "ask" ? "remote.pending" : "remote.connecting" : undefined;
  const parent = videoRef.current?.parentElement;
  return <>
    <span className="lr-remote-controls" role="group" aria-label={t("remote.title")}>
      <span className="lr-remote-viewer-control">
        <Btn icon="mouse" title={presentation === "external" ? "remote.inlineRequired" : presentation === "paused" ? "remote.playbackRequired" : state.state === "unavailable" ? "remote.unavailable" : buttonTitle}
          hint={controlled || state.state === "pending" ? "hint-remote-stop" : "hint-remote-control"}
          hintText={feedback} hintTone={state.state === "failed" ? "warn" : undefined}
          busy={state.state === "pending"} pressed={controlled} disabled={!canControl || state.state === "unavailable"}
          onClick={() => {
            if (controlled || state.state === "pending") release();
            else if (state.mode === "password") setPasswordOpen(open => !open);
            else session.current?.request();
          }} />
        {feedback && !passwordOpen && <span className="lr-remote-feedback" role="status">
          <Glyph name={statusIcon} size={15} />
          <span className={vis ? "visually-hidden" : undefined}>{t(feedback)}</span>
        </span>}
      </span>
      <Btn icon="keyboard" title={keyboardDetached ? "floating.focus" : "remote.keyboard"} hint={keyboardDetached ? "hint-window-detach" : "hint-remote-keyboard"}
        hintText={!active ? feedback ?? "remote.keyboardRequiresControl" : touchControls ? "remote.touchHelp" : undefined} expanded={keyboardOpen} disabled={!active}
        onClick={() => {
          if (keyboardDetached) keyboardDocument?.defaultView?.focus();
          else if (keyboardOpen) closeKeyboard();
          else { reset(); setKeyboardOpen(true); }
        }} />
    </span>
    {parent && (controlled || state.state === "pending" || state.state === "failed" || state.reason || passwordOpen) && createPortal(<>
      {passwordOpen && <form className="lr-remote-password" onSubmit={event => {
        event.preventDefault(); session.current?.request(password); setPassword("");
      }} onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing) {
          event.preventDefault(); setPasswordOpen(false); setPassword(""); release();
        }
      }}>
        <div className="lr-remote-panel-header">
          <strong><Glyph name="key" size={18} />{vis ? null : t("remote.password")}</strong>
          <button type="button" className="lr-btn is-dense is-quiet lr-popover-close" aria-label={t("common.cancel")}
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
          <Btn icon="check" title="remote.request" size="compact" hint="hint-remote-control" type="submit" disabled={!password || state.state === "pending"} />
        </div>
        {state.reason && <p role="status" className={state.reason === "password" ? "is-bad" : undefined}><Glyph name={statusIcon} size={16} />
          <span className={vis ? "visually-hidden" : undefined}>{t(`remote.reason.${state.reason}`)}</span></p>}
      </form>}
      {controlled && <div ref={surface} className={`lr-remote-input-surface${active ? "" : " is-suspended"}${locked ? " is-locked" : ""}`} tabIndex={0}
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
            const delta = rotatePictureDelta({ x: event.movementX, y: event.movementY }, pictureRotation, true);
            input({ type: "relative", dx: delta.x, dy: delta.y });
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
          if (!event.nativeEvent.isComposing) input({ type: "key", code: event.code, down: true });
        }}
        onKeyUp={event => { event.preventDefault(); event.stopPropagation(); input({ type: "key", code: event.code, down: false }); }}>
        <svg ref={cursor} className="lr-remote-touch-cursor" viewBox="0 0 24 28" aria-hidden="true" style={{ display: touch ? undefined : "none" }}>
          <path d="M2 2v21l6-6 5 9 4-2-5-9h9Z" />
        </svg>
      </div>}
      {controlled && zoomed && <div className="lr-remote-zoom">
        <button type="button" className="lr-chip" aria-label={t("remote.resetZoom")}
          onClick={() => { reset(); viewport.current?.reset(); surface.current?.focus({ preventScroll: true }); }}>1×</button>
      </div>}
      {active && keyboardOpen && <RemoteKeyboard input={input} touch={touchControls} platform={state.platform}
        releaseKey={releaseKey} onReleaseKeyChange={key => { setReleaseKey(key); saveRoomPreferences({ remoteReleaseKey: key }); }}
        onSurfaceChange={keyboardSurfaceChanged}
        mouseControl={!touchControls && "requestPointerLock" in HTMLElement.prototype && <span className="lr-remote-game-mouse"><Btn icon="gamepad" size="compact"
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
    </>, parent)}
  </>;
}
