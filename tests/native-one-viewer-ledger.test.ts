import { describe, expect, it, vi } from "vitest";

import {
  SenderStartLedger,
  senderStartComplete,
  waitForSenderStart,
  type SenderStartObservation,
} from "../scripts/native-one-viewer-ledger";

describe("native one-viewer sender-start ledger", () => {
  it("retains the last sanitized stage when an intermediate wait times out", async () => {
    const committed: ReturnType<SenderStartLedger["snapshot"]>[] = [];
    const ledger = new SenderStartLedger((record) => committed.push({ ...record }));
    const samples: Array<Partial<SenderStartObservation>> = [
      { getDisplayMediaRequested: true },
      {
        getDisplayMediaResolved: true,
        hostAdmissionAccepted: true,
        roomCreated: true,
      },
      {
        hostWssAuthenticated: true,
        bridgeConnected: true,
        fixedHighConfigured: true,
        firstEncodedChunk: true,
        bridgeGeneration: 1,
        binarySendAttempts: 1,
        binarySendSucceeded: 1,
        encoderInstances: 1,
        diagnosticsObserved: true,
        postSendDiagnosticsObserved: true,
        postSendDiagnosticsSequence: 1,
        framesWritten: 4,
      },
    ];
    let elapsed = 0;

    await expect(
      waitForSenderStart(
        async () => samples.shift() ?? {},
        ledger,
        {
          timeoutMs: 10,
          pollMs: 5,
          now: () => elapsed,
          sleep: async (milliseconds) => { elapsed += milliseconds; },
        },
      ),
    ).rejects.toThrow("Sender-start stage timed out");

    expect(committed.at(-1)).toEqual({
      schemaVersion: 1,
      sequence: 3,
      getDisplayMediaRequested: true,
      getDisplayMediaResolved: true,
      hostAdmissionAccepted: true,
      roomCreated: true,
      hostWssAuthenticated: true,
      bridgeConnected: true,
      fixedHighConfigured: true,
      firstEncodedChunk: true,
      bridgeGeneration: 1,
      binarySendAttempts: 1,
      binarySendSucceeded: 1,
      binarySendFailed: 0,
      encoderInstances: 1,
      diagnosticsObserved: true,
      postSendDiagnosticsObserved: true,
      postSendDiagnosticsSequence: 1,
      encoderErrors: 0,
      fatalEvents: 0,
      framesWritten: 4,
      sourceRtpPacketsWritten: 0,
      sourceRtpBytesWritten: 0,
    });
    expect(JSON.stringify(committed)).not.toMatch(/token|url|ip|sdp/i);
    expect(committed.flatMap(Object.values).every((value) => typeof value !== "string")).toBe(true);
  });

  it("fails closed and bounds evidence when the bridge generation changes", () => {
    const ledger = new SenderStartLedger();
    ledger.record({
      getDisplayMediaRequested: true,
      getDisplayMediaResolved: true,
      hostAdmissionAccepted: true,
      roomCreated: true,
      hostWssAuthenticated: true,
      bridgeConnected: true,
      fixedHighConfigured: true,
      firstEncodedChunk: true,
      bridgeGeneration: 1,
      binarySendAttempts: Number.MAX_SAFE_INTEGER,
      binarySendSucceeded: Number.MAX_SAFE_INTEGER,
      encoderInstances: 1,
      diagnosticsObserved: true,
      postSendDiagnosticsObserved: true,
      postSendDiagnosticsSequence: 99,
      encoderErrors: 99,
      fatalEvents: 99,
      framesWritten: 1,
      sourceRtpPacketsWritten: 1,
    });
    ledger.record({ bridgeGeneration: 99, binarySendFailed: 1 });

    const snapshot = ledger.snapshot();
    expect(snapshot).toMatchObject({
      bridgeGeneration: 2,
      binarySendAttempts: 1_000_000_000,
      binarySendSucceeded: 1_000_000_000,
      binarySendFailed: 1,
      postSendDiagnosticsSequence: 2,
      encoderErrors: 1,
      fatalEvents: 1,
    });
    expect(senderStartComplete({ ...snapshot, binarySendFailed: 0 })).toBe(false);
    expect(senderStartComplete({ ...snapshot, bridgeGeneration: 1 })).toBe(false);
  });

  it("bounds a sender snapshot that never settles", async () => {
    vi.useFakeTimers();
    try {
      const pending = waitForSenderStart(
        () => new Promise<never>(() => undefined),
        new SenderStartLedger(),
        { timeoutMs: 25 },
      );
      const assertion = expect(pending).rejects.toThrow("Sender-start stage timed out");
      await vi.advanceTimersByTimeAsync(30);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
