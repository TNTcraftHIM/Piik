import controls from "./window-controls.json";
import { windowAppearance } from "./window-appearance";
import "./native-window.css";

declare global {
  interface Window {
    piikNativeWindow?: "integrated" | "system";
    ipc?: { postMessage(message: string): void };
  }
}

// The Windows host supplies this capability. Content only describes appearance
// and the slot reserved for the separately trusted window controls.
if (window.piikNativeWindow) {
  const root = document.documentElement;
  root.dataset.piikNativeWindow = window.piikNativeWindow;
  root.style.setProperty("--native-caption-height", `${controls.height}px`);
}

if (window.piikNativeWindow && window.ipc) {
  const integrated = window.piikNativeWindow === "integrated";
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
    addEventListener("resize", schedule);
    addEventListener("scroll", schedule, { capture: true, passive: true });
    document.addEventListener("fullscreenchange", schedule);
    root.style.setProperty("--native-caption-width", `${controls.width}px`);
  }
  report();
}
