import {
  SIGNALING_PROTOCOL,
  type QualityResolution,
} from "../../shared/protocol";

interface DebugDetails {
  role?: "host" | "viewer";
  type?: string;
  state?: string;
  generation?: number;
  revision?: number;
  code?: string | number;
  count?: number;
  reconnecting?: boolean;
  native?: boolean;
  resolution?: QualityResolution;
  maxFramerate?: number;
  maxBitrate?: number;
  audio?: boolean;
  errorName?: string;
}

interface BrowserDebugEvent {
  at: string;
  scope: string;
  event: string;
  details: DebugDetails;
}

export const browserDebugEnabled =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("debug") === "1";
const events: BrowserDebugEvent[] = [];
const fields = [
  "role",
  "type",
  "state",
  "generation",
  "revision",
  "code",
  "count",
  "reconnecting",
  "native",
  "resolution",
  "maxFramerate",
  "maxBitrate",
  "audio",
  "errorName",
] as const satisfies readonly (keyof DebugDetails)[];
const errorNames = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AbortError",
  "NotAllowedError",
  "NotFoundError",
  "NotReadableError",
  "NotSupportedError",
  "OverconstrainedError",
  "InvalidStateError",
  "SecurityError",
  "TimeoutError",
  "OperationError",
  "NetworkError",
]);

export function debugEvent(
  scope: string,
  event: string,
  details: DebugDetails = {},
): void {
  if (
    !browserDebugEnabled ||
    !/^[a-z][a-z-]{0,47}$/.test(scope) ||
    !/^[a-z][a-z-]{0,47}$/.test(event)
  )
    return;
  const safe: Record<string, string | number | boolean> = {};
  for (const key of fields) {
    const value = details[key];
    if (
      (typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value)) ||
      (typeof value === "number" && Number.isFinite(value)) ||
      typeof value === "boolean"
    ) {
      safe[key] = value;
    }
  }
  const record: BrowserDebugEvent = {
    at: new Date().toISOString(),
    scope,
    event,
    details: safe,
  };
  events.push(record);
  if (events.length > 256) events.shift();
  console.info("[screener]", record);
}

export function debugError(
  scope: string,
  event: string,
  error: unknown,
  details: DebugDetails = {},
): void {
  if (!browserDebugEnabled) return;
  let errorName = "Error";
  try {
    if (
      (error instanceof Error || error instanceof DOMException) &&
      errorNames.has(error.name)
    )
      errorName = error.name;
  } catch {
    /* Diagnostic inspection must not throw into media work. */
  }
  debugEvent(scope, event, { ...details, errorName });
}

function snapshot(): BrowserDebugEvent[] {
  return structuredClone(events);
}

export function installBrowserDebug(): (() => void) | undefined {
  if (!browserDebugEnabled) return;
  window.__SCREENER_DEBUG__ = {
    events: snapshot,
    clear: () => {
      events.length = 0;
    },
    export: () =>
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          protocol: SIGNALING_PROTOCOL,
          asset: new URL(import.meta.url).pathname.split("/").at(-1),
          events: snapshot(),
        },
        null,
        2,
      ),
  };
  const reportError = (event: ErrorEvent) =>
    debugError("window", "error", event.error);
  const reportRejection = (event: PromiseRejectionEvent) =>
    debugError("window", "unhandled-rejection", event.reason);
  window.addEventListener("error", reportError);
  window.addEventListener("unhandledrejection", reportRejection);
  debugEvent("app", "loaded");
  return () => {
    window.removeEventListener("error", reportError);
    window.removeEventListener("unhandledrejection", reportRejection);
  };
}

declare global {
  interface Window {
    __SCREENER_DEBUG__?: {
      events: () => readonly BrowserDebugEvent[];
      clear: () => void;
      export: () => string;
    };
  }
}
