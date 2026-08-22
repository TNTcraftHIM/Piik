import { describe, expect, it } from "vitest";

import type { SelectedEdgeTurnIdentity } from "../src/server/selected-edge-turn.ts";
import { TurnAllocationAdmission } from "../src/server/turn-allocation-admission.ts";

function peerFence(
  roomId: string,
  viewerPeerId: string,
  newConnectionId = `connection-${roomId}-${viewerPeerId}`,
): SelectedEdgeTurnIdentity {
  return {
    edgeKind: "peer-selected",
    roomId,
    shareGeneration: `share-${roomId}`,
    revision: 3,
    parentPeerId: `parent-${viewerPeerId}`,
    parentSessionId: `parent-session-${viewerPeerId}`,
    viewerPeerId,
    viewerSessionId: `viewer-session-${viewerPeerId}`,
    oldConnectionId: `old-${viewerPeerId}`,
    newConnectionId,
  };
}

function ingressFence(roomId: string): SelectedEdgeTurnIdentity {
  return {
    edgeKind: "host-sfu-ingress",
    roomId,
    shareGeneration: `share-${roomId}`,
    revision: 4,
    hostPeerId: `host-${roomId}`,
    hostSessionId: `host-session-${roomId}`,
    publicationGeneration: `publication-${roomId}`,
    oldConnectionId: `publication-${roomId}`,
    newConnectionId: `ingress-${roomId}`,
  };
}

describe("TURN allocation admission", () => {
  it("admits independent peer and Host-SFU edges up to deployment capacity", () => {
    const admission = new TurnAllocationAdmission({ capacity: 3 });
    const first = peerFence("room-a", "viewer-a");
    const second = peerFence("room-a", "viewer-b");
    const ingress = ingressFence("room-b");

    expect(admission.reserve(first)).toBe(true);
    expect(admission.reserve(second)).toBe(true);
    expect(admission.reserve(ingress)).toBe(true);
    expect(admission.usage()).toEqual({ allocations: 3 });
  });

  it("keeps reserve, commit, and drain charged until exact completion", () => {
    const admission = new TurnAllocationAdmission({ capacity: 1 });
    const fence = peerFence("room-a", "viewer-a");

    expect(admission.reserve(fence)).toBe(true);
    expect(admission.reserve(fence)).toBe(true);
    expect(admission.state(fence)).toBe("reserved");
    expect(admission.commit(fence)).toBe(true);
    expect(admission.commit(fence)).toBe(true);
    expect(admission.state(fence)).toBe("committed");
    expect(admission.beginDrain(fence)).toBe(true);
    expect(admission.beginDrain(fence)).toBe(true);
    expect(admission.state(fence)).toBe("draining");
    expect(admission.usage()).toEqual({ allocations: 1 });
    expect(admission.completeDrain(fence)).toBe(true);
    expect(admission.completeDrain(fence)).toBe(false);
    expect(admission.usage()).toEqual({ allocations: 0 });
  });

  it("rejects stale exact identity and allocation ID reuse", () => {
    const admission = new TurnAllocationAdmission({ capacity: 2 });
    const current = peerFence("room-a", "viewer-a", "same-connection");
    const staleRevision = { ...current, revision: current.revision - 1 };
    const staleGeneration = {
      ...current,
      shareGeneration: `${current.shareGeneration}-stale`,
    };
    const wrongEdge = peerFence("room-a", "viewer-b", "same-connection");

    expect(admission.reserve(current)).toBe(true);
    expect(admission.reserve(staleRevision)).toBe(false);
    expect(admission.reserve(staleGeneration)).toBe(false);
    expect(admission.reserve(wrongEdge)).toBe(false);
    expect(admission.commit(staleRevision)).toBe(false);
    expect(admission.beginDrain(staleGeneration)).toBe(false);
    expect(admission.beginDrain(wrongEdge)).toBe(false);
    expect(admission.state(current)).toBe("reserved");
    expect(admission.usage()).toEqual({ allocations: 1 });
    expect(admission.beginDrain(current)).toBe(true);
    expect(admission.completeDrain(current)).toBe(true);
    expect(admission.usage()).toEqual({ allocations: 0 });
  });

  it("shares capacity exhaustion between Host ingress and peer edges", () => {
    const admission = new TurnAllocationAdmission({ capacity: 1 });
    const first = ingressFence("room-a");
    const second = peerFence("room-b", "viewer-b");

    expect(admission.reserve(first)).toBe(true);
    expect(admission.reserve(second)).toBe(false);
    expect(admission.state(first)).toBe("reserved");
    expect(admission.state(second)).toBeUndefined();
    expect(admission.usage()).toEqual({ allocations: 1 });
  });

  it("returns capacity exhaustion immediately without queueing a retry", () => {
    const admission = new TurnAllocationAdmission({ capacity: 1 });
    const active = ingressFence("room-a");
    const rejected = peerFence("room-b", "viewer-b");

    expect(admission.reserve(active)).toBe(true);
    expect(admission.reserve(rejected)).toBe(false);
    expect(admission.beginDrain(active)).toBe(true);
    expect(admission.completeDrain(active)).toBe(true);
    expect(admission.state(rejected)).toBeUndefined();
    expect(admission.usage()).toEqual({ allocations: 0 });
    expect(admission.reserve(rejected)).toBe(true);
  });

  it("makes shutdown drain explicit while restart ownership stays process-local", () => {
    const previousOwner = new TurnAllocationAdmission({ capacity: 2 });
    const first = peerFence("room-a", "viewer-a");
    const second = ingressFence("room-b");
    previousOwner.reserve(first);
    previousOwner.reserve(second);
    previousOwner.commit(first);

    const draining = previousOwner.beginDrainAll();
    expect(draining).toHaveLength(2);
    expect(previousOwner.usage()).toEqual({ allocations: 2 });
    const restartedOwner = new TurnAllocationAdmission({ capacity: 2 });
    expect(restartedOwner.usage()).toEqual({ allocations: 0 });

    for (const fence of draining) {
      expect(previousOwner.completeDrain(fence)).toBe(true);
    }
    expect(previousOwner.usage()).toEqual({ allocations: 0 });
  });
});
