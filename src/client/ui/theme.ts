// Light/dark theme with system default, persistence, and no-flash startup.
// index.html applies the stored/system theme before first paint. Until the user
// chooses explicitly, this module continues following system changes.
import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "piik:ui-theme";
const DARK_THEME_QUERY = "(prefers-color-scheme: dark)";

function detectTheme(): Theme {
  return typeof window !== "undefined" &&
    window.matchMedia?.(DARK_THEME_QUERY).matches
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

function storedTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

const state: { theme: Theme; explicit: boolean; initialized: boolean } = {
  theme: "light",
  explicit: false,
  initialized: false,
};
const listeners = new Set<() => void>();

function commitTheme(theme: Theme): void {
  if (state.theme === theme) return;
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  listeners.forEach((listener) => listener());
}

export function applyTheme(theme: Theme): void {
  state.explicit = true;
  commitTheme(theme);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Restricted storage only disables persistence.
  }
}

export function currentThemePreference(): Theme | null {
  return state.explicit ? state.theme : null;
}

export function initTheme(preference?: Theme | null): void {
  if (preference !== undefined) {
    try {
      if (preference === null) window.localStorage.removeItem(THEME_STORAGE_KEY);
      else window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // The launch choice still applies when persistence is unavailable.
    }
  }
  const stored = preference === undefined ? storedTheme() : preference;
  state.explicit = stored !== null;
  state.theme = stored ?? (preference === null ? detectTheme() : readInitial());
  document.documentElement.dataset.theme = state.theme;
  if (!state.initialized && typeof window.matchMedia === "function") {
    state.initialized = true;
    window.matchMedia(DARK_THEME_QUERY).addEventListener("change", (event) => {
      if (!state.explicit) commitTheme(event.matches ? "dark" : "light");
    });
  }
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
