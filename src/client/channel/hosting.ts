import type { ChannelMessage, ConversationReply, MessageReactions, RoomSettings, RoomSummary, SignedConversationPacket } from "./protocol";

export type BackupHistoryRow = ChannelMessage & { nonce: string; reactions: MessageReactions };
export interface BrowserRoomSnapshot {
  readonly policy: string;
  readonly rows: AsyncIterable<BackupHistoryRow>;
  close(): Promise<void>;
}
export interface BrowserRoomStage extends BrowserRoomSnapshot {
  append(row: BackupHistoryRow): Promise<void>;
  replace(signal?: AbortSignal): Promise<void>;
}

export interface HostedRoom {
  readonly roomId: string;
  summary(): RoomSummary | Promise<RoomSummary>;
  bind(bindingId: string): Promise<void>;
  dispatch(input: unknown): Promise<unknown>;
  dispatchPeer(packet: SignedConversationPacket, now: number): Promise<ConversationReply[]>;
  currentReaders(): string[] | Promise<string[]>;
  snapshot(): Promise<BrowserRoomSnapshot>;
  close(): Promise<void>;
}

interface RoomHosting {
  backup_metadata(input: string): string;
  backup_record_bytes(): number;
  message_mention_limit(): number;
  BackupHistoryImport: new (metadata: string) => BackupHistoryImport;
  CopyHistoryImport: new (metadata: string) => BackupHistoryImport;
  createSessionSigner(seed: Uint8Array): Promise<SessionSigner>;
  verify_reply(packet: string, key: Uint8Array): string;
  conversation_broadcast(record: string): string;
  verify_conversation(packet: string, local: string, state: string): string;
  route_input(frame: string, local: string, state: string, from?: string, binding?: string): string;
  input_binding_current(binding: string, local: string, state: string): boolean;
  encode_control(frame: string): Uint8Array;
  decode_control(bytes: Uint8Array): string;
  initializeRuntime(): Promise<void>;
  FileDelivery: new (sessionId: string) => FileDelivery;
  AttachmentHash: new () => AttachmentHash;
  attachment_media_type(bytes: Uint8Array): string;
  attachment_limits(): string;
  createRoomPolicy(input: RoomSettings & { id: string; creatorId: string }): Promise<string>;
  BrowserRoomHost: {
    open(databaseName: string, policy: string): Promise<HostedRoom>;
    storedPolicies(databaseName: string): Promise<string[]>;
    stage(databaseName: string, policy: string): Promise<BrowserRoomStage>;
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
export interface BackupHistoryImport {
  accept(input: string): string;
  finish(): void;
  free(): void;
}
export interface FileDelivery {
  update(plans: string, roomPeers: string, now: bigint): string;
  control(peer: string, control: string, now: bigint): string;
  next_deadline(): bigint | undefined;
  expire(now: bigint): string;
  chunk(peer: string, frame: Uint8Array): string;
  read_result(key: string, offset: bigint, requestId: string, bytes: Uint8Array): string;
  written(key: string, offset: bigint, length: number): string;
  request_failed(key: string, requestId: string, code: string): string;
  peer_closed(key: string, peer: string, code: string): string;
  peer_unavailable(peer: string): string;
  peer_failed(key: string, peer: string, requestId: string, code: string): string;
  start(key: string): string;
  cancel(key: string): string;
  free(): void;
}

const roomHostingModules = import.meta.glob<RoomHosting>("../../../prototype/channel-browser/src/room-host.ts");

/** Vite bundles the real adapter only for entries that use the channel client. */
export async function loadRoomHosting(): Promise<RoomHosting> {
  if (typeof WebAssembly === "undefined") throw new Error("webassembly_unavailable");
  try { return await roomHostingModules["../../../prototype/channel-browser/src/room-host.ts"](); }
  catch { throw new Error("room_runtime_unavailable"); }
}

export function roomDatabaseName(channelId: string, userId: string): string {
  return `piik.channel.rooms.${channelId}.${userId}`;
}
