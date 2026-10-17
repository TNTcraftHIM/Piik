import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import type { RemoteControlRequest } from "../../native/wire";
import type { InputTransport } from "../../remote-control/input-route";
import { RemoteInputSession, picturePoint, type RemoteInputState, type RemoteInputEvent } from "../../remote-control/input-session";
import { Btn } from "./primitives";
import { videoFullscreenState, type FullscreenVideo } from "./video-fullscreen";
import "./remote-control.css";

// The video keeps its existing media owner. This temporary surface handles
// input only while its current routed endpoint holds a local App grant.
export function RemoteControl({ channel, videoRef, available }: {
  channel: InputTransport | null; videoRef: RefObject<HTMLVideoElement | null>;
  available: boolean;
}) {
  const { t } = useCopy();
  const [state, setState] = useState<RemoteInputState | null>(null);
  const [locked, setLocked] = useState(false);
  const [lockFailed, setLockFailed] = useState(false);
  const [inline, setInline] = useState(true);
  const session = useRef<RemoteInputSession | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  const active = state?.state === "active" && available && inline && channel?.readyState === "open";
  const controlled = (state?.state === "active" || state?.state === "suspended") && available && inline && channel?.readyState === "open";
  const input = (event: RemoteInputEvent) => session.current?.input(event);
  const reset = useCallback(() => { session.current?.input({ type: "reset" }); }, []);
  const release = useCallback(() => {
    reset();
    if (document.pointerLockElement === surface.current && surface.current) document.exitPointerLock();
    session.current?.release();
  }, [reset]);

  useEffect(() => {
    setState(null);
    if (!channel) return;
    const current = new RemoteInputSession(channel, setState);
    session.current = current;
    return () => {
      current.dispose(); session.current = null;
    };
  }, [channel]);
  useEffect(() => {
    if (!available || !inline) release();
  }, [available, inline, channel, release]);
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

  if (!channel || channel.readyState !== "open" || !state) return null;
  const point = (clientX: number, clientY: number) => {
    const video = videoRef.current;
    return video ? picturePoint(video, clientX, clientY) : null;
  };
  const buttonTitle = controlled ? "remote.stop" : state.state === "pending" ? "remote.cancel" : "remote.request";
  const parent = videoRef.current?.parentElement;
  return <>
    <Btn icon="mouse" title={!inline ? "remote.inlineRequired" : state.state === "unavailable" ? "remote.unavailable" : buttonTitle}
      hint={controlled || state.state === "pending" ? "hint-remote-stop" : "hint-remote-control"}
      pressed={controlled} disabled={!available || !inline || state.state === "unavailable"}
      onClick={() => controlled || state.state === "pending" ? release() : session.current?.request()} />
    {controlled && "requestPointerLock" in HTMLElement.prototype && <Btn icon="gamepad"
      title={lockFailed ? "remote.lockFailed" : locked ? "remote.releaseMouse" : "remote.gameMouse"} pressed={locked}
      hint={locked ? "hint-remote-mouse-release" : "hint-remote-mouse-lock"}
      hintText={lockFailed ? "remote.lockFailed" : locked ? "remote.unlockMouse" : "remote.gameMouseHelp"}
      hintTone={lockFailed ? "warn" : undefined}
      onClick={() => void (async () => {
        if (locked) document.exitPointerLock();
        else try { await surface.current?.requestPointerLock(); } catch { setLockFailed(true); }
      })()} />}
    {parent && (controlled || state.state === "pending" || state.state === "failed") && createPortal(<>
      {controlled && <div ref={surface} className={`lr-remote-input-surface${active ? "" : " is-suspended"}`} tabIndex={0}
        aria-label={t("remote.surface")} role="application"
        onContextMenu={event => event.preventDefault()}
        onAuxClick={event => event.preventDefault()}
        onPointerMove={event => {
          if (document.pointerLockElement === surface.current) {
            input({ type: "relative", dx: event.movementX, dy: event.movementY });
          } else {
            const position = point(event.clientX, event.clientY);
            if (position) input({ type: "move", ...position });
          }
        }}
        onPointerDown={event => {
          if (document.pointerLockElement !== surface.current) event.currentTarget.setPointerCapture(event.pointerId);
        }}
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
        onBlur={reset}
        onKeyDown={event => {
          event.preventDefault(); event.stopPropagation();
          if (event.code === "F10" && event.ctrlKey && event.altKey) { release(); return; }
          if (!event.nativeEvent.isComposing) input({ type: "key", code: event.code, down: true });
        }}
        onKeyUp={event => { event.preventDefault(); event.stopPropagation(); input({ type: "key", code: event.code, down: false }); }} />}
      {!active && <div className="lr-remote-input-status" role="status">
        {t(state.state === "suspended" ? "remote.suspended" : state.state === "failed" ? "remote.failed" : "remote.pending")}
      </div>}
    </>, parent)}
  </>;
}

export function RemoteControlApproval({ requests, onDecide }: {
  requests: (RemoteControlRequest & { name: string })[];
  onDecide: (id: string, allow: boolean) => Promise<void>;
}) {
  const { t } = useCopy();
  const [failedId, setFailedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const decide = async (id: string, allow: boolean) => {
    setBusy(true);
    setFailedId(null);
    try {
      await onDecide(id, allow);
    } catch { setFailedId(id); }
    finally { setBusy(false); }
  };
  return <section className="lr-remote-approval" aria-label={t("remote.title")}>
    <h2><Glyph name="mouse" size={18} />{t("remote.title")}</h2>
    {requests.map(request => <div className="lr-remote-request" key={request.id} role="group" aria-label={request.name}>
      <div><strong>{request.name}</strong>
        <p>{t(request.state === "suspended" ? "remote.hostFocus" : request.state === "active" ? "remote.approved" : "remote.waiting")}</p>
        {failedId === request.id && <p role="alert">{t("remote.decisionFailed")}</p>}</div>
      <div className="lr-remote-request-actions">
        <Btn icon="x" title={request.state !== "pending" ? "remote.stop" : "remote.decline"} cap={request.state !== "pending" ? "remote.stop" : "remote.decline"}
          hint="hint-remote-stop" disabled={busy} onClick={() => void decide(request.id, false)} />
        {request.state === "pending" && <Btn icon="check" tone="primary" title="remote.allow" cap="remote.allow" hint="hint-remote-control" disabled={busy} onClick={() => void decide(request.id, true)} />}
      </div>
    </div>)}
    {requests.some(request => request.state === "pending") && <p className="lr-remote-note">{t("remote.consent")}</p>}
    {requests.some(request => request.state !== "pending") && <p className="lr-remote-note">{t("remote.shortcut")} <kbd>Ctrl + Alt + F10</kbd></p>}
  </section>;
}
