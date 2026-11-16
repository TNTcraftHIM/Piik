import { useEffect, useRef, useState, type RefObject } from "react";
import { PLAYER_CONTROLS_IDLE_MS } from "../../ui/control-timing";

export function usePlaybackControlsVisibility(
  videoRef: RefObject<HTMLVideoElement | null>,
  controlsRef: RefObject<HTMLDivElement | null>,
  keepVisible: boolean,
) {
  const [hidden, setHidden] = useState(false);
  const pointerType = useRef("");

  useEffect(() => {
    const video = videoRef.current;
    const screen = video?.parentElement;
    const controls = controlsRef.current;
    if (!video || !screen || !controls) return;
    const surface = screen.closest<HTMLElement>("[data-playback-controls-scope]") ?? screen;
    const controlAreas = [controls, ...surface.querySelectorAll<HTMLElement>("[data-playback-controls]")];
    const ownsControls = (target: EventTarget | null) => target instanceof Node && controlAreas.some(area => area.contains(target));
    const listeners = new AbortController();
    const options = { signal: listeners.signal };
    let timer: number | undefined;
    let lastMove: { x: number; y: number } | undefined;
    let pressed = false;
    let hoveringControls = pointerType.current !== "touch" && controlAreas.some(area => area.matches(":hover"));

    const clearIdle = () => {
      window.clearTimeout(timer);
      timer = undefined;
    };
    // Other surfaces in the TV (such as remote input) own their keyboard focus;
    // only interaction with playback itself should pin its controls open.
    const owns = (target: EventTarget | null) => target === video ||
      ownsControls(target);
    const held = () => keepVisible || pressed || hoveringControls ||
      (owns(document.activeElement) && document.activeElement?.matches(":focus-visible")) ||
      controlAreas.some(area => area.querySelector(":popover-open") !== null);
    const scheduleHide = () => {
      clearIdle();
      if (held()) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        if (!held()) setHidden(true);
      }, PLAYER_CONTROLS_IDLE_MS);
    };
    const show = () => {
      setHidden(false);
      scheduleHide();
    };
    const release = () => {
      if (!pressed) return;
      pressed = false;
      show();
    };

    surface.addEventListener("pointermove", (event) => {
      // Remote input owns picture motion; its bezel pull reveals the controls.
      if (event.pointerType === "touch" || screen.contains(document.pointerLockElement) ||
        (event.target instanceof Element && event.target.closest(".lr-remote-input-surface"))) return;
      // Cursor/style changes can emit stationary moves (Video.js #1068).
      if (lastMove?.x === event.screenX && lastMove.y === event.screenY) return;
      lastMove = { x: event.screenX, y: event.screenY };
      show();
    }, options);
    surface.addEventListener("pointerleave", () => { lastMove = undefined; }, options);
    surface.addEventListener("pointerdown", (event) => {
      pointerType.current = event.pointerType;
      if (event.pointerType === "touch") hoveringControls = false;
      if (ownsControls(event.target)) {
        pressed = true;
        show();
      }
    }, options);
    // Popovers remain descendants in the top layer; moving between the bar and
    // its controls must not briefly start an idle timeout.
    for (const area of controlAreas) area.addEventListener("pointerover", (event) => {
      if (event.pointerType !== "touch" && !ownsControls(event.relatedTarget)) {
        hoveringControls = true;
        show();
      }
    }, options);
    for (const area of controlAreas) area.addEventListener("pointerout", (event) => {
      if (event.pointerType !== "touch" && !ownsControls(event.relatedTarget)) {
        hoveringControls = false;
        scheduleHide();
      }
    }, options);
    surface.addEventListener("click", (event) => {
      // Only the picture itself is a local reveal target. Remote input and
      // other tools retain their clicks; the play button owns playback.
      if (event.target === video && pointerType.current === "touch" && !held()) {
        setHidden((current) => !current);
        scheduleHide();
      }
    }, options);
    surface.addEventListener("focusin", event => {
      // Picture touch owns its click toggle; only keyboard focus reveals it here.
      if (owns(event.target) && (event.target !== video || video.matches(":focus-visible"))) show(); else scheduleHide();
    }, options);
    surface.addEventListener("focusout", scheduleHide, options);
    surface.addEventListener("keydown", event => {
      if (owns(event.target)) show();
    }, options);
    // Popovers retain their DOM parent in the top layer. Their native toggle
    // event resumes idle hiding after a tooltip/long-press has finished.
    surface.addEventListener("toggle", show, { ...options, capture: true });
    document.addEventListener("pointerup", release, options);
    document.addEventListener("pointercancel", () => {
      pointerType.current = "";
      release();
    }, options);
    show();
    return () => {
      clearIdle();
      listeners.abort();
    };
  }, [videoRef, controlsRef, keepVisible]);

  return { hidden: keepVisible ? false : hidden };
}
