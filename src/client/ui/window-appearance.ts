import { resolveLang } from "../locales";

/** The displaying document owns its resolved appearance; Native only consumes it. */
export function windowAppearance(root: HTMLElement, material: "surface" | "image" | null = null) {
  return { kind: "appearance", theme: root.dataset.theme === "dark" ? "dark" : "light",
    language: resolveLang(root.lang), material };
}
