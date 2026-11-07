import { isLang, type Lang } from "../locales";
import { withBrowserDebug } from "./debug";

const CLIENT_LAUNCH_STORAGE_KEY = "piik:client-launch:v1";
const CLIENT_RUNTIME_STORAGE_KEY = "piik:client-runtime-port";
const CLIENT_ACTIVATION_EVENT = "piik-client-activation";
const APP_MODE_PREFERENCE_KEY = "piik:app-mode";
export type AppMode = "local" | "link";

export function readPreferredAppMode(): AppMode {
  try { return window.localStorage.getItem(APP_MODE_PREFERENCE_KEY) === "local" ? "local" : "link"; }
  catch { return "link"; }
}

export function savePreferredAppMode(mode: AppMode): void {
  try { window.localStorage.setItem(APP_MODE_PREFERENCE_KEY, mode); } catch { /* Optional persistence. */ }
}

// Keep the selected App through this tab's reloads, without copying it into invites.
let clientPortInPage = parseClientRuntimePort(readSessionValue(CLIENT_RUNTIME_STORAGE_KEY));
let clientActivatedInPage = clientPortInPage !== null;

export function clientRuntimePort(): number | null { return clientPortInPage; }

function parseClientRuntimePort(value: string | null): number | null {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

export function isClientActivated(): boolean {
  try { return clientActivatedInPage || window.localStorage.getItem(CLIENT_LAUNCH_STORAGE_KEY) === "1"; }
  catch { return clientActivatedInPage; }
}

export function activateClient(): void {
  clientActivatedInPage = true;
  try { window.localStorage.setItem(CLIENT_LAUNCH_STORAGE_KEY, "1"); } catch { /* Optional persistence. */ }
  window.dispatchEvent(new Event(CLIENT_ACTIVATION_EVENT));
}

export function watchClientActivation(changed: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === CLIENT_LAUNCH_STORAGE_KEY || event.key === null) changed();
  };
  window.addEventListener(CLIENT_ACTIVATION_EVENT, changed);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CLIENT_ACTIVATION_EVENT, changed);
    window.removeEventListener("storage", onStorage);
  };
}

export interface ClientLaunchPresentation {
  lang: Lang;
  vis: boolean;
  theme: "light" | "dark" | null;
  /** Domains explicitly chosen in the launcher, rather than system defaults. */
  explicit?: readonly ("copy" | "theme")[];
}

export function clientLaunchURL(target: string, presentation: ClientLaunchPresentation, debug?: boolean, controlPort?: number): string {
  const url = new URL(target);
  const params = new URLSearchParams(url.hash.slice(1));
  if (controlPort !== undefined) url.searchParams.set("piik-client-port", String(controlPort));
  params.set("piik-lang", presentation.lang);
  params.set("piik-mode", presentation.vis ? "vis" : "text");
  params.set("piik-theme", presentation.theme ?? "system");
  url.searchParams.delete("piik-preferences");
  if (presentation.explicit?.length) {
    url.searchParams.set("piik-preferences", presentation.explicit.join(","));
  }
  url.hash = params.toString();
  return withBrowserDebug(url.toString(), debug);
}

export function takeClientLaunchBootstrap(): Partial<ClientLaunchPresentation> | null {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const keys = ["piik-client", "piik-lang", "piik-mode", "piik-theme"] as const;
  const query = new URLSearchParams(window.location.search);
  const present = keys.some((key) => params.has(key)) || query.has("piik-preferences") || query.has("piik-client-port");
  const launchedFromFragment = params.get("piik-client") === "1";
  if (launchedFromFragment) {
    clientActivatedInPage = true;
    clientPortInPage = parseClientRuntimePort(query.get("piik-client-port"));
    if (clientPortInPage !== null) writeSessionValue(CLIENT_RUNTIME_STORAGE_KEY, String(clientPortInPage));
    else try { window.sessionStorage.removeItem(CLIENT_RUNTIME_STORAGE_KEY); } catch { /* Storage is optional. */ }
    try { window.localStorage.setItem(CLIENT_LAUNCH_STORAGE_KEY, "1"); } catch { /* Storage is optional. */ }
  }
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
  if (present) {
    for (const key of keys) params.delete(key);
    query.delete("piik-preferences");
    query.delete("piik-client-port");
    const search = query.toString();
    const remaining = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${search ? `?${search}` : ""}${remaining ? `#${remaining}` : ""}`,
    );
  }
  return launchedFromFragment && Object.keys(presentation).length > 0
    ? {
        ...presentation,
        explicit: (["copy", "theme"] as const).filter((key) => preferenceFields.includes(key)),
      }
    : null;
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
