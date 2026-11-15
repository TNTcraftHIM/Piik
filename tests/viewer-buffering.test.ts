import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";

// Exercise the production page's receiver ownership, without a room or devices.
const file = ts.createSourceFile("ViewerPage.tsx", readFileSync(new URL("../src/client/pages/ViewerPage.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(["createViewerMediaPeer", "refreshScreenBufferStatus", "changeScreenBuffer"]);
const functions: string[] = [];
let apply = "";
function collect(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text)) functions.push(node.getText(file));
  if (ts.isBinaryExpression(node) && node.left.getText(file) === "applyScreenBufferRef.current" && ts.isArrowFunction(node.right)) apply = node.getText(file);
  ts.forEachChild(node, collect);
}
collect(file);
const executable = ts.transpileModule(`${functions.join("\n")}\n${apply};\n({createViewerMediaPeer, refreshScreenBufferStatus, changeScreenBuffer});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function page() {
  class Peer {
    status: "supported" | "unsupported" = "supported";
    target: number | null;
    constructor(_ice: unknown, readonly events: { onPlaybackBufferStatus(): void }, options: { playbackBufferTargetMs: number | null }) { this.target = options.playbackBufferTargetMs; }
    getPlaybackBufferStatus() { return this.status; }
    setPlaybackBufferTarget(target: number | null) { this.target = target; this.events.onPlaybackBufferStatus(); }
  }
  const route = { getPlaybackBufferStatus: () => "failed", setPlaybackBufferTarget: vi.fn() };
  const owner = {
    active: true, currentRouteAssignment: null as { upstream: { kind: "peer" | "sfu" } } | null,
    peerRef: { current: null as Peer | null }, pendingPeer: null as { peer: Peer } | null,
    viewerSfuRoute: route, screenBufferTargetRef: { current: 700 as number | null }, applyScreenBufferRef: { current: null as ((target: number | null) => void) | null },
    setScreenBufferStatus: vi.fn(), setScreenBufferTargetMs: vi.fn(), saveRoomPreferences: vi.fn(),
    clientActivationRef: { current: false }, ViewerPeer: Peer, NativeCapableViewerPeer: Peer,
  };
  const controller = runInNewContext(executable, owner) as {
    createViewerMediaPeer(ice: object, events: object, options: object): Peer;
    refreshScreenBufferStatus(): void;
    changeScreenBuffer(target: number | null): void;
  };
  return { ...controller, owner, route };
}

it("inherits the latest target and only publishes the active receiver's support", () => {
  const current = page();
  const active = current.createViewerMediaPeer({}, {}, {});
  const pending = current.createViewerMediaPeer({}, {}, {});
  expect(active.target).toBe(700);
  expect(pending.target).toBe(700);
  current.owner.peerRef.current = active;
  current.owner.pendingPeer = { peer: pending };
  pending.status = "unsupported";
  pending.events.onPlaybackBufferStatus();
  expect(current.owner.setScreenBufferStatus).not.toHaveBeenCalled();
  active.events.onPlaybackBufferStatus();
  expect(current.owner.setScreenBufferStatus).toHaveBeenLastCalledWith("supported");
  current.owner.peerRef.current = pending;
  current.refreshScreenBufferStatus();
  expect(current.owner.setScreenBufferStatus).toHaveBeenLastCalledWith("unsupported");
  current.owner.currentRouteAssignment = { upstream: { kind: "sfu" } };
  active.events.onPlaybackBufferStatus();
  current.refreshScreenBufferStatus();
  expect(current.owner.setScreenBufferStatus).toHaveBeenLastCalledWith("failed");
  current.owner.active = false;
  current.owner.setScreenBufferStatus.mockClear();
  pending.events.onPlaybackBufferStatus();
  expect(current.owner.setScreenBufferStatus).not.toHaveBeenCalled();
});

it("applies zero and automatic to active, prepared and future routes without replacing them", () => {
  const current = page();
  const active = current.createViewerMediaPeer({}, {}, {});
  const pending = current.createViewerMediaPeer({}, {}, {});
  current.owner.peerRef.current = active;
  current.owner.pendingPeer = { peer: pending };
  for (const target of [0, null]) {
    current.changeScreenBuffer(target);
    expect(active.target).toBe(target);
    expect(pending.target).toBe(target);
    expect(current.route.setPlaybackBufferTarget).toHaveBeenLastCalledWith(target);
    expect(current.owner.saveRoomPreferences).toHaveBeenLastCalledWith({ screenBufferTargetMs: target });
    expect(current.createViewerMediaPeer({}, {}, {}).target).toBe(target);
    expect(current.owner.peerRef.current).toBe(active);
  }
});
