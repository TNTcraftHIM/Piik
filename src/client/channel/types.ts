import type { ChannelMessage, ChannelSnapshot, ChannelUser } from "./protocol";

export interface ChannelView {
  state: ChannelSnapshot | null;
  sessionId: string | null;
  self: ChannelUser | null;
  connection: "connecting" | "connected" | "reconnecting" | "closed";
  messagesByRoom: Record<string, ChannelMessage[]>;
  streams: ReadonlyMap<string, MediaStream>;
  error: string | null;
  inviteURL: string | null;
  pending: ReadonlySet<string>;
}

export interface ChannelActions {
  browse(roomId: string): void;
  sendMessage(roomId: string, text: string): Promise<void>;
  renameSelf(name: string): Promise<void>;
  createRoom(name: string): Promise<void>;
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
