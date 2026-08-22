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
  draining: Map<string, SfuResourceEntry>;
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
    if (room?.draining.has(fenceKey(fence))) {
      return false;
    }
    if (
      this.ingressInUse >= this.ingressCapacity ||
      egress > this.egressCapacity - this.egressInUse
    ) {
      return false;
    }

    const resources: RoomSfuResources = room ?? { draining: new Map() };
    resources.reserved = { fence: { ...fence }, egress };
    this.rooms.set(fence.roomId, resources);
    this.ingressInUse += 1;
    this.egressInUse += egress;
    return true;
  }

  commit(fence: SfuResourceFence): readonly SfuResourceFence[] | null {
    assertFence(fence);
    const room = this.rooms.get(fence.roomId);
    if (room?.committed && sameFence(room.committed.fence, fence)) {
      return [];
    }
    if (!room?.reserved || !sameFence(room.reserved.fence, fence)) {
      return null;
    }

    const draining: SfuResourceFence[] = [];
    if (room.committed) {
      this.addDraining(room, room.committed);
      draining.push({ ...room.committed.fence });
    }
    room.committed = room.reserved;
    room.reserved = undefined;
    return draining;
  }

  beginDrain(fence: SfuResourceFence): boolean {
    assertFence(fence);
    const room = this.rooms.get(fence.roomId);
    if (!room) {
      return false;
    }

    if (room.draining.has(fenceKey(fence))) {
      return true;
    }
    let entry: SfuResourceEntry | undefined;
    if (room.reserved && sameFence(room.reserved.fence, fence)) {
      entry = room.reserved;
      room.reserved = undefined;
    }
    if (room.committed && sameFence(room.committed.fence, fence)) {
      entry = room.committed;
      room.committed = undefined;
    }
    if (!entry) {
      return false;
    }
    this.addDraining(room, entry);
    return true;
  }

  completeDrain(fence: SfuResourceFence): boolean {
    assertFence(fence);
    const room = this.rooms.get(fence.roomId);
    const entry = room?.draining.get(fenceKey(fence));
    if (!room || !entry) {
      return false;
    }
    room.draining.delete(fenceKey(fence));
    this.subtract(entry);
    this.deleteEmptyRoom(fence.roomId, room);
    return true;
  }

  beginDrainRoom(roomId: string): readonly SfuResourceFence[] {
    if (!roomId) {
      throw new Error("SFU resource room ID is invalid");
    }
    const room = this.rooms.get(roomId);
    if (!room) {
      return [];
    }
    if (room.reserved) {
      this.addDraining(room, room.reserved);
      room.reserved = undefined;
    }
    if (room.committed) {
      this.addDraining(room, room.committed);
      room.committed = undefined;
    }
    return [...room.draining.values()].map((entry) => ({ ...entry.fence }));
  }

  beginDrainAll(): readonly SfuResourceFence[] {
    return [...this.rooms.keys()].flatMap((roomId) =>
      this.beginDrainRoom(roomId),
    );
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

  private addDraining(room: RoomSfuResources, entry: SfuResourceEntry): void {
    room.draining.set(fenceKey(entry.fence), entry);
  }

  private deleteEmptyRoom(roomId: string, room: RoomSfuResources): void {
    if (!room.committed && !room.reserved && room.draining.size === 0) {
      this.rooms.delete(roomId);
    }
  }
}

function fenceKey(fence: SfuResourceFence): string {
  return `${fence.shareGeneration}\u0000${fence.publicationGeneration}`;
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
