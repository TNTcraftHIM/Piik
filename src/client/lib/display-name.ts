import {
  normalizeDisplayName,
  type DisplayName,
} from "../../shared/protocol";
import { say } from "../ui/copy";

const DISPLAY_NAME_STORAGE_KEY = "screener:display-name:v1";

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

function suffixedDefaultName(prefix: string, clientId: string): DisplayName {
  const suffix = clientId.slice(-6);
  return (
    normalizeDisplayName(suffix ? `${prefix}-${suffix}` : prefix) ??
    (prefix as DisplayName)
  );
}

export function defaultViewerDisplayName(
  clientId: string,
  visual: boolean,
): DisplayName {
  return visual
    ? suffixedDefaultName("👀", clientId)
    : (say("common.name.viewerDefault") as DisplayName);
}

export function defaultHostDisplayName(
  clientId: string,
  visual = false,
): DisplayName {
  return suffixedDefaultName(
    visual ? "📺" : say("common.name.hostDefault"),
    clientId,
  );
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
