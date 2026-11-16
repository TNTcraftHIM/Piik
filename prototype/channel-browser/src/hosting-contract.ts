// Platform-neutral room hosting and backup transactions over the shared wire.
import type { ChannelMessage, ConversationReply, MessageReactions, RoomSummary, SignedConversationPacket } from "../../../src/client/channel/protocol";

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
