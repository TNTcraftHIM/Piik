import { SIGNALING_PROTOCOL } from "../../shared/protocol";

type DebugValue = null | boolean | number | string | DebugValue[] | { [key: string]: DebugValue };
type DebugDetails = object;
interface BrowserDebugEvent {
  sequence: number;
  at: string;
  elapsedMs: number;
  scope: string;
  event: string;
  details: { [key: string]: DebugValue };
  truncated?: boolean;
}

export const browserDebugEnabled = typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("debug") === "1";

// Keep the explicit opt-in through App launch and room entry without carrying
// any other source-page parameters or credentials into the destination.
export function withBrowserDebug(target: string, enabled = browserDebugEnabled): string {
  if (!enabled) return target;
  const url = new URL(target, window.location.href);
  url.searchParams.set("debug", "1");
  return url.href;
}

const MAX_EVENTS = 8_192;
const MAX_BYTES = 8 * 1024 * 1024;
const events: Array<{ record: BrowserDebugEvent; bytes: number }> = [];
const startedAt = new Date().toISOString();
const started = performance.now();
let sequence = 0, retainedBytes = 0, evictedEvents = 0, truncatedEvents = 0;
const secretKey = /(?:token|password|passwd|secret|credential|authorization|cookie|private.?key|ice.?pwd|ufrag|usernamefragment|sdp|grant)|^(?:candidate|title|displayName)$/i;

function safeText(value: string): string {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[redacted private key]")
    .replace(/\bv=0\r?\n[\s\S]*/g, "[redacted SDP]")
    .replace(/\b(?:set-cookie|cookie|authorization)\s*:[^\r\n]*/gi, "[redacted credential header]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, "[redacted authorization]")
    .replace(/piik-client-v\d+\.[A-Za-z0-9_-]+/g, "[redacted Client capability]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted token]")
    .replace(/\b(?:[a-z]*token|[a-z]*grant|password|passwd|secret|authorization|cookie|ice-pwd)["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "[redacted credential]")
    .replace(/(?:https?|wss?):\/\/[^\s<>"')]+/gi, (text) => {
      try {
        const url = new URL(text);
        url.username = url.password = url.search = url.hash = "";
        return url.toString();
      } catch { return "[redacted URL]"; }
    })
    .replace(/data:[^\s]+/gi, "[redacted data URL]");
}

function sanitize(value: unknown): { value: DebugValue; truncated: boolean } {
  let remaining = 32_768, nodes = 0, truncated = false;
  const seen = new WeakSet<object>();
  const visit = (input: unknown, depth: number): DebugValue => {
    if (++nodes > 2_048 || depth > 6 || remaining <= 0) {
      truncated = true;
      return "[truncated]";
    }
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : null;
    if (typeof input === "string") {
      const text = safeText(input);
      const length = Math.min(text.length, 8_192, remaining);
      remaining -= length;
      if (length < text.length) truncated = true;
      return text.slice(0, length);
    }
    if (typeof input !== "object") return `[${typeof input}]`;
    if (seen.has(input)) return "[circular]";
    seen.add(input);
    try {
      if (Array.isArray(input)) {
        if (input.length > 64) truncated = true;
        return input.slice(0, 64).map((item) => visit(item, depth + 1));
      }
      const output: { [key: string]: DebugValue } = {};
      const keys = Object.keys(input);
      if (keys.length > 128) truncated = true;
      for (const key of keys.slice(0, 128)) {
        // Codec fmtp parameters are not an SDP description or credential.
        if ((key !== "sdpFmtpLine" && secretKey.test(key)) || /^(?:data|payload|body|__proto__|constructor)$/i.test(key)) continue;
        const name = safeText(key).slice(0, 128);
        remaining -= name.length;
        try { output[name] = visit((input as Record<string, unknown>)[key], depth + 1); }
        catch { output[name] = "[unavailable]"; truncated = true; }
      }
      return output;
    } catch { truncated = true; return { unavailable: true }; }
  };
  return { value: visit(value, 0), truncated };
}

function errorDetails(error: unknown, depth = 0): object {
  if (depth > 3) return { cause: "[truncated]" };
  try {
    if (error instanceof Error || (typeof DOMException !== "undefined" && error instanceof DOMException)) {
      return { name: error.name, message: error.message, stack: error.stack,
        ...("cause" in error ? { cause: errorDetails(error.cause, depth + 1) } : {}) };
    }
    return { message: typeof error === "string" ? error : "Non-Error rejection", value: error };
  } catch { return { message: "Error details unavailable" }; }
}

export function debugEvent(scope: string, event: string, details: DebugDetails = {}): void {
  if (!browserDebugEnabled || !/^[a-z][a-z-]{0,47}$/.test(scope) || !/^[a-z][a-z-]{0,47}$/.test(event)) return;
  try {
    const safe = sanitize(details);
    const record: BrowserDebugEvent = {
      sequence: ++sequence, at: new Date().toISOString(), elapsedMs: performance.now() - started,
      scope, event, details: safe.value as BrowserDebugEvent["details"],
      ...(safe.truncated ? { truncated: true } : {}),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(record)).byteLength;
    events.push({ record, bytes });
    retainedBytes += bytes;
    if (safe.truncated) truncatedEvents++;
    while (events.length > MAX_EVENTS || retainedBytes > MAX_BYTES) {
      retainedBytes -= events.shift()!.bytes;
      evictedEvents++;
    }
    console.info("[piik]", record);
  } catch { /* Diagnostics must not interrupt the operation being observed. */ }
}

export function debugError(scope: string, event: string, error: unknown, details: DebugDetails = {}): void {
  if (browserDebugEnabled) debugEvent(scope, event, { ...details, error: errorDetails(error) });
}

export function debugOperation(scope: string, event: string, details: DebugDetails = {}):
  (outcome: string, result?: DebugDetails, error?: unknown) => void {
  if (!browserDebugEnabled) return () => undefined;
  const operationId = sequence + 1;
  const began = performance.now();
  debugEvent(scope, `${event}-started`, { ...details, operationId });
  return (outcome, result = {}, error) => {
    const completed = { ...result, operationId, outcome, durationMs: performance.now() - began };
    if (error === undefined) debugEvent(scope, `${event}-completed`, completed);
    else debugError(scope, `${event}-completed`, error, completed);
  };
}

function snapshot(): BrowserDebugEvent[] {
  return structuredClone(events.map(({ record }) => record));
}

export async function exportBrowserDebug(): Promise<string> {
  const buildEnvironment = (import.meta as ImportMeta & { env?: Record<string, string> }).env;
  const collectorErrors: object[] = [];
  let environment: object = {};
  try {
    const nav = navigator as Navigator & { userAgentData?: { getHighEntropyValues(hints: string[]): Promise<object> } };
    environment = { userAgent: nav.userAgent, platform: nav.platform, language: nav.language,
      hardwareConcurrency: nav.hardwareConcurrency, visibility: document.visibilityState,
      online: nav.onLine, secureContext: globalThis.isSecureContext };
    if (nav.userAgentData) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const userAgentData = await Promise.race([
          nav.userAgentData.getHighEntropyValues(["fullVersionList", "platformVersion", "architecture"]),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Browser version collection timed out")), 1_000); }),
        ]);
        environment = { ...environment, userAgentData };
      } finally { clearTimeout(timer); }
    }
  } catch (error) { collectorErrors.push({ collector: "environment", error: errorDetails(error) }); }
  const history = snapshot();
  for (const record of history) {
    if (record.event === "collector-failed") collectorErrors.push({ at: record.at, ...record.details });
  }
  return JSON.stringify({
    capturedAt: new Date().toISOString(), startedAt, protocol: SIGNALING_PROTOCOL,
    build: { version: buildEnvironment?.VITE_PIIK_VERSION ?? "development",
      revision: buildEnvironment?.VITE_PIIK_REVISION ?? "development" },
    asset: new URL(import.meta.url).pathname.split("/").at(-1),
    environment: sanitize(environment).value,
    history: { maxEvents: MAX_EVENTS, maxBytes: MAX_BYTES, retainedBytes,
      retainedEvents: history.length, evictedEvents, truncatedEvents,
      firstSequence: history[0]?.sequence ?? null, lastSequence: history.at(-1)?.sequence ?? null,
      firstAt: history[0]?.at ?? null, lastAt: history.at(-1)?.at ?? null },
    partial: evictedEvents > 0 || truncatedEvents > 0 || collectorErrors.length > 0,
    collectorErrors: sanitize(collectorErrors).value,
    events: history,
  }, null, 2);
}

export async function downloadBrowserDebug(): Promise<void> {
  const blob = new Blob([await exportBrowserDebug()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = `piik-browser-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    link.click();
  } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
}

export function installBrowserDebug(): (() => void) | undefined {
  if (!browserDebugEnabled) return;
  window.__PIIK_DEBUG__ = {
    events: snapshot,
    clear: () => { evictedEvents += events.length; events.length = 0; retainedBytes = 0; },
    export: exportBrowserDebug,
  };
  const reportError = (event: ErrorEvent) => debugError("window", "error", event.error ?? event.message);
  const reportRejection = (event: PromiseRejectionEvent) => debugError("window", "unhandled-rejection", event.reason);
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
    __PIIK_DEBUG__?: {
      events: () => readonly BrowserDebugEvent[];
      clear: () => void;
      export: () => Promise<string>;
    };
  }
}
