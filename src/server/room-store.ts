import {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

import {
  MAX_VIEWERS_PER_ROOM_LIMIT,
  viewerGrantSchema,
  viewerPasswordSchema,
  type CodeEntryPolicy,
  type Role,
} from "../shared/protocol.js";

export type RoomStoreErrorCode =
  | "INVALID_TOKEN"
  | "ROOM_ACCESS_DENIED"
  | "ROOM_NOT_FOUND"
  | "ROOM_EXPIRED"
  | "ROOM_FULL"
  | "HOST_ALREADY_CONNECTED"
  | "ROOM_LIMIT";

export const ROOM_CAPACITY = 9_000;
const ROOM_CODE_FIRST = 1_000;
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
  admittedBy: "grant" | "code";
}

interface Room {
  roomId: string;
  hostTokenDigest: Buffer;
  viewerGrantDigest: Buffer;
  viewerPasswordMaterial: Buffer | null;
  viewerAuthorizationGeneration: string;
  codeEntryPolicy: CodeEntryPolicy;
  sharingActive: boolean;
  leaseExpiresAtMs: number | null;
  host?: Participant;
  viewers: Map<string, Participant>;
}

export interface CreatedRoom {
  roomId: string;
  hostToken: string;
  codeEntryPolicy: CodeEntryPolicy;
  viewerGrant: string | null;
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
  codeEntryPolicy: CodeEntryPolicy;
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

export interface ViewerGrantUpdate {
  viewerGrant: string | null;
  viewerAuthorizationGeneration: string;
  previousViewerAuthorizationGeneration: string;
  revokedViewers: readonly RevokedViewer[];
}

export interface CodeEntryUpdate {
  codeEntryPolicy: CodeEntryPolicy;
  viewerPasswordEnabled: boolean;
}

export interface RoomStoreOptions {
  leaseMs: number;
  maxRooms: number;
  maxViewersPerRoom: number;
  now?: () => number;
  random?: (size: number) => Buffer;
}

export class RoomStore {
  private readonly rooms = new Map<string, Room>();
  private readonly freeRoomCodes = Array.from(
    { length: ROOM_CAPACITY },
    (_, index) => (ROOM_CODE_FIRST + index).toString(),
  );
  private readonly now: () => number;
  private readonly random: (size: number) => Buffer;
  readonly maxViewersPerRoom: number;

  constructor(private readonly options: RoomStoreOptions) {
    if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs <= 0) {
      throw new Error("Room lease must be a positive integer");
    }
    if (
      !Number.isSafeInteger(options.maxRooms) ||
      options.maxRooms <= 0 ||
      options.maxRooms > ROOM_CAPACITY
    ) {
      throw new Error(
        `Room limit must be an integer between 1 and ${ROOM_CAPACITY}`,
      );
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
  }

  async createRoom(
    codeEntryPolicy: CodeEntryPolicy = "open",
    roomPassword?: string | null,
    preferredRoomId?: string,
  ): Promise<CreatedRoom> {
    if (this.rooms.size >= this.options.maxRooms) {
      throw new RoomStoreError("ROOM_LIMIT");
    }
    const createdAtMs = this.now();
    const viewerPasswordMaterial = roomPassword
      ? await this.createViewerPasswordMaterial(roomPassword)
      : null;
    if (this.rooms.size >= this.options.maxRooms) {
      throw new RoomStoreError("ROOM_LIMIT");
    }
    const roomId = this.takeRoomCode(preferredRoomId);
    try {
      const hostTokenBytes = this.random(32);
      if (hostTokenBytes.byteLength !== 32) {
        throw new Error("Host token random source must return 32 bytes");
      }
      const hostToken = hostTokenBytes.toString("base64url");
      const viewerGrant = this.createViewerGrant();
      const viewerAuthorizationGeneration = this.newAuthorizationGeneration();

      this.rooms.set(roomId, {
        roomId,
        hostTokenDigest: digest(hostToken),
        viewerGrantDigest: digest(viewerGrant),
        viewerPasswordMaterial,
        viewerAuthorizationGeneration,
        codeEntryPolicy,
        sharingActive: false,
        leaseExpiresAtMs: createdAtMs + this.options.leaseMs,
        viewers: new Map(),
      });

      return {
        roomId,
        hostToken,
        codeEntryPolicy,
        viewerGrant,
        expiresAt: formatExpiresAt(createdAtMs + this.options.leaseMs),
      };
    } catch (error) {
      this.releaseRoomCode(roomId);
      throw error;
    }
  }

  connectParticipant(input: ConnectParticipantInput): ConnectedParticipant {
    let room: Room;
    try {
      room = this.getAvailableRoom(input.roomId);
    } catch (error) {
      if (
        input.role === "viewer" &&
        !input.viewerGrant &&
        error instanceof RoomStoreError &&
        (error.code === "INVALID_TOKEN" || error.code === "ROOM_EXPIRED")
      ) {
        throw new RoomStoreError("ROOM_NOT_FOUND");
      }
      throw error;
    }
    if (input.role === "host") {
      if (!verifyDigest(input.token, room.hostTokenDigest)) {
        throw new RoomStoreError("INVALID_TOKEN");
      }
      return this.connectHost(room, input);
    }

    if (input.viewerGrant) {
      if (!this.viewerGrantIsValid(room, input.viewerGrant)) {
        throw new RoomStoreError("INVALID_TOKEN");
      }
      return this.connectViewer(room, input, "grant");
    }
    if (room.codeEntryPolicy !== "open") {
      throw new RoomStoreError("INVALID_TOKEN");
    }
    return this.connectViewer(room, input, "code");
  }

  viewerGrantMayEnter(roomId: string, grant: string | undefined): boolean {
    try {
      return this.viewerGrantIsValid(this.getAvailableRoom(roomId), grant);
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
    const expectedMaterial =
      room?.codeEntryPolicy === "private" && room.viewerPasswordMaterial
        ? Buffer.from(room.viewerPasswordMaterial)
        : DUMMY_VIEWER_PASSWORD_MATERIAL;
    const expectedSalt = expectedMaterial.subarray(0, VIEWER_PASSWORD_SALT_BYTES);
    const expectedVerifier = expectedMaterial.subarray(VIEWER_PASSWORD_SALT_BYTES);
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
        throw new RoomStoreError("ROOM_NOT_FOUND");
      }
      throw error;
    }
    if (
      !room ||
      currentRoom !== room ||
      currentRoom.codeEntryPolicy !== "private" ||
      currentRoom.viewerPasswordMaterial === null ||
      !matches ||
      !sameBytes(currentRoom.viewerPasswordMaterial, expectedMaterial) ||
      !mayConnect()
    ) {
      throw new RoomStoreError("INVALID_TOKEN");
    }
    try {
      return this.connectViewer(currentRoom, { ...input, role: "viewer" }, "code");
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
    hostToken: string,
  ): Promise<boolean> {
    const room = this.getHostManagedRoom(roomId, hostToken);

    const nextPasswordMaterial = password
      ? await this.createViewerPasswordMaterial(password, () => {
          const currentRoom = this.rooms.get(roomId);
          return (
            currentRoom === room &&
            verifyDigest(hostToken, currentRoom.hostTokenDigest)
          );
        })
      : null;

    const currentRoom = this.getHostManagedRoom(roomId, hostToken);
    if (
      currentRoom !== room ||
      (password !== null && nextPasswordMaterial === null)
    ) {
      throw new RoomStoreError("ROOM_ACCESS_DENIED");
    }
    currentRoom.viewerPasswordMaterial = nextPasswordMaterial;
    return nextPasswordMaterial !== null;
  }

  setCodeEntryPolicy(
    roomId: string,
    policy: CodeEntryPolicy,
    hostToken: string,
  ): CodeEntryUpdate {
    const room = this.getHostManagedRoom(roomId, hostToken);
    room.codeEntryPolicy = policy;
    return {
      codeEntryPolicy: policy,
      viewerPasswordEnabled: room.viewerPasswordMaterial !== null,
    };
  }

  setViewerGrant(
    roomId: string,
    action: "rotate" | "revoke",
    hostToken: string,
  ): ViewerGrantUpdate {
    const room = this.getHostManagedRoom(roomId, hostToken);
    const previousViewerAuthorizationGeneration =
      room.viewerAuthorizationGeneration;
    const viewerGrant = action === "rotate" ? this.createViewerGrant() : null;

    const revokedViewers = [...room.viewers.values()]
      .filter((viewer) => viewer.admittedBy === "grant")
      .map((viewer) => ({
        peerId: viewer.peerId,
        ...(viewer.sessionId ? { sessionId: viewer.sessionId } : {}),
      }));
    const viewerGrantDigest = viewerGrant
      ? digest(viewerGrant)
      : this.randomDigest();
    const viewerAuthorizationGeneration = this.newAuthorizationGeneration();
    room.viewerGrantDigest = viewerGrantDigest;
    room.viewerAuthorizationGeneration = viewerAuthorizationGeneration;
    for (const [clientId, viewer] of room.viewers) {
      if (viewer.admittedBy === "grant") {
        room.viewers.delete(clientId);
      }
    }
    return {
      viewerGrant,
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
      room.sharingActive = false;
      room.leaseExpiresAtMs = this.now() + this.options.leaseMs;
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
    return room ? [...room.viewers.values()].map((viewer) => viewer.peerId) : [];
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
    const sessionIds = connectedSessionIds(room);
    this.rooms.delete(roomId);
    this.releaseRoomCode(roomId);
    return { roomId, sessionIds };
  }

  expireRooms(nowMs = this.now()): ClosedRoom[] {
    const expired: ClosedRoom[] = [];
    for (const [roomId, room] of this.rooms) {
      if (!roomIsExpired(room, nowMs)) {
        continue;
      }
      expired.push({ roomId, sessionIds: connectedSessionIds(room) });
      this.rooms.delete(roomId);
      this.releaseRoomCode(roomId);
    }
    return expired;
  }

  get size(): number {
    return this.rooms.size;
  }

  close(): void {
    // Room state is process-memory only and disappears with the process.
  }

  private connectHost(
    room: Room,
    input: ConnectParticipantInput,
  ): ConnectedParticipant {
    const current = room.host;
    if (current?.sessionId && current.clientId !== input.clientId) {
      throw new RoomStoreError("HOST_ALREADY_CONNECTED");
    }

    const isNewParticipant = !current || current.clientId !== input.clientId;
    const participant: Participant = isNewParticipant
      ? {
          clientId: input.clientId,
          peerId: this.newPeerId(room),
          admittedBy: "code",
        }
      : current;
    const replacedSessionId = participant.sessionId;
    participant.sessionId = input.sessionId;
    room.host = participant;
    room.sharingActive = true;
    room.leaseExpiresAtMs = null;

    return this.connectedParticipant(
      room,
      participant.peerId,
      "host",
      replacedSessionId,
      input.sessionId,
    );
  }

  private connectViewer(
    room: Room,
    input: ConnectParticipantInput,
    admittedBy: "grant" | "code",
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
        admittedBy,
      } satisfies Participant);
    const replacedSessionId = participant.sessionId;
    participant.sessionId = input.sessionId;
    participant.admittedBy = admittedBy;
    room.viewers.set(input.clientId, participant);
    return this.connectedParticipant(
      room,
      participant.peerId,
      "viewer",
      replacedSessionId,
      input.sessionId,
    );
  }

  private connectedParticipant(
    room: Room,
    peerId: string,
    role: Role,
    replacedSessionId: string | undefined,
    sessionId: string,
  ): ConnectedParticipant {
    return {
      roomId: room.roomId,
      role,
      peerId,
      expiresAt: formatExpiresAt(room.leaseExpiresAtMs),
      hostOnline: Boolean(room.host?.sessionId),
      replacedSessionId:
        replacedSessionId === sessionId ? undefined : replacedSessionId,
      viewerPeerIds:
        role === "host"
          ? [...room.viewers.values()].map((viewer) => viewer.peerId)
          : [],
      codeEntryPolicy: room.codeEntryPolicy,
      viewerPasswordEnabled: room.viewerPasswordMaterial !== null,
      viewerAuthorizationGeneration: room.viewerAuthorizationGeneration,
    };
  }

  private getAvailableRoom(roomId: string): Room {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new RoomStoreError("INVALID_TOKEN");
    }
    if (roomIsExpired(room, this.now())) {
      throw new RoomStoreError("ROOM_EXPIRED");
    }
    return room;
  }

  private getHostManagedRoom(roomId: string, hostToken: string): Room {
    const room = this.getAvailableRoom(roomId);
    if (!verifyDigest(hostToken, room.hostTokenDigest)) {
      throw new RoomStoreError("INVALID_TOKEN");
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

  private takeRoomCode(preferredRoomId?: string): string {
    if (this.freeRoomCodes.length === 0) {
      throw new RoomStoreError("ROOM_LIMIT");
    }
    if (preferredRoomId) {
      const preferredIndex = this.freeRoomCodes.indexOf(preferredRoomId);
      if (preferredIndex >= 0) {
        return this.takeRoomCodeAt(preferredIndex);
      }
    }
    const range = BigInt(this.freeRoomCodes.length);
    const randomLimit = (1n << 64n) - ((1n << 64n) % range);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const bytes = this.random(8);
      if (bytes.byteLength !== 8) {
        throw new Error("Room code random source must return 8 bytes");
      }
      const value = bytes.readBigUInt64BE();
      if (value >= randomLimit) {
        continue;
      }
      const index = Number(value % range);
      return this.takeRoomCodeAt(index);
    }
    throw new Error("Unable to select a room code uniformly");
  }

  private takeRoomCodeAt(index: number): string {
    const roomId = this.freeRoomCodes[index]!;
    const lastRoomId = this.freeRoomCodes.pop()!;
    if (index < this.freeRoomCodes.length) {
      this.freeRoomCodes[index] = lastRoomId;
    }
    return roomId;
  }

  private releaseRoomCode(roomId: string): void {
    this.freeRoomCodes.push(roomId);
  }

  private uniqueId(size: number, exists: (candidate: string) => boolean): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const value = this.random(size);
      if (value.byteLength !== size) {
        throw new Error(`Identifier random source must return ${size} bytes`);
      }
      const candidate = value.toString("base64url");
      if (!exists(candidate)) {
        return candidate;
      }
    }
    throw new Error("Unable to allocate a unique identifier");
  }

  private viewerGrantIsValid(room: Room, grant: string | undefined): boolean {
    if (!grant || !viewerGrantSchema.safeParse(grant).success) {
      return false;
    }
    return verifyDigest(grant, room.viewerGrantDigest);
  }

  private createViewerGrant(): string {
    const secret = this.random(16);
    if (secret.byteLength !== 16) {
      throw new Error("Viewer grant random source must return 16 bytes");
    }
    return secret.toString("base64url");
  }

  private async createViewerPasswordMaterial(
    password: string,
    mayStart: () => boolean = () => true,
  ): Promise<Buffer | null> {
    if (!viewerPasswordSchema.safeParse(password).success) {
      throw new RoomStoreError("INVALID_TOKEN");
    }
    const salt = this.random(VIEWER_PASSWORD_SALT_BYTES);
    if (salt.byteLength !== VIEWER_PASSWORD_SALT_BYTES) {
      throw new Error("Viewer password salt source must return 16 bytes");
    }
    const verifier = await deriveViewerPassword(password, salt, mayStart);
    return verifier && Buffer.concat([salt, verifier]);
  }

  private randomDigest(): Buffer {
    const value = this.random(32);
    if (value.byteLength !== 32) {
      throw new Error("Viewer grant random source must return 32 bytes");
    }
    return Buffer.from(value);
  }

  private newAuthorizationGeneration(): string {
    const value = this.random(16);
    if (value.byteLength !== 16) {
      throw new Error(
        "Authorization generation random source must return 16 bytes",
      );
    }
    return value.toString("base64url");
  }
}

function roomIsExpired(room: Room, nowMs: number): boolean {
  return (
    !room.sharingActive &&
    room.leaseExpiresAtMs !== null &&
    room.leaseExpiresAtMs <= nowMs
  );
}

function formatExpiresAt(expiresAtMs: number | null): string | null {
  return expiresAtMs === null ? null : new Date(expiresAtMs).toISOString();
}

function findViewerByPeerId(
  room: Room,
  peerId: string,
): Participant | undefined {
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
          (error, derivedKey) =>
            error ? reject(error) : resolve(derivedKey),
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
