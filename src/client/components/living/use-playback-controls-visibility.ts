import { useEffect, useRef, useState, type RefObject } from "react";

// Matches Media Chrome's default: hide playing-video controls after 2s idle.
const CONTROLS_IDLE_MS = 2000;

export function usePlaybackControlsVisibility(
  videoRef: RefObject<HTMLVideoElement | null>,
  controlsRef: RefObject<HTMLDivElement | null>,
  keepVisible: boolean,
): boolean {
  const [hidden, setHidden] = useState(false);
  const pointerType = useRef("");

  useEffect(() => {
    const video = videoRef.current;
    const screen = video?.parentElement;
    const controls = controlsRef.current;
    if (!video || !screen || !controls) return;
    const listeners = new AbortController();
    const options = { signal: listeners.signal };
    let timer: number | undefined;
    let lastMove: { x: number; y: number } | undefined;
    let pressed = false;
    let hoveringControls = pointerType.current !== "touch" && controls.matches(":hover");

    const clearIdle = () => {
      window.clearTimeout(timer);
      timer = undefined;
    };
    const held = () => keepVisible || pressed || hoveringControls ||
      (screen.contains(document.activeElement) && document.activeElement?.matches(":focus-visible")) ||
      controls.querySelector(":popover-open") !== null;
    const scheduleHide = () => {
      clearIdle();
      if (held()) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        if (!held()) setHidden(true);
      }, CONTROLS_IDLE_MS);
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

    screen.addEventListener("pointermove", (event) => {
      if (event.pointerType === "touch") return;
      // Cursor/style changes can emit stationary moves (Video.js #1068).
      if (lastMove?.x === event.screenX && lastMove.y === event.screenY) return;
      lastMove = { x: event.screenX, y: event.screenY };
      show();
    }, options);
    screen.addEventListener("pointerdown", (event) => {
      pointerType.current = event.pointerType;
      if (event.pointerType === "touch") hoveringControls = false;
      if (controls.contains(event.target as Node)) {
        pressed = true;
        show();
      }
    }, options);
    controls.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "touch") {
        hoveringControls = true;
        show();
      }
    }, options);
    controls.addEventListener("pointerleave", (event) => {
      if (event.pointerType !== "touch") {
        hoveringControls = false;
        scheduleHide();
      }
    }, options);
    screen.addEventListener("click", (event) => {
      // Native click excludes scrolling/cancelled gestures. A video tap only
      // reveals/hides controls; playback remains owned by the play button.
      if (event.target === video && pointerType.current === "touch" && !held()) {
        setHidden((current) => !current);
        scheduleHide();
      }
    }, options);
    screen.addEventListener("focusin", show, options);
    screen.addEventListener("focusout", scheduleHide, options);
    screen.addEventListener("keydown", show, options);
    // Popovers retain their DOM parent in the top layer. Their native toggle
    // event resumes idle hiding after a tooltip/long-press has finished.
    controls.addEventListener("toggle", show, { ...options, capture: true });
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

  return keepVisible ? false : hidden;
}
