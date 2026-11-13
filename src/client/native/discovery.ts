import { debugEvent } from "../lib/debug";
import { clientRuntimePort } from "../lib/app-launch";
import { NATIVE_CLIENT_PORT_START, NATIVE_CLIENT_PORT_END } from "./discovery-ports";
import type { AppReleaseIdentity } from "../lib/release-update";

export interface AppDiscoveryOptions {
  waitForPermission?: boolean;
  signal?: AbortSignal;
}

export interface AppDiscovery {
  health(options?: AppDiscoveryOptions): Promise<(Partial<AppReleaseIdentity> & { updateSupported?: boolean; managementURL?: string }) | null>;
  connect(signal?: AbortSignal): Promise<string | null>;
  navigation?(signal?: AbortSignal): Promise<{ url: string; windowNavigation: boolean } | null>;
  isIncompatible(error: unknown): boolean;
}

export function isLoopbackPage(): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
}

async function localPermission(): Promise<PermissionStatus | null> {
  if (isLoopbackPage()) return null;
  for (const name of ["loopback-network", "local-network-access"]) {
    try {
      return await navigator.permissions.query({ name: name as PermissionName });
    } catch { /* Older Browsers may expose neither permission name. */ }
  }
  return null;
}

/** One network deadline; each protocol adapter verifies the responding App's identity. */
export async function discoverLocalApp<T>(
  path: "health" | "connect-discovery", read: (body: unknown, port: number) => T,
  { waitForPermission = true, signal }: AppDiscoveryOptions,
  isIncompatible: (error: unknown) => boolean,
): Promise<T | null> {
  if (signal?.aborted) return null;
  const permission = await localPermission();
  if (!waitForPermission && permission && permission.state !== "granted") {
    debugEvent("native", "unavailable", { stage: "permission", permission: permission.state });
    return null;
  }
  if (signal?.aborted) return null;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  let timer: number | undefined;
  const startDeadline = () => { timer ??= window.setTimeout(() => controller.abort(), 8_000); };
  const permissionChanged = () => { if (permission?.state !== "prompt") startDeadline(); };
  const awaitingPermission = permission?.state === "prompt";
  try {
    if (awaitingPermission) permission.addEventListener("change", permissionChanged);
    permissionChanged();
    const selectedPort = clientRuntimePort();
    const ports = selectedPort === null ? Array.from({
      length: NATIVE_CLIENT_PORT_END - NATIVE_CLIENT_PORT_START + 1,
    }, (_, index) => NATIVE_CLIENT_PORT_START + index) : [selectedPort];
    return await Promise.any(ports.map(async port => {
      const response = await fetch(`http://127.0.0.1:${port}/${path}`, {
        cache: "no-store", signal: controller.signal,
        ...(isLoopbackPage() ? {} : { targetAddressSpace: "loopback" }),
      } as RequestInit);
      startDeadline();
      if (!response.ok) throw new Error("Piik App discovery was not accepted");
      return read(await response.json(), port);
    }));
  } catch (error) {
    const incompatible = error instanceof AggregateError ? error.errors.find(isIncompatible) : undefined;
    if (incompatible) throw incompatible;
    debugEvent("native", "unavailable", { stage: "discovery", timedOut: controller.signal.aborted });
    return null;
  } finally {
    if (awaitingPermission) permission.removeEventListener("change", permissionChanged);
    signal?.removeEventListener("abort", abort);
    window.clearTimeout(timer);
    controller.abort();
  }
}

export function appApprovalURL(value: string): string {
  const url = appManagementURL(value);
  url.searchParams.set("site", window.location.origin);
  return url.toString();
}

export function appManagementURL(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
      url.username || url.password || url.pathname !== "/client" || url.search || url.hash) {
    throw new Error("Invalid local App approval address");
  }
  return url;
}
