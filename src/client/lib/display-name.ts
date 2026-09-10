import {
  normalizeDisplayName,
  type DisplayName,
} from "../../shared/protocol";
import { say } from "../ui/copy";

const DISPLAY_NAME_STORAGE_KEY = "piik:display-name:v1";

export function readStoredDisplayName(): DisplayName | null {
  try {
    const stored = window.localStorage.getItem(DISPLAY_NAME_STORAGE_KEY);
    if (!stored) {
      return null;
    }
    const normalized = normalizeDisplayName(stored);
    if (normalized === stored) {
      return normalized;
    }
    window.localStorage.removeItem(DISPLAY_NAME_STORAGE_KEY);
  } catch {
    // Restricted storage must not block joining a room.
  }
  return null;
}

export function readDisplayName(
  fallback: DisplayName = say("common.name.viewerDefault") as DisplayName,
): DisplayName {
  return readStoredDisplayName() ?? fallback;
}

export function defaultViewerDisplayName(
  visual: boolean,
): DisplayName {
  return visual
    ? ("👤" as DisplayName)
    : (say("common.name.viewerDefault") as DisplayName);
}

export function defaultHostDisplayName(
  visual = false,
): DisplayName {
  return (visual ? "👑" : say("common.name.hostDefault")) as DisplayName;
}

export function saveDisplayName(
  value: string,
  fallback: DisplayName = say("common.name.viewerDefault") as DisplayName,
): DisplayName | null {
  const normalized = normalizeDisplayName(value);
  const useFallback = value.length === 0 || /^\p{Zs}+$/u.test(value);
  if (!normalized && !useFallback) {
    return null;
  }
  const displayName = normalized ?? fallback;
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
