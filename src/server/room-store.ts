import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  MAX_VIEWERS_PER_ROOM_LIMIT,
  ROOM_CODE_LENGTH,
  type Role,
} from "../shared/protocol.js";
import { RoomDatabase } from "./room-database.js";

export type RoomStoreErrorCode =
  | "INVALID_TOKEN"
  | "ROOM_EXPIRED"
  | "ROOM_FULL"
  | "HOST_ALREADY_CONNECTED"
  | "ROOM_LIMIT";

export class RoomStoreError extends Error {
  constructor(public readonly code: RoomStoreErrorCode) {
    super(code);
    this.name = "RoomStoreError";
  }
}

interface Participant {
  clientId: string;
  peerId: string;
  sessionId?: string;
}

interface Room {
  roomId: string;
  hostTokenDigest: Buffer;
  expiresAtMs: number | null;
  host?: Participant;
  viewers: Map<string, Participant>;
}

export interface CreatedRoom {
  roomId: string;
  hostToken: string;
  expiresAt: string | null;
}

export type ConnectParticipantInput =
  | {
      roomId: string;
      role: "host";
      token: string;
      clientId: string;
      sessionId: string;
    }
  | {
      roomId: string;
      role: "viewer";
      clientId: string;
      sessionId: string;
    };

export interface ConnectedParticipant {
  roomId: string;
  role: Role;
  peerId: string;
  expiresAt: string | null;
  hostOnline: boolean;
  replacedSessionId?: string;
  viewerPeerIds: readonly string[];
}

export interface DisconnectedParticipant {
  roomId: string;
  role: Role;
  peerId: string;
}

export interface ConnectedPeer {
  peerId: string;
  sessionId: string;
}

export interface ClosedRoom {
  roomId: string;
  sessionIds: readonly string[];
}

export interface RoomStoreOptions {
  ttlMs: number;
  maxRooms: number;
  maxViewersPerRoom: number;
  database?: RoomDatabase;
  now?: () => number;
  random?: (size: number) => Buffer;
}

export class RoomStore {
  private readonly rooms = new Map<string, Room>();
  private readonly now: () => number;
  private readonly random: (size: number) => Buffer;
  readonly maxViewersPerRoom: number;

  constructor(private readonly options: RoomStoreOptions) {
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error("Room TTL must be a positive integer");
    }
    if (!Number.isSafeInteger(options.maxRooms) || options.maxRooms <= 0) {
      throw new Error("Room limit must be a positive integer");
    }
    if (
      !Number.isSafeInteger(options.maxViewersPerRoom) ||
      options.maxViewersPerRoom <= 0 ||
      options.maxViewersPerRoom > MAX_VIEWERS_PER_ROOM_LIMIT
    ) {
      throw new Error(
        `Room viewer limit must be an integer between 1 and ${MAX_VIEWERS_PER_ROOM_LIMIT}`,
      );
    }
    this.now = options.now ?? Date.now;
    this.random = options.random ?? randomBytes;
    this.maxViewersPerRoom = options.maxViewersPerRoom;

    try {
      for (const storedRoom of options.database?.loadRooms() ?? []) {
        if (!isRoomCode(storedRoom.roomId) || this.rooms.has(storedRoom.roomId)) {
          throw new Error("Room database contains an invalid or duplicate room id");
        }
        this.rooms.set(storedRoom.roomId, {
          roomId: storedRoom.roomId,
          hostTokenDigest: Buffer.from(storedRoom.hostTokenDigest),
          expiresAtMs: null,
          viewers: new Map(),
        });
      }
    } catch (error) {
      options.database?.close();
      throw error;
    }
  }

  createRoom(): CreatedRoom {
    if (this.rooms.size >= this.options.maxRooms) {
      throw new RoomStoreError("ROOM_LIMIT");
    }

    const hostToken = this.random(32).toString("base64url");
    const hostTokenDigest = digest(hostToken);
    const createdAtMs = this.now();
    const storedRoom = this.options.database?.createRoom(hostTokenDigest);
    const roomId = storedRoom?.roomId ?? this.uniqueRoomCode();
    const expiresAtMs = storedRoom ? null : createdAtMs + this.options.ttlMs;

    this.rooms.set(roomId, {
      roomId,
      hostTokenDigest,
      expiresAtMs,
      viewers: new Map(),
    });

    return {
      roomId,
      hostToken,
      expiresAt: formatExpiresAt(expiresAtMs),
    };
  }

  connectParticipant(input: ConnectParticipantInput): ConnectedParticipant {
    const room = this.getAvailableRoom(input.roomId);
    if (input.role === "host" && !verifyDigest(input.token, room.hostTokenDigest)) {
      throw new RoomStoreError("INVALID_TOKEN");
    }

    if (input.role === "host") {
      return this.connectHost(room, input);
    }
    return this.connectViewer(room, input);
  }

  disconnectParticipant(
    roomId: string,
    peerId: string,
    sessionId: string,
  ): DisconnectedParticipant | undefined {
    const room = this.rooms.get(roomId);
    if (!room) {
      return undefined;
    }

    if (room.host?.peerId === peerId) {
      if (room.host.sessionId !== sessionId) {
        return undefined;
      }
      room.host.sessionId = undefined;
      return { roomId, role: "host", peerId };
    }

    const viewer = findViewerByPeerId(room, peerId);
    if (!viewer || viewer.sessionId !== sessionId) {
      return undefined;
    }
    viewer.sessionId = undefined;
    return { roomId, role: "viewer", peerId };
  }

  removeDisconnectedViewer(roomId: string, peerId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) {
      return false;
    }
    const viewer = findViewerByPeerId(room, peerId);
    if (!viewer || viewer.sessionId) {
      return false;
    }
    return room.viewers.delete(viewer.clientId);
  }

  getConnectedHost(roomId: string): ConnectedPeer | undefined {
    const host = this.rooms.get(roomId)?.host;
    return host?.sessionId
      ? { peerId: host.peerId, sessionId: host.sessionId }
      : undefined;
  }

  getConnectedViewer(roomId: string, peerId: string): ConnectedPeer | undefined {
    const room = this.rooms.get(roomId);
    const viewer = room ? findViewerByPeerId(room, peerId) : undefined;
    return viewer?.sessionId ? { peerId, sessionId: viewer.sessionId } : undefined;
  }

  getConnectedViewers(roomId: string): ConnectedPeer[] {
    const room = this.rooms.get(roomId);
    if (!room) {
      return [];
    }
    return [...room.viewers.values()].flatMap((viewer) =>
      viewer.sessionId
        ? [{ peerId: viewer.peerId, sessionId: viewer.sessionId }]
        : [],
    );
  }

  abandonRoom(roomId: string): ClosedRoom | undefined {
    const room = this.rooms.get(roomId);
    if (!room) {
      return undefined;
    }
    if (this.options.database && !this.options.database.deleteRoom(roomId)) {
      throw new Error("Persistent room is missing from the room database");
    }
    const sessionIds = connectedSessionIds(room);
    this.rooms.delete(roomId);
    return { roomId, sessionIds };
  }

  expireRooms(nowMs = this.now()): ClosedRoom[] {
    const expired: ClosedRoom[] = [];
    for (const [roomId, room] of this.rooms) {
      if (room.expiresAtMs === null || room.expiresAtMs > nowMs) {
        continue;
      }
      expired.push({ roomId, sessionIds: connectedSessionIds(room) });
      this.rooms.delete(roomId);
    }
    return expired;
  }

  get size(): number {
    return this.rooms.size;
  }

  close(): void {
    this.options.database?.close();
  }

  private connectHost(
    room: Room,
    input: ConnectParticipantInput,
  ): ConnectedParticipant {
    const current = room.host;
    if (
      current?.sessionId &&
      current.clientId !== input.clientId
    ) {
      throw new RoomStoreError("HOST_ALREADY_CONNECTED");
    }

    const isNewParticipant = !current || current.clientId !== input.clientId;
    const participant = isNewParticipant
      ? {
          clientId: input.clientId,
          peerId: this.newPeerId(room),
        }
      : current;
    const replacedSessionId = participant.sessionId;
    participant.sessionId = input.sessionId;
    room.host = participant;

    return {
      roomId: room.roomId,
      role: "host",
      peerId: participant.peerId,
      expiresAt: formatExpiresAt(room.expiresAtMs),
      hostOnline: true,
      replacedSessionId:
        replacedSessionId === input.sessionId ? undefined : replacedSessionId,
      // Disconnected viewers remain room members until their grace period ends.
      viewerPeerIds: [...room.viewers.values()].map((viewer) => viewer.peerId),
    };
  }

  private connectViewer(
    room: Room,
    input: ConnectParticipantInput,
  ): ConnectedParticipant {
    const current = room.viewers.get(input.clientId);
    if (!current && room.viewers.size >= this.maxViewersPerRoom) {
      throw new RoomStoreError("ROOM_FULL");
    }

    const participant =
      current ??
      ({
        clientId: input.clientId,
        peerId: this.newPeerId(room),
      } satisfies Participant);
    const replacedSessionId = participant.sessionId;
    participant.sessionId = input.sessionId;
    room.viewers.set(input.clientId, participant);

    return {
      roomId: room.roomId,
      role: "viewer",
      peerId: participant.peerId,
      expiresAt: formatExpiresAt(room.expiresAtMs),
      hostOnline: Boolean(room.host?.sessionId),
      replacedSessionId:
        replacedSessionId === input.sessionId ? undefined : replacedSessionId,
      viewerPeerIds: [],
    };
  }

  private getAvailableRoom(roomId: string): Room {
    const room = this.rooms.get(roomId);
    if (!room) {
      // A single response avoids turning room IDs into an enumeration oracle.
      throw new RoomStoreError("INVALID_TOKEN");
    }
    if (room.expiresAtMs !== null && room.expiresAtMs <= this.now()) {
      throw new RoomStoreError("ROOM_EXPIRED");
    }
    return room;
  }

  private newPeerId(room: Room): string {
    return this.uniqueId(
      16,
      (candidate) =>
        room.host?.peerId === candidate ||
        [...room.viewers.values()].some((viewer) => viewer.peerId === candidate),
    );
  }

  private uniqueRoomCode(): string {
    const minimum = 10n ** BigInt(ROOM_CODE_LENGTH - 1);
    const range = 9n * minimum;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const bytes = this.random(8);
      if (bytes.length !== 8) {
        throw new Error("Room code random source must return 8 bytes");
      }
      const candidate = (
        minimum +
        (bytes.readBigUInt64BE() % range)
      ).toString();
      if (!this.rooms.has(candidate)) {
        return candidate;
      }
    }
    throw new Error("Unable to allocate a unique room code");
  }

  private uniqueId(size: number, exists: (candidate: string) => boolean): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this.random(size).toString("base64url");
      if (!exists(candidate)) {
        return candidate;
      }
    }
    throw new Error("Unable to allocate a unique identifier");
  }
}

function isRoomCode(value: string): boolean {
  return (
    value.length <= ROOM_CODE_LENGTH &&
    /^[1-9]\d*$/.test(value)
  );
}

function formatExpiresAt(expiresAtMs: number | null): string | null {
  return expiresAtMs === null ? null : new Date(expiresAtMs).toISOString();
}

function findViewerByPeerId(room: Room, peerId: string): Participant | undefined {
  return [...room.viewers.values()].find((viewer) => viewer.peerId === peerId);
}

function connectedSessionIds(room: Room): string[] {
  const sessionIds = room.host?.sessionId ? [room.host.sessionId] : [];
  for (const viewer of room.viewers.values()) {
    if (viewer.sessionId) {
      sessionIds.push(viewer.sessionId);
    }
  }
  return sessionIds;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function verifyDigest(value: string, expectedDigest: Buffer): boolean {
  return timingSafeEqual(digest(value), expectedDigest);
}
