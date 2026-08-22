import {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

import {
  MAX_HOST_CLAIM_TTL_SECONDS,
  MAX_VIEWERS_PER_ROOM_LIMIT,
  ROOM_CODE_LENGTH,
  viewerGrantSchema,
  viewerPasswordSchema,
  type Role,
  type ViewerAccessPolicy,
} from "../shared/protocol.js";
import { RoomDatabase } from "./room-database.js";

export type RoomStoreErrorCode =
  | "INVALID_TOKEN"
  | "ROOM_EXPIRED"
  | "ROOM_FULL"
  | "HOST_ALREADY_CONNECTED"
  | "ROOM_LIMIT";

const PERSISTENT_VIEWER_GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const VIEWER_PASSWORD_SALT_BYTES = 16;
const VIEWER_PASSWORD_VERIFIER_BYTES = 32;
const VIEWER_PASSWORD_MATERIAL_BYTES =
  VIEWER_PASSWORD_SALT_BYTES + VIEWER_PASSWORD_VERIFIER_BYTES;
const VIEWER_PASSWORD_KDF_CONCURRENCY = 2;
const VIEWER_PASSWORD_KDF_PENDING_LIMIT = 16;
const VIEWER_PASSWORD_SCRYPT_OPTIONS = {
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 32 * 1024 * 1024,
} as const;
const DUMMY_VIEWER_PASSWORD_MATERIAL = Buffer.alloc(
  VIEWER_PASSWORD_MATERIAL_BYTES,
);

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
  viewerGrantDigest: Buffer | null;
  viewerPasswordMaterial: Buffer | null;
  viewerAuthorizationGeneration: string;
  expiresAtMs: number | null;
  provisionalHostExpiresAtMs: number | null;
  host?: Participant;
  viewers: Map<string, Participant>;
}

export interface CreatedRoom {
  roomId: string;
  hostToken: string;
  viewerPolicy: ViewerAccessPolicy;
  viewerGrant: string | null;
  viewerGrantExpiresAt: string | null;
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
      viewerGrant?: string;
      clientId: string;
      sessionId: string;
    };

export interface ConnectViewerWithPasswordInput {
  roomId: string;
  password: string;
  clientId: string;
  sessionId: string;
}

export interface ConnectedParticipant {
  roomId: string;
  role: Role;
  peerId: string;
  expiresAt: string | null;
  hostOnline: boolean;
  replacedSessionId?: string;
  viewerPeerIds: readonly string[];
  viewerPolicy: ViewerAccessPolicy;
  viewerPasswordEnabled: boolean;
  viewerAuthorizationGeneration: string;
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

export interface RevokedViewer {
  peerId: string;
  sessionId?: string;
}

export interface ViewerAccessUpdate {
  viewerPolicy: ViewerAccessPolicy;
  viewerGrant: string | null;
  viewerGrantExpiresAt: string | null;
  viewerAuthorizationGeneration: string;
  previousViewerAuthorizationGeneration: string;
  revokedViewers: readonly RevokedViewer[];
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
          viewerGrantDigest:
            storedRoom.viewerGrantDigest === null
              ? null
              : Buffer.from(storedRoom.viewerGrantDigest),
          viewerPasswordMaterial:
            storedRoom.viewerPasswordMaterial === null
              ? null
              : Buffer.from(storedRoom.viewerPasswordMaterial),
          viewerAuthorizationGeneration: this.newAuthorizationGeneration(),
          expiresAtMs: null,
          provisionalHostExpiresAtMs: null,
          viewers: new Map(),
        });
      }
    } catch (error) {
      options.database?.close();
      throw error;
    }
  }

  createRoom(
    viewerPolicy: ViewerAccessPolicy = "private-link",
    hostClaimTtlSeconds?: number,
  ): CreatedRoom {
    if (
      hostClaimTtlSeconds !== undefined &&
      hostClaimTtlSeconds !== MAX_HOST_CLAIM_TTL_SECONDS
    ) {
      throw new Error(
        `Provisional Host TTL must be ${MAX_HOST_CLAIM_TTL_SECONDS} seconds`,
      );
    }
    if (this.rooms.size >= this.options.maxRooms) {
      throw new RoomStoreError("ROOM_LIMIT");
    }

    const hostToken = this.random(32).toString("base64url");
    const hostTokenDigest = digest(hostToken);
    const viewerAuthorizationGeneration = this.newAuthorizationGeneration();
    const createdAtMs = this.now();
    const provisionalHostExpiresAtMs =
      hostClaimTtlSeconds === undefined
        ? null
        : createdAtMs + hostClaimTtlSeconds * 1_000;
    if (
      provisionalHostExpiresAtMs !== null &&
      !Number.isSafeInteger(provisionalHostExpiresAtMs)
    ) {
      throw new Error("Provisional Host expiry exceeds the supported time range");
    }
    let viewerGrant: string | null = null;
    let viewerGrantExpiresAtMs: number | null = null;
    const storedRoom =
      provisionalHostExpiresAtMs === null
        ? this.options.database?.createRoom(
            hostTokenDigest,
            (roomId) => {
              if (viewerPolicy === "public-watch") {
                return null;
              }
              const persistentGrantExpiresAtMs = toEpochSecondsMs(
                createdAtMs + PERSISTENT_VIEWER_GRANT_TTL_MS,
              );
              viewerGrantExpiresAtMs = persistentGrantExpiresAtMs;
              viewerGrant = this.createViewerGrant(
                roomId,
                persistentGrantExpiresAtMs,
              );
              return digest(viewerGrant);
            },
          )
        : undefined;
    const roomId = storedRoom?.roomId ?? this.uniqueRoomCode();
    const expiresAtMs = storedRoom ? null : createdAtMs + this.options.ttlMs;
    if (!storedRoom && viewerPolicy === "private-link") {
      const temporaryGrantExpiresAtMs = toEpochSecondsMs(
        createdAtMs + this.options.ttlMs,
      );
      viewerGrantExpiresAtMs = temporaryGrantExpiresAtMs;
      viewerGrant = this.createViewerGrant(roomId, temporaryGrantExpiresAtMs);
    }
    const viewerGrantDigest =
      storedRoom?.viewerGrantDigest ??
      (viewerGrant === null ? null : digest(viewerGrant));

    this.rooms.set(roomId, {
      roomId,
      hostTokenDigest,
      viewerGrantDigest,
      viewerPasswordMaterial: null,
      viewerAuthorizationGeneration,
      expiresAtMs,
      provisionalHostExpiresAtMs,
      viewers: new Map(),
    });

    return {
      roomId,
      hostToken,
      viewerPolicy,
      viewerGrant,
      viewerGrantExpiresAt: formatExpiresAt(viewerGrantExpiresAtMs),
      expiresAt: formatExpiresAt(expiresAtMs),
    };
  }

  connectParticipant(input: ConnectParticipantInput): ConnectedParticipant {
    let room: Room;
    try {
      room = this.getAvailableRoom(input.roomId);
    } catch (error) {
      if (input.role === "viewer" && error instanceof RoomStoreError) {
        throw new RoomStoreError("INVALID_TOKEN");
      }
      throw error;
    }
    if (input.role === "host" && !verifyDigest(input.token, room.hostTokenDigest)) {
      throw new RoomStoreError("INVALID_TOKEN");
    }

    if (input.role === "host") {
      return this.connectHost(room, input);
    }
    if (!this.viewerMayEnter(room, input.viewerGrant)) {
      throw new RoomStoreError("INVALID_TOKEN");
    }
    return this.connectViewer(room, input);
  }

  viewerGrantMayEnter(roomId: string, grant: string | undefined): boolean {
    try {
      const room = this.getAvailableRoom(roomId);
      return room.viewerGrantDigest !== null && this.viewerMayEnter(room, grant);
    } catch (error) {
      if (error instanceof RoomStoreError) {
        return false;
      }
      throw error;
    }
  }

  async connectViewerWithPassword(
    input: ConnectViewerWithPasswordInput,
    mayConnect: () => boolean = () => true,
  ): Promise<ConnectedParticipant> {
    if (!viewerPasswordSchema.safeParse(input.password).success) {
      throw new RoomStoreError("INVALID_TOKEN");
    }

    let room: Room | undefined;
    try {
      room = this.getAvailableRoom(input.roomId);
    } catch (error) {
      if (!(error instanceof RoomStoreError)) {
        throw error;
      }
    }
    if (room?.viewerGrantDigest === null) {
      if (!mayConnect()) {
        throw new RoomStoreError("INVALID_TOKEN");
      }
      return this.connectViewer(room, { ...input, role: "viewer" });
    }

    const expectedMaterial = Buffer.from(
      room?.viewerPasswordMaterial ?? DUMMY_VIEWER_PASSWORD_MATERIAL,
    );
    const expectedSalt = expectedMaterial.subarray(
      0,
      VIEWER_PASSWORD_SALT_BYTES,
    );
    const expectedVerifier = expectedMaterial.subarray(
      VIEWER_PASSWORD_SALT_BYTES,
    );
    const derived = await deriveViewerPassword(
      input.password,
      expectedSalt,
      mayConnect,
    );
    if (derived === null) {
      throw new RoomStoreError("INVALID_TOKEN");
    }
    const matches = timingSafeEqual(derived, expectedVerifier);

    let currentRoom: Room;
    try {
      currentRoom = this.getAvailableRoom(input.roomId);
    } catch (error) {
      if (error instanceof RoomStoreError) {
        throw new RoomStoreError("INVALID_TOKEN");
      }
      throw error;
    }
    if (currentRoom.viewerGrantDigest === null) {
      if (!mayConnect()) {
        throw new RoomStoreError("INVALID_TOKEN");
      }
      return this.connectViewer(currentRoom, { ...input, role: "viewer" });
    }
    if (
      !room ||
      currentRoom !== room ||
      !matches ||
      !sameBytes(currentRoom.viewerPasswordMaterial, expectedMaterial) ||
      !mayConnect()
    ) {
      throw new RoomStoreError("INVALID_TOKEN");
    }
    try {
      return this.connectViewer(currentRoom, { ...input, role: "viewer" });
    } catch (error) {
      if (error instanceof RoomStoreError && error.code === "ROOM_FULL") {
        throw new RoomStoreError("INVALID_TOKEN");
      }
      throw error;
    }
  }

  async setViewerPassword(
    roomId: string,
    password: string | null,
    hostSessionId: string,
  ): Promise<boolean> {
    const room = this.getAvailableRoom(roomId);
    if (room.host?.sessionId !== hostSessionId) {
      throw new RoomStoreError("INVALID_TOKEN");
    }

    let nextPasswordMaterial: Buffer | null = null;
    if (password !== null) {
      if (!viewerPasswordSchema.safeParse(password).success) {
        throw new RoomStoreError("INVALID_TOKEN");
      }
      const salt = this.random(VIEWER_PASSWORD_SALT_BYTES);
      if (salt.byteLength !== VIEWER_PASSWORD_SALT_BYTES) {
        throw new Error("Viewer password salt source must return 16 bytes");
      }
      const verifier = await deriveViewerPassword(password, salt, () => {
        const currentRoom = this.rooms.get(roomId);
        return (
          currentRoom === room &&
          currentRoom.host?.sessionId === hostSessionId
        );
      });
      if (verifier === null) {
        throw new RoomStoreError("INVALID_TOKEN");
      }
      nextPasswordMaterial = Buffer.concat([salt, verifier]);
    }

    const currentRoom = this.getAvailableRoom(roomId);
    if (
      currentRoom !== room ||
      currentRoom.host?.sessionId !== hostSessionId
    ) {
      throw new RoomStoreError("INVALID_TOKEN");
    }
    if (currentRoom.expiresAtMs === null) {
      this.options.database?.updateViewerPassword(roomId, nextPasswordMaterial);
    }
    currentRoom.viewerPasswordMaterial = nextPasswordMaterial;
    return nextPasswordMaterial !== null;
  }

  setViewerAccess(
    roomId: string,
    action: "public-watch" | "rotate" | "revoke",
  ): ViewerAccessUpdate {
    const room = this.getAvailableRoom(roomId);
    const previousViewerAuthorizationGeneration =
      room.viewerAuthorizationGeneration;

    if (action === "public-watch") {
      if (room.expiresAtMs === null) {
        this.options.database?.updateViewerGrantDigest(roomId, null);
      }
      room.viewerGrantDigest = null;
      return {
        viewerPolicy: "public-watch",
        viewerGrant: null,
        viewerGrantExpiresAt: null,
        viewerAuthorizationGeneration: room.viewerAuthorizationGeneration,
        previousViewerAuthorizationGeneration,
        revokedViewers: [],
      };
    }

    const viewerGrantExpiresAtMs =
      action === "rotate"
        ? toEpochSecondsMs(
            room.expiresAtMs ?? this.now() + PERSISTENT_VIEWER_GRANT_TTL_MS,
          )
        : null;
    const viewerGrant =
      viewerGrantExpiresAtMs === null
        ? null
        : this.createViewerGrant(room.roomId, viewerGrantExpiresAtMs);
    const nextDigest =
      viewerGrant === null ? this.randomDigest() : digest(viewerGrant);
    const nextViewerAuthorizationGeneration =
      this.newAuthorizationGeneration();

    // Persistence is the commit point for durable rooms. Provisional native
    // rooms deliberately never enter the configured database.
    if (room.expiresAtMs === null) {
      this.options.database?.updateViewerGrantDigest(roomId, nextDigest);
    }

    const revokedViewers = [...room.viewers.values()].map((viewer) => ({
      peerId: viewer.peerId,
      ...(viewer.sessionId ? { sessionId: viewer.sessionId } : {}),
    }));
    room.viewerGrantDigest = nextDigest;
    room.viewerAuthorizationGeneration = nextViewerAuthorizationGeneration;
    room.viewers.clear();
    return {
      viewerPolicy: "private-link",
      viewerGrant,
      viewerGrantExpiresAt: formatExpiresAt(viewerGrantExpiresAtMs),
      viewerAuthorizationGeneration: room.viewerAuthorizationGeneration,
      previousViewerAuthorizationGeneration,
      revokedViewers,
    };
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
      if (room.provisionalHostExpiresAtMs !== null) {
        room.provisionalHostExpiresAtMs =
          this.now() + MAX_HOST_CLAIM_TTL_SECONDS * 1_000;
      }
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

  getViewerPeerIds(roomId: string): string[] {
    const room = this.rooms.get(roomId);
    return room
      ? [...room.viewers.values()].map((viewer) => viewer.peerId)
      : [];
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
    if (
      room.expiresAtMs === null &&
      this.options.database &&
      !this.options.database.deleteRoom(roomId)
    ) {
      throw new Error("Persistent room is missing from the room database");
    }
    const sessionIds = connectedSessionIds(room);
    this.rooms.delete(roomId);
    return { roomId, sessionIds };
  }

  expireRooms(nowMs = this.now()): ClosedRoom[] {
    const expired: ClosedRoom[] = [];
    for (const [roomId, room] of this.rooms) {
      if (!roomIsExpired(room, nowMs)) {
        continue;
      }
      if (
        room.expiresAtMs === null &&
        this.options.database &&
        !this.options.database.deleteRoom(roomId)
      ) {
        throw new Error("Persistent room is missing from the room database");
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
      viewerPolicy: viewerPolicy(room),
      viewerPasswordEnabled: room.viewerPasswordMaterial !== null,
      viewerAuthorizationGeneration: room.viewerAuthorizationGeneration,
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
      viewerPolicy: viewerPolicy(room),
      viewerPasswordEnabled: room.viewerPasswordMaterial !== null,
      viewerAuthorizationGeneration: room.viewerAuthorizationGeneration,
    };
  }

  private getAvailableRoom(roomId: string): Room {
    const room = this.rooms.get(roomId);
    if (!room) {
      // A single response avoids turning room IDs into an enumeration oracle.
      throw new RoomStoreError("INVALID_TOKEN");
    }
    if (roomIsExpired(room, this.now())) {
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

  private viewerMayEnter(room: Room, grant: string | undefined): boolean {
    if (room.viewerGrantDigest === null) {
      return true;
    }
    if (!grant || !viewerGrantSchema.safeParse(grant).success) {
      return false;
    }
    const parsed = parseViewerGrant(grant);
    return Boolean(
      parsed &&
        parsed.roomId === room.roomId &&
        parsed.expiresAtMs > this.now() &&
        verifyDigest(grant, room.viewerGrantDigest),
    );
  }

  private createViewerGrant(roomId: string, expiresAtMs: number): string {
    const expiresAtSeconds = Math.floor(expiresAtMs / 1_000);
    const secret = this.random(32);
    if (secret.byteLength !== 32) {
      throw new Error("Viewer grant random source must return 32 bytes");
    }
    return `g1.${roomId}.${expiresAtSeconds}.${secret.toString("base64url")}`;
  }

  private randomDigest(): Buffer {
    const value = this.random(32);
    if (value.byteLength !== 32) {
      throw new Error("Viewer lock random source must return 32 bytes");
    }
    return Buffer.from(value);
  }

  private newAuthorizationGeneration(): string {
    const value = this.random(16);
    if (value.byteLength !== 16) {
      throw new Error("Authorization generation random source must return 16 bytes");
    }
    return value.toString("base64url");
  }
}

function roomIsExpired(room: Room, nowMs: number): boolean {
  return (
    (room.expiresAtMs !== null && room.expiresAtMs <= nowMs) ||
    (!room.host?.sessionId &&
      room.provisionalHostExpiresAtMs !== null &&
      room.provisionalHostExpiresAtMs <= nowMs)
  );
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

function toEpochSecondsMs(value: number): number {
  return Math.floor(value / 1_000) * 1_000;
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

function sameBytes(value: Buffer | null, expected: Buffer): boolean {
  return value !== null && timingSafeEqual(value, expected);
}

function deriveViewerPassword(
  password: string,
  salt: Buffer,
  mayStart: () => boolean = () => true,
): Promise<Buffer | null> {
  return viewerPasswordKdfGate.run(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        scrypt(
          password,
          salt,
          VIEWER_PASSWORD_VERIFIER_BYTES,
          VIEWER_PASSWORD_SCRYPT_OPTIONS,
          (error, derivedKey) => (error ? reject(error) : resolve(derivedKey)),
        );
      }),
    mayStart,
  );
}

class AsyncGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly limit: number,
    private readonly pendingLimit: number,
  ) {}

  async run<T>(
    task: () => Promise<T>,
    mayStart: () => boolean,
  ): Promise<T | null> {
    if (!(await this.acquire())) {
      return null;
    }
    try {
      return mayStart() ? await task() : null;
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<boolean> {
    if (this.active >= this.limit) {
      if (this.waiters.length >= this.pendingLimit) {
        return Promise.resolve(false);
      }
      return new Promise<boolean>((resolve) =>
        this.waiters.push(() => resolve(true)),
      );
    }
    this.active += 1;
    return Promise.resolve(true);
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }
}

const viewerPasswordKdfGate = new AsyncGate(
  VIEWER_PASSWORD_KDF_CONCURRENCY,
  VIEWER_PASSWORD_KDF_PENDING_LIMIT,
);

function viewerPolicy(room: Room): ViewerAccessPolicy {
  return room.viewerGrantDigest === null ? "public-watch" : "private-link";
}

function parseViewerGrant(
  value: string,
): { roomId: string; expiresAtMs: number } | null {
  const [version, roomId, expiresAtText, secret, ...extra] = value.split(".");
  if (
    version !== "g1" ||
    extra.length > 0 ||
    !isRoomCode(roomId ?? "") ||
    !/^[1-9]\d{0,12}$/.test(expiresAtText ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/.test(secret ?? "")
  ) {
    return null;
  }
  const expiresAtSeconds = Number(expiresAtText);
  if (!Number.isSafeInteger(expiresAtSeconds)) {
    return null;
  }
  return { roomId: roomId!, expiresAtMs: expiresAtSeconds * 1_000 };
}
