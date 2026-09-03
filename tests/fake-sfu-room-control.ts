import type {
  SfuResourceFence,
  SfuSubscriptionFence,
} from "../src/server/sfu-resource-admission.ts";
import { managedSfuRoomName } from "../src/server/sfu-resource-admission.ts";
import {
  type SfuRoomControl,
} from "../src/server/sfu-room-control.ts";

export class FakeSfuRoomControl implements SfuRoomControl {
  readonly rooms = new Map<string, Set<string>>();
  readonly created: SfuResourceFence[] = [];
  readonly deleted: SfuResourceFence[] = [];
  readonly subscriptionDrainAttempts: SfuSubscriptionFence[] = [];
  readonly drainedSubscriptions: SfuSubscriptionFence[] = [];
  readonly startupDeletedRoomNames: string[] = [];
  initializeCalls = 0;
  initializeBarrier?: Promise<void>;
  initializeError?: Error;
  createBarrier?: Promise<void>;
  deleteBarrier?: Promise<void>;
  subscriptionDrainBarrier?: Promise<void>;
  failDelete = false;
  failHostCheck = false;

  async initialize(): Promise<void> {
    this.initializeCalls += 1;
    await this.initializeBarrier;
    if (this.initializeError) {
      throw this.initializeError;
    }
    this.startupDeletedRoomNames.push(...this.rooms.keys());
    this.rooms.clear();
  }

  async createRoom(fence: SfuResourceFence): Promise<void> {
    await this.createBarrier;
    const roomName = managedSfuRoomName(fence);
    if (this.rooms.has(roomName)) {
      throw new Error("room already exists");
    }
    this.rooms.set(roomName, new Set());
    this.created.push({ ...fence });
  }

  async deleteRoom(fence: SfuResourceFence): Promise<void> {
    await this.deleteBarrier;
    if (this.failDelete) {
      throw new Error("room deletion failed");
    }
    this.rooms.delete(managedSfuRoomName(fence));
    this.deleted.push({ ...fence });
  }

  async drainSubscription(fence: SfuSubscriptionFence): Promise<void> {
    this.subscriptionDrainAttempts.push({ ...fence });
    await this.subscriptionDrainBarrier;
    this.rooms
      .get(managedSfuRoomName(fence))
      ?.delete(`viewer:${fence.viewerPeerId}`);
    this.drainedSubscriptions.push({ ...fence });
  }

  async hostParticipantExists(fence: SfuResourceFence): Promise<boolean> {
    if (this.failHostCheck) {
      throw new Error("host check failed");
    }
    return this.rooms.get(managedSfuRoomName(fence))?.has("host") ?? false;
  }

  seedRoom(fence: SfuResourceFence, identities: readonly string[] = []): void {
    this.rooms.set(managedSfuRoomName(fence), new Set(identities));
  }

  canJoin(roomName: string): boolean {
    return this.rooms.has(roomName);
  }
}
