import {
  createRoomResponseSchema,
  roomCodeSchema,
  viewerGrantSchema,
  type CreateRoomResponse,
  type CodeEntryPolicy,
} from "../../shared/protocol";
import { z } from "zod";
import { createOpaqueId } from "./opaque-id";

const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const CLIENT_ACCESS_BOOTSTRAP_PATTERN = /^[\x21-\x7e]{8,128}$/;
const CLIENT_LAUNCH_STORAGE_KEY = "screener:client-launch:v1";
const HOST_ROOM_STORAGE_KEY = "screener:host-room:v1";
const HOST_ROOM_PREFERENCE_STORAGE_KEY = "screener:host-room-preference:v1";
const hostRoomStorageSchema = createRoomResponseSchema.pick({
  roomId: true,
  hostToken: true,
  inviteUrl: true,
  expiresAt: true,
  roomLeaseSeconds: true,
});
const hostRoomPreferenceSchema = z
  .object({
    roomId: roomCodeSchema,
  })
  .strict();

export type HostRoomIdentity = Pick<
  CreateRoomResponse,
  "roomId" | "hostToken" | "expiresAt" | "roomLeaseSeconds"
> & { canonicalUrl: string };

export interface HostRoomState extends HostRoomIdentity {
  codeEntryPolicy: CodeEntryPolicy | null;
  inviteUrl: string | null;
}

export interface ViewerRoute {
  roomId: string;
  viewerGrant?: string;
}

export type AppRoute =
  | { kind: "client" }
  | { kind: "host" }
  | { kind: "join" }
  | { kind: "viewer"; roomId: string }
  | { kind: "malformed-room" }
  | { kind: "unknown" };

export function isValidRoomId(value: string): boolean {
  return roomCodeSchema.safeParse(value).success;
}

export function roomRouteFromInput(value: string): string | null {
  return isValidRoomId(value) ? `/r/${value}` : null;
}

export function roomRouteForExplicitEntry(value: string): string | null {
  const route = roomRouteFromInput(value);
  if (route) {
    clearViewerGrant(value);
  }
  return route;
}

export function parseAppRoute(pathname: string): AppRoute {
  if (/^\/client\/?$/.test(pathname)) {
    return { kind: "client" };
  }
  if (pathname === "/") {
    return { kind: "host" };
  }
  if (/^\/join\/?$/.test(pathname)) {
    return { kind: "join" };
  }
  const viewerMatch = pathname.match(/^\/r\/([1-9]\d{3})\/?$/);
  if (viewerMatch) {
    return { kind: "viewer", roomId: viewerMatch[1]! };
  }
  if (pathname === "/r" || pathname.startsWith("/r/")) {
    return { kind: "malformed-room" };
  }
  return { kind: "unknown" };
}

export interface ClientLaunchBootstrap {
  accessToken: string | null;
  launchedByClient: boolean;
}

export function takeClientLaunchBootstrap(): ClientLaunchBootstrap {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const keys = [
    "client-access",
    "screener-client",
  ] as const;
  const present = keys.some((key) => params.has(key));
  const accessValue = params.get("client-access");
  const launchedFromFragment = params.get("screener-client") === "1";
  let launchedByClient = launchedFromFragment;
  try {
    if (launchedFromFragment) {
      window.localStorage.setItem(CLIENT_LAUNCH_STORAGE_KEY, "1");
    } else {
      launchedByClient =
        window.localStorage.getItem(CLIENT_LAUNCH_STORAGE_KEY) === "1";
    }
  } catch {
    // The launch fragment still enables the current load when storage is blocked.
  }
  const result: ClientLaunchBootstrap = {
    accessToken:
      accessValue && CLIENT_ACCESS_BOOTSTRAP_PATTERN.test(accessValue)
        ? accessValue
        : null,
    launchedByClient,
  };
  if (present) {
    for (const key of keys) params.delete(key);
    const remaining = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ""}`,
    );
  }
  return result;
}

export function clearHostRoom(): void {
  try {
    window.localStorage.removeItem(HOST_ROOM_STORAGE_KEY);
  } catch {
    // Storage can be disabled; the current page still keeps its in-memory room.
  }
}

export function readHostRoom(): HostRoomIdentity | null {
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
      roomLeaseSeconds: parsed.data.roomLeaseSeconds,
      canonicalUrl: canonicalViewerUrl(parsed.data.inviteUrl),
    };
    return room;
  } catch {
    clearHostRoom();
    return null;
  }
}

export function readPreferredRoomId(): string | null {
  let stored: string | null;
  try {
    stored = window.localStorage.getItem(HOST_ROOM_PREFERENCE_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!stored) {
    return null;
  }
  try {
    const parsed = hostRoomPreferenceSchema.safeParse(JSON.parse(stored));
    if (!parsed.success) {
      clearPreferredRoom();
      return null;
    }
    return parsed.data.roomId;
  } catch {
    clearPreferredRoom();
    return null;
  }
}

export function writePreferredRoom(roomId: string): void {
  if (!roomCodeSchema.safeParse(roomId).success) {
    return;
  }
  try {
    window.localStorage.setItem(
      HOST_ROOM_PREFERENCE_STORAGE_KEY,
      JSON.stringify({ roomId }),
    );
  } catch {
    // A storage failure only disables best-effort code reuse.
  }
}

export function clearPreferredRoom(): void {
  try {
    window.localStorage.removeItem(HOST_ROOM_PREFERENCE_STORAGE_KEY);
  } catch {
    // Restricted storage is equivalent to having no local preference.
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
        roomLeaseSeconds: room.roomLeaseSeconds,
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
  const route = parseAppRoute(window.location.pathname);
  if (route.kind !== "viewer") {
    return null;
  }

  const roomId = route.roomId;
  const fragment = window.location.hash;
  if (fragment) {
    const fragmentMatch = fragment.match(/^#v=(.+)$/);
    const viewerGrant = fragmentMatch?.[1];
    const validGrant = viewerGrant && isValidViewerGrant(viewerGrant)
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
  if (storedGrant && isValidViewerGrant(storedGrant)) {
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
  const inviteRoute = parseAppRoute(parsed.pathname);
  const match = parsed.hash.match(/^#v=(.+)$/);
  const viewerGrant = match?.[1];
  if (
    inviteRoute.kind === "viewer" &&
    inviteRoute.roomId === roomId &&
    viewerGrant &&
    isValidViewerGrant(viewerGrant)
  ) {
    writeSessionValue(viewerGrantStorageKey(roomId), viewerGrant);
    return;
  }
  clearViewerGrant(roomId);
}

export function readViewerGrant(roomId: string): string | null {
  const value = readSessionValue(viewerGrantStorageKey(roomId));
  if (value && isValidViewerGrant(value)) {
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
  codeEntryPolicy: CodeEntryPolicy,
): HostRoomState | null {
  if (!current || current.roomId !== activeRoomId) {
    return current;
  }

  let inviteUrl = current.inviteUrl;
  if (inviteUrl === null) {
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
    codeEntryPolicy,
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

function isValidViewerGrant(value: string): boolean {
  return viewerGrantSchema.safeParse(value).success;
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
