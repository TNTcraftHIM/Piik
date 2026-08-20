export interface SenderStartObservation {
  getDisplayMediaRequested: boolean;
  getDisplayMediaResolved: boolean;
  hostAdmissionAccepted: boolean;
  roomCreated: boolean;
  hostWssAuthenticated: boolean;
  bridgeConnected: boolean;
  fixedHighConfigured: boolean;
  firstEncodedChunk: boolean;
  bridgeGeneration: number;
  binarySendAttempts: number;
  binarySendSucceeded: number;
  binarySendFailed: number;
  encoderInstances: number;
  diagnosticsObserved: boolean;
  postSendDiagnosticsObserved: boolean;
  postSendDiagnosticsSequence: number;
  encoderErrors: number;
  fatalEvents: number;
  framesWritten: number;
  sourceRtpPacketsWritten: number;
  sourceRtpBytesWritten: number;
}

export interface SenderStartLedgerRecord extends SenderStartObservation {
  schemaVersion: 1;
  sequence: number;
}

type LedgerSink = (record: Readonly<SenderStartLedgerRecord>) => void;

const initialObservation: SenderStartObservation = {
  getDisplayMediaRequested: false,
  getDisplayMediaResolved: false,
  hostAdmissionAccepted: false,
  roomCreated: false,
  hostWssAuthenticated: false,
  bridgeConnected: false,
  fixedHighConfigured: false,
  firstEncodedChunk: false,
  bridgeGeneration: 0,
  binarySendAttempts: 0,
  binarySendSucceeded: 0,
  binarySendFailed: 0,
  encoderInstances: 0,
  diagnosticsObserved: false,
  postSendDiagnosticsObserved: false,
  postSendDiagnosticsSequence: 0,
  encoderErrors: 0,
  fatalEvents: 0,
  framesWritten: 0,
  sourceRtpPacketsWritten: 0,
  sourceRtpBytesWritten: 0,
};

const booleanKeys = [
  "getDisplayMediaRequested",
  "getDisplayMediaResolved",
  "hostAdmissionAccepted",
  "roomCreated",
  "hostWssAuthenticated",
  "bridgeConnected",
  "fixedHighConfigured",
  "firstEncodedChunk",
  "diagnosticsObserved",
  "postSendDiagnosticsObserved",
] as const;

const counterKeys = [
  "binarySendAttempts",
  "binarySendSucceeded",
  "binarySendFailed",
  "encoderInstances",
  "framesWritten",
  "sourceRtpPacketsWritten",
  "sourceRtpBytesWritten",
] as const;

// The first positive value is enough for this stage and bounds the append-only
// ledger to at most one record per field transition.
const counterLimit = 1_000_000_000;
const singleEventCounterKeys = ["encoderErrors", "fatalEvents"] as const;

export class SenderStartLedger {
  private observation = { ...initialObservation };
  private sequence = 0;

  constructor(private readonly sink: LedgerSink = () => undefined) {}

  record(patch: Partial<SenderStartObservation>): void {
    const next = { ...this.observation };
    for (const key of booleanKeys) {
      if (patch[key] === true) next[key] = true;
    }
    for (const key of counterKeys) {
      const value = patch[key];
      if (next[key] === 0 && typeof value === "number" && Number.isFinite(value) && value > 0) {
        next[key] = Math.min(Math.floor(value), counterLimit);
      }
    }
    for (const key of singleEventCounterKeys) {
      if (typeof patch[key] === "number" && patch[key] > 0) next[key] = 1;
    }
    const diagnosticsSequence = patch.postSendDiagnosticsSequence;
    if (typeof diagnosticsSequence === "number" && Number.isFinite(diagnosticsSequence) &&
      diagnosticsSequence > next.postSendDiagnosticsSequence) {
      next.postSendDiagnosticsSequence = Math.min(Math.floor(diagnosticsSequence), 2);
    }
    const bridgeGeneration = patch.bridgeGeneration;
    if (typeof bridgeGeneration === "number" && Number.isFinite(bridgeGeneration) &&
      bridgeGeneration > next.bridgeGeneration) {
      next.bridgeGeneration = Math.min(Math.floor(bridgeGeneration), 2);
    }
    if (JSON.stringify(next) === JSON.stringify(this.observation)) return;
    this.observation = next;
    this.sequence += 1;
    this.sink(Object.freeze(this.snapshot()));
  }

  snapshot(): SenderStartLedgerRecord {
    return {
      schemaVersion: 1,
      sequence: this.sequence,
      ...this.observation,
    };
  }
}

export function senderStartComplete(record: SenderStartObservation): boolean {
  return booleanKeys.every((key) => record[key]) && record.encoderInstances === 1 &&
    record.bridgeGeneration === 1 && record.binarySendAttempts > 0 &&
    record.binarySendSucceeded > 0 && record.binarySendFailed === 0 &&
    record.postSendDiagnosticsSequence > 0 &&
    record.framesWritten > 0 && record.sourceRtpPacketsWritten > 0;
}

interface WaitOptions {
  timeoutMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function waitForSenderStart(
  sample: (deadline: number) => Promise<Partial<SenderStartObservation>>,
  ledger: SenderStartLedger,
  options: WaitOptions,
): Promise<SenderStartLedgerRecord> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const deadline = now() + options.timeoutMs;
  for (;;) {
    let observation: Partial<SenderStartObservation> | undefined;
    try {
      observation = await settleBefore(sample(deadline), Math.max(0, deadline - now()));
    } catch {
      // A failed sample cannot erase the last synchronously committed stage.
    }
    if (observation) ledger.record(observation);
    const current = ledger.snapshot();
    if (senderStartComplete(current)) return current;
    if (now() >= deadline) throw new Error("Sender-start stage timed out");
    await sleep(options.pollMs ?? 100);
  }
}

function settleBefore<T>(pending: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Sender-start sample timed out")), milliseconds);
    pending.then(
      (value) => { clearTimeout(timeout); resolve(value); },
      (error: unknown) => { clearTimeout(timeout); reject(error); },
    );
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
