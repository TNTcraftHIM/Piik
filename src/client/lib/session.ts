import {
  createRoomResponseSchema,
  roomCodeSchema,
  viewerGrantSchema,
  type CreateRoomResponse,
  type CodeEntryPolicy,
} from "../../shared/protocol";
import { z } from "zod";
import { createOpaqueId } from "./opaque-id";
import { isLang, type Lang } from "../locales";
import { withBrowserDebug } from "./debug";

const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const CLIENT_LAUNCH_STORAGE_KEY = "piik:client-launch:v1";
const HOST_ROOM_STORAGE_KEY = "piik:host-room:v1";
const HOST_ROOM_PREFERENCE_STORAGE_KEY = "piik:host-room-preference:v1";
const hostRoomStorageSchema = createRoomResponseSchema.pick({
  roomId: true,
  hostToken: true,
  inviteUrl: true,
}).strip();
const hostRoomPreferenceSchema = z
  .object({
    roomId: roomCodeSchema,
  })
  .strict();

export type HostRoomIdentity = Pick<
  CreateRoomResponse,
  "roomId" | "hostToken"
> & { canonicalUrl: string };

export interface HostRoomState extends HostRoomIdentity {
  codeEntryPolicy: CodeEntryPolicy | null;
  inviteUrl: string | null;
}

interface HostRoomClaim {
  room: HostRoomIdentity;
  ready: Promise<boolean>;
  done: Promise<void>;
  release: () => void;
}

let hostRoomClaim: HostRoomClaim | null = null;
let hostRoomRelease: Promise<void> = Promise.resolve();

export interface ViewerRoute {
  roomId: string;
  viewerGrant?: string;
  /** An invite fragment was present but its grant was unusable. */
  invalidGrant?: true;
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
  return route ? withBrowserDebug(route) : null;
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
  presentation: Partial<ClientLaunchPresentation> | null;
}

export interface ClientLaunchPresentation {
  lang: Lang;
  vis: boolean;
  theme: "light" | "dark" | null;
  /** Domains explicitly chosen in the launcher, rather than system defaults. */
  explicit?: readonly ("copy" | "theme")[];
}

export function clientLaunchURL(target: string, presentation: ClientLaunchPresentation, debug?: boolean): string {
  const url = new URL(target);
  const params = new URLSearchParams(url.hash.slice(1));
  params.set("piik-lang", presentation.lang);
  params.set("piik-mode", presentation.vis ? "vis" : "text");
  params.set("piik-theme", presentation.theme ?? "system");
  // Keep the public tuple for older Sites. The non-secret provenance goes in
  // the query: an unknown fragment key would corrupt their exact #v= parser.
  url.searchParams.delete("piik-preferences");
  if (presentation.explicit?.length) {
    url.searchParams.set("piik-preferences", presentation.explicit.join(","));
  }
  url.hash = params.toString();
  return withBrowserDebug(url.toString(), debug);
}

export function takeClientLaunchBootstrap(): ClientLaunchBootstrap {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const keys = [
    "client-access",
    "piik-client",
    "piik-lang",
    "piik-mode",
    "piik-theme",
  ] as const;
  const query = new URLSearchParams(window.location.search);
  const present = keys.some((key) => params.has(key)) || query.has("piik-preferences");
  const accessValue = params.get("client-access");
  const launchedFromFragment = params.get("piik-client") === "1";
  const lang = params.get("piik-lang");
  const mode = params.get("piik-mode");
  const theme = params.get("piik-theme");
  const preferenceFields = query.get("piik-preferences")?.split(",") ?? [];
  const presentation: Partial<ClientLaunchPresentation> = {
    ...(isLang(lang) ? { lang } : {}),
    ...(mode === "vis" || mode === "text" ? { vis: mode === "vis" } : {}),
    ...(theme === "light" || theme === "dark" || theme === "system"
      ? { theme: theme === "system" ? null : theme } : {}),
  };
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
    accessToken: accessValue || null,
    launchedByClient,
    presentation: launchedFromFragment && Object.keys(presentation).length > 0
      ? {
          ...presentation,
          explicit: (["copy", "theme"] as const).filter((key) => preferenceFields.includes(key)),
        }
      : null,
  };
  if (present) {
    for (const key of keys) params.delete(key);
    query.delete("piik-preferences");
    const search = query.toString();
    const remaining = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${search ? `?${search}` : ""}${remaining ? `#${remaining}` : ""}`,
    );
  }
  return result;
}

export function clearHostRoom(keepResumeHint = false): void {
  const room = readStoredHostRoom("sessionStorage") ?? hostRoomClaim?.room;
  if (room) {
    removeStoredHostRoom("sessionStorage", room);
    if (!keepResumeHint) removeStoredHostRoom("localStorage", room);
  }
  releaseHostRoom();
}

export function releaseHostRoom(): void {
  if (hostRoomClaim) {
    hostRoomClaim.release();
    hostRoomRelease = hostRoomClaim.done;
  }
  hostRoomClaim = null;
}

export async function readHostRoom(): Promise<HostRoomIdentity | null> {
  const tabRoom = readStoredHostRoom("sessionStorage") ?? hostRoomClaim?.room;
  const room =
    tabRoom ?? (hostRoomLocks() ? readStoredHostRoom("localStorage") : null);
  if (!room) return null;
  const claim = claimHostRoom(room, Boolean(tabRoom));
  const acquired = await claim.ready;
  if (hostRoomClaim !== claim) return null;
  if (!acquired) {
    releaseHostRoom();
    removeStoredHostRoom("sessionStorage", room);
    return null;
  }
  storeHostRoom("sessionStorage", room);
  return room;
}

function readStoredHostRoom(
  storage: "localStorage" | "sessionStorage",
): HostRoomIdentity | null {
  let stored: string | null;
  try {
    stored = window[storage].getItem(HOST_ROOM_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!stored) {
    return null;
  }

  try {
    const parsed = hostRoomStorageSchema.safeParse(JSON.parse(stored));
    if (!parsed.success) {
      window[storage].removeItem(HOST_ROOM_STORAGE_KEY);
      return null;
    }
    const room: HostRoomIdentity = {
      roomId: parsed.data.roomId,
      hostToken: parsed.data.hostToken,
      canonicalUrl: canonicalViewerUrl(parsed.data.inviteUrl),
    };
    return room;
  } catch {
    try {
      window[storage].removeItem(HOST_ROOM_STORAGE_KEY);
    } catch {
      /* Storage is optional. */
    }
    return null;
  }
}

function sameHostRoom(
  left: HostRoomIdentity | null,
  right: HostRoomIdentity,
): boolean {
  return left?.roomId === right.roomId && left.hostToken === right.hostToken;
}

function removeStoredHostRoom(
  storage: "localStorage" | "sessionStorage",
  room: HostRoomIdentity,
): void {
  if (!sameHostRoom(readStoredHostRoom(storage), room)) return;
  try {
    window[storage].removeItem(HOST_ROOM_STORAGE_KEY);
  } catch {
    /* Storage is optional. */
  }
}

function hostRoomLocks(): LockManager | undefined {
  try {
    return window.navigator?.locks;
  } catch {
    return undefined;
  }
}

function claimHostRoom(
  room: HostRoomIdentity,
  allowWithoutLocks: boolean,
): HostRoomClaim {
  let claim = hostRoomClaim;
  if (!claim || !sameHostRoom(claim.room, room)) {
    releaseHostRoom();
    const previousRelease = hostRoomRelease;
    let release!: () => void;
    let resolveReady!: (ready: boolean) => void;
    const lifetime = new Promise<void>((resolve) => {
      release = resolve;
    });
    claim = {
      room,
      release,
      done: Promise.resolve(),
      ready: new Promise<boolean>((resolve) => {
        resolveReady = resolve;
      }),
    };
    hostRoomClaim = claim;
    const locks = hostRoomLocks();
    const requestedClaim = claim;
    claim.done = (async () => {
      await previousRelease;
      if (hostRoomClaim !== requestedClaim) {
        resolveReady(false);
        return;
      }
      if (!locks) {
        resolveReady(allowWithoutLocks);
        return;
      }
      // The lock follows the room incarnation without exposing the Host token
      // in queryable lock names. The browser releases it when this document ends.
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(room.hostToken),
      );
      if (hostRoomClaim !== requestedClaim) {
        resolveReady(false);
        return;
      }
      const identity = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      await locks.request(
        `piik:host-room:${room.roomId}:${identity}`,
        { ifAvailable: true },
        async (lock) => {
          resolveReady(lock !== null);
          if (lock) await lifetime;
        },
      );
    })().catch(() => resolveReady(allowWithoutLocks));
  }
  return claim;
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

export async function writeHostRoom(
  room: HostRoomIdentity | CreateRoomResponse,
  owns: () => boolean = () => true,
): Promise<boolean> {
  if (!owns()) return false;
  const identity: HostRoomIdentity = {
    roomId: room.roomId,
    hostToken: room.hostToken,
    canonicalUrl:
      "canonicalUrl" in room
        ? room.canonicalUrl
        : canonicalViewerUrl(room.inviteUrl),
  };
  const previousClaim = hostRoomClaim;
  const claim = claimHostRoom(identity, true);
  const acquired = await claim.ready;
  if (hostRoomClaim !== claim) return false;
  if (!acquired || !owns()) {
    if (!acquired || claim !== previousClaim) releaseHostRoom();
    return false;
  }
  claim.room = identity;
  storeHostRoom("sessionStorage", identity);
  storeHostRoom("localStorage", identity);
  return true;
}

function storeHostRoom(
  storage: "localStorage" | "sessionStorage",
  room: HostRoomIdentity,
): void {
  try {
    window[storage].setItem(
      HOST_ROOM_STORAGE_KEY,
      JSON.stringify({
        roomId: room.roomId,
        hostToken: room.hostToken,
        inviteUrl: room.canonicalUrl,
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
  // Only a `#v=` fragment is an invite credential. Any other fragment (a mail
  // client suffix, a `#:~:text=` scroll target) must not be read as a failed
  // grant, or it would revoke the grant this tab already holds.
  const fragmentMatch = window.location.hash.match(/^#v=(.*)$/);
  if (fragmentMatch) {
    const viewerGrant = fragmentMatch[1];
    const validGrant = isValidViewerGrant(viewerGrant) ? viewerGrant : null;
    if (validGrant) {
      writeSessionValue(viewerGrantStorageKey(roomId), validGrant);
    } else {
      clearViewerGrant(roomId);
    }
    window.history.replaceState(window.history.state, "", withBrowserDebug(`/r/${roomId}`));
    return validGrant
      ? { roomId, viewerGrant: validGrant }
      : { roomId, invalidGrant: true };
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

// Following another invitation to this page is a fragment navigation, not a
// document load. Consume it through the same authority owner as initial entry.
export function watchViewerInvites(changed: (route: ViewerRoute) => void): () => void {
  const onHashChange = () => {
    if (!window.location.hash.startsWith("#v=")) return;
    const route = readViewerRoute();
    if (route) changed(route);
  };
  window.addEventListener("hashchange", onHashChange);
  return () => window.removeEventListener("hashchange", onHashChange);
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
  return `piik:viewer-grant:${roomId}`;
}

function isValidViewerGrant(value: string): boolean {
  return viewerGrantSchema.safeParse(value).success;
}

export function getStableClientId(role: "host" | "viewer", roomId: string): string {
  const storageKey = `piik:client-id:${role}:${roomId}`;
  const existing = readSessionValue(storageKey);
  if (existing && CLIENT_ID_PATTERN.test(existing)) {
    return existing;
  }

  const clientId = createOpaqueId();
  writeSessionValue(storageKey, clientId);
  return clientId;
}
