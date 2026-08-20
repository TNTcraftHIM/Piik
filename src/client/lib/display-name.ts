import {
  DEFAULT_VIEWER_DISPLAY_NAME,
  normalizeDisplayName,
  type DisplayName,
} from "../../shared/protocol";

const DISPLAY_NAME_STORAGE_KEY = "screener:display-name:v1";

export function readDisplayName(): DisplayName {
  try {
    const stored = window.localStorage.getItem(DISPLAY_NAME_STORAGE_KEY);
    if (!stored) {
      return DEFAULT_VIEWER_DISPLAY_NAME;
    }
    const normalized = normalizeDisplayName(stored);
    if (normalized === stored) {
      return normalized;
    }
    window.localStorage.removeItem(DISPLAY_NAME_STORAGE_KEY);
  } catch {
    // Restricted storage must not block joining a room.
  }
  return DEFAULT_VIEWER_DISPLAY_NAME;
}

export function saveDisplayName(value: string): DisplayName | null {
  const normalized = normalizeDisplayName(value);
  const useFallback = value.length === 0 || /^\p{Zs}+$/u.test(value);
  if (!normalized && !useFallback) {
    return null;
  }
  const displayName = normalized ?? DEFAULT_VIEWER_DISPLAY_NAME;
  try {
    if (useFallback) {
      window.localStorage.removeItem(DISPLAY_NAME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(DISPLAY_NAME_STORAGE_KEY, displayName);
    }
  } catch {
    // The current signaling session can still use the in-memory value.
  }
  return displayName;
}
