import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import {
  captureOneViewerIdentity,
  fetchJsonBefore,
  finalizeGate,
  isExactGateProfile,
  retainsFirstBridgeSend,
  retainsOneViewerIdentity,
  waitForSample,
  type CleanupResult,
  type SenderIdentityEvidence,
  type ViewerIdentityEvidence,
} from "../scripts/native-one-viewer-gate-core";
import { profileCleanupScript, senderProbe } from "../scripts/native-one-viewer-gate";

const viewer: ViewerIdentityEvidence = {
  socketCount: 1, socketOrdinal: 1, authGeneration: 1,
  connectionCount: 1, connectionOrdinal: 1, pcCount: 1, pcOrdinal: 1,
  trackCount: 1, trackOrdinal: 1, consistent: true,
};
const sender: SenderIdentityEvidence = {
  peerCount: 1, maxPeers: 1, slot: 1, edgeGeneration: 1,
};
const clean: CleanupResult = {
  browserExited: true, nativeExited: true, serverClosed: true,
  portsClosed: true, profileRemoved: true,
};

interface BridgeProbeSnapshot {
  bridgeGeneration: number;
  binarySendAttempts: number;
  binarySendSucceeded: number;
  binarySendFailed: number;
}

class ProbeWebSocket {
  failBinary = false;

  constructor(..._args: unknown[]) {}
  addEventListener(..._args: unknown[]): void {}
  send(value: unknown): void {
    if (this.failBinary && value instanceof ArrayBuffer) throw new Error("not retained");
  }
}

function bridgeProbeContext(): {
  WebSocket: typeof ProbeWebSocket;
  snapshot: () => BridgeProbeSnapshot;
} {
  const context: Record<string, unknown> = {
    ArrayBuffer,
    URL,
    structuredClone,
    location: { href: "http://127.0.0.1/" },
    navigator: { mediaDevices: { getDisplayMedia: async () => ({}) } },
    WebSocket: ProbeWebSocket,
  };
  runInNewContext(senderProbe(), context);
  return {
    WebSocket: context.WebSocket as typeof ProbeWebSocket,
    snapshot: (context.__NATIVE_ONE_VIEWER_GATE__ as { snapshot(): BridgeProbeSnapshot }).snapshot,
  };
}

describe("native one-viewer gate invariants", () => {
  it("rejects cumulative evidence from a rebuilt Viewer PC", () => {
    const baseline = captureOneViewerIdentity(viewer, sender);
    expect(baseline).not.toBeNull();
    expect(retainsOneViewerIdentity(baseline!, {
      ...viewer, connectionCount: 2, connectionOrdinal: 2, pcCount: 2, pcOrdinal: 2,
    }, sender)).toBe(false);
  });

  it("rejects a missing Pion slot", () => {
    expect(captureOneViewerIdentity(viewer, { ...sender, slot: 0 })).toBeNull();
  });

  it("records only the current local bridge binary-send outcome", () => {
    const successful = bridgeProbeContext();
    const first = new successful.WebSocket("ws://127.0.0.1/media");
    first.send("config");
    first.send(new ArrayBuffer(1));
    expect(successful.snapshot()).toMatchObject({
      bridgeGeneration: 1,
      binarySendAttempts: 1,
      binarySendSucceeded: 1,
      binarySendFailed: 0,
    });

    const replacement = new successful.WebSocket("ws://127.0.0.1/media");
    replacement.send(new ArrayBuffer(1));
    expect(successful.snapshot()).toMatchObject({
      bridgeGeneration: 2,
      binarySendAttempts: 1,
      binarySendSucceeded: 1,
      binarySendFailed: 0,
    });

    const failed = bridgeProbeContext();
    const throwing = new failed.WebSocket("ws://127.0.0.1/media");
    throwing.failBinary = true;
    expect(() => throwing.send(new ArrayBuffer(1))).toThrow("not retained");
    expect(failed.snapshot()).toMatchObject({
      bridgeGeneration: 1,
      binarySendAttempts: 1,
      binarySendSucceeded: 0,
      binarySendFailed: 1,
    });
  });

  it("rejects a late bridge replacement at every post-start gate", () => {
    const senderStart = {
      bridgeGeneration: 1,
      binarySendAttempts: 1,
      binarySendSucceeded: 1,
      binarySendFailed: 0,
    };
    expect(retainsFirstBridgeSend(senderStart)).toBe(true);

    const replaced = { ...senderStart, bridgeGeneration: 2 };
    expect({
      viewerSignal: retainsFirstBridgeSend(replaced),
      viewerMedia: retainsFirstBridgeSend(replaced),
      finalSuccess: retainsFirstBridgeSend(replaced),
    }).toEqual({ viewerSignal: false, viewerMedia: false, finalSuccess: false });
  });

  it("bounds Chrome version headers and body with one abort deadline", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const headers = fetchJsonBefore("http://gate.invalid", Date.now() + 25,
        async (_url, init) => {
          signals.push(init.signal);
          return new Promise<never>(() => undefined);
        });
      const body = fetchJsonBefore("http://gate.invalid", Date.now() + 25,
        async (_url, init) => {
          signals.push(init.signal);
          return { ok: true, json: () => new Promise<never>(() => undefined) };
        });
      const headerAssertion = expect(headers).rejects.toThrow("Operation deadline exceeded");
      const bodyAssertion = expect(body).rejects.toThrow("Operation deadline exceeded");
      await vi.advanceTimersByTimeAsync(30);
      await Promise.all([headerAssertion, bodyAssertion]);
      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a hung browser sample by the stage deadline", async () => {
    vi.useFakeTimers();
    try {
      const pending = waitForSample(() => new Promise<never>(() => undefined), () => true, 25, 5);
      const assertion = expect(pending).rejects.toThrow("Bounded browser stage timed out");
      await vi.advanceTimersByTimeAsync(30);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("cannot pass before cleanup and fails when profile removal fails", async () => {
    const report = { status: "failed" as const, failedStage: "viewer-media" as string | null,
      stages: {} };
    let release!: (result: CleanupResult) => void;
    const cleanup = new Promise<CleanupResult>((resolve) => { release = resolve; });
    const finishing = finalizeGate(report, true, () => cleanup);
    await Promise.resolve();
    expect(report.status).toBe("failed");
    release(clean);
    await finishing;
    expect(report).toMatchObject({ status: "passed", failedStage: null });

    const failed = { status: "failed" as const, failedStage: null as string | null, stages: {} };
    await finalizeGate(failed, true, async () => ({ ...clean, profileRemoved: false }));
    expect(failed).toMatchObject({ status: "failed", failedStage: "cleanup" });
  });

  it("accepts only the exact task profile directly under system Temp", () => {
    const temp = join("C:", "Temp");
    expect(isExactGateProfile(join(temp, "screener-native-one-viewer-a1B_2-"), temp)).toBe(true);
    expect(isExactGateProfile(join(temp, "nested", "screener-native-one-viewer-a1B_2-"), temp)).toBe(false);
    expect(isExactGateProfile(join(temp, "other-a1B_2-"), temp)).toBe(false);
    expect(profileCleanupScript).toContain("EnumerateFileSystemEntries($parent, $name");
    expect(profileCleanupScript).toContain("GetAttributes($root)");
    expect(profileCleanupScript).not.toMatch(/\[IO\.(?:File|Directory)\]::Exists/);
  });
});
