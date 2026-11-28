import controls from "./window-controls.json";
import { windowAppearance } from "./window-appearance";
import { applyWindowTheme } from "./theme";
import { applyWindowCopy } from "./copy";
import { isLang } from "../locales";
import "./native-window.css";

declare global {
  interface Window {
    piikNativeWindow?: "integrated" | "system";
    ipc?: { postMessage(message: string): void };
  }
}

export const nativeBookmarkWindow = window.piikNativeWindow === "system"
  && location.pathname === "/client" && new URLSearchParams(location.search).has("bookmarks");

// The Windows host supplies these capabilities. Content requests bar gestures
// and describes appearance and the slot for the separately trusted caption controls.

/** What a press on a window's bar means: the first one moves the window, the second maximizes. */
export function barGesture(event: MouseEvent, bar: string, controls: string): "drag" | "maximize" | null {
  const target = event.target instanceof Element ? event.target : null;
  if (event.button !== 0 || event.detail > 2 || !target?.closest(bar) || target.closest(controls)) return null;
  return event.detail === 2 ? "maximize" : "drag";
}
if (window.piikNativeWindow) {
  const root = document.documentElement;
  root.dataset.piikNativeWindow = window.piikNativeWindow;
  root.style.setProperty("--native-caption-height", `${controls.height}px`);
}

if (window.piikNativeWindow && window.ipc) {
  const integrated = window.piikNativeWindow === "integrated";
  if (nativeBookmarkWindow) {
    window.addEventListener("piik-window-appearance", event => {
      const { detail } = event as CustomEvent<{ theme?: unknown; language?: unknown } | null>;
      if (detail?.theme === "light" || detail?.theme === "dark") applyWindowTheme(detail.theme);
      if (isLang(detail?.language)) applyWindowCopy(detail.language);
    });
  }
  const ipc = window.ipc;
  const root = document.documentElement;
  const headers = ".c3-site-bar,.lr-app > .lr-top,.c3-monitor.is-theater > .c3-monitor-heading";
  let observed: Element | undefined;
  let previousAppearance = "";
  let previousHeader = "";
  let scheduled = false;
  const resize = integrated ? new ResizeObserver(schedule) : null;

  function modalMaterial(): "surface" | "image" | null {
    const dialog = [...document.querySelectorAll("dialog:modal")].at(-1);
    const material = dialog?.getAttribute("data-modal-material");
    return material === "surface" || material === "image" ? material : null;
  }

  function report(): void {
    scheduled = false;
    const appearance = JSON.stringify(windowAppearance(root, modalMaterial()));
    if (appearance !== previousAppearance) {
      ipc.postMessage(appearance);
      previousAppearance = appearance;
    }
    if (!integrated) return;
    const header = [...document.querySelectorAll(headers)].find(element => {
      const rect = element.getBoundingClientRect();
      return rect.width >= controls.width && rect.height >= controls.height
        && rect.top >= 0 && rect.top + controls.height <= innerHeight
        && getComputedStyle(element).visibility === "visible";
    });
    if (header !== observed) {
      resize?.disconnect();
      observed = header;
      if (header) resize?.observe(header);
    }
    const rect = header?.getBoundingClientRect();
    const message = JSON.stringify({ kind: "header", slot: rect && !document.fullscreenElement
      ? [rect.right - controls.width, rect.top] : null });
    if (message !== previousHeader) {
      ipc.postMessage(message);
      previousHeader = message;
    }
  }

  function schedule(): void {
    if (!scheduled) { scheduled = true; requestAnimationFrame(report); }
  }

  new MutationObserver(schedule).observe(root, { subtree: true, childList: true,
    attributes: true, attributeFilter: integrated
      ? ["class", "hidden", "data-layout", "data-theme", "lang", "open", "data-modal-material"]
      : ["data-theme", "lang", "open", "data-modal-material"] });
  if (integrated) {
    // The host moves the window. WebView2 recomputes a CSS drag region on the App's window
    // thread after each layout change and answers each pointer move over it there, which stalls
    // every window of the App; so the bar is ordinary content that asks on a press.
    const barControls = "button,a,input,select,textarea,[role=button],[popover],dialog,.lr-comic-tip-wrap.is-disabled-trigger";
    addEventListener("mousedown", event => {
      const gesture = document.fullscreenElement ? null : barGesture(event, headers, barControls);
      if (!gesture) return;
      // The system's move loop takes the release, so the page must not start a gesture of its own.
      event.preventDefault();
      ipc.postMessage(JSON.stringify({ kind: gesture }));
    });
    addEventListener("resize", schedule);
    addEventListener("scroll", schedule, { capture: true, passive: true });
    document.addEventListener("fullscreenchange", schedule);
    root.style.setProperty("--native-caption-width", `${controls.width}px`);
  }
  report();
}
