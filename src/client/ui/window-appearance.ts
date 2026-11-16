import { resolveLang } from "../locales";

/** Bounds belong to the displaying document, including its Native overlay caption. */
export function surfaceViewport(document: Document) {
  const view = document.defaultView!;
  const viewport = view.visualViewport;
  const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? view.innerWidth, height = viewport?.height ?? view.innerHeight;
  const root = document.documentElement;
  const caption = root.dataset.piikNativeWindow === "integrated" && !document.fullscreenElement
    ? parseFloat(view.getComputedStyle(root).getPropertyValue("--native-caption-height")) || 0 : 0;
  const inset = Math.min(height, Math.max(0, caption - top));
  return { left, top: top + inset, width, height: height - inset, right: left + width, bottom: top + height };
}

/** The displaying document owns its resolved appearance; Native only consumes it. */
export function windowAppearance(root: HTMLElement, material: "surface" | "image" | null = null) {
  return { kind: "appearance", theme: root.dataset.theme === "dark" ? "dark" : "light",
    language: resolveLang(root.lang), material };
}
