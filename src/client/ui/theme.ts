// Light/dark theme with system default, persistence, and no-flash startup.
// index.html applies the stored/system theme before first paint; this module
// owns runtime toggles.
import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "screener:ui-theme";

function detectTheme(): Theme {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function readInitial(): Theme {
  const attr = document.documentElement.dataset.theme;
  if (attr === "dark" || attr === "light") {
    return attr;
  }
  return detectTheme();
}

const state: { theme: Theme } = { theme: "light" };
const listeners = new Set<() => void>();

export function applyTheme(theme: Theme): void {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Restricted storage only disables persistence.
  }
  listeners.forEach((listener) => listener());
}

export function initTheme(): void {
  state.theme = readInitial();
  document.documentElement.dataset.theme = state.theme;
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const theme = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state.theme,
  );
  return {
    theme,
    toggle: () => applyTheme(theme === "dark" ? "light" : "dark"),
  };
}
