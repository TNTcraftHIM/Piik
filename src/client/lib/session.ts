import {
  createRoomResponseSchema,
  roomCodeSchema,
  viewerGrantSchema,
  type CreateRoomResponse,
  type ViewerAccessPolicy,
} from "../../shared/protocol";
import { createOpaqueId } from "./opaque-id";

const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const HOST_ROOM_STORAGE_KEY = "screener:host-room:v1";
const hostRoomStorageSchema = createRoomResponseSchema.pick({
  roomId: true,
  hostToken: true,
  inviteUrl: true,
  expiresAt: true,
});

export type HostRoomIdentity = Pick<
  CreateRoomResponse,
  "roomId" | "hostToken" | "expiresAt"
> & { canonicalUrl: string };

export interface HostRoomState extends HostRoomIdentity {
  viewerPolicy: ViewerAccessPolicy | null;
  inviteUrl: string | null;
}

export interface ViewerRoute {
  roomId: string;
  viewerGrant?: string;
}

export function isValidRoomId(value: string): boolean {
  return roomCodeSchema.safeParse(value).success;
}

export function isHostRoomExpired(
  room: HostRoomIdentity,
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

export function readHostRoom(now = Date.now()): HostRoomIdentity | null {
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
    const parsed = hostRoomStorageSchema.safeParse(JSON.parse(stored));
    if (!parsed.success) {
      clearHostRoom();
      return null;
    }
    const room: HostRoomIdentity = {
      roomId: parsed.data.roomId,
      hostToken: parsed.data.hostToken,
      expiresAt: parsed.data.expiresAt,
      canonicalUrl: canonicalViewerUrl(parsed.data.inviteUrl),
    };
    if (isHostRoomExpired(room, now)) {
      clearHostRoom();
      return null;
    }
    return room;
  } catch {
    clearHostRoom();
    return null;
  }
}

export function writeHostRoom(
  room: HostRoomIdentity | CreateRoomResponse,
): void {
  try {
    const canonicalUrl =
      "canonicalUrl" in room
        ? room.canonicalUrl
        : canonicalViewerUrl(room.inviteUrl);
    window.localStorage.setItem(
      HOST_ROOM_STORAGE_KEY,
      JSON.stringify({
        roomId: room.roomId,
        hostToken: room.hostToken,
        expiresAt: room.expiresAt,
        inviteUrl: canonicalUrl,
      }),
    );
  } catch {
    // A storage failure must not prevent the current sharing session.
  }
}

function canonicalViewerUrl(inviteUrl: string): string {
  const parsed = new URL(inviteUrl);
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString();
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

  const roomId = match[1];
  const fragment = window.location.hash;
  if (fragment) {
    const fragmentMatch = fragment.match(/^#v=(.+)$/);
    const viewerGrant = fragmentMatch?.[1];
    const validGrant =
      viewerGrant && isViewerGrantForRoom(viewerGrant, roomId)
        ? viewerGrant
        : null;
    if (validGrant) {
      writeSessionValue(viewerGrantStorageKey(roomId), validGrant);
    } else {
      clearViewerGrant(roomId);
    }
    window.history.replaceState(window.history.state, "", `/r/${roomId}`);
    return validGrant ? { roomId, viewerGrant: validGrant } : { roomId };
  }

  const storedGrant = readSessionValue(viewerGrantStorageKey(roomId));
  if (storedGrant && isViewerGrantForRoom(storedGrant, roomId)) {
    return { roomId, viewerGrant: storedGrant };
  }
  if (storedGrant) {
    clearViewerGrant(roomId);
  }
  return { roomId };
}

export function replaceViewerInvite(
  roomId: string,
  inviteUrl: string | null,
): void {
  if (inviteUrl === null) {
    clearViewerGrant(roomId);
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(inviteUrl);
  } catch {
    clearViewerGrant(roomId);
    return;
  }
  const match = parsed.hash.match(/^#v=(.+)$/);
  const viewerGrant = match?.[1];
  if (viewerGrant && isViewerGrantForRoom(viewerGrant, roomId)) {
    writeSessionValue(viewerGrantStorageKey(roomId), viewerGrant);
    return;
  }
  clearViewerGrant(roomId);
}

export function readViewerGrant(roomId: string): string | null {
  const value = readSessionValue(viewerGrantStorageKey(roomId));
  if (value && isViewerGrantForRoom(value, roomId)) {
    return value;
  }
  if (value) {
    clearViewerGrant(roomId);
  }
  return null;
}

export function mergeAuthenticatedHostRoom(
  current: HostRoomState | null,
  activeRoomId: string,
  roomExpiresAt: string | null,
  viewerPolicy: ViewerAccessPolicy,
): HostRoomState | null {
  if (!current || current.roomId !== activeRoomId) {
    return current;
  }

  let inviteUrl = current.inviteUrl;
  if (viewerPolicy === "public-watch") {
    inviteUrl = current.canonicalUrl;
  } else if (current.viewerPolicy === null) {
    const viewerGrant = readViewerGrant(current.roomId);
    if (viewerGrant) {
      const restoredInvite = new URL(current.canonicalUrl);
      restoredInvite.hash = `v=${viewerGrant}`;
      inviteUrl = restoredInvite.toString();
    }
  }

  return {
    ...current,
    expiresAt: roomExpiresAt,
    viewerPolicy,
    inviteUrl,
  };
}

export function clearViewerGrant(roomId: string): void {
  try {
    window.sessionStorage.removeItem(viewerGrantStorageKey(roomId));
  } catch {
    // Restricted storage does not change the current in-memory authorization.
  }
}

function viewerGrantStorageKey(roomId: string): string {
  return `screener:viewer-grant:${roomId}`;
}

function isViewerGrantForRoom(value: string, roomId: string): boolean {
  if (!viewerGrantSchema.safeParse(value).success) {
    return false;
  }
  const [, grantRoomId, expiresAtText] = value.split(".", 4);
  const expiresAtSeconds = Number(expiresAtText);
  return (
    grantRoomId === roomId &&
    Number.isSafeInteger(expiresAtSeconds) &&
    expiresAtSeconds > Math.floor(Date.now() / 1_000)
  );
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
