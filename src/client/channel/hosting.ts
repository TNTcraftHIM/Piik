import type { ConversationReply, RoomSettings, RoomSummary, SignedConversationPacket } from "./protocol";

export interface HostedRoom {
  readonly roomId: string;
  summary(): RoomSummary | Promise<RoomSummary>;
  bind(bindingId: string): Promise<void>;
  dispatch(input: unknown): Promise<unknown>;
  dispatchPeer(packet: SignedConversationPacket, now: number): Promise<ConversationReply[]>;
  currentReaders(): string[] | Promise<string[]>;
  close(): Promise<void>;
}

interface RoomHosting {
  createSessionSigner(seed: Uint8Array): Promise<SessionSigner>;
  verify_reply(packet: string, key: Uint8Array): string;
  route_conversation(packet: string, local: string, state: string, from?: string): string;
  encode_control(frame: string): Uint8Array;
  decode_control(bytes: Uint8Array): string;
  initializeFiles(): Promise<void>;
  FileDelivery: new (sessionId: string) => FileDelivery;
  AttachmentHash: new () => AttachmentHash;
  attachment_media_type(bytes: Uint8Array): string;
  attachment_limits(): string;
  createRoomPolicy(input: RoomSettings & { id: string; creatorId: string }): Promise<string>;
  BrowserRoomHost: {
    open(databaseName: string, policy: string): Promise<HostedRoom>;
    storedPolicies(databaseName: string): Promise<string[]>;
  };
}

export interface SessionSigner {
  signing_key(): Uint8Array;
  sign(sender: string, payload: string): string;
  free(): void;
}

export interface AttachmentHash {
  update(bytes: Uint8Array): void;
  finish(): string;
  free(): void;
}
export interface FileDelivery {
  update(plans: string): string;
  control(peer: string, control: string): string;
  chunk(peer: string, frame: Uint8Array): string;
  read_result(key: string, offset: bigint, bytes: Uint8Array): string;
  written(key: string, offset: bigint, length: number): string;
  fail(key: string, code: string): string;
  peer_unavailable(peer: string): string;
  peer_failed(key: string, peer: string, code: string): string;
  start(key: string): string;
  cancel(key: string): string;
  free(): void;
}

const roomHostingModules = import.meta.glob<RoomHosting>("../../../prototype/channel-browser/src/room-host.ts");

/** Vite bundles the real adapter only for entries that use the channel client. */
export async function loadRoomHosting(): Promise<RoomHosting> {
  try { return await roomHostingModules["../../../prototype/channel-browser/src/room-host.ts"](); }
  catch { throw new Error("room_runtime_unavailable"); }
}

export function roomDatabaseName(channelId: string, userId: string): string {
  return `piik.channel.rooms.${channelId}.${userId}`;
}
