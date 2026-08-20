import { basename, dirname, resolve } from "node:path";

export interface ViewerIdentityEvidence {
  socketCount: number;
  socketOrdinal: number;
  authGeneration: number;
  connectionCount: number;
  connectionOrdinal: number;
  pcCount: number;
  pcOrdinal: number;
  trackCount: number;
  trackOrdinal: number;
  consistent: boolean;
}

export interface SenderIdentityEvidence {
  peerCount: number;
  maxPeers: number;
  slot: number;
  edgeGeneration: number;
}

export interface BridgeSendEvidence {
  bridgeGeneration: number;
  binarySendAttempts: number;
  binarySendSucceeded: number;
  binarySendFailed: number;
}

export interface OneViewerIdentity {
  socketOrdinal: number;
  authGeneration: number;
  connectionOrdinal: number;
  pcOrdinal: number;
  trackOrdinal: number;
  pionSlot: number;
  pionEdgeGeneration: number;
}

export interface CleanupResult {
  browserExited: boolean;
  nativeExited: boolean;
  serverClosed: boolean;
  portsClosed: boolean;
  profileRemoved: boolean;
}

interface FinalizableReport {
  status: "passed" | "failed";
  failedStage: string | null;
  stages: Record<string, Record<string, boolean | number | string | null> | undefined>;
}

export function captureOneViewerIdentity(
  viewer: ViewerIdentityEvidence,
  sender: SenderIdentityEvidence,
): OneViewerIdentity | null {
  if (!viewer.consistent || viewer.socketCount !== 1 || viewer.authGeneration !== 1 ||
    viewer.connectionCount !== 1 || viewer.pcCount !== 1 || viewer.trackCount !== 1 ||
    sender.peerCount !== 1 || sender.maxPeers > 1 || sender.edgeGeneration !== 1 ||
    viewer.socketOrdinal !== 1 || viewer.connectionOrdinal !== 1 || viewer.pcOrdinal !== 1 ||
    viewer.trackOrdinal !== 1 || sender.slot <= 0) return null;
  return {
    socketOrdinal: viewer.socketOrdinal,
    authGeneration: viewer.authGeneration,
    connectionOrdinal: viewer.connectionOrdinal,
    pcOrdinal: viewer.pcOrdinal,
    trackOrdinal: viewer.trackOrdinal,
    pionSlot: sender.slot,
    pionEdgeGeneration: sender.edgeGeneration,
  };
}

export function retainsOneViewerIdentity(
  baseline: OneViewerIdentity,
  viewer: ViewerIdentityEvidence,
  sender: SenderIdentityEvidence,
): boolean {
  const current = captureOneViewerIdentity(viewer, sender);
  return current !== null && Object.keys(baseline).every(
    (key) => current[key as keyof OneViewerIdentity] === baseline[key as keyof OneViewerIdentity],
  );
}

export function retainsFirstBridgeSend(evidence: BridgeSendEvidence): boolean {
  return evidence.bridgeGeneration === 1 && evidence.binarySendAttempts > 0 &&
    evidence.binarySendSucceeded > 0 && evidence.binarySendFailed === 0;
}

export function withDeadline<T>(
  operation: () => Promise<T>,
  deadline: number,
  now: () => number = Date.now,
): Promise<T> {
  const remaining = Math.max(0, deadline - now());
  return new Promise<T>((resolveValue, rejectValue) => {
    const timeout = setTimeout(() => rejectValue(new Error("Operation deadline exceeded")), remaining);
    Promise.resolve().then(operation).then(
      (value) => { clearTimeout(timeout); resolveValue(value); },
      (error: unknown) => { clearTimeout(timeout); rejectValue(error); },
    );
  });
}

type JsonFetch = (
  input: string,
  init: { signal: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export async function fetchJsonBefore<T>(
  url: string,
  deadline: number,
  fetcher: JsonFetch = fetch,
): Promise<T> {
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
  try {
    const response = await withDeadline(
      () => fetcher(url, { signal: controller.signal }),
      deadline,
    );
    if (!response.ok) throw new Error("HTTP response was not successful");
    return await withDeadline(() => response.json() as Promise<T>, deadline);
  } finally {
    clearTimeout(abort);
    controller.abort();
  }
}

export async function waitForSample<T>(
  sample: (deadline: number) => Promise<T>,
  retainAndAccept: (value: T) => boolean,
  timeoutMs: number,
  pollMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let value: T | undefined;
    try { value = await withDeadline(() => sample(deadline), deadline); } catch {}
    if (value !== undefined && retainAndAccept(value)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
  throw new Error("Bounded browser stage timed out");
}

export async function finalizeGate(
  report: FinalizableReport,
  gateSucceeded: boolean,
  cleanup: () => Promise<CleanupResult>,
): Promise<void> {
  let result: CleanupResult;
  try {
    result = await cleanup();
  } catch {
    result = { browserExited: false, nativeExited: false, serverClosed: false,
      portsClosed: false, profileRemoved: false };
  }
  const complete = Object.values(result).every(Boolean);
  report.stages.cleanup = { ...result, complete };
  if (gateSucceeded && complete) {
    report.status = "passed";
    report.failedStage = null;
  } else if (!complete) {
    report.status = "failed";
    report.failedStage = "cleanup";
  }
}

export function isExactGateProfile(profile: string, systemTemp: string): boolean {
  const candidate = resolve(profile);
  const temp = resolve(systemTemp);
  const same = process.platform === "win32"
    ? dirname(candidate).toLowerCase() === temp.toLowerCase()
    : dirname(candidate) === temp;
  return same && /^screener-native-one-viewer-[A-Za-z0-9_-]{6}$/.test(basename(candidate));
}
