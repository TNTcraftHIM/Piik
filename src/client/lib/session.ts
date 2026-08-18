import { roomCodeSchema } from "../../shared/protocol";

const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export interface ViewerRoute {
  roomId: string;
}

export function isValidRoomId(value: string): boolean {
  return roomCodeSchema.safeParse(value).success;
}

function readSessionValue(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSessionValue(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // The current page can still use the in-memory value in restricted browsers.
  }
}

export function readViewerRoute(): ViewerRoute | null {
  const match = window.location.pathname.match(/^\/r\/(\d+)\/?$/);
  if (!match || !isValidRoomId(match[1])) {
    return null;
  }

  return { roomId: match[1] };
}

export function getStableClientId(role: "host" | "viewer", roomId: string): string {
  const storageKey = `screener:client-id:${role}:${roomId}`;
  const existing = readSessionValue(storageKey);
  if (existing && CLIENT_ID_PATTERN.test(existing)) {
    return existing;
  }

  // randomUUID is unavailable to LAN viewers on HTTP; getRandomValues is not.
  const randomBytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const clientId = Array.from(randomBytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  writeSessionValue(storageKey, clientId);
  return clientId;
}
