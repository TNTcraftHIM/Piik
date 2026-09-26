import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import { EMPTY_METRICS } from "../src/client/types";
import type { ViewerPeerEvents } from "../src/client/webrtc/viewer-peer";

// Exercise the page's actual media callbacks, without needing a physical game.
const source = ts.createSourceFile("ViewerPage.tsx", readFileSync(
  new URL("../src/client/pages/ViewerPage.tsx", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const owners = new Set(["ensurePeer", "reportActivePeerFailure"]);
const functions: string[] = [];
function collect(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name && owners.delete(node.name.text)) {
    functions.push(node.getText(source));
  }
  ts.forEachChild(node, collect);
}
collect(source);
if (owners.size) throw new Error("Viewer route owner was not found");
const executable = ts.transpile(functions.join("\n"), { target: ts.ScriptTarget.ES2022 });

afterEach(() => vi.useRealTimers());

it("retains a connected route through quiet video and still reports actual recovery exhaustion", () => {
  vi.useFakeTimers();
  let events!: ViewerPeerEvents;
  const peer = {
    isRecovering: () => false,
    getConnectionIdentity: () => ({ parentPeerId: "host", connectionId: "edge" }),
    hasConnectionId: (id: string) => id === "edge",
  };
  const send = vi.fn();
  const reportPeerFailure = vi.fn(() => true);
  const setPeerSnapshot = vi.fn();
  const context = createContext({
    Date, active: true, currentHostOnline: true,
    currentIceConfig: { iceServers: [] }, currentRoutePolicy: { natPrediction: false },
    currentRouteRevision: 1, currentRouteAssignment: { upstream: { kind: "peer", peerId: "host" } },
    activePeerMetrics: null, peerRef: { current: null },
    signal: { send }, viewerSfuRoute: { reportPeerFailure },
    createViewerMediaPeer: (_config: unknown, callbacks: ViewerPeerEvents) => { events = callbacks; return peer; },
    createOwnedViewerRestartSender: () => vi.fn(),
    offerPeerQualityEvidence: vi.fn(), setPeerSnapshot,
    dispatchPresentation: vi.fn(), connectionFact: (state: string) => state,
  });
  runInContext(executable + "\nensurePeer();", context);
  const snapshot = {
    peerId: "host", connectionId: "edge", connectionState: "connected" as const,
    metrics: { ...EMPTY_METRICS, intervalFramesDecoded: 0 },
  };
  // Silence also occurs for a live, minimized source; elapsed time cannot locate
  // the fault in a route, even if audio or incomplete video packets still arrive.
  for (let second = 0; second < 40; second += 2) {
    vi.advanceTimersByTime(2_000);
    events.onUpdate(snapshot as Parameters<ViewerPeerEvents["onUpdate"]>[0]);
  }
  events.onUpdate({ ...snapshot, metrics: { ...snapshot.metrics, intervalFramesDecoded: 30 } } as Parameters<ViewerPeerEvents["onUpdate"]>[0]);
  expect(send).not.toHaveBeenCalled();
  expect(reportPeerFailure).not.toHaveBeenCalled();
  expect(setPeerSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({
    metrics: expect.objectContaining({ intervalFramesDecoded: 30 }),
  }));
  events.onRecoveryExhausted?.("host", "edge");
  expect(reportPeerFailure).toHaveBeenCalledExactlyOnceWith("host", "edge");
});
