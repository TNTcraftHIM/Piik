import { RoomServiceClient, ServerError } from "livekit-server-sdk";

import { MAX_VIEWERS_PER_ROOM_LIMIT } from "../shared/protocol.js";
import type {
  SfuResourceFence,
  SfuSubscriptionFence,
} from "./sfu-resource-admission.js";

const MANAGED_ROOM_PREFIX = "screener-v1.";
const ROOM_ID_PATTERN = /^[1-9]\d{0,11}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const LEGACY_MANAGED_ROOM_PATTERN = /^screener-[1-9]\d{0,11}-[A-Za-z0-9_-]{8,128}$/;
const ROOM_SERVICE_TIMEOUT_SECONDS = 5;

interface LiveKitRoomRecord {
  name: string;
}

interface LiveKitParticipantRecord {
  identity: string;
}

export interface LiveKitRoomService {
  createRoom(options: {
    name: string;
    maxParticipants: number;
  }): Promise<LiveKitRoomRecord>;
  listRooms(names?: string[]): Promise<LiveKitRoomRecord[]>;
  deleteRoom(room: string): Promise<void>;
  listParticipants(room: string): Promise<LiveKitParticipantRecord[]>;
  removeParticipant(room: string, identity: string): Promise<void>;
}

export interface SfuRoomControl {
  initialize(): Promise<void>;
  createRoom(fence: SfuResourceFence): Promise<void>;
  deleteRoom(fence: SfuResourceFence): Promise<void>;
  drainSubscription(fence: SfuSubscriptionFence): Promise<void>;
  hostParticipantExists(fence: SfuResourceFence): Promise<boolean>;
}

export interface LiveKitSfuRoomControlOptions {
  apiUrl: string;
  apiKey: string;
  apiSecret: string;
  maxViewersPerRoom: number;
  roomService?: LiveKitRoomService;
}

export class LiveKitSfuRoomControl implements SfuRoomControl {
  private readonly roomService: LiveKitRoomService;
  private readonly maxParticipants: number;
  private readonly roomOperations = new Map<string, Promise<void>>();

  constructor(options: LiveKitSfuRoomControlOptions) {
    if (!options.apiUrl || !options.apiKey || Buffer.byteLength(options.apiSecret) < 32) {
      throw new Error("LiveKit RoomService configuration is invalid");
    }
    if (
      !Number.isSafeInteger(options.maxViewersPerRoom) ||
      options.maxViewersPerRoom < 1 ||
      options.maxViewersPerRoom > MAX_VIEWERS_PER_ROOM_LIMIT
    ) {
      throw new Error("LiveKit viewer limit is invalid");
    }
    this.maxParticipants = options.maxViewersPerRoom + 1;
    this.roomService =
      options.roomService ??
      new RoomServiceClient(
        options.apiUrl,
        options.apiKey,
        options.apiSecret,
        {
          requestTimeout: ROOM_SERVICE_TIMEOUT_SECONDS,
          failover: false,
        },
      );
  }

  async initialize(): Promise<void> {
    const rooms = await this.roomService.listRooms();
    if (rooms.some((room) => !isManagedSfuRoomName(room.name))) {
      throw new Error("Dedicated LiveKit instance contains a foreign room");
    }
    for (const room of rooms) {
      await this.deleteRoomByName(room.name);
    }
    if ((await this.roomService.listRooms()).length !== 0) {
      throw new Error("Dedicated LiveKit instance is not empty after startup drain");
    }
  }

  createRoom(fence: SfuResourceFence): Promise<void> {
    const roomName = managedSfuRoomName(fence);
    return this.serialize(roomName, async () => {
      if ((await this.roomService.listRooms([roomName])).length !== 0) {
        throw new Error("Managed LiveKit room already exists");
      }
      await this.roomService.createRoom({
        name: roomName,
        maxParticipants: this.maxParticipants,
      });
      const rooms = await this.roomService.listRooms([roomName]);
      if (rooms.length !== 1 || rooms[0]?.name !== roomName) {
        throw new Error("Managed LiveKit room creation was not confirmed");
      }
    });
  }

  deleteRoom(fence: SfuResourceFence): Promise<void> {
    const roomName = managedSfuRoomName(fence);
    return this.serialize(roomName, async () => {
      await this.deleteRoomByName(roomName);
      if ((await this.roomService.listRooms([roomName])).length !== 0) {
        throw new Error("Managed LiveKit room deletion was not confirmed");
      }
    });
  }

  drainSubscription(fence: SfuSubscriptionFence): Promise<void> {
    const roomName = managedSfuRoomName(fence);
    const identity = managedSfuViewerIdentity(fence.viewerPeerId);
    return this.serialize(roomName, async () => {
      try {
        await this.roomService.removeParticipant(roomName, identity);
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }
      if (await this.participantExists(roomName, identity)) {
        throw new Error("Managed LiveKit participant removal was not confirmed");
      }
    });
  }

  hostParticipantExists(fence: SfuResourceFence): Promise<boolean> {
    const roomName = managedSfuRoomName(fence);
    return this.serialize(roomName, () =>
      this.participantExists(roomName, "host"),
    );
  }

  private async deleteRoomByName(roomName: string): Promise<void> {
    try {
      await this.roomService.deleteRoom(roomName);
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }

  private async participantExists(
    roomName: string,
    identity: string,
  ): Promise<boolean> {
    try {
      return (await this.roomService.listParticipants(roomName)).some(
        (participant) => participant.identity === identity,
      );
    } catch (error) {
      if (isNotFound(error)) {
        return false;
      }
      throw error;
    }
  }

  private serialize<Result>(
    roomName: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.roomOperations.get(roomName) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.roomOperations.set(roomName, tail);
    void tail.then(() => {
      if (this.roomOperations.get(roomName) === tail) {
        this.roomOperations.delete(roomName);
      }
    });
    return result;
  }
}

export function managedSfuRoomName(fence: SfuResourceFence): string {
  if (
    !ROOM_ID_PATTERN.test(fence.roomId) ||
    !OPAQUE_ID_PATTERN.test(fence.shareGeneration) ||
    !OPAQUE_ID_PATTERN.test(fence.publicationGeneration)
  ) {
    throw new Error("Managed LiveKit room fence is invalid");
  }
  return `${MANAGED_ROOM_PREFIX}${fence.roomId}.${fence.shareGeneration}.${fence.publicationGeneration}`;
}

function managedSfuViewerIdentity(peerId: string): string {
  if (!OPAQUE_ID_PATTERN.test(peerId)) {
    throw new Error("Managed LiveKit Viewer identity is invalid");
  }
  return `viewer:${peerId}`;
}

export function isManagedSfuRoomName(roomName: string): boolean {
  if (LEGACY_MANAGED_ROOM_PATTERN.test(roomName)) {
    return true;
  }
  if (!roomName.startsWith(MANAGED_ROOM_PREFIX)) {
    return false;
  }
  const parts = roomName.slice(MANAGED_ROOM_PREFIX.length).split(".");
  return (
    parts.length === 3 &&
    ROOM_ID_PATTERN.test(parts[0] ?? "") &&
    OPAQUE_ID_PATTERN.test(parts[1] ?? "") &&
    OPAQUE_ID_PATTERN.test(parts[2] ?? "")
  );
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof ServerError &&
    (error.status === 404 || error.code === "not_found")
  );
}
