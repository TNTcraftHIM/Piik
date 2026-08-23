export interface SfuResourceFence {
  roomId: string;
  shareGeneration: string;
  publicationGeneration: string;
}

export interface SfuSubscriptionFence extends SfuResourceFence {
  viewerPeerId: string;
}

export interface SfuResourceAdmissionOptions {
  readonly ingressCapacity: number;
  readonly egressCapacity: number;
}

export interface SfuResourceUsage {
  ingress: number;
  egress: number;
}

type ResourceState = "reserved" | "committed" | "draining";

interface SubscriptionEntry {
  fence: SfuSubscriptionFence;
  state: ResourceState;
  reservedFromDraining: boolean;
}

interface PublicationEntry {
  fence: SfuResourceFence;
  state: ResourceState;
  subscriptions: Map<string, SubscriptionEntry>;
}

interface RoomResources {
  publications: Map<string, PublicationEntry>;
}

export class SfuResourceAdmission {
  private readonly rooms = new Map<string, RoomResources>();
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

  reservePublication(fence: SfuResourceFence): boolean {
    assertFence(fence);
    const room = this.rooms.get(fence.roomId);
    const existing = room?.publications.get(publicationKey(fence));
    if (existing) {
      return existing.state !== "draining" && sameFence(existing.fence, fence);
    }
    if (
      this.ingressInUse >= this.ingressCapacity ||
      [...(room?.publications.values() ?? [])].some(
        (publication) => publication.state === "reserved",
      )
    ) {
      return false;
    }

    const resources = room ?? { publications: new Map() };
    resources.publications.set(publicationKey(fence), {
      fence: cloneFence(fence),
      state: "reserved",
      subscriptions: new Map(),
    });
    this.rooms.set(fence.roomId, resources);
    this.ingressInUse += 1;
    return true;
  }

  reserveSubscription(fence: SfuSubscriptionFence): boolean {
    assertSubscriptionFence(fence);
    const publication = this.publication(fence);
    if (!publication || publication.state === "draining") {
      return false;
    }
    const existing = publication.subscriptions.get(fence.viewerPeerId);
    if (existing) {
      if (!sameSubscriptionFence(existing.fence, fence)) return false;
      if (existing.state === "reserved" || existing.state === "committed") {
        return true;
      }
      if (publication.state !== "committed") return false;
      existing.state = "reserved";
      existing.reservedFromDraining = true;
      return true;
    }
    if (this.egressInUse >= this.egressCapacity) return false;

    publication.subscriptions.set(fence.viewerPeerId, {
      fence: cloneSubscriptionFence(fence),
      state: "reserved",
      reservedFromDraining: false,
    });
    this.egressInUse += 1;
    return true;
  }

  commitPublication(fence: SfuResourceFence): readonly SfuResourceFence[] | null {
    assertFence(fence);
    const room = this.rooms.get(fence.roomId);
    const publication = room?.publications.get(publicationKey(fence));
    if (!room || !publication || !sameFence(publication.fence, fence)) {
      return null;
    }
    if (publication.state === "committed") return [];
    if (publication.state !== "reserved") return null;
    if (![...publication.subscriptions.values()].some((entry) => entry.state === "reserved")) {
      return null;
    }

    const draining: SfuResourceFence[] = [];
    for (const other of room.publications.values()) {
      if (other === publication || other.state !== "committed") continue;
      this.markDraining(other);
      draining.push(cloneFence(other.fence));
    }
    publication.state = "committed";
    for (const subscription of publication.subscriptions.values()) {
      if (subscription.state === "reserved") {
        subscription.state = "committed";
        subscription.reservedFromDraining = false;
      }
    }
    return draining;
  }

  commitSubscription(fence: SfuSubscriptionFence): boolean {
    assertSubscriptionFence(fence);
    const publication = this.publication(fence);
    const subscription = publication?.subscriptions.get(fence.viewerPeerId);
    if (
      publication?.state !== "committed" ||
      !subscription ||
      !sameSubscriptionFence(subscription.fence, fence)
    ) {
      return false;
    }
    if (subscription.state === "committed") return true;
    if (subscription.state !== "reserved") return false;
    subscription.state = "committed";
    subscription.reservedFromDraining = false;
    return true;
  }

  releaseSubscription(fence: SfuSubscriptionFence): boolean {
    assertSubscriptionFence(fence);
    const publication = this.publication(fence);
    const subscription = publication?.subscriptions.get(fence.viewerPeerId);
    if (
      !publication ||
      !subscription ||
      !sameSubscriptionFence(subscription.fence, fence)
    ) {
      return false;
    }
    if (subscription.state === "reserved") {
      if (subscription.reservedFromDraining) {
        subscription.state = "draining";
        subscription.reservedFromDraining = false;
      } else {
        publication.subscriptions.delete(fence.viewerPeerId);
        this.subtractEgress(1);
      }
      return true;
    }
    if (subscription.state === "committed") {
      subscription.state = "draining";
    }
    return true;
  }

  beginDrain(fence: SfuResourceFence): boolean {
    assertFence(fence);
    const publication = this.publication(fence);
    if (!publication) return false;
    this.markDraining(publication);
    return true;
  }

  completeDrain(fence: SfuResourceFence): boolean {
    assertFence(fence);
    const room = this.rooms.get(fence.roomId);
    const key = publicationKey(fence);
    const publication = room?.publications.get(key);
    if (
      !room ||
      !publication ||
      publication.state !== "draining" ||
      !sameFence(publication.fence, fence)
    ) {
      return false;
    }

    room.publications.delete(key);
    this.ingressInUse -= 1;
    this.subtractEgress(publication.subscriptions.size);
    this.assertNoUnderflow();
    if (room.publications.size === 0) this.rooms.delete(fence.roomId);
    return true;
  }

  beginDrainRoom(roomId: string): readonly SfuResourceFence[] {
    if (!roomId) throw new Error("SFU resource room ID is invalid");
    const room = this.rooms.get(roomId);
    if (!room) return [];
    for (const publication of room.publications.values()) {
      this.markDraining(publication);
    }
    return [...room.publications.values()].map((publication) =>
      cloneFence(publication.fence),
    );
  }

  beginDrainAll(): readonly SfuResourceFence[] {
    return [...this.rooms.keys()].flatMap((roomId) =>
      this.beginDrainRoom(roomId),
    );
  }

  usage(): SfuResourceUsage {
    return { ingress: this.ingressInUse, egress: this.egressInUse };
  }

  private publication(
    fence: SfuResourceFence,
  ): PublicationEntry | undefined {
    const publication = this.rooms
      .get(fence.roomId)
      ?.publications.get(publicationKey(fence));
    return publication && sameFence(publication.fence, fence)
      ? publication
      : undefined;
  }

  private markDraining(publication: PublicationEntry): void {
    publication.state = "draining";
    for (const subscription of publication.subscriptions.values()) {
      subscription.state = "draining";
      subscription.reservedFromDraining = false;
    }
  }

  private subtractEgress(count: number): void {
    this.egressInUse -= count;
    this.assertNoUnderflow();
  }

  private assertNoUnderflow(): void {
    if (this.ingressInUse < 0 || this.egressInUse < 0) {
      throw new Error("SFU resource accounting underflow");
    }
  }
}

function publicationKey(fence: SfuResourceFence): string {
  return `${fence.shareGeneration}\u0000${fence.publicationGeneration}`;
}

function cloneFence(fence: SfuResourceFence): SfuResourceFence {
  return { ...fence };
}

function cloneSubscriptionFence(
  fence: SfuSubscriptionFence,
): SfuSubscriptionFence {
  return { ...fence };
}

function sameFence(left: SfuResourceFence, right: SfuResourceFence): boolean {
  return (
    left.roomId === right.roomId &&
    left.shareGeneration === right.shareGeneration &&
    left.publicationGeneration === right.publicationGeneration
  );
}

function sameSubscriptionFence(
  left: SfuSubscriptionFence,
  right: SfuSubscriptionFence,
): boolean {
  return sameFence(left, right) && left.viewerPeerId === right.viewerPeerId;
}

function assertFence(fence: SfuResourceFence): void {
  if (!fence.roomId || !fence.shareGeneration || !fence.publicationGeneration) {
    throw new Error("SFU resource fence is invalid");
  }
}

function assertSubscriptionFence(fence: SfuSubscriptionFence): void {
  assertFence(fence);
  if (!fence.viewerPeerId) {
    throw new Error("SFU subscription fence is invalid");
  }
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}
