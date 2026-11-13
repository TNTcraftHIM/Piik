import controls from "./window-controls.json";
import "./native-window.css";

declare global {
  interface Window {
    piikNativeWindow?: boolean;
    ipc?: { postMessage(message: string): void };
  }
}

// The Windows host supplies this capability. Content only describes appearance
// and the slot reserved for the separately trusted window controls.
if (window.piikNativeWindow && window.ipc) {
  const ipc = window.ipc;
  const root = document.documentElement;
  root.dataset.piikNativeWindow = "";
  const headers = ".c3-site-bar,.lr-app > .lr-top,.c3-monitor.is-theater > .c3-monitor-heading";
  let observed: Element | undefined;
  let previousAppearance = "";
  let previousHeader = "";
  let scheduled = false;
  const resize = new ResizeObserver(schedule);

  function report(): void {
    scheduled = false;
    const appearance = JSON.stringify({ kind: "appearance",
      theme: root.dataset.theme === "dark" ? "dark" : "light",
      language: root.lang.startsWith("zh") ? "zh" : "en" });
    if (appearance !== previousAppearance) {
      ipc.postMessage(appearance);
      previousAppearance = appearance;
    }
    const header = [...document.querySelectorAll(headers)].find(element => {
      const rect = element.getBoundingClientRect();
      return rect.width >= controls.width && rect.height >= controls.height
        && rect.top >= 0 && rect.top + controls.height <= innerHeight
        && getComputedStyle(element).visibility === "visible";
    });
    if (header !== observed) {
      resize.disconnect();
      observed = header;
      if (header) resize.observe(header);
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
    attributes: true, attributeFilter: ["class", "hidden", "data-layout", "data-theme", "lang"] });
  addEventListener("resize", schedule);
  addEventListener("scroll", schedule, { capture: true, passive: true });
  document.addEventListener("fullscreenchange", schedule);
  root.style.setProperty("--native-caption-width", `${controls.width}px`);
  root.style.setProperty("--native-caption-height", `${controls.height}px`);
  report();
}
