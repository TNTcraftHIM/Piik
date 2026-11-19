// Platform-neutral room hosting and backup transactions over the shared wire.
import type { ChannelMessage, ConversationReply, MessageReactions, RoomSummary, SignedConversationPacket } from "../../../src/client/channel/protocol";

export type DeletedHistoryRow = { seq: number; retryKey: string };
export type BackupHistoryRow = DeletedHistoryRow | ChannelMessage & { nonce: string; reactions: MessageReactions };

// Zero is the staging marker. All history consumers in JavaScript need exact sequence keys.
export function validBackupSequence(seq: number): boolean {
  return Number.isSafeInteger(seq) && seq > 0;
}

export interface BrowserRoomSnapshot {
  readonly policy: string;
  readonly rows: AsyncIterable<BackupHistoryRow>;
  close(): Promise<void>;
}
export interface BrowserRoomStage extends BrowserRoomSnapshot {
  append(row: BackupHistoryRow): Promise<void>;
  replace(signal?: AbortSignal): Promise<void>;
  createRoom(policy: string, signal?: AbortSignal): Promise<void>;
}

export interface HostedRoom {
  readonly roomId: string;
  summary(): RoomSummary | Promise<RoomSummary>;
  bind(bindingId: string): Promise<void>;
  dispatch(input: unknown): Promise<unknown>;
  dispatchPeer(packet: SignedConversationPacket, now: number, signal?: AbortSignal, publish?: (output: unknown) => void): Promise<ConversationReply[]>;
  currentReaders(): string[] | Promise<string[]>;
  snapshot(): Promise<BrowserRoomSnapshot>;
  close(): Promise<void>;
}
