import { readFileSync } from "node:fs";

import { ServerError } from "livekit-server-sdk";
import { describe, expect, it, vi } from "vitest";

import type { SfuResourceFence } from "../src/server/sfu-resource-admission.ts";
import {
  LiveKitSfuRoomControl,
  isManagedSfuRoomName,
  managedSfuRoomName,
  type LiveKitRoomService,
} from "../src/server/sfu-room-control.ts";

class FakeRoomService implements LiveKitRoomService {
  readonly rooms = new Map<string, Set<string>>();
  readonly operations: string[] = [];
  readonly createOptions: Array<{ name: string; maxParticipants: number }> = [];
  createBarrier?: Promise<void>;
  retainDeletedRoom = false;
  retainRemovedParticipant = false;

  async createRoom(options: { name: string; maxParticipants: number }) {
    this.operations.push(`create:${options.name}`);
    this.createOptions.push(options);
    await this.createBarrier;
    if (this.rooms.has(options.name)) {
      throw new Error("room already exists");
    }
    this.rooms.set(options.name, new Set());
    return { name: options.name };
  }

  async listRooms(names?: string[]) {
    const selected = names?.length
      ? [...this.rooms.keys()].filter((name) => names.includes(name))
      : [...this.rooms.keys()];
    return selected.map((name) => ({ name }));
  }

  async deleteRoom(room: string): Promise<void> {
    this.operations.push(`delete:${room}`);
    if (!this.rooms.has(room)) {
      throw new ServerError("Not Found", "missing", 404, "not_found");
    }
    if (!this.retainDeletedRoom) {
      this.rooms.delete(room);
    }
  }

  async listParticipants(room: string) {
    const participants = this.rooms.get(room);
    if (!participants) {
      throw new ServerError("Not Found", "missing", 404, "not_found");
    }
    return [...participants].map((identity) => ({ identity }));
  }

  async removeParticipant(room: string, identity: string): Promise<void> {
    this.operations.push(`remove:${room}:${identity}`);
    const participants = this.rooms.get(room);
    if (!participants?.has(identity)) {
      throw new ServerError("Not Found", "missing", 404, "not_found");
    }
    if (!this.retainRemovedParticipant) {
      participants.delete(identity);
    }
  }

  join(room: string, identity: string): boolean {
    const participants = this.rooms.get(room);
    if (!participants) {
      return false;
    }
    participants.add(identity);
    return true;
  }
}

function fence(
  roomId = "42",
  shareGeneration = "share_generation_12345678",
  publicationGeneration = "publication_generation_12345678",
): SfuResourceFence {
  return { roomId, shareGeneration, publicationGeneration };
}

function control(roomService: FakeRoomService): LiveKitSfuRoomControl {
  return new LiveKitSfuRoomControl({
    apiUrl: "http://127.0.0.1:7880",
    apiKey: "test-key",
    apiSecret: "s".repeat(32),
    maxViewersPerRoom: 8,
    roomService,
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("LiveKitSfuRoomControl", () => {
  it("drains current managed rooms before startup", async () => {
    const roomService = new FakeRoomService();
    const current = managedSfuRoomName(fence());
    roomService.rooms.set(current, new Set(["host"]));

    await expect(control(roomService).initialize()).resolves.toBeUndefined();
    expect(roomService.rooms.size).toBe(0);
    expect(roomService.operations).toEqual([`delete:${current}`]);
  });

  it("rejects a shared instance and an unconfirmed startup drain", async () => {
    const foreign = new FakeRoomService();
    foreign.rooms.set("another-application", new Set());
    await expect(control(foreign).initialize()).rejects.toThrow("foreign room");
    expect(foreign.operations).toEqual([]);

    const retained = new FakeRoomService();
    retained.retainDeletedRoom = true;
    retained.rooms.set(managedSfuRoomName(fence()), new Set());
    await expect(control(retained).initialize()).rejects.toThrow(
      "not empty after startup drain",
    );
  });

  it("serializes create and delete and leaves a stale token with no room", async () => {
    const roomService = new FakeRoomService();
    const roomControl = control(roomService);
    const resourceFence = fence();
    const roomName = managedSfuRoomName(resourceFence);
    const gate = deferred();
    roomService.createBarrier = gate.promise;

    const creating = roomControl.createRoom(resourceFence);
    await vi.waitFor(() =>
      expect(roomService.operations).toEqual([`create:${roomName}`]),
    );
    const deleting = roomControl.deleteRoom(resourceFence);
    await Promise.resolve();
    expect(roomService.operations).toEqual([`create:${roomName}`]);

    gate.resolve();
    await Promise.all([creating, deleting]);
    expect(roomService.operations).toEqual([
      `create:${roomName}`,
      `delete:${roomName}`,
    ]);
    expect(roomService.createOptions[0]?.maxParticipants).toBe(9);
    expect(roomService.join(roomName, "host")).toBe(false);
  });

  it("rejects an off-ledger exact room before issuing another generation", async () => {
    const roomService = new FakeRoomService();
    const resourceFence = fence();
    roomService.rooms.set(managedSfuRoomName(resourceFence), new Set(["host"]));

    await expect(control(roomService).createRoom(resourceFence)).rejects.toThrow(
      "already exists",
    );
    expect(roomService.operations).toEqual([]);
  });

  it("checks the exact Host participant and treats an absent room as offline", async () => {
    const roomService = new FakeRoomService();
    const roomControl = control(roomService);
    const resourceFence = fence();
    await roomControl.createRoom(resourceFence);
    const roomName = managedSfuRoomName(resourceFence);

    expect(roomService.join(roomName, "viewer:one")).toBe(true);
    await expect(
      roomControl.hostParticipantExists(resourceFence),
    ).resolves.toBe(false);
    expect(roomService.join(roomName, "host")).toBe(true);
    await expect(
      roomControl.hostParticipantExists(resourceFence),
    ).resolves.toBe(true);
    await roomControl.deleteRoom(resourceFence);
    await expect(
      roomControl.hostParticipantExists(resourceFence),
    ).resolves.toBe(false);
  });

  it("removes and confirms only the exact Viewer subscription", async () => {
    const roomService = new FakeRoomService();
    const roomControl = control(roomService);
    const resourceFence = fence();
    await roomControl.createRoom(resourceFence);
    const roomName = managedSfuRoomName(resourceFence);
    const viewerPeerId = "viewer_peer_12345678";
    expect(roomService.join(roomName, "host")).toBe(true);
    expect(roomService.join(roomName, `viewer:${viewerPeerId}`)).toBe(true);
    expect(roomService.join(roomName, "viewer:other_peer_12345678")).toBe(true);

    const subscriptionFence = { ...resourceFence, viewerPeerId };
    await expect(
      roomControl.drainSubscription(subscriptionFence),
    ).resolves.toBeUndefined();
    expect(roomService.rooms.get(roomName)).toEqual(
      new Set(["host", "viewer:other_peer_12345678"]),
    );
    await expect(
      roomControl.drainSubscription(subscriptionFence),
    ).resolves.toBeUndefined();
  });

  it("rejects an unconfirmed Viewer participant drain", async () => {
    const roomService = new FakeRoomService();
    const roomControl = control(roomService);
    const resourceFence = fence();
    await roomControl.createRoom(resourceFence);
    const roomName = managedSfuRoomName(resourceFence);
    const viewerPeerId = "viewer_peer_12345678";
    roomService.join(roomName, `viewer:${viewerPeerId}`);
    roomService.retainRemovedParticipant = true;

    await expect(
      roomControl.drainSubscription({ ...resourceFence, viewerPeerId }),
    ).rejects.toThrow("removal was not confirmed");
  });

  it("keeps the tracked deployment unable to auto-create rooms", () => {
    const configuration = readFileSync(
      new URL("../deploy/livekit/livekit.yaml.example", import.meta.url),
      "utf8",
    );
    expect(configuration).toMatch(/room:\s+[\s\S]*auto_create: false/);
    expect(isManagedSfuRoomName("screener-v1.42.bad.segment.extra")).toBe(false);
  });
});
