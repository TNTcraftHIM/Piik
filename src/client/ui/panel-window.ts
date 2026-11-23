import { createContext, useContext, useLayoutEffect, useRef, useState } from "react";
import { windowAppearance } from "./window-appearance";

// Geometry, focus and visibility follow the document displaying a surface.
// Its React tree and domain state continue to belong to the original page.
export const SurfaceDocument = createContext<Document | null>(null);
export const useSurfaceDocument = () => useContext(SurfaceDocument) ?? (typeof document === "undefined" ? null : document);

type PictureInPicture = EventTarget & { readonly window: Window | null;
  requestWindow(options: { width: number; height: number; preferInitialWindowPlacement: boolean }): Promise<Window> };
export const PANEL_SIZE = { width: 420, height: 560 };
type PanelSize = { width: number; height: number };
export function panelWindowAPI(view: Window | null) {
  return view && view === view.top && view.isSecureContext
    ? (view as Window & { documentPictureInPicture?: PictureInPicture }).documentPictureInPicture
    : undefined;
}

/** One portal target survives adoption; the containing room owns its retirement. */
export function usePanelWindow(enabled: boolean, onDocument?: (owner: Document) => void, onNativeReady?: (owner: Document) => void) {
  const [container] = useState(() => {
    if (!enabled || typeof document === "undefined") return null;
    const node = document.createElement("div");
    node.style.display = "contents";
    return node;
  });
  const slot = useRef<HTMLSpanElement>(null);
  const lifetime = useRef<AbortController | null>(null);
  const callbacks = useRef({ onDocument, onNativeReady });
  useLayoutEffect(() => { callbacks.current = { onDocument, onNativeReady }; }, [onDocument, onNativeReady]);
  const [surfaceDocument, setSurfaceDocument] = useState<Document | null>(null);
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  useLayoutEffect(() => {
    if (!container || !slot.current) return;
    slot.current.append(container);
    return () => { lifetime.current?.abort(); container.remove(); };
  }, [container]);
  async function open(size?: PanelSize) {
    if (!container || opening) return;
    const controller = new AbortController();
    lifetime.current = controller;
    setOpening(true); setFailed(false);
    try {
      await openPanelWindow(container, controller.signal, owner => {
        setSurfaceDocument(owner); callbacks.current.onDocument?.(owner);
      }, size, owner => callbacks.current.onNativeReady?.(owner));
    } catch { if (!controller.signal.aborted) setFailed(true); }
    finally { if (!controller.signal.aborted) setOpening(false); }
  }
  function close() {
    lifetime.current?.abort();
    setSurfaceDocument(null);
    if (surfaceDocument) callbacks.current.onDocument?.(container?.ownerDocument ?? document);
    setOpening(false); setFailed(false);
  }
  return { container, slot, surfaceDocument, opening, failed, open, close,
    detached: Boolean(surfaceDocument && surfaceDocument !== document) };
}

/** Adopt one stable portal, then return it on close. No second React root/session. */
export async function openPanelWindow(container: HTMLElement, signal: AbortSignal, onDocument: (document: Document) => void, size?: PanelSize,
  onNativeReady?: (owner: Document) => void) {
  const home = container.ownerDocument;
  const parent = container.parentElement;
  const api = panelWindowAPI(home.defaultView);
  if (!api || !parent || signal.aborted) return;
  // The portal wrapper uses display: contents; its child owns visible geometry.
  const { width, height } = size ?? container.firstElementChild!.getBoundingClientRect();
  const nativeOwner = home.defaultView?.piikNativeWindow === "integrated" ? home.defaultView : null;
  let pip: Window;
  let readySource: MessageEventSource | null = null;
  let declared = false;
  let returned = false;
  function declareNative() {
    if (!pip || returned || signal.aborted || declared || !nativeOwner || readySource !== pip) return;
    pip.postMessage({ type: "piik-native-window-presentation", message: { kind: "panel", width: Math.round(width), height: Math.round(height) } }, "*");
    declared = true;
    pip.postMessage({ type: "piik-native-window-presentation", message: windowAppearance(home.documentElement) }, "*");
    onNativeReady?.(pip.document);
  }
  function nativeReady(event: MessageEvent) {
    if (event.data !== "piik-native-window-ready") return;
    if (pip && event.source !== pip) return;
    readySource = event.source;
    declareNative();
  }
  // SetNewWindow can finish host injection after the PiP Promise resolves.
  // The opener survives target replacement; subscribe before requesting it.
  nativeOwner?.addEventListener("message", nativeReady);
  try {
    pip = await api.requestWindow({
      width: Math.round(width),
      height: Math.round(height),
      preferInitialWindowPlacement: true,
    });
  } catch (error) {
    nativeOwner?.removeEventListener("message", nativeReady);
    throw error;
  }
  // Room retirement can beat the browser's permission/window creation work.
  if (signal.aborted || !container.isConnected) {
    nativeOwner?.removeEventListener("message", nativeReady);
    pip.close(); return;
  }
  declareNative();
  const observer = new MutationObserver(() => copyAttributes());
  const attributes = ["lang", "dir", "data-theme", "data-reduced-motion", "data-comic-reduced-motion"];
  function copyAttributes() {
    for (const name of attributes) {
      const value = home.documentElement.getAttribute(name);
      if (value === null) pip.document.documentElement.removeAttribute(name);
      else pip.document.documentElement.setAttribute(name, value);
    }
    if (declared) pip.postMessage({ type: "piik-native-window-presentation", message: windowAppearance(home.documentElement) }, "*");
  }
  function restore() {
    if (returned) return;
    returned = true;
    observer.disconnect();
    nativeOwner?.removeEventListener("message", nativeReady);
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
