import {
  createRoomResponseSchema,
  roomCodeSchema,
  type CreateRoomResponse,
} from "../../shared/protocol";
import { createOpaqueId } from "./opaque-id";

const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const HOST_ROOM_STORAGE_KEY = "screener:host-room:v1";

export interface ViewerRoute {
  roomId: string;
}

export function isValidRoomId(value: string): boolean {
  return roomCodeSchema.safeParse(value).success;
}

export function isHostRoomExpired(
  room: CreateRoomResponse,
  now = Date.now(),
): boolean {
  if (room.expiresAt === null) {
    return false;
  }
  const expiresAt = Date.parse(room.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

export function clearHostRoom(): void {
  try {
    window.localStorage.removeItem(HOST_ROOM_STORAGE_KEY);
  } catch {
    // Storage can be disabled; the current page still keeps its in-memory room.
  }
}

export function readHostRoom(now = Date.now()): CreateRoomResponse | null {
  let stored: string | null;
  try {
    stored = window.localStorage.getItem(HOST_ROOM_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!stored) {
    return null;
  }

  try {
    const parsed = createRoomResponseSchema.safeParse(JSON.parse(stored));
    if (!parsed.success || isHostRoomExpired(parsed.data, now)) {
      clearHostRoom();
      return null;
    }
    return parsed.data;
  } catch {
    clearHostRoom();
    return null;
  }
}

export function writeHostRoom(room: CreateRoomResponse): void {
  try {
    window.localStorage.setItem(HOST_ROOM_STORAGE_KEY, JSON.stringify(room));
  } catch {
    // A storage failure must not prevent the current sharing session.
  }
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

  const clientId = createOpaqueId();
  writeSessionValue(storageKey, clientId);
  return clientId;
}
