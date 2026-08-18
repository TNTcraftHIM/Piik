const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const ROOM_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export interface ViewerRoute {
  roomId: string;
  token: string | null;
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
  const match = window.location.pathname.match(/^\/r\/([A-Za-z0-9_-]+)\/?$/);
  if (!match || !ROOM_PATTERN.test(match[1])) {
    return null;
  }

  const roomId = match[1];
  const storageKey = `screener:viewer-token:${roomId}`;
  const fragmentToken = new URLSearchParams(window.location.hash.slice(1)).get(
    "token",
  );
  const token =
    fragmentToken && TOKEN_PATTERN.test(fragmentToken)
      ? fragmentToken
      : readSessionValue(storageKey);

  if (fragmentToken && TOKEN_PATTERN.test(fragmentToken)) {
    writeSessionValue(storageKey, fragmentToken);
  }

  if (window.location.hash) {
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
  }

  return {
    roomId,
    token: token && TOKEN_PATTERN.test(token) ? token : null,
  };
}

export function getStableClientId(role: "host" | "viewer", roomId: string): string {
  const storageKey = `screener:client-id:${role}:${roomId}`;
  const existing = readSessionValue(storageKey);
  if (existing && ROOM_PATTERN.test(existing)) {
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
