import type { ChannelMessage, ChannelSnapshot, ChannelTopology, ChannelUser, DomainSettings, RoomInvitationState, RoomSettings } from "./protocol";
import type { ChannelAttachments, DraftFile } from "./attachments";
import type { NativeCaptureTarget } from "../native/wire";
import type { NativeCaptureRequest, NativeCaptureSources, ChannelRemoteControlState, NativeConnectionMetrics } from "./app-link";
import type { RemoteStopShortcut } from "../native/wire";
import type { InputTransport } from "../remote-control/input-route";
import type { RemoteControlMode } from "../remote-control/protocol";
import type { QualityProfile } from "../media/quality";
import type { RoomInteractionSession } from "../lib/room-interactions";
import type { RoomPreferences } from "../lib/room-preferences";
import type { CaptureDevice } from "../media/capture-devices";
import type { BrowserCaptureSource } from "../media/quality";
import type { loadCameraPreviews } from "../media/camera-previews";
import type { CommentaryInput } from "../media/host-audio";
import type { BrowserVideoCodecMode } from "../webrtc/video-codec";
import type { ConnectionMetrics } from "../types";

export interface ChannelMediaMetric {
  pairId: string;
  flowId: string;
  publicationId: string;
  peerId: string;
  direction: "send" | "receive";
  media: "video" | "audio";
  metrics: ConnectionMetrics;
}

export interface ChannelConnectionSample extends ChannelMediaMetric {
  ownerSessionId: string;
  connectionId: string;
  selected: boolean;
}

export type SourceMicrophoneConfiguration = Omit<CommentaryInput, "voiceProcessing"> & { enabled: boolean; voiceProcessing?: boolean };
export type SourceMicrophoneSettings = Partial<SourceMicrophoneConfiguration>;

export interface ChannelScreenInput {
  flowId: string;
  stream: MediaStream;
  selected: boolean;
  switchReady: boolean;
}

export type ScreenPresentation = "prepared" | "waiting" | "failed";

export interface ChannelView {
  quality: QualityProfile;
  videoCodecMode: BrowserVideoCodecMode;
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
  setVideoCodecMode(mode: BrowserVideoCodecMode): void;
  screenQuality(publicationId: string): { applied: QualityProfile; requested: QualityProfile } | undefined;
  screenCodecMode(publicationId: string): BrowserVideoCodecMode | undefined;
  setScreenQuality(publicationId: string, profile: QualityProfile): Promise<void>;
  setScreenPaused(publicationId: string, paused: boolean): Promise<void>;
  sourceAudio(publicationId: string): { level: number; muted: boolean; bitrate: number; hasAudio: boolean; available: boolean; canMute: boolean } | undefined;
  setSourceAudio(publicationId: string, settings: { bitrate?: number; level?: number; muted?: boolean }): Promise<void>;
  sourceMicrophone(publicationId: string): SourceMicrophoneConfiguration & { browser: boolean; canDisable: boolean; available: boolean; requested: SourceMicrophoneConfiguration } | undefined;
  setSourceMicrophone(publicationId: string, settings: SourceMicrophoneSettings): Promise<void>;
  sourceMicrophones(publicationId: string): Promise<CaptureDevice[]>;
  activateApp(): Promise<void>;
  browse(roomId: string): void;
  roomTopology(roomId: string, publicationId?: string, signal?: AbortSignal): Promise<ChannelTopology>;
  connectionMetrics(roomId: string, publicationId?: string): Promise<ChannelMediaMetric[]>;
  appConnectionMetrics(roomId: string, publicationId?: string, signal?: AbortSignal): Promise<NativeConnectionMetrics>;
  sendMessage(roomId: string, text: string, attachments?: DraftFile[], signal?: AbortSignal): Promise<void>;
  setMessageReaction(roomId: string, messageSeq: number, reaction: string, active: boolean): Promise<void>;
  loadHistory(roomId: string): Promise<void>;
  loadLatestHistory(roomId: string): Promise<void>;
  attachments: ChannelAttachments;
  renameSelf(name: string): Promise<void>;
  enterDomain(password: string): void;
  resetDomainInvite(reportError?: boolean): Promise<void>;
  updateDomain(settings: DomainSettings, reportError?: boolean): Promise<void>;
  exportDomainBackup(): Promise<Blob>;
  restoreDomainBackup(archive: Blob): Promise<DomainSettings>;
  createRoom(settings: RoomSettings, reportError?: boolean): Promise<string>;
  updateRoom(roomId: string, settings: RoomSettings, reportError?: boolean): Promise<void>;
  deleteRoom(roomId: string, deleteData: boolean, reportError?: boolean): Promise<{ dataRemoved: boolean }>;
  setRoomVoiceBitrate(roomId: string, bitrate: number): Promise<void>;
  setRelayOverride(roomId: string, capacity: number | null, reportError?: boolean): Promise<void>;
  roomBackupAvailable(roomId: string): Promise<boolean>;
  exportRoomBackup(roomId: string): Promise<Blob>;
  restoreRoomBackup(archive: Blob, roomId?: string): Promise<{ roomId: string; cached: boolean }>;
  enterRoom(roomId: string, password: string): Promise<void>;
  createRoomInvite(roomId: string, reportError?: boolean): Promise<string>;
  getRoomInvite(roomId: string): Promise<RoomInvitationState>;
  revokeRoomAccess(roomId: string, userId: string, reportError?: boolean): Promise<void>;
  startScreen(roomId: string, source?: BrowserCaptureSource, deviceId?: string): Promise<void>;
  cameraPreviews: typeof loadCameraPreviews;
  nativeSources(): Promise<NativeCaptureSources>;
  nativePreview(target: NativeCaptureTarget, signal?: AbortSignal): Promise<string | null>;
  nativeCaptureRequest(roomId: string): NativeCaptureRequest | undefined;
  nativeCaptureSelection(roomId: string): { target: NativeCaptureTarget; audio: boolean; excludeAudio?: NativeCaptureTarget; showCaptureBorder: boolean; current: boolean } | undefined;
  startNativeScreen(roomId: string, target: NativeCaptureTarget, audio?: boolean, excludeAudio?: NativeCaptureTarget, showCaptureBorder?: boolean): Promise<void>;
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
  canUnmute(roomId: string): boolean;
  /** Post-gain linear levels keyed by the speaking endpoint/session, never its relay. */
  voiceActivity(roomId: string, localOnly?: boolean): Promise<ReadonlyMap<string, number>>;
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
