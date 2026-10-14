import { createContext, useContext } from "react";

// Geometry, focus and visibility follow the document displaying a surface.
// Its React tree and domain state continue to belong to the original page.
export const SurfaceDocument = createContext<Document | null>(null);
export const useSurfaceDocument = () => useContext(SurfaceDocument) ?? (typeof document === "undefined" ? null : document);

type PictureInPicture = { requestWindow(options: { width: number; height: number }): Promise<Window> };
export function panelWindowAPI(view: Window | null) {
  return view && view === view.top && view.isSecureContext
    ? (view as Window & { documentPictureInPicture?: PictureInPicture }).documentPictureInPicture
    : undefined;
}

/** Adopt one stable portal, then return it on close. No second React root/session. */
export async function openPanelWindow(container: HTMLElement, signal: AbortSignal, onDocument: (document: Document) => void) {
  const home = container.ownerDocument;
  const parent = container.parentElement;
  const api = panelWindowAPI(home.defaultView);
  if (!api || !parent || signal.aborted) return;
  const pip = await api.requestWindow({ width: 360, height: 480 });
  // Room retirement can beat the browser's permission/window creation work.
  if (signal.aborted || !container.isConnected) { pip.close(); return; }
  let returned = false;
  const observer = new MutationObserver(() => copyAttributes());
  const attributes = ["lang", "dir", "data-theme", "data-comic-reduced-motion"];
  function copyAttributes() {
    for (const name of attributes) {
      const value = home.documentElement.getAttribute(name);
      if (value === null) pip.document.documentElement.removeAttribute(name);
      else pip.document.documentElement.setAttribute(name, value);
    }
  }
  function restore() {
    if (returned) return;
    returned = true;
    observer.disconnect();
    pip.removeEventListener("pagehide", restore);
    signal.removeEventListener("abort", retire);
    parent!.append(container);
    if (!signal.aborted) onDocument(home);
  }
  function retire() { restore(); pip.close(); }
  pip.addEventListener("pagehide", restore);
  signal.addEventListener("abort", retire, { once: true });
  try {
    const base = pip.document.createElement("base");
    base.href = home.baseURI;
    pip.document.head.append(base);
    // Loaded same-origin rules avoid a second stylesheet fetch/unstyled frame.
    // Cross-origin sheets keep their original link when CSSOM access is denied.
    for (const sheet of home.styleSheets) {
      if (sheet.ownerNode && !home.head.contains(sheet.ownerNode)) continue;
      try {
        const style = pip.document.createElement("style");
        style.textContent = [...sheet.cssRules].map(rule => rule.cssText).join("\n");
        pip.document.head.append(style);
      } catch {
        if (sheet.ownerNode) pip.document.head.append(sheet.ownerNode.cloneNode(true));
      }
    }
    copyAttributes();
    observer.observe(home.documentElement, { attributes: true, attributeFilter: attributes });
    pip.document.body.className = "lr-panel-window";
    pip.document.body.append(container);
    onDocument(pip.document);
  } catch (error) {
    retire();
    throw error;
  }
}
