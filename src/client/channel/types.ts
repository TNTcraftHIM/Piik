import type { ChannelMessage, ChannelSnapshot, ChannelUser, DomainSettings, RoomSettings } from "./protocol";
import type { ChannelAttachments, DraftFile } from "./attachments";
import type { NativeCaptureTarget } from "../native/wire";
import type { NativeCaptureRequest, NativeCaptureSources, ChannelRemoteControlState } from "./app-link";
import type { RemoteStopShortcut } from "../native/wire";
import type { InputTransport } from "../remote-control/input-route";
import type { RemoteControlMode } from "../remote-control/protocol";
import type { QualityProfile } from "../media/quality";
import type { RoomInteractionSession } from "../lib/room-interactions";
import type { RoomPreferences } from "../lib/room-preferences";
import type { CaptureDevice } from "../media/capture-devices";
import type { BrowserCaptureSource } from "../media/quality";
import type { loadCameraPreviews } from "../media/camera-previews";

export interface ChannelScreenInput {
  flowId: string;
  stream: MediaStream;
  selected: boolean;
  switchReady: boolean;
}

export type ScreenPresentation = "prepared" | "waiting" | "failed";

export interface ChannelView {
  quality: QualityProfile;
  interactionsByRoom: ReadonlyMap<string, RoomInteractionSession>;
  voiceInput: RoomPreferences["voiceInput"];
  voicePlaybackByUser: ReadonlyMap<string, { volume: number; muted: boolean }>;
  listeningVolume: number;
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
  setQuality(profile: QualityProfile): void;
  screenQuality(publicationId: string): { applied: QualityProfile; requested: QualityProfile } | undefined;
  setScreenQuality(publicationId: string, profile: QualityProfile): Promise<void>;
  setScreenPaused(publicationId: string, paused: boolean): Promise<void>;
  sourceAudio(publicationId: string): { level: number; muted: boolean; bitrate: number; available: boolean } | undefined;
  setSourceAudio(publicationId: string, settings: { bitrate?: number; level?: number; muted?: boolean }): Promise<void>;
  activateApp(): Promise<void>;
  browse(roomId: string): void;
  sendMessage(roomId: string, text: string, attachments?: DraftFile[], signal?: AbortSignal): Promise<void>;
  setMessageReaction(roomId: string, messageSeq: number, reaction: string, active: boolean): Promise<void>;
  loadHistory(roomId: string): Promise<void>;
  loadLatestHistory(roomId: string): Promise<void>;
  attachments: ChannelAttachments;
  renameSelf(name: string): Promise<void>;
  updateDomain(settings: DomainSettings): Promise<void>;
  exportDomainBackup(): Promise<Blob>;
  restoreDomainBackup(archive: Blob): Promise<void>;
  createRoom(settings: RoomSettings): Promise<string>;
  updateRoom(roomId: string, settings: RoomSettings): Promise<void>;
  setRoomVoiceBitrate(roomId: string, bitrate: number): Promise<void>;
  roomBackupAvailable(roomId: string): Promise<boolean>;
  exportRoomBackup(roomId: string): Promise<Blob>;
  restoreRoomBackup(archive: Blob, roomId?: string): Promise<{ roomId: string; cached: boolean }>;
  enterRoom(roomId: string, password: string): Promise<void>;
  createRoomInvite(roomId: string): Promise<string>;
  revokeRoomAccess(roomId: string, userId: string): Promise<void>;
  setRoles(userId: string, roles: string[]): Promise<void>;
  startScreen(roomId: string, source?: BrowserCaptureSource, deviceId?: string): Promise<void>;
  cameraPreviews: typeof loadCameraPreviews;
  nativeSources(): Promise<NativeCaptureSources>;
  nativePreview(target: NativeCaptureTarget, signal?: AbortSignal): Promise<string | null>;
  nativeCaptureRequest(roomId: string): NativeCaptureRequest | undefined;
  nativeCaptureSelection(roomId: string): { target: NativeCaptureTarget; audio: boolean; excludeAudio?: NativeCaptureTarget } | undefined;
  startNativeScreen(roomId: string, target: NativeCaptureTarget, audio?: boolean, excludeAudio?: NativeCaptureTarget): Promise<void>;
  cancelScreenSelection(roomId: string): Promise<void>;
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
  setInputVolume(volume: number): void;
  microphones(): Promise<CaptureDevice[]>;
  configureVoiceInput(settings: Partial<Pick<RoomPreferences["voiceInput"], "deviceId" | "voiceProcessing">>): Promise<void>;
  setListeningVolume(volume: number): void;
  setVoiceVolume(userId: string, volume: number): void;
  setVoiceMuted(userId: string, muted: boolean): void;
  clearError(): void;
  reconnect(): void;
}

export type ChannelController = ChannelView & ChannelActions;
