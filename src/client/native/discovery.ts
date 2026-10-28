import { debugEvent } from "../lib/debug";
import { clientRuntimePort } from "../lib/session";
import { NATIVE_CLIENT_PORT_START, NATIVE_CLIENT_PORT_END } from "./discovery-ports";

export interface AppDiscoveryOptions {
  waitForPermission?: boolean;
  signal?: AbortSignal;
}

export interface AppDiscovery {
  health(options?: AppDiscoveryOptions): Promise<object | null>;
  connect(signal?: AbortSignal): Promise<string | null>;
  isIncompatible(error: unknown): boolean;
}

export function isLoopbackPage(): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
}

async function ungrantedLocalPermission(): Promise<PermissionState | null> {
  if (isLoopbackPage()) return null;
  for (const name of ["loopback-network", "local-network-access"]) {
    try {
      const { state } = await navigator.permissions.query({ name: name as PermissionName });
      return state === "granted" ? null : state;
    } catch { /* Older Browsers may expose neither permission name. */ }
  }
  return null;
}

/** One bounded scan; each protocol adapter verifies the responding App's identity. */
export async function discoverLocalApp<T>(
  path: "health" | "connect-discovery", read: (body: unknown, port: number) => T,
  { waitForPermission = true, signal }: AppDiscoveryOptions,
  isIncompatible: (error: unknown) => boolean,
): Promise<T | null> {
  if (signal?.aborted) return null;
  if (!waitForPermission) {
    const permission = await ungrantedLocalPermission();
    if (permission) {
      debugEvent("native", "unavailable", { stage: "permission", permission });
      return null;
    }
  }
  if (signal?.aborted) return null;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = window.setTimeout(() => controller.abort(), 8_000);
  try {
    const selectedPort = clientRuntimePort();
    const ports = selectedPort === null ? Array.from({
      length: NATIVE_CLIENT_PORT_END - NATIVE_CLIENT_PORT_START + 1,
    }, (_, index) => NATIVE_CLIENT_PORT_START + index) : [selectedPort];
    return await Promise.any(ports.map(async port => {
      const response = await fetch(`http://127.0.0.1:${port}/${path}`, {
        cache: "no-store", signal: controller.signal,
        ...(isLoopbackPage() ? {} : { targetAddressSpace: "loopback" }),
      } as RequestInit);
      if (!response.ok) throw new Error("Piik App discovery was not accepted");
      return read(await response.json(), port);
    }));
  } catch (error) {
    const incompatible = error instanceof AggregateError ? error.errors.find(isIncompatible) : undefined;
    if (incompatible) throw incompatible;
    debugEvent("native", "unavailable", { stage: "discovery", timedOut: controller.signal.aborted });
    return null;
  } finally {
    signal?.removeEventListener("abort", abort);
    window.clearTimeout(timer);
    controller.abort();
  }
}

export function appApprovalURL(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
      url.username || url.password || url.pathname !== "/client" || url.search || url.hash) {
    throw new Error("Invalid local App approval address");
  }
  url.searchParams.set("site", window.location.origin);
  return url.toString();
}
