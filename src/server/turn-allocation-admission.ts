import type { SelectedEdgeTurnIdentity } from "./selected-edge-turn.js";

export interface TurnAllocationAdmissionOptions {
  readonly capacity: number;
}

export interface TurnAllocationUsage {
  allocations: number;
}

export type TurnAllocationState = "reserved" | "committed" | "draining";

interface TurnAllocationEntry {
  fence: SelectedEdgeTurnIdentity;
  state: TurnAllocationState;
}

export class TurnAllocationAdmission {
  private readonly entries = new Map<string, TurnAllocationEntry>();
  private readonly allocationIdsByRoom = new Map<string, Set<string>>();
  private readonly capacity: number;

  constructor(options: TurnAllocationAdmissionOptions) {
    assertPositiveSafeInteger(options.capacity, "TURN allocation capacity");
    this.capacity = options.capacity;
  }

  reserve(fence: SelectedEdgeTurnIdentity): boolean {
    assertFence(fence);
    const allocationId = fence.newConnectionId;
    const existing = this.entries.get(allocationId);
    if (existing) {
      return existing.state !== "draining" && sameFence(existing.fence, fence);
    }
    if (this.entries.size >= this.capacity) {
      return false;
    }

    this.entries.set(allocationId, {
      fence: cloneFence(fence),
      state: "reserved",
    });
    let roomAllocationIds = this.allocationIdsByRoom.get(fence.roomId);
    if (!roomAllocationIds) {
      roomAllocationIds = new Set();
      this.allocationIdsByRoom.set(fence.roomId, roomAllocationIds);
    }
    roomAllocationIds.add(allocationId);
    return true;
  }

  commit(fence: SelectedEdgeTurnIdentity): boolean {
    assertFence(fence);
    const entry = this.entries.get(fence.newConnectionId);
    if (!entry || !sameFence(entry.fence, fence)) {
      return false;
    }
    if (entry.state === "committed") {
      return true;
    }
    if (entry.state !== "reserved") {
      return false;
    }
    entry.state = "committed";
    return true;
  }

  beginDrain(fence: SelectedEdgeTurnIdentity): boolean {
    assertFence(fence);
    const entry = this.entries.get(fence.newConnectionId);
    if (!entry || !sameFence(entry.fence, fence)) {
      return false;
    }
    entry.state = "draining";
    return true;
  }

  completeDrain(fence: SelectedEdgeTurnIdentity): boolean {
    assertFence(fence);
    const allocationId = fence.newConnectionId;
    const entry = this.entries.get(allocationId);
    if (
      !entry ||
      entry.state !== "draining" ||
      !sameFence(entry.fence, fence)
    ) {
      return false;
    }

    this.entries.delete(allocationId);
    const roomAllocationIds = this.allocationIdsByRoom.get(fence.roomId);
    roomAllocationIds?.delete(allocationId);
    if (roomAllocationIds?.size === 0) {
      this.allocationIdsByRoom.delete(fence.roomId);
    }
    return true;
  }

  beginDrainRoom(roomId: string): readonly SelectedEdgeTurnIdentity[] {
    if (!roomId) {
      throw new Error("TURN allocation room ID is invalid");
    }
    const allocationIds = this.allocationIdsByRoom.get(roomId);
    if (!allocationIds) {
      return [];
    }
    const fences: SelectedEdgeTurnIdentity[] = [];
    for (const allocationId of allocationIds) {
      const entry = this.entries.get(allocationId);
      if (!entry) {
        throw new Error("TURN allocation room index is inconsistent");
      }
      entry.state = "draining";
      fences.push(cloneFence(entry.fence));
    }
    return fences;
  }

  beginDrainAll(): readonly SelectedEdgeTurnIdentity[] {
    return [...this.allocationIdsByRoom.keys()].flatMap((roomId) =>
      this.beginDrainRoom(roomId),
    );
  }

  state(fence: SelectedEdgeTurnIdentity): TurnAllocationState | undefined {
    assertFence(fence);
    const entry = this.entries.get(fence.newConnectionId);
    return entry && sameFence(entry.fence, fence) ? entry.state : undefined;
  }

  usage(): TurnAllocationUsage {
    return { allocations: this.entries.size };
  }
}

function cloneFence(
  fence: SelectedEdgeTurnIdentity,
): SelectedEdgeTurnIdentity {
  return { ...fence };
}

function sameFence(
  left: SelectedEdgeTurnIdentity,
  right: SelectedEdgeTurnIdentity,
): boolean {
  if (left.edgeKind !== right.edgeKind) {
    return false;
  }
  if (left.edgeKind === "peer-selected" && right.edgeKind === "peer-selected") {
    return (
      left.roomId === right.roomId &&
      left.shareGeneration === right.shareGeneration &&
      left.revision === right.revision &&
      left.parentPeerId === right.parentPeerId &&
      left.parentSessionId === right.parentSessionId &&
      left.viewerPeerId === right.viewerPeerId &&
      left.viewerSessionId === right.viewerSessionId &&
      left.oldConnectionId === right.oldConnectionId &&
      left.newConnectionId === right.newConnectionId
    );
  }
  if (
    left.edgeKind === "host-sfu-ingress" &&
    right.edgeKind === "host-sfu-ingress"
  ) {
    return (
      left.roomId === right.roomId &&
      left.shareGeneration === right.shareGeneration &&
      left.revision === right.revision &&
      left.hostPeerId === right.hostPeerId &&
      left.hostSessionId === right.hostSessionId &&
      left.publicationGeneration === right.publicationGeneration &&
      left.oldConnectionId === right.oldConnectionId &&
      left.newConnectionId === right.newConnectionId
    );
  }
  return false;
}

function assertFence(fence: SelectedEdgeTurnIdentity): void {
  const commonValues = [
    fence.roomId,
    fence.shareGeneration,
    fence.oldConnectionId,
    fence.newConnectionId,
  ];
  const edgeValues =
    fence.edgeKind === "peer-selected"
      ? [
          fence.parentPeerId,
          fence.parentSessionId,
          fence.viewerPeerId,
          fence.viewerSessionId,
        ]
      : [
          fence.hostPeerId,
          fence.hostSessionId,
          fence.publicationGeneration,
        ];
  if (
    commonValues.some((value) => value.length === 0) ||
    edgeValues.some((value) => value.length === 0) ||
    !Number.isSafeInteger(fence.revision) ||
    fence.revision < 0
  ) {
    throw new Error("TURN allocation fence is invalid");
  }
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}
