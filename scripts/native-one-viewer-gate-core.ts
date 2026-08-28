import type { CleanupResult } from "./browser-gate-harness";

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

export interface CriticalSenderEvidence {
  encoderErrors: number;
  fatalEvents: number;
}

export interface OneViewerMediaCounters {
  viewerPackets: number;
  viewerDecoded: number;
  viewerRendered: number;
  pionPackets: number;
  pionBytes: number;
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

export function hasNoCriticalSenderErrors(evidence: CriticalSenderEvidence): boolean {
  return evidence.encoderErrors === 0 && evidence.fatalEvents === 0;
}

export function hasOneViewerPionProof(
  sameGeneration: boolean,
  before: OneViewerMediaCounters,
  current: OneViewerMediaCounters,
): boolean {
  const viewerAdvanced = current.viewerPackets > before.viewerPackets &&
    current.viewerDecoded > before.viewerDecoded && current.viewerRendered > before.viewerRendered;
  const pionAdvanced = current.pionPackets > before.pionPackets && current.pionBytes > before.pionBytes;
  // Viewer growth proves the current window when the 2s Pion diagnostics snapshot has not advanced.
  const pionAbsolute = current.pionPackets > 0 && current.pionBytes > 0;
  return sameGeneration && viewerAdvanced && (pionAdvanced || pionAbsolute);
}

export async function verifyFinalSenderEvidence<T extends CriticalSenderEvidence>(
  sample: () => Promise<T>,
  retain: (evidence: T) => CriticalSenderEvidence,
): Promise<boolean> {
  try {
    const evidence = await sample();
    const retained = retain(evidence);
    return hasNoCriticalSenderErrors(evidence) && hasNoCriticalSenderErrors(retained);
  } catch {
    return false;
  }
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
