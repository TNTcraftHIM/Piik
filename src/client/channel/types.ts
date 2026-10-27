import type { ChannelMessage, ChannelSnapshot, ChannelUser, RoomSettings } from "./protocol";
import type { ChannelAttachments } from "./attachments";

export interface ChannelView {
  state: ChannelSnapshot | null;
  sessionId: string | null;
  self: ChannelUser | null;
  connection: "connecting" | "connected" | "reconnecting" | "closed";
  messagesByRoom: Record<string, ChannelMessage[]>;
  historyByRoom: Record<string, { hasMore: boolean; before?: number; atLatest: boolean }>;
  streams: ReadonlyMap<string, MediaStream>;
  error: string | null;
  inviteURL: string | null;
  pending: ReadonlySet<string>;
}

export interface ChannelActions {
  browse(roomId: string): void;
  sendMessage(roomId: string, text: string, attachments?: string[]): Promise<void>;
  loadHistory(roomId: string): Promise<void>;
  loadLatestHistory(roomId: string): Promise<void>;
  attachments: ChannelAttachments;
  renameSelf(name: string): Promise<void>;
  createRoom(settings: RoomSettings): Promise<string>;
  updateRoom(roomId: string, settings: RoomSettings): Promise<void>;
  enterRoom(roomId: string, password: string): Promise<void>;
  createRoomInvite(roomId: string): Promise<string>;
  revokeRoomAccess(roomId: string, userId: string): Promise<void>;
  setRoles(userId: string, roles: string[]): Promise<void>;
  startScreen(roomId: string): Promise<void>;
  stopScreen(publicationId: string): Promise<void>;
  watch(publicationId: string): Promise<void>;
  unwatch(publicationId: string): Promise<void>;
  joinVoice(roomId: string, listenOnly?: boolean): Promise<void>;
  leaveVoice(roomId: string): Promise<void>;
  setMuted(roomId: string, muted: boolean): Promise<void>;
  setDeafened(roomId: string, deafened: boolean): Promise<void>;
  clearError(): void;
  reconnect(): void;
}

export type ChannelController = ChannelView & ChannelActions;
