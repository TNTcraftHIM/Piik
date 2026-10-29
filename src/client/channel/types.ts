import type { ChannelMessage, ChannelSnapshot, ChannelUser, RoomSettings } from "./protocol";
import type { ChannelAttachments, DraftFile } from "./attachments";
import type { NativeCaptureTarget } from "../native/wire";
import type { NativeCaptureSources, ChannelRemoteControlState } from "./app-link";
import type { RemoteStopShortcut } from "../native/wire";
import type { InputTransport } from "../remote-control/input-route";
import type { RemoteControlMode } from "../remote-control/protocol";

export interface ChannelScreenInput {
  flowId: string;
  stream: MediaStream;
  selected: boolean;
  switchReady: boolean;
}

export type ScreenPresentation = "prepared" | "waiting" | "failed";

export interface ChannelView {
  appConnected: boolean;
  ownedScreens: ReadonlySet<string>;
  state: ChannelSnapshot | null;
  sessionId: string | null;
  self: ChannelUser | null;
  connection: "connecting" | "connected" | "reconnecting" | "closed";
  messagesByRoom: Record<string, ChannelMessage[]>;
  historyByRoom: Record<string, { hasMore: boolean; before?: number; atLatest: boolean }>;
  streams: ReadonlyMap<string, MediaStream>;
  screenInputs: ReadonlyMap<string, readonly ChannelScreenInput[]>;
  inputChannels: ReadonlyMap<string, InputTransport>;
  remoteControls: ReadonlyMap<string, ChannelRemoteControlState>;
  error: string | null;
  inviteURL: string | null;
  pending: ReadonlySet<string>;
}

export interface ChannelActions {
  activateApp(): Promise<void>;
  browse(roomId: string): void;
  sendMessage(roomId: string, text: string, attachments?: DraftFile[], signal?: AbortSignal): Promise<void>;
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
  nativeSources(): Promise<NativeCaptureSources>;
  startNativeScreen(roomId: string, target: NativeCaptureTarget, audio?: boolean): Promise<void>;
  stopScreen(publicationId: string): Promise<void>;
  watch(publicationId: string): Promise<void>;
  unwatch(publicationId: string): Promise<void>;
  screenPresentation(flowId: string, stream: MediaStream, state: ScreenPresentation): void;
  inputPolicy(publicationId: string, mode: RemoteControlMode, password?: string): Promise<void>;
  inputDecide(publicationId: string, requestId: string, allow: boolean): Promise<void>;
  inputSimultaneous(publicationId: string, enabled: boolean): Promise<void>;
  inputShortcut(publicationId: string, key?: number): Promise<RemoteStopShortcut>;
  joinVoice(roomId: string, listenOnly?: boolean): Promise<void>;
  leaveVoice(roomId: string): Promise<void>;
  setMuted(roomId: string, muted: boolean): Promise<void>;
  setDeafened(roomId: string, deafened: boolean): Promise<void>;
  clearError(): void;
  reconnect(): void;
}

export type ChannelController = ChannelView & ChannelActions;
