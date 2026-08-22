export interface SfuResourceFence {
  roomId: string;
  shareGeneration: string;
  publicationGeneration: string;
}

export interface SfuResourceAdmissionOptions {
  readonly ingressCapacity: number;
  readonly egressCapacity: number;
}

export interface SfuResourceUsage {
  ingress: number;
  egress: number;
}

interface SfuResourceEntry {
  fence: SfuResourceFence;
  egress: number;
}

interface RoomSfuResources {
  committed?: SfuResourceEntry;
  reserved?: SfuResourceEntry;
}

export class SfuResourceAdmission {
  private readonly rooms = new Map<string, RoomSfuResources>();
  private readonly ingressCapacity: number;
  private readonly egressCapacity: number;
  private ingressInUse = 0;
  private egressInUse = 0;

  constructor(options: SfuResourceAdmissionOptions) {
    assertPositiveSafeInteger(options.ingressCapacity, "SFU ingress capacity");
    assertPositiveSafeInteger(options.egressCapacity, "SFU egress capacity");
    this.ingressCapacity = options.ingressCapacity;
    this.egressCapacity = options.egressCapacity;
  }

  reserve(fence: SfuResourceFence, egress: number): boolean {
    assertFence(fence);
    assertPositiveSafeInteger(egress, "SFU egress reservation");
    const room = this.rooms.get(fence.roomId);
    if (room?.reserved) {
      return sameEntry(room.reserved, fence, egress);
    }
    if (room?.committed && sameFence(room.committed.fence, fence)) {
      return room.committed.egress === egress;
    }
    if (
      this.ingressInUse >= this.ingressCapacity ||
      egress > this.egressCapacity - this.egressInUse
    ) {
      return false;
    }

    const resources = room ?? {};
    resources.reserved = { fence: { ...fence }, egress };
    this.rooms.set(fence.roomId, resources);
    this.ingressInUse += 1;
    this.egressInUse += egress;
    return true;
  }

  commit(fence: SfuResourceFence): boolean {
    assertFence(fence);
    const room = this.rooms.get(fence.roomId);
    if (room?.committed && sameFence(room.committed.fence, fence)) {
      return true;
    }
    if (!room?.reserved || !sameFence(room.reserved.fence, fence)) {
      return false;
    }

    if (room.committed) {
      this.subtract(room.committed);
    }
    room.committed = room.reserved;
    room.reserved = undefined;
    return true;
  }

  release(fence: SfuResourceFence): boolean {
    assertFence(fence);
    const room = this.rooms.get(fence.roomId);
    if (!room) {
      return false;
    }

    let released = false;
    if (room.reserved && sameFence(room.reserved.fence, fence)) {
      this.subtract(room.reserved);
      room.reserved = undefined;
      released = true;
    }
    if (room.committed && sameFence(room.committed.fence, fence)) {
      this.subtract(room.committed);
      room.committed = undefined;
      released = true;
    }
    this.deleteEmptyRoom(fence.roomId, room);
    return released;
  }

  releaseRoom(roomId: string): boolean {
    if (!roomId) {
      throw new Error("SFU resource room ID is invalid");
    }
    const room = this.rooms.get(roomId);
    if (!room) {
      return false;
    }
    if (room.reserved) {
      this.subtract(room.reserved);
    }
    if (room.committed) {
      this.subtract(room.committed);
    }
    this.rooms.delete(roomId);
    return true;
  }

  releaseAll(): void {
    this.rooms.clear();
    this.ingressInUse = 0;
    this.egressInUse = 0;
  }

  usage(): SfuResourceUsage {
    return { ingress: this.ingressInUse, egress: this.egressInUse };
  }

  private subtract(entry: SfuResourceEntry): void {
    this.ingressInUse -= 1;
    this.egressInUse -= entry.egress;
    if (this.ingressInUse < 0 || this.egressInUse < 0) {
      throw new Error("SFU resource accounting underflow");
    }
  }

  private deleteEmptyRoom(roomId: string, room: RoomSfuResources): void {
    if (!room.committed && !room.reserved) {
      this.rooms.delete(roomId);
    }
  }
}

function sameEntry(
  entry: SfuResourceEntry,
  fence: SfuResourceFence,
  egress: number,
): boolean {
  return entry.egress === egress && sameFence(entry.fence, fence);
}

function sameFence(left: SfuResourceFence, right: SfuResourceFence): boolean {
  return (
    left.roomId === right.roomId &&
    left.shareGeneration === right.shareGeneration &&
    left.publicationGeneration === right.publicationGeneration
  );
}

function assertFence(fence: SfuResourceFence): void {
  if (!fence.roomId || !fence.shareGeneration || !fence.publicationGeneration) {
    throw new Error("SFU resource fence is invalid");
  }
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}
