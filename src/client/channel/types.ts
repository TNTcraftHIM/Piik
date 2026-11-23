import type { WatchMediaSources } from "./watch-page-media";
import type { NativePageCandidate, NativePageIndexedSelection, NativePageMpdCatalog, NativePageMpdSelection } from "../native/wire";
import type { WatchMedia } from "./watch-media";
import type { WatchPlayer } from "./watch-playback";
import type { WatchPlayback, WatchMode } from "./protocol";
import type { ChannelMessage, ChannelSnapshot, ChannelTopology, ChannelUser, DomainSettings, RoomCreationPolicy, RoomInvitationState, RoomSettings, PublicationReactionSnapshot, ChatOptions, ProfilePage } from "./protocol";
export type { ChatOptions } from "./protocol";
import type { ChannelAttachments, DraftFile } from "./attachments";
import type { FeedbackCue } from "./feedback-audio";
import type { RoomCopyInfo } from "./backup-archive";
import type { NativeCaptureTarget, EncodingExecution } from "../native/wire";
import type { BackgroundVoiceShortcuts, NativeCaptureRequest, NativeCaptureSources, NativeExternalInput, ChannelRemoteControlState, NativeConnectionMetrics, NativeRelayCapacity } from "./app-link";
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
import type { ScreenPlaybackError } from "../media/viewer-playback";
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

export interface ChannelMediaMetrics {
  samples: ChannelMediaMetric[];
  unavailable: boolean;
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

export type ScreenBufferStatus = "supported" | "unsupported" | "failed" | null;

export interface ChannelView {
  watchPlayers: ReadonlyMap<string, WatchPlayer>;
  pagePlayer: boolean;
  externalScreenInputAvailable: boolean;
  screenBufferTargetMs: number | null;
  screenBufferStatus: ScreenBufferStatus;
  feedbackSound: RoomPreferences["feedbackSound"];
  quality: QualityProfile;
  videoCodecMode: BrowserVideoCodecMode;
  encodingExecution: EncodingExecution;
  interactionsByRoom: ReadonlyMap<string, RoomInteractionSession>;
  publicationReactions: ReadonlyMap<string, PublicationReactionSnapshot>;
  voiceInput: RoomPreferences["voiceInput"];
  voicePlaybackByUser: ReadonlyMap<string, { volume: number; muted: boolean }>;
  listeningVolume: number;
  appConnected: boolean;
  appPort?: number;
  backgroundVoiceShortcuts?: BackgroundVoiceShortcuts;
  ownedScreens: ReadonlySet<string>;
  /** Local playback provenance, independent of this page's capture controls. */
  localScreens: ReadonlySet<string>;
  state: ChannelSnapshot | null;
  sessionId: string | null;
  self: ChannelUser | null;
  profiles: ReadonlyMap<string, ChannelUser>;
  connection: "connecting" | "connected" | "reconnecting" | "closed";
  messagesByRoom: Record<string, ChannelMessage[]>;
  historyChangesByRoom: Record<string, RoomHistoryChanges>;
  forwardingLimit: number;
  historyByRoom: Record<string, { hasMore: boolean; before?: number; atLatest: boolean; emptyThrough?: number }>;
  readByRoom: Record<string, number>;
  streams: ReadonlyMap<string, MediaStream>;
  screenInputs: ReadonlyMap<string, readonly ChannelScreenInput[]>;
  inputChannels: ReadonlyMap<string, InputTransport>;
  remoteControls: ReadonlyMap<string, ChannelRemoteControlState>;
  error: string | null;
  siteURL: string | null;
  pending: ReadonlySet<string>;
}

export interface RoomHistoryChanges {
  clearedThrough: number;
  deleted: ReadonlySet<number>;
}

export function messageRemoved(changes: RoomHistoryChanges | undefined, seq: number): boolean {
  return !!changes && (seq <= changes.clearedThrough || changes.deleted.has(seq));
}

export interface ChatAttachmentPreparation {
  signal: AbortSignal;
  /** Clear the cancellable preparation before submitting the message. */
  progress(percent: number | null): void;
}

export interface ChannelActions {
  startWatch(roomId: string, url: string, reportError?: boolean): Promise<void>;
  prepareWatchEmbed(roomId: string, url: string, reportError?: boolean): Promise<void>;
  confirmWatchEmbed(roomId: string, reportError?: boolean): Promise<void>;
  watchEmbed(roomId: string): WatchMedia | undefined;
  prepareWatchPage(roomId: string, url: string, activityId?: string, reportError?: boolean): Promise<void>;
  watchPage(roomId: string, activityId?: string): { url: string; candidates: readonly NativePageCandidate[]; activityId?: string; watchSources?: WatchMediaSources } | undefined;
  selectWatchPage(roomId: string, candidateId: string, activityId?: string, reportError?: boolean, mode?: "choose-source" | "original-page"): Promise<boolean>;
  selectWatchBrowserSource(roomId: string, choiceId: string | null, reportError?: boolean): Promise<void>;
  focusWatch(id: string): Promise<void>;
  focusWatchPage(roomId: string, activityId?: string): Promise<void>;
  joinWatch(id: string, mode?: WatchMode): Promise<void>;
  watchMediaChoices(id: string, signal: AbortSignal, onChange?: (sources: WatchMediaSources) => void): Promise<WatchMediaSources>;
  inspectWatchMpdSource(roomId: string, choiceId: string, signal: AbortSignal, activityId?: string): Promise<NativePageMpdCatalog>;
  selectWatchMpdSource(roomId: string, selection: NativePageMpdSelection, reportError?: boolean): Promise<void>;
  selectWatchIndexedSource(roomId: string, videoId: string, audioId?: string, reportError?: boolean): Promise<void>;
  selectWatchForwardSource(roomId: string, choiceId: string, reportError?: boolean): Promise<void>;
  setWatchByteSource(id: string, choice: string | NativePageIndexedSelection | NativePageMpdSelection | null, signal?: AbortSignal): Promise<void>;
  watchEmbedPreparation(id: string): import("./watch-media").WatchMedia | undefined;
  cancelWatchPage(id: string): void;
  leaveWatch(id: string): Promise<void>;
  stopWatch(id: string): Promise<void>;
  setWatchPlayback(id: string, patch: Partial<Pick<WatchPlayback, "paused" | "position" | "rate">>): Promise<void>;
  resumeWatch(id: string): Promise<void>;
  setScreenBufferTarget(target: number | null): void;
  queryProfiles(query: { after?: string; query?: string }, signal?: AbortSignal): Promise<ProfilePage>;
  loadProfiles(ids: readonly string[]): Promise<ChannelUser[]>;
  setConversationPopout(roomId: string, document: Document | null): void;
  setFeedbackSound(patch: Partial<RoomPreferences["feedbackSound"]>): void;
  previewFeedbackSound(cue?: FeedbackCue): void;
  setFeedbackClip(cue: FeedbackCue, file: File | null): Promise<void>;
  setQuality(profile: QualityProfile): void;
  setVideoCodecMode(mode: BrowserVideoCodecMode): void;
  setEncodingExecution(mode: EncodingExecution): void;
  screenEncodingExecution(publicationId: string): EncodingExecution | undefined;
  screenQuality(publicationId: string): { applied: QualityProfile; requested: QualityProfile } | undefined;
  screenCodecMode(publicationId: string): BrowserVideoCodecMode | undefined;
  setScreenQuality(publicationId: string, profile: QualityProfile): Promise<void>;
  setScreenPaused(publicationId: string, paused: boolean): Promise<void>;
  setScreenDirectLimit(publicationId: string, limit: number | null): Promise<void>;
  setScreenTitle(publicationId: string, title: string | null): Promise<void>;
  sourceAudio(publicationId: string): { level: number; muted: boolean; bitrate: number; hasAudio: boolean; available: boolean; canMute: boolean } | undefined;
  setSourceAudio(publicationId: string, settings: { bitrate?: number; level?: number; muted?: boolean }): Promise<void>;
  sourceMicrophone(publicationId: string): SourceMicrophoneConfiguration & { browser: boolean; canDisable: boolean; available: boolean; requested: SourceMicrophoneConfiguration } | undefined;
  setSourceMicrophone(publicationId: string, settings: SourceMicrophoneSettings): Promise<void>;
  sourceMicrophones(publicationId: string, signal?: AbortSignal): Promise<CaptureDevice[]>;
  activateApp(verifiedHealth?: unknown, signal?: AbortSignal): Promise<void>;
  browse(roomId: string): void;
  roomTopology(roomId: string, publicationId?: string, signal?: AbortSignal): Promise<ChannelTopology>;
  connectionMetrics(roomId: string, publicationId?: string): Promise<ChannelMediaMetrics>;
  appConnectionMetrics(roomId: string, publicationId?: string, signal?: AbortSignal): Promise<NativeConnectionMetrics>;
  discardMessageRetry(roomId: string, bindingId?: string): void;
  sendMessage(roomId: string, text: string, attachments?: DraftFile[], signal?: AbortSignal, options?: ChatOptions, preparation?: ChatAttachmentPreparation): Promise<void>;
  deleteMessage(roomId: string, messageSeq: number, messageId: string): Promise<void>;
  purgeRoomHistory(roomId: string): Promise<void>;
  clearLocalRoomCache(roomId: string): Promise<void>;
  markRead(roomId: string, seq: number): void;
  findUnreadMessage(roomId: string, after: number, signal: AbortSignal): Promise<ChannelMessage | null>;
  loadMessage(roomId: string, seq: number): Promise<void>;
  loadHistory(roomId: string): Promise<void>;
  loadLatestHistory(roomId: string): Promise<void>;
  attachments: ChannelAttachments;
  updateProfile(profile: { name?: string; avatar?: string | null }): Promise<void>;
  updateDomain(settings: Partial<DomainSettings>, reportError?: boolean): Promise<void>;
  setRoomCreationPolicy(policy: RoomCreationPolicy, reportError?: boolean): Promise<void>;
  exportDomainBackup(signal?: AbortSignal): Promise<Blob>;
  restoreDomainBackup(archive: Blob): Promise<DomainSettings>;
  createRoom(settings: RoomSettings, reportError?: boolean): Promise<string>;
  updateRoom(roomId: string, settings: Partial<RoomSettings>, reportError?: boolean): Promise<void>;
  deleteRoom(roomId: string, deleteData: boolean, reportError?: boolean): Promise<{ dataRemoved: boolean }>;
  setRoomVoiceBitrate(roomId: string, bitrate: number): Promise<void>;
  setForwardingLimit(capacity: number): void;
  appRelayCapacity(signal?: AbortSignal): Promise<NativeRelayCapacity>;
  setAppRelayOverride(current: NativeRelayCapacity, capacity: number | null, reportError?: boolean): Promise<NativeRelayCapacity>;
  roomBackupAvailable(roomId: string): Promise<boolean>;
  exportRoomBackup(roomId: string, includeFiles?: boolean, signal?: AbortSignal): Promise<Blob>;
  exportRoomCopy(roomId: string, includeRoomInfo: boolean, includeFiles?: boolean, signal?: AbortSignal): Promise<Blob>;
  inspectRoomCopy(archive: Blob): Promise<{ settings: Partial<RoomCopyInfo>; retainedFileCount: number }>;
  importRoomCopy(archive: Blob, settings: RoomSettings): Promise<{ roomId: string; cached: boolean }>;
  restoreRoomBackup(archive: Blob, roomId?: string): Promise<{ roomId: string; cached: boolean }>;
  enterRoom(roomId: string, password: string): Promise<void>;
  createRoomInvite(roomId: string, reportError?: boolean): Promise<string>;
  getRoomInvite(roomId: string): Promise<RoomInvitationState>;
  revokeRoomAccess(roomId: string, userId: string, reportError?: boolean): Promise<void>;
  startScreen(roomId: string, source?: BrowserCaptureSource, deviceId?: string): Promise<void>;
  cameraPreviews: typeof loadCameraPreviews;
  nativeSources(signal?: AbortSignal): Promise<NativeCaptureSources>;
  externalInput(roomId: string): (NativeExternalInput & { publicationId: string }) | undefined;
  startExternalScreen(roomId: string): Promise<void>;
  cancelExternalScreen(roomId: string): Promise<void>;
  nativePreview(target: NativeCaptureTarget, signal?: AbortSignal): Promise<string | null>;
  nativeCaptureRequest(roomId: string): NativeCaptureRequest | undefined;
  nativeCaptureSelection(roomId: string): { target: NativeCaptureTarget; audio: boolean; excludeAudio?: NativeCaptureTarget; showCaptureBorder: boolean; current: boolean } | undefined;
  startNativeScreen(roomId: string, target: NativeCaptureTarget, audio?: boolean, excludeAudio?: NativeCaptureTarget, showCaptureBorder?: boolean): Promise<void>;
  sourceSelectionCommitting(roomId: string): boolean;
  browserCapturePreparation(roomId: string): "picker" | "preparing" | undefined;
  cancelScreenSelection(roomId: string): Promise<void>;
  stopScreen(publicationId: string): Promise<void>;
  watch(publicationId: string): Promise<void>;
  unwatch(publicationId: string): Promise<void>;
  retryPicture(publicationId: string): Promise<void>;
  screenPresentation(flowId: string, stream: MediaStream, state: ScreenPresentation, playbackError?: ScreenPlaybackError): void;
  screenPlaybackError(publicationId: string): ScreenPlaybackError | undefined;
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
  configureVoiceInput(settings: Partial<Pick<RoomPreferences["voiceInput"], "deviceId" | "voiceProcessing" | "strongerSuppression">>): Promise<void>;
  setListeningVolume(volume: number): void;
  setVoiceVolume(userId: string, volume: number): void;
  setVoiceMuted(userId: string, muted: boolean): void;
  clearError(): void;
  reconnect(): void;
  joinAsNewIdentity(): void;
}

export type ChannelController = ChannelView & ChannelActions;
