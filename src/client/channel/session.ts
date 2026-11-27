import { is_watch_frame, session_recovery_ms } from "../../../prototype/channel-browser/pkg/piik_channel_browser";
import { isDocumentActive } from "../ui/document-active";
import type { NativeCaptureSelection } from "../native/capture-selection";
import { RoomCreationInterrupted } from "./room-creation";
import { YouTubeMedia } from "./watch-youtube-media";
import { PeerTubeMedia } from "./watch-peertube-media";
import { canMoveWatchEmbed, canWatchInBrowser, originalWatchURL, sharedWatchEmbed, watchEmbed } from "./watch-embed-source";
import { PageSuppliedMedia, preparePageSuppliedWatchMedia, preparePortableWatchMedia, observeWatchSources, directForwardMediaURL, type WatchMediaSources } from "./watch-page-media";
import { youtubeStartSeconds } from "./watch-youtube-source";
import { indexedMediaSelection } from "./watch-indexed-source";
import { sameWatchByteSource, WatchBytes } from "./watch-bytes";
import { directWatchFormat } from "../../shared/watch-format";
import { z } from "zod";
import { WatchPlayer } from "./watch-playback";
import { Stage, type SourceSelection, type ScreenShare } from "./stage";
import { HTMLVideoMedia, AppPageMedia, createResourceWatchMedia, waitForWatchMedia, type WatchMedia } from "./watch-media";
import { watchSourceSchema, type WatchPlayback, type WatchSource, type WatchMode, type WatchByteSource, type WatchFormat } from "./protocol";
import { ChannelMedia } from "./media";
import { ChannelInput } from "./input";
import { ChannelConversation } from "./conversation";
import { selectedRoom } from "./navigation";
import { RoomReadMarkers } from "./read-markers";
import { historyProfileIds } from "./message-history";
import { RoomHistory, type CompletedPage, type HistoryRefresh } from "./room-history";
import { userProfile } from "./presentation";
import { id as channelId, roomInvitationSchema, CHANNEL_PROTOCOL, CHANNEL_EVENT_BYTES, PROFILE_PAGE_SIZE, ChannelEventDecoder, channelTopologySchema, createRoomCommand, roomSummarySchema, userSchema, type ChannelUser, type ProfilePage, type ProfileUpdate, type ChannelCommand, type ChannelEvent, type ChannelMessage, type ChannelReply, type ChannelSnapshot, type ChannelTopology, type ConversationReply, type DomainSettings, type MessageReactionSnapshot, type RoomInvitationState, type RoomSettings, type RoomSummary, type ScreenSource } from "./protocol";
import { requestBrowserRoomPersistence } from "./browser-room-persistence";
import { ChannelAttachments, type DraftFile, type PreparedFile } from "./attachments";
import { messageRemoved, type ChannelActions, type ReportError, type ChannelView, type ChatAttachmentPreparation, type ChatOptions, type SourceMicrophoneConfiguration, type SourceMicrophoneSettings } from "./types";
import { loadRoomHosting, roomDatabaseName } from "./hosting";
import { BrowserHosting, browserRoomStorage } from "./browser-hosting";
import { validBackupSequence, type BrowserRoomSnapshot, type BrowserRoomStage, type BackupHistoryRow } from "../../../prototype/channel-browser/src/hosting-contract";
import type { BackupHistoryImport } from "../../../prototype/channel-browser/pkg/piik_channel_browser";
import { AppPage, ChannelApp, discoverChannelAppHealth, type ChannelStopShortcut, type NativeCaptureSources, type NativeConnectionMetrics, type NativeExternalInputState, type NativeRelayCapacity } from "./app-link";
import type { NativeCaptureTarget, EncodingExecution, NativePageIndexedSelection, NativePageMpdSelection, NativePageMpdCatalog } from "../native/wire";
import type { RemoteControlMode } from "../remote-control/protocol";
import { readRoomPreferences, saveRoomPreferences, type RoomPreferences } from "../lib/room-preferences";
import { MAX_RELAY_CAPACITY } from "../../shared/relay-capacity";
import type { MicrophoneInput } from "../media/microphone-input";
import { VoiceParticipation } from "./voice-participation";
import { browserDebugEnabled, debugEvent, debugOperation, registerDebugCollector } from "../lib/debug";
import { HostAudio } from "../media/host-audio";
import { readPreferredQuality, savePreferredQuality, screenContentHint, screenVideoSettings, supportsCaptureProfile, type QualityProfile } from "../media/quality";
import { SCREEN_BUFFER_TARGET_MAX_MS, type ScreenPlaybackError } from "../media/viewer-playback";
import { browserCaptureDevices } from "../media/capture-devices";
import type { RoomInteractionSession, RoomInteraction } from "../lib/room-interactions";
import { RoomReader } from "./room-reader";
import { isThrow } from "../../shared/room-interactions";
import { FeedbackAudio, type FeedbackCue } from "./feedback-audio";
import { validateCustomFeedbackClip } from "./feedback-clip";
import { captureBrowserSource, setMediaPaused, type BrowserCaptureSource } from "../media/quality";
import { loadCameraPreviews, type CameraPreview } from "../media/camera-previews";
import { prepareHostedRoomArchive, readBackup, writeBackup, type BackupMetadata, type RetainedBackupFile } from "./backup-archive";
import { NativeDomainHosting, NativeRoomHosting, roomRestoreRecovery } from "./hosting-api";
import type { RetainedFile } from "./file-store";
import { automaticVideoCodecPreference, manualVideoCodecPreference, supportsH264Receive, type BrowserVideoCodecMode, type BrowserVideoCodecPreference } from "../webrtc/video-codec";
import { preferredVideoCodecForTrack } from "../webrtc/video-codec-preflight";

const credentialKey = "piik.channel.prototype.credential";
const nameKey = "piik.channel.prototype.name";

interface RoomReading {
  reader: RoomReader;
  socket: WebSocket | null;
  ready: Promise<void>;
  history?: Promise<void>;
  followLatest?: symbol;
}

type RoomBackupMetadata = Extract<BackupMetadata, { kind: "room" }>;
type RoomHistorySource =
  | { kind: "copy"; stage: BrowserRoomStage }
  | { kind: "restore"; archive: Blob; stage?: BrowserRoomStage; owner?: {
      current(): void; native?: Pick<NativeRoomHosting, "restore">;
    } };

interface ScreenWatch {
  playbackError?: ScreenPlaybackError;
  helperSessionId?: string;
  retry?: { controller: AbortController; available: () => boolean };
  query?: AbortController;
  operation?: Promise<void>;
}

async function waitForDisplaySurface(track: MediaStreamTrack, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (track.readyState !== "live") throw new Error("capture_unavailable");
  const complete = debugOperation("capture", "display-unmute");
  const listeners = new AbortController();
  try {
    await new Promise<void>((resolve, reject) => {
      track.addEventListener("unmute", () => resolve(), { signal: listeners.signal });
      track.addEventListener("ended", () => reject(new Error("capture_unavailable")), { signal: listeners.signal });
      signal.addEventListener("abort", () => reject(signal.reason), { signal: listeners.signal });
    });
    complete("available");
  } catch (error) {
    complete(signal.aborted ? "cancelled" : "failed", {}, error);
    throw error;
  } finally { listeners.abort(); }
}

function captureSource(track: MediaStreamTrack | undefined, camera = false): ScreenSource {
  const label = track?.label?.trim() ?? "";
  // Chromium DeviceName exposes DesktopMediaID or a generated tab token, not a content title.
  // chrome/browser/media/webrtc/desktop_capture_devices_util.cc (DeviceName).
  if (!camera && (/^(?:screen|window):-?\d+:-?\d+(?::s)?$/.test(label)
    || /^(?:current-)?web-contents-media-stream:\/\/[A-F0-9]{32}$/.test(label))) return { kind: "screen", name: null };
  let name = "";
  for (const character of label) {
    if (name.length + character.length > 64) break;
    name += character;
  }
  return { kind: camera ? "camera" : "screen", name: name || null };
}

function signedConversationRequest(command: ChannelCommand) {
  switch (command.type) {
    case "chat": return { command, result: "confirmed" } as const;
    case "history": return { command, result: "history_page" } as const;
    case "history_seek": return { command, result: "history_seek_result" } as const;
    case "react": return { command, result: "reaction" } as const;
    case "delete_message": return { command, result: "message_deleted" } as const;
    case "clear_history": return { command, result: "history_cleared" } as const;
  }
}

function acceptsChannelReply(command: ChannelCommand, event: ChannelReply): boolean {
  switch (command.type) {
    case "create_room": return event.type === "room_created";
    case "profiles": return event.type === "profiles";
    case "room_invite": return event.type === "room_reply" && event.result.type === "invite";
    case "get_room_invite": return event.type === "room_reply" && event.result.type === "invite_state";
    case "room_topology": return event.type === "room_reply" && event.result.type === "topology";
    case "delete_room": return event.type === "room_reply" && event.result.type === "deleted";
    case "start_watch":
    case "join_watch":
      if (command.type === "join_watch" && command.mode === null) break;
      if (event.type !== "room_reply" || event.result.type !== "watch_ready") return false;
      const time = event.result.serverTime;
      return typeof time === "number" && Number.isSafeInteger(time) && time >= 0;
  }
  return event.type === "ack" || event.type === "room_reply" && event.result.type === "done";
}

function stored(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch { return null; }
}

type OwnerBootstrap = { key: string; parameter?: "launch" | "owner" };

function ownerBootstrapFromLocation(): OwnerBootstrap | undefined {
  const parameters = new URLSearchParams(location.hash.slice(1));
  const launch = parameters.get("launch");
  if (launch !== null) return { key: launch, parameter: "launch" };
  const owner = parameters.get("owner");
  return owner === null ? undefined : { key: owner, parameter: "owner" };
}

function withoutRoomPictures(state: ChannelSnapshot): ChannelSnapshot {
  if (!state.channel.rooms.some(room => room.picture)) return state;
  const rooms = state.channel.rooms.map(room => {
    if (!room.picture) return room;
    const { picture: _picture, ...rest } = room;
    return rest;
  });
  return { ...state, channel: { ...state.channel, rooms } };
}

/** The live browser endpoint owns captures and reconnects; browsing owns neither. */
export class ChannelSession {
  private view: ChannelView = {
    watchPlayers: new Map(), pagePlayer: false, externalScreenInputAvailable: false,
    screenBufferTargetMs: readRoomPreferences().screenBufferTargetMs,
    screenBufferStatus: null,
    quality: readPreferredQuality(),
    videoCodecMode: "auto",
    encodingExecution: "auto",
    interactionsByRoom: new Map(),
    publicationReactions: new Map(),
    voiceInput: readRoomPreferences().voiceInput,
    voiceTransmission: readRoomPreferences().voiceTransmission,
    voicePlaybackByUser: new Map(),
    listeningVolume: readRoomPreferences().voiceListeningVolume,
    feedbackSound: readRoomPreferences().feedbackSound,
    appConnected: false,
    forwardingLimit: -1,
    ownedScreens: new Set(),
    localScreens: new Set(),
    state: null, sessionId: null, self: null, profiles: new Map(), connection: "connecting", messagesByRoom: {}, historyChangesByRoom: {}, historyByRoom: {}, readByRoom: {},
    streams: new Map(), screenInputs: new Map(), inputChannels: new Map(), remoteControls: new Map(), error: null, roomOpenFailures: new Map(), siteURL: null, pending: new Set(),
  };
  private listeners = new Set<() => void>();
  private profileLoads = new Map<string, Promise<void>>();
  private missingProfiles = new Set<string>();
  private readonly readMarkers = new RoomReadMarkers();
  private socket: WebSocket | null = null;
  private forwardingBudget: ReturnType<ChannelConversation["forwardingBudget"]>;
  private roomSnapshot: ChannelSnapshot | undefined;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private recoveryDeadline: ReturnType<typeof setTimeout> | null = null;
  private closed = true;
  private identityGeneration = 0;
  private releaseDebug?: () => void;
  private feedbackAudio = new FeedbackAudio();
  private feedbackImports = new Map<FeedbackCue, symbol>();
  private reactionNonce = 0;
  private credential = stored(credentialKey) ?? undefined;
  private invitationOrigin = location.origin;
  private ownerBootstrap = ownerBootstrapFromLocation();
  private roomId = selectedRoom();
  private requests = new Map<string, {
    kind: ChannelCommand["type"]; roomId?: string; bindingId?: string;
    signedResult?: ConversationReply["record"]["type"]; seekAfter?: number;
    resolve(): void; reject(error: Error): void; result?: (event: ChannelReply) => void;
  }>();
  private readonly hosting = new BrowserHosting({
    view: () => this.view,
    socket: () => this.socket,
    request: command => this.request(command),
    write: command => this.write(command),
    report: error => this.patch({ error }),
    failures: roomOpenFailures => this.patch({ roomOpenFailures }),
  });
  private app: ChannelApp | undefined;
  private localNativeEndpoints = new Set<string>();
  private signals: Extract<ChannelCommand, { type: "signal" }>[] = [];
  private watching = new Map<string, ScreenWatch>();
  private historyOwner: string | undefined;
  private histories = new Map<string, RoomHistory>();
  private readings = new Map<string, RoomReading>();
  private get reading(): RoomReading | undefined { return this.readings.get(this.roomId); }
  private readingRooms = new Set<string>();
  private outgoingMessages = new Map<string, {
    bindingId: string; content: string; files: PreparedFile[]; command: Extract<ChannelCommand, { type: "chat" }>;
  }>();
  private captureLifetime = new AbortController();
  private readonly pendingActions = new Set<string>();
  private readonly stages = new Map<string, Stage>();
  private waitingWatchPages = new Map<string, {
    roomId: string;
    priorMode: WatchMode;
    predecessor: { kind: "watch" | "screen"; id: string };
    browser: boolean;
  }>();
  // Sources this page left, by room: until the room sees the leave it can still name them on a successor.
  private declinedSources = new Map<string, string>();
  private local = new Map<string, { admitted: boolean; roomId: string; kind: "screen" | "voice"; stream: MediaStream; microphone?: MicrophoneInput; audio?: HostAudio; camera?: boolean }>();
  private readonly voice = new VoiceParticipation({
    local: this.local,
    view: () => this.view,
    snapshot: () => this.roomSnapshot,
    lifetime: () => this.captureLifetime.signal,
    action: (key, work, reportError) => this.action(key, work, reportError),
    request: command => this.request(command),
    send: command => this.send(command),
    write: command => this.write(command),
    unpublishMissing: (state, scope) => this.unpublishMissing(state, scope),
    publish: (roomId, stream, microphone, publicationId) => this.publish("voice", roomId, stream, { microphone, publicationId }),
    retire: id => this.retireCapture(id),
    refresh: () => this.refreshActivity(),
    levels: roomId => this.media.voiceActivity(roomId),
    saveInput: voiceInput => { this.patch({ voiceInput }); saveRoomPreferences({ voiceInput }); },
    saveTransmission: voiceTransmission => { this.patch({ voiceTransmission }); saveRoomPreferences({ voiceTransmission }); },
    report: error => this.patch({ error }),
  });
  private conversation = new ChannelConversation({
    context: () => ({ sessionId: this.view.sessionId, state: this.view.state, connected: this.view.connection === "connected" }),
    host: roomId => this.hosting.host(roomId),
    pending: (requestId, bindingId) => this.requests.get(requestId)?.bindingId === bindingId
      || [...this.readings.values()].some(({ reader }) => reader.bindingId === bindingId && reader.hasPendingInteraction(requestId)),
    send: (packet, requestId) => {
      if (this.view.connection !== "connected" || this.socket?.readyState !== WebSocket.OPEN) throw new Error("disconnected");
      this.write({ type: "conversation", packet, requestId });
    },
    file: (peer, control) => this.attachments.data(peer, "control", control),
    watch: (peer, control) => this.watchBytes.data(peer, "control", control),
    reply: reply => this.receiveConversation(reply),
    projection: (roomId, output) => this.write({ type: "host_output", roomId, output }),
  });
  private input = new ChannelInput({
    context: () => ({ sessionId: this.view.sessionId, state: this.view.state,
      connected: this.view.connection === "connected" && this.socket?.readyState === WebSocket.OPEN }),
    register: command => this.request(command),
    send: (peer, frame) => this.media.sendInput(peer, frame),
    changed: inputChannels => this.patch({ inputChannels }),
  });
  private media = new ChannelMedia(command => this.send(command), (streams, screenInputs) => {
    for (const id of streams.keys()) {
      const watch = this.watching.get(id);
      if (watch) delete watch.playbackError;
    }
    this.patch({ streams, screenInputs });
  },
    (peer, kind, data) => {
      if (kind === "chunk") {
        const bytes = data as Uint8Array;
        if (is_watch_frame(bytes[0], bytes[1])) this.watchBytes.data(peer, kind, bytes);
        else this.attachments.data(peer, kind, data);
      }
      else void this.conversation.receiveControl(peer, data as string).catch(() => {});
    }, (peer, ready) => { this.attachments.peerState(peer, ready); if (!ready) this.watchBytes.peerClosed(peer); }, peer => { this.attachments.bulkClosed(peer); this.watchBytes.peerClosed(peer); },
    (pair, channel) => this.input.setChannel(pair, channel), { target: this.view.screenBufferTargetMs,
      isLocalScreen: id => this.view.localScreens.has(id),
      changed: screenBufferStatus => { if (screenBufferStatus !== this.view.screenBufferStatus) this.patch({ screenBufferStatus }); } });
  private watchBytes = new WatchBytes((peer, kind, data, allowed) => this.media.sendData(peer, kind, data, allowed));
  readonly attachments = new ChannelAttachments(command => this.request(command), async (peer, kind, data, allowed, request) =>
    this.media.sendData(peer, kind, kind === "control" ? await this.conversation.fileFrame(data as string) : data, allowed, request),
    key => messageRemoved(this.histories.get(key.roomId)?.changes, key.messageSeq),
    (peer, request) => this.media.cancelChunks(peer, request), () => this.conversation.fileAvailabilityLimit(),
    key => this.histories.get(key.roomId)?.messages?.find(message => message.seq === key.messageSeq),
    (peer, roomId) => this.media.fileDataReady(peer, roomId));

  getSnapshot = (): ChannelView => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  stats = () => this.media.stats();
  setScreenBufferTarget = (target: number | null): void => {
    if (target !== null && (!Number.isFinite(target) || target < 0 || target > SCREEN_BUFFER_TARGET_MAX_MS)) return;
    saveRoomPreferences({ screenBufferTargetMs: target });
    this.patch({ screenBufferTargetMs: target });
    this.media.setScreenBufferTarget(target);
  };
  private mergeProfiles(users: readonly ChannelUser[]): void {
    const profiles = new Map(this.view.profiles);
    for (const user of users) {
      const summary = this.view.state?.users.find(value => value.id === user.id);
      if (!summary || summary.version === user.version) profiles.set(user.id, user);
    }
    const selfId = this.view.state?.sessions.find(session => session.id === this.view.sessionId)?.userId ?? this.view.self?.id;
    this.patch({ profiles, self: profiles.get(selfId ?? "") ?? this.view.self });
  }
  private profileKey(id: string): string {
    return `${id}:${this.view.state?.users.find(user => user.id === id)?.version ?? "offline"}`;
  }
  private profileFresh(id: string): boolean {
    const user = this.view.profiles.get(id), summary = this.view.state?.users.find(user => user.id === id);
    return !!user && (!summary || user.version === summary.version);
  }
  private async readProfiles(query: { ids?: string[]; after?: string; query?: string }, signal?: AbortSignal): Promise<ProfilePage> {
    let page: ProfilePage | undefined;
    await this.request({ type: "profiles", ...query }, event => {
      if (event.type === "profiles") page = { profiles: event.profiles, total: event.total, nextCursor: event.nextCursor };
    }, undefined, { signal });
    if (!page) throw new Error("invalid_response");
    return page;
  }
  queryProfiles = (query: { after?: string; query?: string }, signal?: AbortSignal): Promise<ProfilePage> => this.readProfiles(query, signal);
  loadProfiles = async (requested: readonly string[]): Promise<ChannelUser[]> => {
    const ids = [...new Set(requested)];
    for (let offset = 0; offset < ids.length; offset += PROFILE_PAGE_SIZE) {
      const page = ids.slice(offset, offset + PROFILE_PAGE_SIZE);
      const waiting = new Set(page.flatMap(id => this.profileLoads.get(this.profileKey(id)) ?? []));
      const batch = page.filter(id => !this.profileFresh(id) && !this.missingProfiles.has(this.profileKey(id)) && !this.profileLoads.has(this.profileKey(id)));
      if (!batch.length) { await Promise.all(waiting); continue; }
      const keys = batch.map(id => this.profileKey(id));
      const socket = this.socket;
      const pending = this.readProfiles({ ids: batch }).then(page => {
        if (this.socket !== socket) return;
        for (let index = 0; index < batch.length; index++) if (!page.profiles.some(profile => profile.id === batch[index])) this.missingProfiles.add(keys[index]);
      }).finally(() => { for (const key of keys) if (this.profileLoads.get(key) === pending) this.profileLoads.delete(key); });
      for (const key of keys) this.profileLoads.set(key, pending);
      await Promise.all([...waiting, pending]);
    }
    return ids.flatMap(id => this.profileFresh(id) ? [this.view.profiles.get(id)!] : []);
  };
  screenPlaybackError = (id: string): ScreenPlaybackError | undefined => this.watching.get(id)?.playbackError;
  screenPresentation: ChannelActions["screenPresentation"] = (flowId, stream, state, playbackError) => {
    this.media.screenPresentation(flowId, stream, state, playbackError === undefined ? undefined : id => {
      const watch = this.watching.get(id);
      if (watch && !watch.retry && !this.view.localScreens.has(id)) watch.playbackError = playbackError;
    });
  };
  setQuality = (profile: QualityProfile): void => {
    if (!supportsCaptureProfile(profile)) throw new Error("capture_quality_unsupported");
    savePreferredQuality(profile);
    this.patch({ quality: profile });
  };
  setEncodingExecution = (encodingExecution: EncodingExecution): void => { this.patch({ encodingExecution }); };

  setVideoCodecMode = (videoCodecMode: BrowserVideoCodecMode): void => {
    this.patch({ videoCodecMode });
  };

  private patch(patch: Partial<ChannelView>): void {
    const ownedScreens = new Set(this.app?.screens);
    const pending = new Set(this.pendingActions);
    for (const stage of this.stages.values()) {
      if (!stage.screen) continue;
      ownedScreens.add(stage.screen.id);
      if (stage.screen.microphoneChange?.current()) pending.add(`source-microphone:${stage.screen.id}`);
      if (stage.qualityPending) pending.add(`quality:${stage.screen.id}`);
    }
    for (const [id, capture] of this.local) if (capture.kind === "screen") ownedScreens.add(id);
    const localScreens = new Set(ownedScreens);
    for (const publication of (patch.state ?? this.view.state)?.publications ?? []) {
      if (publication.kind === "screen" && this.localNativeEndpoints.has(publication.sessionId)) localScreens.add(publication.id);
    }
    for (const id of localScreens) {
      const watch = this.watching.get(id);
      if (watch) delete watch.playbackError;
    }
    const remoteControls = new Map([...(patch.remoteControls ?? this.view.remoteControls)].filter(([id]) => ownedScreens.has(id)));
    const errorRoomId = "error" in patch ? patch.errorRoomId : this.view.errorRoomId;
    this.view = { ...this.view, ...patch, pending, errorRoomId, waitingWatchPages: new Set(this.waitingWatchPages.keys()), watchPlayers: new Map(this.watchPlayers()), pagePlayer: this.app?.pagePlayer ?? false, appConnected: this.app?.connected ?? false,
      appPort: this.app?.connected ? this.app.port : undefined,
      backgroundVoiceShortcuts: this.app?.connected ? this.app.backgroundVoiceShortcuts : undefined,
      externalScreenInputAvailable: this.app?.connected === true && this.app.externalScreenInputAvailable, ownedScreens, localScreens, remoteControls };
    for (const listener of this.listeners) listener();
  }

  start = (): void => {
    if (this.closed) this.connect();
  };

  setFeedbackSound = (patch: Partial<RoomPreferences["feedbackSound"]>): void => {
    const feedbackSound = { ...this.view.feedbackSound, ...patch };
    if (!Number.isFinite(feedbackSound.volume)) return;
    feedbackSound.volume = Math.min(1, Math.max(0, feedbackSound.volume));
    saveRoomPreferences({ feedbackSound });
    this.applyFeedbackSound(feedbackSound);
  };
  private applyFeedbackSound(feedbackSound: RoomPreferences["feedbackSound"]): void {
    this.patch({ feedbackSound });
    this.feedbackAudio.configure(feedbackSound);
    if (feedbackSound.enabled) this.feedbackAudio.activate();
  }
  previewFeedbackSound = (cue?: FeedbackCue): void => { this.feedbackAudio.preview(cue); };
  setFeedbackClip = async (cue: FeedbackCue, file: File | null): Promise<void> => {
    const operation = Symbol();
    this.feedbackImports.set(cue, operation);
    try {
      const clip = file ? await validateCustomFeedbackClip(file) : undefined;
      if (this.feedbackImports.get(cue) !== operation) throw new DOMException("Cancelled", "AbortError");
      const clips = { ...this.view.feedbackSound.clips };
      if (clip) clips[cue] = clip; else delete clips[cue];
      const feedbackSound = { ...this.view.feedbackSound, clips };
      if (!saveRoomPreferences({ feedbackSound })) throw new Error("feedback_clip_storage_failed");
      this.applyFeedbackSound(feedbackSound);
    } finally { if (this.feedbackImports.get(cue) === operation) this.feedbackImports.delete(cue); }
  };

  private conversationPopout: { roomId: string; document: Document } | null = null;
  setConversationPopout = (roomId: string, document: Document | null): void => {
    this.conversationPopout = document ? { roomId, document } : null;
  };

  private playFeedback(roomId: string, event: RoomInteraction): void {
    const self = this.view.self?.id;
    if (this.closed || !self || !this.view.feedbackSound.enabled) return;
    const popout = this.conversationPopout;
    const popoutFocused = popout?.roomId === roomId && isDocumentActive(popout.document);
    if (event.payload.kind === "chat") {
      if (event.messageSeq !== undefined && event.messageSeq <= (this.view.readByRoom[roomId] ?? 0)) return;
      if (!popoutFocused && !isDocumentActive(document) && event.sender.peerId !== self) this.feedbackAudio.play("message");
      return;
    }
    if ((document.hidden && !popoutFocused) || !isThrow(event.payload.reaction)) return;
    const target = event.contentTarget;
    const recipient = target ? "messageSeq" in target
      ? this.histories.get(roomId)?.messages?.find(message => message.seq === target.messageSeq && message.id === target.messageId)?.userId
      : this.view.state?.publications.find(source => source.id === target.publicationId)?.userId
      : event.payload.targetPeerId ?? event.sender.peerId;
    if (event.sender.peerId === self || recipient === self) this.feedbackAudio.play("throw");
  }

  private connect(acceptWelcome?: (event: Extract<ChannelEvent, { type: "welcome" }>) => string | undefined, newIdentity = false): void {
    if (this.closed) {
      this.closed = false;
      this.feedbackAudio.configure(this.view.feedbackSound);
    }
    this.releaseDebug ??= registerDebugCollector("channel", () => {
      const { state, sessionId } = this.view;
      if (!state || !sessionId) return;
      debugEvent("channel", "media-snapshot", { sessionId, connection: this.view.connection,
        appControlReady: this.app?.connected ?? false, nativeSessionIds: [...this.localNativeEndpoints],
        nativePublicationIds: [...(this.app?.screens ?? [])],
        watches: [...this.watching].map(([publicationId, watch]) => ({ publicationId, helperSessionId: watch.helperSessionId ?? null,
          helperOnline: watch.helperSessionId ? state.sessions.some(endpoint => endpoint.id === watch.helperSessionId && endpoint.online) : null })),
        subscriptions: state.subscriptions,
        publications: state.publications.map(({ id, roomId, sessionId, kind }) => ({ id, roomId, sessionId, kind })),
        rooms: state.channel.rooms.filter(room => room.authorized).map(room => ({ roomId: room.id, bindingId: room.delivery?.bindingId ?? null })),
        pairs: state.pairs.map(({ id, peerId, rooms, incoming, outgoing }) => ({ pairId: id, peerId, rooms, incoming, outgoing })),
      });
    });
    const url = new URL("/prototype/channel", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    const decoder = new ChannelEventDecoder();
    const credential = newIdentity ? undefined : this.credential;
    let sentBootstrap: OwnerBootstrap | undefined;
    this.socket = socket;
    this.patch({ connection: this.view.sessionId ? "reconnecting" : "connecting" });
    socket.onopen = async () => {
      try {
        const signingKey = await this.conversation.initialize();
        if (this.socket !== socket || this.closed) return;
        sentBootstrap = newIdentity ? undefined : this.ownerBootstrap;
        this.write({ type: "join", protocol: CHANNEL_PROTOCOL, canUsePeerTransport: typeof RTCPeerConnection === "function", signingKey, name: stored(nameKey) ?? "Guest", credential, ownerKey: sentBootstrap?.key, sessionId: this.view.sessionId ?? undefined });
      } catch (error) {
        if (this.socket === socket && !this.closed) {
          this.closeConnection();
          this.patch({ error: error instanceof Error ? error.message : "room_runtime_unavailable" });
        }
      }
    };
    socket.onmessage = ({ data }) => {
      if (this.socket !== socket) return;
      try {
        const text = String(data), wireBytes = new TextEncoder().encode(text).byteLength;
        if (wireBytes > CHANNEL_EVENT_BYTES) throw new Error("Channel event exceeds frame limit");
        const raw = JSON.parse(text);
        if (raw.type === "welcome" && raw.protocol !== CHANNEL_PROTOCOL) {
          this.closeConnection(); this.patch({ error: "incompatible_protocol" }); return;
        }
        const event = decoder.decode(raw, wireBytes);
        if (event.type === "welcome") {
          const skipRoom = acceptWelcome?.(event);
          const bootstrap = sentBootstrap;
          acceptWelcome = undefined;
          sentBootstrap = undefined;
          this.receive(event, skipRoom, bootstrap);
        } else this.receive(event);
      } catch {
        this.patch({ error: "invalid_response" });
        // Later frames may omit pictures; recovery must start with a complete Welcome.
        socket.close();
      }
    };
    socket.onclose = () => {
      socket.onmessage = null; // Retire this socket's picture decoder.
      if (this.socket !== socket || this.closed) return;
      this.socket = null;
      this.rejectRequests("disconnected");
      const state = this.view.state;
      this.patch({ connection: "reconnecting", state: state ? withoutRoomPictures(state) : null });
      this.beginRecovery();
      // Spread the retries of everyone a restarting site dropped at the same instant
      // (RFC 6455 section 7.2.3). No later than the second it has always been.
      this.retry = setTimeout(() => { this.retry = null; this.connect(acceptWelcome); }, 500 + Math.random() * 500);
    };
    socket.onerror = () => { /* The close event owns retry. */ };
  }

  private receive(event: ChannelEvent, skipRestoreRoom?: string, bootstrap?: OwnerBootstrap): void {
    // A routed conversation can fail at the Domain, but only its writer confirms it.
    if ("requestId" in event && event.requestId && this.requests.get(event.requestId)?.signedResult
      && event.type !== "error" && !(event.type === "room_reply" && event.result.type === "error")) return;
    if (event.type === "welcome") {
      this.endRecovery();
      const resumed = this.view.sessionId === event.sessionId;
      if (this.view.sessionId && !resumed) this.releaseMedia();
      if (!resumed) this.releaseHosts();
      this.credential = event.credential;
      const saved = stored(credentialKey, event.credential) === event.credential;
      const owner = event.state.sessions.find(session => session.id === event.sessionId)?.userId === event.state.channel.ownerId;
      if (bootstrap && owner) {
        this.ownerBootstrap = undefined;
        const parameter = bootstrap.parameter;
        // A manual Server link still provides admission on reload if storage failed.
        if (parameter && (saved || parameter === "launch")) {
          const parameters = new URLSearchParams(location.hash.slice(1));
          if (parameters.get(parameter) === bootstrap.key) {
            const remaining = [...parameters].filter(([name, value]) => name !== parameter || value !== bootstrap.key);
            const hash = new URLSearchParams(remaining).toString();
            try {
              history.replaceState(history.state, "", location.pathname + location.search + (hash ? `#${hash}` : ""));
            } catch { /* The welcome credential owns reconnect even if URL editing is unavailable. */ }
          }
        }
      }
      this.invitationOrigin = event.invitationOrigin ?? location.origin;
      this.profileLoads.clear(); this.missingProfiles.clear();
      const identityKey = JSON.stringify([event.state.channel.id, event.selfProfile.id]);
      const forwardingLimit = resumed ? this.view.forwardingLimit : readRoomPreferences().forwardingLimitByIdentity[identityKey] ?? -1;
      this.forwardingBudget ??= this.conversation.forwardingBudget();
      if (resumed) this.forwardingBudget?.reconnected();
      if (this.historyOwner !== undefined && this.historyOwner !== identityKey) {
        this.clearReadings();
        const removed = [...this.histories.keys()];
        this.histories.clear();
        this.patch({ ...this.historyView(removed), readByRoom: {}, voicePlaybackByUser: new Map(), publicationReactions: new Map() });
      }
      this.historyOwner = identityKey;
      this.patch({ sessionId: event.sessionId, self: event.selfProfile, profiles: new Map([[event.selfProfile.id, event.selfProfile]]), connection: "connected", error: null, siteURL: this.siteURL(), forwardingLimit });
      for (const room of event.state.channel.rooms) if (room.reading) this.readingRooms.add(room.id);
      for (const [id] of this.pendingWatchPlayers()) {
        if (this.hasJoiningWatchCandidate(id)) this.retirePendingWatchPlayer(id);
      }
      this.applyState(event.state, true);
      void this.syncAppWatching(resumed);
      void this.resumeWatches();
      const socket = this.socket, current = () => this.socket === socket && this.view.sessionId === event.sessionId && !this.closed;
      void this.hosting.restore(event.sessionId, current, skipRestoreRoom).catch(error => {
        if (current()) this.patch({ error: error instanceof Error ? error.message : "storage_failed" });
      });
      if (resumed) {
        this.media.resync();
        this.attachments.resume();
        this.reconcileLocalMedia(event.state);
        for (const id of event.state.subscriptions) {
          if (event.state.publications.some(publication => publication.id === id && publication.kind === "screen") && !this.watching.has(id)) {
            this.write({ type: "subscribe", publicationId: id, enabled: false });
          }
        }
        for (const id of this.watching.keys()) {
          if (!event.state.subscriptions.includes(id) && !this.view.pending.has(`watch:${id}`)) void this.watch(id).catch(() => {});
        }
      }
      this.browse(this.roomId);
      if (!skipRestoreRoom) void this.acceptInvitation().catch(() => {});
      for (const command of this.signals.splice(0)) {
        if (event.state.pairs.some(pair => pair.id === command.pairId)) this.write(command);
      }
    } else if (event.type === "conversation") {
      void this.conversation.receive(event.packet).catch(() => {});
    } else if (event.type === "host_bound") this.hosting.bound(event.roomId, event.bindingId);
    else if (event.type === "host_input") this.hosting.input(event.roomId, event.input);
    else if (event.type === "room_reply") {
      if (event.requestId) this.forwardingBudget?.capacity_reply(event.requestId);
      const request = event.requestId ? this.requests.get(event.requestId) : undefined;
      if (!request && event.requestId && event.result.type === "error") this.readings.get(event.roomId)?.reader.undelivered(event.requestId);
      if (!request || request.roomId !== event.roomId || !event.requestId) return;
      this.retireRequest(event.requestId);
      if (event.result.type === "error") request.reject(new Error(event.result.code ?? "operation_failed"));
      else {
        request.result?.(event); request.resolve();
      }
    } else if (event.type === "room_created" || event.type === "profiles") {
      const request = event.requestId ? this.requests.get(event.requestId) : undefined;
      if (!request || !event.requestId) return;
      this.retireRequest(event.requestId);
      request.result?.(event); request.resolve();
    } else if (event.type === "state") this.applyState(event.state);
    else if (event.type === "signal") this.media.signal(event.pairId, event.payload);
    else if (event.type === "ack" || event.type === "error") {
      if (event.requestId) this.forwardingBudget?.capacity_reply(event.requestId);
      const request = event.requestId ? this.requests.get(event.requestId) : null;
      if (request && event.requestId) {
        if (event.type === "ack" && (request.kind === "room_invite" || request.kind === "get_room_invite")) return;
        this.retireRequest(event.requestId);
        if (event.type === "ack") { request.result?.(event); request.resolve(); }
        else request.reject(new Error(event.code));
      } else if (event.type === "error" && event.requestId) {
        for (const { reader } of this.readings.values()) {
          if (!reader.hasPendingInteraction(event.requestId)) continue;
          reader.undelivered(event.requestId);
          break;
        }
      } else if (event.type === "error" && !event.requestId) {
        if (!this.view.sessionId || event.code === "incompatible_protocol" || event.code === "invalid_credential") {
          this.closeConnection();
        }
        this.patch({ error: event.code });
      }
    }
  }

  private applyState(state: ChannelSnapshot, restoring = false): void {
    const sessionId = this.view.sessionId;
    if (!sessionId) return;
    const previous = this.roomSnapshot;
    // Keep room facts independently of the current view.
    this.roomSnapshot = withoutRoomPictures(state);
    for (const [roomId, stage] of this.stages) {
      stage.updateAvailability(state.channel.rooms.some(room => room.id === roomId && room.authorized && room.available));
      if (stage.empty && !state.channel.rooms.some(room => room.id === roomId)) this.stages.delete(roomId);
    }
    for (const id of this.localNativeEndpoints) if (!state.sessions.some(endpoint => endpoint.id === id)) this.localNativeEndpoints.delete(id);
    const previousRooms = this.view.state?.channel.rooms;
    // A room writer can resume while this endpoint's channel socket stays connected.
    for (const activity of state.watchActivities) {
      if (this.watchPlayer(activity.id) || this.waitingWatchPages.has(activity.id)) continue;
      const room = state.channel.rooms.find(room => room.id === activity.roomId);
      if (!room?.available || !room.authorized || (!restoring && !previousRooms?.some(previous =>
        previous.id === room.id && !previous.available))) continue;
      if (activity.sessionId === sessionId) this.write({ type: "stop_watch", roomId: room.id, id: activity.id });
      else if (state.watchSubscriptions.some(value => value.id === activity.id))
        this.write({ type: "join_watch", roomId: room.id, id: activity.id, mode: null });
    }
    const userId = state.sessions.find(session => session.id === sessionId)?.userId;
    // Native can replace its Domain endpoint while this page's App control stays connected.
    const refreshHelper = !restoring && this.app?.connected
      && [...this.watching.values()].some(watch => watch.helperSessionId && !state.sessions.some(endpoint => endpoint.id === watch.helperSessionId))
      && state.sessions.some(endpoint => endpoint.userId === userId && endpoint.online
        && !this.view.state?.sessions.some(previous => previous.id === endpoint.id && previous.online));
    const readByRoom = this.readMarkers.project(state.channel.id, userId, state.channel.rooms);
    for (const [id, capture] of this.local) {
      if (capture.admitted && !state.publications.some(publication => publication.id === id)) {
        const { roomId } = capture;
        this.stages.get(roomId)?.screenRemoved(id);
        this.retireCapture(id);
      }
    }
    this.voice.update(state);
    for (const publication of state.publications) if (publication.kind === "screen") {
      const local = this.local.get(publication.id);
      if (local) {
        const paused = this.stages.get(publication.roomId)?.screen?.paused ?? publication.paused;
        setMediaPaused(local.stream, paused);
        if (local.audio) setMediaPaused(local.audio.sourceStream, paused);
      }
    }
    const previousState = this.view.state;
    const canFollow = (roomId: string) => state.channel.rooms.some(room => room.id === roomId && room.authorized && room.available);
    // A room names a predecessor only in the snapshot of a viewer that watched it, until that viewer joins or
    // declines the successor, so a named successor is followed unless this page holds, opens or declined it.
    // A named predecessor never returns: a declined source that is neither present nor named is settled.
    for (const [id, roomId] of this.declinedSources) {
      if (canFollow(roomId) && !state.watchActivities.some(next => next.id === id || next.predecessor?.id === id)
        && !state.publications.some(next => next.id === id || next.kind === "screen" && next.predecessor?.id === id)) this.declinedSources.delete(id);
    }
    const declined = (next: { id: string; predecessor?: { id: string } }) => this.declinedSources.has(next.id) || !!next.predecessor && this.declinedSources.has(next.predecessor.id);
    const nextScreens = state.publications.filter(next => next.kind === "screen" && next.predecessor && canFollow(next.roomId) && !declined(next)
      && !this.watching.has(next.id) && !state.subscriptions.includes(next.id));
    const nextWatches = state.watchActivities.filter(next => next.predecessor && canFollow(next.roomId) && !declined(next)
      && !this.watchPlayer(next.id) && !this.pendingWatchPlayer(next.id) && !this.waitingWatchPages.has(next.id)
      && !state.watchSubscriptions.some(sub => sub.id === next.id));
    for (const next of nextWatches) {
      const predecessor = next.predecessor!;
      // The receiving method is this page's choice: carry it from the source it watched, through any successor still pending.
      const priorMode = [...this.waitingWatchPages].find(([id, waiting]) => id === predecessor.id || waiting.predecessor.id === predecessor.id)?.[1].priorMode
        ?? previousState?.watchSubscriptions.find(sub => sub.id === predecessor.id)?.mode ?? "direct";
      this.waitingWatchPages.set(next.id, { roomId: next.roomId, priorMode, predecessor, browser: canWatchInBrowser(next.source) });
    }
    if (restoring) {
      // A leave made offline never reached the room, which still names the successor.
      for (const next of state.watchActivities) {
        if (next.predecessor && canFollow(next.roomId) && declined(next)) this.write({ type: "join_watch", roomId: next.roomId, id: next.id, mode: null });
      }
      for (const next of state.publications) {
        if (next.kind === "screen" && next.predecessor && canFollow(next.roomId) && declined(next)) this.write({ type: "subscribe", publicationId: next.id, enabled: false });
      }
    }
    for (const [id, watch] of this.watching) {
      const publication = state.publications.find(value => value.id === id);
      if (!publication && (watch.query || !this.view.pending.has(`watch:${id}`))) this.retireWatch(id);
      if (watch.playbackError !== undefined) {
        const before = this.view.state?.publications.find(value => value.id === id);
        const room = state.channel.rooms.find(value => value.id === publication?.roomId);
        if (!state.subscriptions.includes(id) || publication?.kind !== "screen" || before?.kind !== "screen"
          || !room?.authorized || !room.available || room.delivery?.bindingId !== previousRooms?.find(value => value.id === room.id)?.delivery?.bindingId
          || publication.sessionId !== before.sessionId || publication.source.kind !== before.source.kind || publication.source.name !== before.source.name) {
          delete watch.playbackError;
        }
      }
    }
    for (const stage of this.stages.values()) stage.reconcileWatches(this.roomSnapshot, previous, restoring,
      id => { void this.stopWatchResource(id, "provider-session-ended").catch(() => {}); });
    const visible = this.projectActivity(state);
    const sameChannel = !previous || previous.channel.id === state.channel.id;
    if (!sameChannel) this.clearReadings();
    const canRead = (id: string) => sameChannel && state.channel.rooms.some(room => room.id === id && room.authorized);
    const freshBindings = new Set(state.channel.rooms.filter(room => room.delivery
      && previousRooms?.find(previous => previous.id === room.id)?.delivery?.bindingId !== room.delivery.bindingId).map(room => room.id));
    for (const id of freshBindings) this.readings.get(id)?.reader.clearInteraction();
    for (const [id, request] of this.requests) if (request.bindingId
      && !state.channel.rooms.some(room => room.id === request.roomId && room.authorized
        && room.available && room.delivery?.bindingId === request.bindingId)) {
      this.retireRequest(id);
      request.reject(new Error("room_unavailable"));
    }
    const dropped = [...this.histories.keys()].filter(id => !canRead(id) || freshBindings.has(id));
    for (const id of dropped) this.histories.delete(id);
    for (const [id, attempt] of this.outgoingMessages) {
      const bindingId = state.channel.rooms.find(room => room.id === id)?.delivery?.bindingId;
      if (!canRead(id) || (bindingId && bindingId !== attempt.bindingId)) this.outgoingMessages.delete(id);
    }
    let invalidated: Map<string, ChannelUser> | undefined;
    for (const summary of state.users) {
      const cached = this.view.profiles.get(summary.id);
      if (cached && cached.version !== summary.version) {
        invalidated ??= new Map(this.view.profiles);
        invalidated.delete(summary.id);
      }
    }
    const profiles = invalidated ?? this.view.profiles;
    this.patch({ state: visible, profiles, self: userId ? userProfile(state, profiles, userId) ?? null : null, readByRoom,
      siteURL: this.siteURL(),
      voicePlaybackByUser: sameChannel ? new Map([...this.view.voicePlaybackByUser].filter(([id]) => state.users.some(user => user.id === id))) : new Map(),
      ...this.historyView(dropped),
      publicationReactions: new Map([...this.view.publicationReactions].filter(([id]) => state.publications.some(publication => publication.id === id
        && canRead(publication.roomId) && !freshBindings.has(publication.roomId)))),
    });
    for (const [id, waiting] of this.waitingWatchPages) {
      const next = state.watchActivities.find(activity => activity.id === id);
      const joined = state.watchSubscriptions.some(sub => sub.id === id);
      const player = this.watchPlayer(id);
      if (!next || !canFollow(waiting.roomId) || (!joined && previousState?.watchSubscriptions.some(sub => sub.id === id))
        || waiting.browser && joined && player) {
        this.waitingWatchPages.delete(id);
        this.patch({});
        continue;
      }
      if (nextWatches.includes(next) || restoring && !player && (waiting.browser || !joined)) {
        const socket = this.socket;
        const opening = waiting.browser ? this.joinWatch(id) : this.request({ type: "join_watch", roomId: waiting.roomId, id, mode: "direct" }, undefined, waiting.roomId);
        void opening.catch(error => {
          // The activity is gone: nothing to decline, and this entry keeps the receiving method for the successor the room names next.
          if (error instanceof Error && error.message === "watch_unavailable") return;
          if (this.socket === socket && this.waitingWatchPages.get(id) === waiting) {
            this.waitingWatchPages.delete(id);
            this.declineSuccessor(waiting.roomId, { kind: "watch", id });
            this.patch({});
          }
        });
      }
      if (waiting.browser || !joined || !next.byteSource || player || this.pendingWatchPlayer(id)) continue;
      const before = previousState?.watchActivities.find(activity => activity.id === id);
      if (before?.byteSource && previousState?.watchSubscriptions.some(sub => sub.id === id)) continue;
      if (waiting.priorMode === "peer" || !(this.view.pagePlayer && originalWatchURL(next.source)) || next.playback.timeline === "program")
        void this.joinWatch(id, "peer").catch(() => {});
    }
    for (const next of nextScreens) {
      const socket = this.socket;
      void this.watch(next.id, next.roomId).catch(() => {
        if (this.socket === socket && !this.watching.has(next.id)) this.declineSuccessor(next.roomId, { kind: "screen", id: next.id });
      });
    }
    const historyProfiles = [...this.histories.values()].flatMap(history => historyProfileIds(history.messages ?? []));
    void this.loadProfiles([...state.users.map(user => user.id), ...historyProfiles]).catch(() => {});
    if (refreshHelper) void this.syncAppWatching(true);
    this.hosting.update(state);
    if (this.view.connection === "connected") for (const room of state.channel.rooms) {
      if (!restoring && room.available && previousRooms?.some(previous => previous.id === room.id && !previous.available)) this.voice.resumed(state, room.id);
      if (room.id !== this.roomId && room.reading && room.authorized && room.available
        && previousRooms?.some(previous => previous.id === room.id && !previous.available)) {
        this.readingRooms.add(room.id);
      }
    }
    this.applyForwarding(sessionId, this.roomSnapshot, userId);
    this.input.update();
    this.browseRooms();
  }

  private reconcileLocalMedia(state: ChannelSnapshot): void {
    this.unpublishMissing(state);
    for (const publication of state.publications) {
      if (publication.sessionId !== this.view.sessionId || publication.kind !== "screen" || !this.local.has(publication.id)) continue;
      const share = this.stages.get(publication.roomId)?.screen;
      if (share?.id === publication.id && share.paused !== undefined && share.paused !== publication.paused)
        this.write({ type: "set_paused", publicationId: publication.id, paused: share.paused });
    }
    this.voice.reconcile(state);
  }

  /** Withdraws this session's publications that no local capture carries, only in one room and kind when given. */
  private unpublishMissing(state: ChannelSnapshot, scope?: { roomId: string; kind: "screen" | "voice" }): void {
    for (const publication of state.publications) {
      if (publication.sessionId !== this.view.sessionId || this.local.has(publication.id)
        || scope && (publication.roomId !== scope.roomId || publication.kind !== scope.kind)) continue;
      this.write({ type: "unpublish", publicationId: publication.id });
    }
  }

  private applyForwarding(sessionId: string, state: ChannelSnapshot, userId: string | undefined): void {
    const limit = this.view.forwardingLimit;
    const result = userId && this.forwardingBudget
      ? JSON.parse(this.forwardingBudget.apply(limit < 0 ? undefined : limit, sessionId, userId, JSON.stringify(state))) as {
        snapshot: Pick<ChannelSnapshot, "watchBytes" | "pairs" | "files">;
        commands: ChannelCommand[];
        capacity: (ChannelCommand & { requestId: string })[];
      } : { snapshot: state, commands: [], capacity: [] };
    const { pairs, files, watchBytes } = result.snapshot;
    this.watchBytes.update(sessionId, watchBytes, pairs);
    this.media.update(sessionId, { ...state, pairs });
    if (userId) this.attachments.update(sessionId, { domainId: state.channel.id, userId }, files, state.channel.rooms, pairs);
    else this.attachments.reset();
    for (const update of result.capacity) this.write(update);
    for (const command of result.commands) this.send(command);
  }

  private siteURL(): string {
    return new URL(location.pathname, this.invitationOrigin).href;
  }

  private write(command: ChannelCommand & { requestId?: string }): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(command));
    if (command.type === "flow_state") {
      const { pairId, flowId, state } = command;
      debugEvent("channel", "flow-state-sent", { pairId, flowId, state });
    } else if (command.type === "link_state" && browserDebugEnabled) {
      debugEvent("channel", "link-state-sent", { pairId: command.pairId, state: command.state });
    }
  }

  private send(command: ChannelCommand): void {
    if (this.view.connection === "connected") this.write(command);
    else if (command.type === "signal" && this.signals.length < 256) this.signals.push(command);
  }

  private conversationBinding(roomId: string | undefined): string | undefined {
    return this.view.state?.channel.rooms.find(room => room.id === roomId && room.authorized && room.available)?.delivery?.bindingId;
  }

  private async request(command: ChannelCommand, result?: (event: ChannelReply) => void, roomId = this.commandRoom(command), options: {
    signal?: AbortSignal; replaceHistory?: boolean; refresh?: HistoryRefresh; bindingId?: string;
  } = {}): Promise<void> {
    const { signal, replaceHistory = false, refresh, bindingId } = options;
    const reading = roomId ? this.readings.get(roomId) : undefined, socket = this.socket;
    const conversation = signedConversationRequest(command);
    const expectedBinding = conversation ? bindingId ?? this.conversationBinding(roomId) : undefined;
    if (conversation && reading) await reading.ready;
    signal?.throwIfAborted();
    if (bindingId && command.type !== "chat" && reading !== this.readings.get(roomId!)) throw new DOMException("Read cancelled", "AbortError");
    if (this.view.connection !== "connected" || this.socket !== socket) throw new Error("disconnected");
    if (conversation && (!expectedBinding || this.conversationBinding(roomId) !== expectedBinding)) throw new Error("room_unavailable");
    const tracksRoomBinding = command.type === "browse" || command.type === "room_topology";
    const replyBinding = expectedBinding ?? (tracksRoomBinding
      ? this.view.state?.channel.rooms.find(room => room.id === roomId)?.delivery?.bindingId : undefined);
    const requestId = crypto.randomUUID();
    const abort = () => {
      const request = this.requests.get(requestId);
      if (!request) return;
      this.retireRequest(requestId);
      request.reject(signal?.reason instanceof Error ? signal.reason : new DOMException("Read cancelled", "AbortError"));
    };
    let timer: ReturnType<typeof setTimeout>;
    return new Promise<void>((resolve, reject) => {
      // Conversation includes image upload and its host-confirmed response.
      timer = setTimeout(() => { this.retireRequest(requestId); reject(new Error("request_timeout")); }, conversation || command.type === "profiles" ? 30000 : 10000);
      this.requests.set(requestId, { resolve, reject, roomId, kind: command.type, signedResult: conversation?.result,
        result: event => {
          try {
            if (!conversation && !acceptsChannelReply(command, event)) throw new Error("invalid_response");
            if (event.type === "profiles") this.mergeProfiles(event.profiles);
            result?.(event);
          }
          catch (error) {
            this.retireRequest(requestId);
            reject(error instanceof Error ? error : new Error("invalid_response"));
          }
        },
        ...(replyBinding ? { bindingId: replyBinding } : {}),
        ...(command.type === "history_seek" ? { seekAfter: command.after } : {}) });
      if (command.type === "history") this.roomHistory(command.roomId).openPage(requestId, { bindingId: replyBinding, before: command.before, replace: replaceHistory,
        refresh, latestThrough: this.view.state?.channel.rooms.find(room => room.id === roomId)?.lastMessageSeq });
      signal?.addEventListener("abort", abort, { once: true });
      if (conversation) void this.conversation.send(conversation.command, requestId, expectedBinding).catch(error => {
        if (!this.retireRequest(requestId)) return;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
      else {
        if (command.type === "browse" && command.active) this.readingRooms.add(command.roomId);
        this.write({ ...command, requestId });
        if (command.type === "room_invite") this.patch({});
      }
    }).finally(() => {
      this.retireRequest(requestId);
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    });
  }

  private receiveConversation(reply: ConversationReply): void {
    const record = reply.record;
    const request = this.requests.get(reply.requestId);
    const addressed = request?.signedResult && request.roomId === reply.roomId && request.bindingId === reply.bindingId;
    if (addressed && record.type !== request.signedResult && record.type !== "error"
      && record.type !== "live_message" && record.type !== "message_reactions") {
      this.receive({ type: "error", requestId: reply.requestId, code: "invalid_response" });
      return;
    }
    if (record.type === "message_deleted" || record.type === "history_cleared") {
      if (!this.view.state?.channel.rooms.some(room => room.id === reply.roomId && room.authorized && room.delivery?.bindingId === reply.bindingId)) return;
      this.applyHistoryRemoval(reply.roomId, record);
    }
    if (record.type === "message_reactions") {
      this.applyReactionSnapshot(reply.roomId, reply.bindingId, record.snapshot);
      return;
    }
    if (record.type === "interaction_ready" || record.type === "reaction" || (record.type === "error" && !request)) {
      const reader = this.readings.get(reply.roomId)?.reader;
      if (reader?.bindingId === reply.bindingId && reader.receiveInteraction(reply.requestId, record)) return;
    }
    if (record.type === "live_message") {
      if (this.view.state?.channel.rooms.some(room => room.id === reply.roomId && room.delivery?.bindingId === reply.bindingId)) {
        this.applyMessage(reply.roomId, record.message, true);
      }
      return;
    }
    if (!addressed) return;
    if (request.seekAfter !== undefined && record.type !== "error") {
      if (record.type !== "history_seek_result" || record.after !== request.seekAfter
        || (record.seq !== null && (!Number.isSafeInteger(record.seq) || record.seq <= record.after))) {
        this.receive({ type: "error", requestId: reply.requestId, code: "invalid_response" });
        return;
      }
      request.result?.(record);
    }
    const history = this.histories.get(reply.roomId);
    if (record.type === "history_page" && history?.hasPage(reply.requestId)) {
      const page = history.completePage(reply.requestId, record);
      if (!page) {
        this.receive({ type: "error", requestId: reply.requestId, code: "incomplete_history" });
        return;
      }
      this.applyHistory(reply.roomId, history, page);
    } else if (record.type === "confirmed" && !messageRemoved(history?.changes, record.message.seq)) {
      request.result?.(record);
      this.applyMessage(reply.roomId, record.message, record.inserted);
    }
    this.retireRequest(reply.requestId);
    if (record.type === "error") request.reject(new Error(record.code));
    else request.resolve();
  }

  private applyHistoryRemoval(roomId: string, record: Extract<ConversationReply["record"], { type: "message_deleted" | "history_cleared" }>): void {
    this.applyHistoryRemovals(roomId, record.type === "history_cleared" ? record.throughSeq : 0,
      record.type === "message_deleted" ? [record.messageSeq] : []);
  }

  private applyHistoryRemovals(roomId: string, throughSeq: number, messageSeqs: number[]): void {
    const removed = this.roomHistory(roomId).remove(throughSeq, messageSeqs, this.view.state?.channel.historyWindow ?? 1000);
    this.patch(this.historyView([roomId]));
    this.attachments.removeMessages(roomId, removed);
    this.readings.get(roomId)?.reader.removeMessages(removed);
    if (throughSeq) this.markRead(roomId, throughSeq);
  }

  private applyReactionSnapshot(roomId: string, bindingId: string, snapshot: MessageReactionSnapshot): void {
    const state = this.view.state;
    if (!state?.channel.rooms.some(room => room.id === roomId && room.authorized && room.delivery?.bindingId === bindingId)) return;
    const history = this.histories.get(roomId), messages = history?.messages;
    if (!history) return;
    for (const requestId of history.applyReactions(bindingId, snapshot)) this.receive({ type: "error", requestId, code: "incomplete_history" });
    if (history.messages !== messages) this.patch(this.historyView([roomId]));
  }

  private applyPublicationReactionSnapshot(roomId: string, snapshot: import("./protocol").PublicationReactionSnapshot): void {
    if (!this.view.state?.publications.some(publication => publication.id === snapshot.publicationId && publication.roomId === roomId)) return;
    const previous = this.view.publicationReactions.get(snapshot.publicationId);
    if (previous && previous.revision >= snapshot.revision) return;
    this.patch({ publicationReactions: new Map(this.view.publicationReactions).set(snapshot.publicationId, snapshot) });
  }

  private applyHistory(roomId: string, history: RoomHistory, page: CompletedPage): void {
    const state = this.view.state;
    if (!state?.channel.rooms.some(room => room.id === roomId && room.authorized)) return;
    // Rows missing from a refreshed range leave with their effects before the rest of the page merges.
    if (page.missing.length) this.applyHistoryRemovals(roomId, 0, page.missing);
    if (!history.mergePage(page, state.channel.historyWindow)) return;
    this.patch(this.historyView([roomId]));
    void this.loadProfiles(historyProfileIds(history.messages!)).catch(() => {});
  }

  private applyMessage(roomId: string, message: ChannelMessage, live: boolean): void {
    const state = this.view.state;
    if (!state?.channel.rooms.some(room => room.id === roomId && room.authorized)) return;
    const history = this.roomHistory(roomId), visible = history.visible(message);
    if (!visible) return;
    message = visible;
    void this.loadProfiles(historyProfileIds([message])).catch(() => {});
    if (live) this.readings.get(roomId)?.reader.receiveLiveMessage(message);
    if (history.receiveMessage(message, live, state.channel.historyWindow)) this.patch(this.historyView([roomId]));
  }

  private roomHistory(roomId: string): RoomHistory {
    return this.histories.get(roomId) ?? this.histories.set(roomId, new RoomHistory()).get(roomId)!;
  }

  /** The only writer of the view's history maps, which project each listed room's RoomHistory. */
  private historyView(roomIds: Iterable<string>): Pick<ChannelView, "messagesByRoom" | "historyByRoom" | "historyChangesByRoom"> {
    const messagesByRoom = { ...this.view.messagesByRoom }, historyByRoom = { ...this.view.historyByRoom }, historyChangesByRoom = { ...this.view.historyChangesByRoom };
    for (const id of roomIds) {
      const history = this.histories.get(id);
      if (history?.messages) messagesByRoom[id] = history.messages; else delete messagesByRoom[id];
      if (history?.paging) historyByRoom[id] = history.paging; else delete historyByRoom[id];
      if (history?.changes) historyChangesByRoom[id] = history.changes; else delete historyChangesByRoom[id];
    }
    return { messagesByRoom, historyByRoom, historyChangesByRoom };
  }

  /** Removes a request together with its page under assembly, so no page outlives its request. */
  private retireRequest(requestId: string): boolean {
    const request = this.requests.get(requestId);
    if (!request) return false;
    this.requests.delete(requestId);
    if (request.roomId) this.histories.get(request.roomId)?.dropPage(requestId);
    if (request.kind === "room_invite") this.patch({});
    return true;
  }

  private commandRoom(command: ChannelCommand): string | undefined {
    if ("roomId" in command) return command.roomId;
    if (command.type === "publish") return command.publication.roomId;
    if ("publicationId" in command) return this.view.state?.publications.find(value => value.id === command.publicationId)?.roomId;
    return undefined;
  }

  private releaseHosts(): void {
    this.hosting.release();
    const app = this.app;
    this.app = undefined;
    app?.close();
  }

  private async connectApp(signal: AbortSignal | undefined, verifiedHealth?: unknown): Promise<ChannelApp> {
    signal?.throwIfAborted();
    const state = this.view.state, self = this.view.self;
    if (!state || !self || !this.credential || this.closed) throw new Error("disconnected");
    if (!this.app) {
      if (this.view.connection !== "connected") throw new Error("disconnected");
      // The approval operation already proved this App. A passive permission query
      // can still say "prompt" after a successful request, so do not repeat discovery.
      const health = verifiedHealth ?? await discoverChannelAppHealth({ waitForPermission: false, signal });
      signal?.throwIfAborted();
      if (!health) throw new Error("app_disconnected");
      if (this.closed || this.view.connection !== "connected" || this.view.self?.id !== self.id
          || this.view.state?.channel.id !== state.channel.id) throw new Error("disconnected");
      if (!this.app) {
        const app: ChannelApp = new ChannelApp(health, state.channel.id, self.id, this.credential, self.name, () => {
          if (this.app !== app) return;
          this.app = undefined;
          for (const [, share] of this.screenShares()) this.forgetInactiveScreen(share.id);
          this.patch({ remoteControls: new Map() });
          void this.syncAppWatching();
        }, (id, error) => {
          if (this.app !== app) return;
          this.forgetInactiveScreen(id);
          this.patch(error ? { error } : {});
        }, (id, state) => {
          if (this.app === app) this.patch({ remoteControls: new Map(this.view.remoteControls).set(id, state) });
        }, () => {
          if (this.app === app) this.patch({});
        }, event => {
          if (this.app !== app) return;
          if (event.state === "prepared") void this.commitExternalScreen(app, event).catch(() => {});
          if (event.state === "closed") this.forgetInactiveScreen(event.publicationId);
          this.patch({});
        }, () => this.app === app && this.view.connection === "connected" && this.voice.joined());
        this.app = app;
      }
    }
    const app = this.app;
    await app.waitReady(signal);
    if (this.app !== app || this.closed) throw new DOMException("App connection cancelled", "AbortError");
    this.patch({});
    void this.syncAppWatching();
    return app;
  }

  activateApp = (verifiedHealth?: unknown, signal?: AbortSignal): Promise<void> => {
    if (this.closed || this.view.connection !== "connected") return Promise.reject(new Error("disconnected"));
    return this.action("app", async () => { await this.connectApp(signal, verifiedHealth); }, false);
  };

  private rememberLocalEndpoint(app: ChannelApp, sessionId: string): void {
    if (this.app !== app || !app.connected || this.closed || this.localNativeEndpoints.has(sessionId)
      || !this.view.state?.sessions.some(endpoint => endpoint.id === sessionId)) return;
    // This is a source-location fact, not a capture grant. Another page's
    // capture can outlive our App control socket; only endpoint retirement clears it.
    this.localNativeEndpoints.add(sessionId);
    this.patch({});
    this.media.setScreenBufferTarget(this.view.screenBufferTargetMs);
  }

  private async syncAppWatching(resync = false): Promise<void> {
    if (this.closed || this.view.connection !== "connected") return;
    const watches = [...this.watching].filter(([id, watch]) => !this.local.has(id) && !watch.retry && !this.view.pending.has(`watch:${id}`));
    if (!watches.length) return;
    const socket = this.socket, sessionId = this.view.sessionId;
    const app = this.app?.connected ? this.app : undefined;
    let helperSessionId: string | undefined;
    if (app) {
      try { helperSessionId = (await app.describeHosting()).sessionId; }
      catch { return; }
    }
    if (this.closed || this.view.connection !== "connected" || this.socket !== socket
      || this.view.sessionId !== sessionId || (this.app?.connected ? this.app : undefined) !== app) return;
    if (app && helperSessionId) this.rememberLocalEndpoint(app, helperSessionId);
    // Cached placement hints are not authority acknowledgements after recovery.
    for (const [publicationId, watch] of watches) {
      if (this.watching.get(publicationId) !== watch || watch.retry
        || this.view.pending.has(`watch:${publicationId}`) || !resync && watch.helperSessionId === helperSessionId) continue;
      watch.helperSessionId = helperSessionId;
      // Assistance changes route placement; failure must not withdraw the watch.
      void this.request({ type: "subscribe", publicationId, enabled: true, helperSessionId }).catch(() => {});
    }
  }

  inputPolicy = (publicationId: string, mode: RemoteControlMode, password?: string): Promise<void> =>
    this.action(`input:${publicationId}`, async () => {
      if (!this.app?.screens.has(publicationId)) throw new Error("capture_unavailable");
      await this.app.inputPolicy(publicationId, { mode, password });
    }, false);

  inputDecide = (publicationId: string, requestId: string, allow: boolean): Promise<void> =>
    this.action(`input:${publicationId}:${requestId}`, async () => {
      const request = this.view.remoteControls.get(publicationId)?.requests.find(request => request.id === requestId);
      if (!this.app?.screens.has(publicationId) || !request) throw new Error("input_unavailable");
      await this.app.inputDecide(publicationId, request.peerId, request.id, allow);
    }, false);

  inputSimultaneous = (publicationId: string, enabled: boolean): Promise<void> =>
    this.action(`input:${publicationId}`, async () => {
      const state = this.view.remoteControls.get(publicationId);
      if (!this.app?.screens.has(publicationId) || !state) throw new Error("input_unavailable");
      await this.app.inputPolicy(publicationId, { mode: state.mode, simultaneous: enabled });
    }, false);

  inputShortcut = async (publicationId: string, key?: number): Promise<ChannelStopShortcut> => {
    const app = this.app, state = this.view.remoteControls.get(publicationId);
    if (!app?.screens.has(publicationId) || !state) throw new Error("input_unavailable");
    if (key === undefined) return { key: state.stopShortcut ?? readRoomPreferences().remoteStopKey, available: state.stopShortcut != null,
      ...(state.stopShortcutLabel !== undefined ? { stopShortcutLabel: state.stopShortcutLabel } : {}) };
    const shortcut = await app.inputShortcut(publicationId, key);
    const current = this.view.remoteControls.get(publicationId);
    if (this.app === app && app.screens.has(publicationId) && current && shortcut.available) {
      this.patch({ remoteControls: new Map(this.view.remoteControls).set(publicationId, { ...current, stopShortcut: shortcut.key,
        ...(shortcut.stopShortcutLabel !== undefined ? { stopShortcutLabel: shortcut.stopShortcutLabel } : {}) }) });
    }
    return shortcut;
  };

  private async action<T>(key: string, work: () => Promise<T>, reportError: ReportError = true, options: { clearError?: boolean } = {}): Promise<T> {
    if (this.pendingActions.has(key)) throw new Error("operation_pending");
    this.pendingActions.add(key);
    const failed = this.beginActionFeedback(reportError, options.clearError);
    try { return await work(); }
    catch (error) { failed(error); throw error; }
    finally { this.pendingActions.delete(key); this.patch({}); }
  }

  private beginActionFeedback(reportError: ReportError = true, clearError = true): (error: unknown) => void {
    const socket = this.socket;
    const ownsError = () => typeof reportError === "function" ? reportError() : reportError;
    this.patch(ownsError() && clearError ? { error: null } : {});
    return error => {
      const code = error instanceof DOMException ? error.name : error instanceof Error ? error.message : "operation_failed";
      if (this.socket === socket && code !== "AbortError" && ownsError()) this.patch({ error: code });
    };
  }

  browse = (roomId: string): void => {
    this.roomId = roomId;
    const wanted = this.wantedReadings();
    for (const [id, { reader }] of this.readings) if (!wanted.has(id)) reader.clearInteraction();
    this.browseRooms();
  };

  private wantedReadings(): Set<string> {
    const state = this.view.state;
    const rooms = new Set(this.roomId ? [this.roomId] : []);
    for (const publication of state?.publications ?? []) {
      if (publication.kind !== "screen") continue;
      const retry = this.watching.get(publication.id)?.retry;
      if (this.view.ownedScreens.has(publication.id) || state?.subscriptions.includes(publication.id)
        || (retry && !retry.controller.signal.aborted && retry.available())) {
        rooms.add(publication.roomId);
      }
    }
    for (const member of state?.voice ?? []) {
      if (member.sessionId === this.view.sessionId) rooms.add(member.roomId);
    }
    for (const waiting of this.waitingWatchPages.values()) rooms.add(waiting.roomId);
    for (const [, player] of this.watchPlayers()) rooms.add(player.roomId);
    return rooms;
  }

  private browseRooms(): void {
    if (this.view.connection !== "connected") return;
    const wanted = this.wantedReadings();
    for (const [id, reading] of this.readings) {
      const room = this.view.state?.channel.rooms.find(room => room.id === id);
      if (!room?.authorized || !room.available || room.delivery?.bindingId !== reading.reader.bindingId || reading.socket !== this.socket && !wanted.has(id)) {
        reading.reader.clearInteraction(); this.readings.delete(id);
      }
    }
    for (const id of wanted) {
      const room = this.view.state?.channel.rooms.find(room => room.id === id && room.authorized && room.available);
      if (!room?.delivery) continue;
      let reading = this.readings.get(id);
      if (!reading || reading.socket !== this.socket) {
        const bindingId = room.delivery.bindingId;
        const reader = reading?.reader ?? new RoomReader(id, bindingId, {
          send: (command, requestId) => this.conversation.send(command, requestId, bindingId),
          nextReactionNonce: () => ++this.reactionNonce,
          interactionChanged: () => this.publishInteractions(),
          feedback: event => this.playFeedback(id, event),
          userName: userId => this.view.state?.users.find(user => user.id === userId)?.name ?? this.view.profiles.get(userId)?.name,
          messageReactions: snapshot => this.applyReactionSnapshot(id, bindingId, snapshot),
          publicationReactions: snapshot => this.applyPublicationReactionSnapshot(id, snapshot),
        });
        reading = { reader, socket: this.socket, ready: this.request({ type: "browse", roomId: id, active: true }) };
        this.readings.set(id, reading);
      }
      const current = reading;
      void current.ready.then(() => {
        if (this.readings.get(id) !== current || this.socket !== current.socket || !this.wantedReadings().has(id)) return;
        this.retireReadings();
        if (this.view.self && this.conversationBinding(id) === current.reader.bindingId) current.reader.admit(this.view.self.id);
        if (this.roomId !== id || current.history || this.view.pending.has(`history:${id}`)) return;
        const history = this.histories.get(id), rows = history?.messages;
        const latest = history?.paging?.atLatest !== false;
        const refresh: HistoryRefresh | undefined = rows?.length ? { from: rows[0].seq,
          through: latest ? Math.max(room.lastMessageSeq, rows.at(-1)!.seq) : rows.at(-1)!.seq, latest, window: [] } : undefined;
        let before = !latest && refresh ? refresh.through + 1 : undefined;
        current.history = this.action(`history:${id}`, async () => {
          try {
            do {
              await this.request({ type: "history", roomId: id, ...(before === undefined ? {} : { before }) }, undefined, id,
                { replaceHistory: before !== undefined, refresh, bindingId: current.reader.bindingId });
              before = refresh?.before;
            } while (before !== undefined && this.roomId === id && this.readings.get(id) === current);
            // An overlay can keep a reader alive after selection leaves this room.
            if (before !== undefined) delete current.history;
          } catch (error) {
            if (this.readings.get(id) === current && this.socket === current.socket) throw error;
          }
        }, true, { clearError: false });
        void current.history.catch(() => {});
      }, error => {
        if (this.readings.get(id) === current && this.socket === current.socket && this.view.connection === "connected") {
          current.reader.clearInteraction(); this.readings.delete(id);
          this.retireReadings();
          this.patch({ error: error instanceof Error ? error.message : "operation_failed" });
        }
      });
    }
    if (!this.reading) this.retireReadings();
  }

  private retireReadings(): void {
    const keep = this.wantedReadings();
    for (const [id, { reader }] of this.readings) if (!keep.has(id)) {
      reader.clearInteraction(); this.readings.delete(id);
      for (const [requestId, request] of this.requests) if (request.roomId === id && (request.kind === "browse" || this.histories.get(id)?.hasPage(requestId) || request.seekAfter !== undefined)) {
        this.retireRequest(requestId);
        request.reject(new DOMException("Read cancelled", "AbortError"));
      }
      this.histories.get(id)?.resetWindow();
      this.patch(this.historyView([id]));
    }
    for (const id of this.readingRooms) {
      if (keep.has(id) && this.readings.has(id)) continue;
      const room = this.view.state?.channel.rooms.find(room => room.id === id);
      if (room?.authorized && !room.available) continue;
      if (room?.authorized) this.write({ type: "browse", roomId: id, active: false });
      this.readingRooms.delete(id);
    }
  }
  private clearReadings(): void {
    for (const { reader } of this.readings.values()) reader.clearInteraction();
    this.readings.clear();
  }

  private publishInteractions(): void {
    const interactionsByRoom = new Map<string, RoomInteractionSession>();
    for (const [id, { reader }] of this.readings) {
      const interaction = reader.interaction;
      if (interaction) interactionsByRoom.set(id, interaction);
    }
    this.patch({ interactionsByRoom });
  }

  acceptInvitation = async (): Promise<string | null> => {
    const params = new URLSearchParams(location.hash.slice(1));
    const roomId = params.get("room"), key = params.get("invite");
    if (!key) return roomId || null;
    if (!roomId) return null;
    if (this.view.connection === "connected") {
      const currentInvitation = () => {
        const current = new URLSearchParams(location.hash.slice(1));
        return current.get("room") === roomId && current.get("invite") === key ? current : null;
      };
      const entry = `enter:${roomId}`;
      if (this.view.pending.has(entry)) {
        const checkSession = this.sessionContext();
        await this.waitForState(() => !this.view.pending.has(entry));
        checkSession();
        if (!currentInvitation()) return null;
      }
      await this.action(entry, () => this.request({ type: "enter_room", roomId, inviteKey: key }), () => !!currentInvitation());
      const current = currentInvitation();
      if (current && this.credential && stored(credentialKey) === this.credential) {
        current.delete("invite");
        const hash = current.toString();
        try {
          history.replaceState(history.state, "", location.pathname + location.search + (hash ? `#${hash}` : ""));
        } catch {
          // Admission already succeeded; an unavailable history API must not
          // turn that committed room entry into a failed operation.
        }
      }
    }
    return roomId;
  };
  discardMessageRetry = (roomId: string, bindingId?: string): void => {
    const attempt = this.outgoingMessages.get(roomId);
    if (attempt && attempt.bindingId === bindingId) this.outgoingMessages.delete(roomId);
  };
  sendMessage = (roomId: string, text: string, files: DraftFile[] = [], signal?: AbortSignal, options: ChatOptions = {}, preparation?: ChatAttachmentPreparation): Promise<void> => this.action(`chat:${roomId}`, async () => {
    signal?.throwIfAborted();
    if (files.length && !this.view.state?.channel.rooms.find(room => room.id === roomId)?.capabilities.attachments) throw new Error("attachments_unavailable");
    const sessionId = this.view.sessionId, bindingId = this.conversationBinding(roomId);
    if (!sessionId || this.view.connection !== "connected") throw new Error("disconnected");
    if (!bindingId) throw new Error("room_unavailable");
    const reading = this.readings.get(roomId), followIntent = Symbol();
    if (reading) reading.followLatest = followIntent;
    const draft = { text, ...structuredClone(options) }, content = JSON.stringify(draft);
    const previous = this.outgoingMessages.get(roomId);
    const retry = previous?.bindingId === bindingId && previous.content === content && previous.files.length === files.length
      && files.every((entry, index) => entry.id === previous.files[index].id && entry.file === previous.files[index].file) ? previous : undefined;
    const preparationSignal = preparation && signal ? AbortSignal.any([preparation.signal, signal]) : preparation?.signal ?? signal;
    let prepared = retry?.files ?? [];
    if (!retry && files.length) {
      const lifetime = this.abortWhenStale(() => {
        if (this.closed || this.view.sessionId !== sessionId) throw new Error("disconnected");
        if (this.conversationBinding(roomId) !== bindingId) throw new Error("room_unavailable");
      });
      const fileSignal = preparationSignal ? AbortSignal.any([preparationSignal, lifetime.signal]) : lifetime.signal;
      try {
        prepared = await this.attachments.describe(files, fileSignal, preparation?.progress);
        fileSignal.throwIfAborted();
      } finally { lifetime.dispose(); }
    }
    if (this.closed || this.view.sessionId !== sessionId) throw new Error("disconnected");
    preparationSignal?.throwIfAborted();
    if (this.conversationBinding(roomId) !== bindingId) throw new Error("room_unavailable");
    // Retry the prepared command even if its selected disk file is no longer readable.
    const attempt = retry ?? { bindingId, content, files: prepared, command: {
      type: "chat" as const, roomId, ...draft, nonce: crypto.randomUUID(), attachments: prepared.map(file => file.attachment),
      inlineImages: Object.fromEntries(prepared.flatMap(file => file.inlineImage ? [[file.id, file.inlineImage]] : [])),
    } };
    preparation?.progress(null);
    this.outgoingMessages.set(roomId, attempt);
    await this.request(attempt.command, event => {
      if (event.type === "confirmed") this.attachments.confirmed(roomId, event.message, prepared);
    }, roomId, { signal, bindingId });
    if (this.outgoingMessages.get(roomId) === attempt) this.outgoingMessages.delete(roomId);
    if (reading && reading.followLatest === followIntent) {
      const follow = () => {
        if (this.readings.get(roomId) !== reading || !this.wantedReadings().has(roomId) || reading.followLatest !== followIntent) return;
        delete reading.followLatest;
        if (this.histories.get(roomId)?.paging?.atLatest === false)
          void this.requestHistory(roomId, undefined, false, { clearError: false }).catch(() => {});
      };
      if (reading.history && this.view.pending.has(`history:${roomId}`)) void reading.history.then(follow, follow);
      else follow();
    }
  });
  deleteMessage = (roomId: string, messageSeq: number, messageId: string): Promise<void> =>
    this.action(`delete-message:${roomId}:${messageId}`, () => this.request({ type: "delete_message", roomId, messageSeq, messageId }), false);
  purgeRoomHistory = (roomId: string): Promise<void> => this.action(`clear-history:${roomId}`, () => {
    const room = this.view.state?.channel.rooms.find(value => value.id === roomId && value.authorized && value.available);
    if (!room) throw new Error("room_unavailable");
    return this.request({ type: "clear_history", roomId, throughSeq: room.lastMessageSeq });
  }, false);
  clearLocalRoomCache = (roomId: string): Promise<void> =>
    this.action(`clear-local-cache:${roomId}`, () => this.attachments.clearLocalCache(roomId), false);
  loadHistory = (roomId: string): Promise<void> => this.requestHistory(roomId, this.histories.get(roomId)?.paging?.before);
  loadLatestHistory = (roomId: string): Promise<void> => this.requestHistory(roomId);
  loadMessage = async (roomId: string, seq: number): Promise<void> => {
    const reading = this.readings.get(roomId);
    if (reading) delete reading.followLatest;
    await this.ensureMessage(roomId, seq);
  };

  private async ensureMessage(roomId: string, seq: number, options: { signal?: AbortSignal; bindingId?: string } = {}): Promise<ChannelMessage> {
    if (!this.histories.get(roomId)?.messages?.some(message => message.seq === seq)) {
      await this.requestHistory(roomId, seq + 1, true, { ...options, clearError: !options.signal });
    }
    options.signal?.throwIfAborted();
    const message = this.histories.get(roomId)?.messages?.find(message => message.seq === seq);
    if (!message) throw new Error("message_unavailable");
    return message;
  }

  findUnreadMessage = async (roomId: string, after: number, signal: AbortSignal): Promise<ChannelMessage | null> => {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("invalid_cursor");
    const sessionId = this.view.sessionId;
    const room = this.view.state?.channel.rooms.find(room => room.id === roomId);
    const bindingId = room?.delivery?.bindingId;
    const reading = this.readings.get(roomId);
    if (reading) delete reading.followLatest;
    const guard = () => {
      signal.throwIfAborted();
      if (this.view.connection !== "connected" || this.view.sessionId !== sessionId) throw new Error("disconnected");
      if (this.readings.get(roomId) !== reading || !this.wantedReadings().has(roomId)) throw new DOMException("Read cancelled", "AbortError");
      if (!bindingId || !this.view.state?.channel.rooms.some(room => room.id === roomId && room.authorized
        && room.available && room.delivery?.bindingId === bindingId && room.historyLineage)) throw new Error("room_unavailable");
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      guard();
      let seq: number | null | undefined;
      await this.request({ type: "history_seek", roomId, after }, event => {
        if (event.type === "history_seek_result") seq = event.seq;
      }, roomId, { signal, bindingId });
      guard();
      if (seq === undefined) throw new Error("invalid_response");
      if (seq === null) return null;
      try {
        const message = await this.ensureMessage(roomId, seq, { signal, bindingId });
        guard();
        return message;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "message_unavailable" || attempt === 1) throw error;
        after = seq;
      }
    }
    throw new Error("message_unavailable");
  };

  refreshReadMarkers = (event?: StorageEvent): void => {
    const state = this.view.state;
    if (!state) return;
    const readByRoom = this.readMarkers.refresh(state.channel.rooms, event?.key);
    if (readByRoom !== this.view.readByRoom) this.patch({ readByRoom });
  };

  markRead = (roomId: string, seq: number): void => {
    const state = this.view.state;
    if (!state) return;
    const readByRoom = this.readMarkers.advance(state.channel.rooms, roomId, seq);
    if (readByRoom !== this.view.readByRoom) this.patch({ readByRoom });
  };
  private requestHistory(roomId: string, before?: number, replace = false, options: { clearError?: boolean; signal?: AbortSignal; bindingId?: string } = {}): Promise<void> {
    const reading = this.readings.get(roomId);
    if (reading) delete reading.followLatest;
    const pending = this.view.pending.has(`history:${roomId}`);
    const loading = this.action(`history:${roomId}`, () => this.request(
      { type: "history", roomId, ...(before !== undefined ? { before } : {}) }, undefined, roomId, { signal: options.signal, replaceHistory: replace, bindingId: options.bindingId }), !options.signal, options);
    if (reading && !pending) reading.history = loading;
    return loading;
  }
  updateProfile = ({ name, avatar }: ProfileUpdate): Promise<void> => this.action("profile", async () => {
    await this.request({ type: "set_profile", name, avatar });
    if (name !== undefined) stored(nameKey, name.trim());
  }, false);
  updateDomain = (settings: Partial<DomainSettings>, reportError = true): Promise<void> => this.action("domain", () => this.request({ type: "update_domain", ...settings }), reportError);
  setRoomCreationPolicy = (policy: Extract<ChannelCommand, { type: "set_room_creation_policy" }>["policy"], reportError = true): Promise<void> =>
    this.action("domain", () => this.request({ type: "set_room_creation_policy", policy }), reportError);
  private async allocateRoom(settings: RoomSettings) {
    const current = this.sessionContext(), socket = this.socket;
    const serverHosted = this.view.state!.channel.hostingMode === "hosted";
    let room: RoomSummary | undefined;
    await this.request(createRoomCommand(settings, this.view.self!.id, serverHosted), event => {
      if (event.type === "room_created") room = event.room;
    });
    try { current(); } catch (error) {
      if (room && serverHosted) throw new RoomCreationInterrupted(room.id, true);
      throw error;
    }
    if (!room) throw new Error("invalid_response");
    const roomId = room.id;
    return { room, cancel: () => {
      if (this.socket === socket) this.write({ type: "cancel_room_creation", roomId });
    } };
  }
  createRoom = (settings: RoomSettings, reportError = true): Promise<string> => this.action("create-room", async () => {
    const app = this.app?.connected ? this.app : undefined;
    const current = this.sessionContext(), state = this.view.state!, self = this.view.self!;
    const { room, cancel } = await this.allocateRoom(settings);
    if (state.channel.hostingMode === "hosted") {
      try { await this.request({ type: "browse", roomId: room.id, active: true }); }
      catch { throw new RoomCreationInterrupted(room.id, true); }
      return room.id;
    }
    let creation: "reserved" | "dispatched" | "committed" = "reserved";
    try {
      const runtime = await loadRoomHosting();
      const policy = await runtime.createRoomPolicy({ ...settings, id: room.id, creatorId: self.id });
      current();
      if (app) {
        if (this.app !== app || !app.connected) throw new Error("app_disconnected");
        creation = "dispatched";
        const opened = await app.open(policy);
        creation = "committed";
        current();
        await this.request({ type: "browse", roomId: opened.id, active: true });
        return opened.id;
      }
      const storage = await browserRoomStorage(state.channel.id, self.id);
      current();
      const host = await storage.open(policy);
      creation = "committed";
      requestBrowserRoomPersistence();
      await this.hosting.register(room.id, host, current);
      await this.request({ type: "browse", roomId: room.id, active: true });
      return room.id;
    } catch (error) {
      if (creation === "reserved") { cancel(); throw error; }
      throw new RoomCreationInterrupted(room.id, creation === "committed");
    }
  }, reportError);
  private sessionContext(): () => void {
    const { sessionId, self, state } = this.view, socket = this.socket;
    if (!sessionId || !self || !state || this.view.connection !== "connected") throw new Error("disconnected");
    return () => {
      if (this.closed || this.socket !== socket || this.view.connection !== "connected"
        || this.view.sessionId !== sessionId || this.view.self?.id !== self.id || this.view.state?.channel.id !== state.channel.id) throw new Error("disconnected");
    };
  }

  /** A signal that aborts with the check's error once a view change makes the check throw. */
  private abortWhenStale(check: () => void): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const dispose = this.subscribe(() => { try { check(); } catch (error) { controller.abort(error); } });
    return { signal: controller.signal, dispose };
  }

  private connectionContext(roomId: string, publicationId?: string) {
    const selection = this.roomId;
    const room = this.view.state?.channel.rooms.find(room => room.id === roomId);
    if (!room?.authorized || !room.available || !room.delivery) throw new Error("room_unavailable");
    const bindingId = room.delivery.bindingId;
    const publication = publicationId ? this.view.state?.publications.find(value => value.id === publicationId
      && value.roomId === roomId && value.kind === "screen") : undefined;
    if (publicationId && !publication) throw new Error("publication_unavailable");
    const available = () => {
      const actual = this.view.state?.channel.rooms.find(room => room.id === roomId);
      return !!actual?.authorized && actual.available && actual.delivery?.bindingId === bindingId
        && (!publicationId || !!this.view.state?.publications.some(value => value.id === publicationId
          && value.roomId === roomId && value.sessionId === publication?.sessionId && value.kind === "screen"));
    };
    return { bindingId, sourceSessionId: publication?.sessionId, available, current: (scope: "view" | "publication" = "view") => {
      if ((scope === "view" && this.roomId !== selection) || !available()) throw new Error("room_context_changed");
    } };
  }

  roomTopology = async (roomId: string, publicationId?: string, signal?: AbortSignal): Promise<ChannelTopology> => {
    signal?.throwIfAborted();
    const current = this.sessionContext(), context = this.connectionContext(roomId, publicationId);
    let topology: ChannelTopology | undefined;
    await this.request({ type: "room_topology", roomId, publicationId }, event => {
      if (event.type !== "room_reply" || event.result.type !== "topology") throw new Error("invalid_response");
      const parsed = channelTopologySchema.safeParse(event.result.topology);
      if (!parsed.success) throw new Error("invalid_response");
      topology = parsed.data;
    }, roomId, { signal });
    current(); signal?.throwIfAborted();
    context.current();
    if (!topology || topology.bindingId !== context.bindingId || (publicationId
      ? topology.screen?.publicationId !== publicationId || topology.screen.sourceSessionId !== context.sourceSessionId
      : topology.screen !== null)) throw new Error("invalid_response");
    return topology;
  };

  connectionMetrics = (roomId: string, publicationId?: string) => this.media.connectionMetrics(roomId, publicationId);

  appConnectionMetrics = async (roomId: string, publicationId?: string, signal?: AbortSignal): Promise<NativeConnectionMetrics> => {
    signal?.throwIfAborted();
    const current = this.sessionContext(), app = this.app;
    if (!app?.connected) throw new Error("app_disconnected");
    const context = this.connectionContext(roomId, publicationId);
    const metrics = await app.connectionMetrics(roomId, publicationId, signal);
    current(); signal?.throwIfAborted();
    if (this.app !== app || !app.connected) throw new Error("room_context_changed");
    context.current();
    if (metrics.bindingId !== context.bindingId) throw new Error("invalid_response");
    return metrics;
  };

  private async backupOwner(roomId: string) {
    const check = this.sessionContext(), state = this.view.state!, self = this.view.self!;
    const room = state.channel.rooms.find(room => room.id === roomId), delivery = room?.delivery;
    if (!room?.available || !delivery) throw new Error("room_unavailable");
    if (room.creatorId !== self.id) throw new Error("room_host_unavailable");
    const current = () => {
      check();
      const next = this.view.state?.channel.rooms.find(room => room.id === roomId)?.delivery;
      if (next?.bindingId !== delivery.bindingId || next.hostSessionId !== delivery.hostSessionId) throw new Error("room_host_conflict");
    };
    if (state.channel.hostingMode === "hosted") {
      if (!this.credential) throw new Error("room_host_unavailable");
      const native = new NativeRoomHosting("/prototype/channel/rooms", { Authorization: `Bearer ${this.credential}` });
      return { current, native: { snapshot: (signal?: AbortSignal) => native.snapshot(roomId, signal), restore: (blob: Blob) => native.restore(blob, roomId) } };
    }
    const host = this.hosting.host(roomId, delivery.bindingId);
    if (host && delivery.hostSessionId === this.view.sessionId) return { current, snapshot: (signal?: AbortSignal) => host.snapshot(signal) };
    const app = this.app?.connected ? this.app : undefined;
    if (app) {
      const description = await app.describeHosting().catch(() => undefined); current();
      if (description && this.app === app && app.connected && description.sessionId === delivery.hostSessionId && description.roomIds.includes(roomId)) {
        return { current: () => { current(); if (this.app !== app || !app.connected) throw new Error("app_disconnected"); },
          native: { snapshot: (signal?: AbortSignal) => app.snapshotRoom(roomId, signal), restore: (blob: Blob) => app.restoreRoom(blob) } };
      }
    }
    if (state.channel.ownerId === self.id && this.credential) {
      const native = new NativeRoomHosting("/prototype/channel/rooms", { Authorization: `Bearer ${this.credential}` }, "/prototype/channel/hosting");
      const description = await native.describe().catch(() => undefined); current();
      if (description && description.sessionId === delivery.hostSessionId && description.roomIds.includes(roomId)) {
        return { current, native: { snapshot: (signal?: AbortSignal) => native.snapshot(roomId, signal), restore: (blob: Blob) => native.restore(blob) } };
      }
    }
    throw new Error("room_host_unavailable");
  }

  nativeRoomOpenFailure: ChannelActions["nativeRoomOpenFailure"] = async (roomId, operator, signal) => {
    const current = this.sessionContext();
    const { self, state } = this.view;
    const eligible = () => this.view.state?.channel.rooms.some(room =>
      room.id === roomId && room.authorized && !room.available && (operator === "domain" || room.creatorId === self?.id));
    if (!eligible() || (operator === "app" && state?.channel.hostingMode === "hosted")) return;
    const app = this.app;
    const credential = this.credential;
    const native = operator === "domain" && self?.id === state?.channel.ownerId && credential
      ? new NativeRoomHosting("/prototype/channel/rooms", { Authorization: `Bearer ${credential}` }, "/prototype/channel/hosting")
      : undefined;
    const description = operator === "app" && app?.connected ? await app.describeHosting(signal)
      : await native?.describe(signal);
    current();
    if (signal.aborted || !eligible() || (operator === "app" && (app !== this.app || !app?.connected))
      || (operator === "domain" && (credential !== this.credential || self?.id !== this.view.state?.channel.ownerId))) return;
    return description?.unavailable?.find(entry => entry.roomId === roomId)?.reason;
  };

  roomBackupAvailable = async (roomId: string): Promise<boolean> => {
    try { await this.backupOwner(roomId); return true; } catch { return false; }
  };

  private async writeRoomSnapshot(snapshot: BrowserRoomSnapshot, metadata: Exclude<BackupMetadata, { kind: "domain" }>, retained: RetainedFile[], check: () => void, signal: AbortSignal): Promise<Blob> {
    const files = new Map<string, File>(), inventory: RetainedBackupFile[] = [];
    const authors = new Set<string>();
    const readAuthors = async () => {
      if (metadata.kind !== "room_copy" || !authors.size) return;
      const profiles = await this.loadProfiles([...authors]); check();
      for (const profile of profiles) metadata.authors[profile.id] = profile.name;
      authors.clear();
    };
    const byKey = new Map(retained.map(file => [JSON.stringify([file.key.messageSeq, file.key.attachmentId]), file]));
    for await (const row of snapshot.rows) {
      check();
      if (!("attachments" in row)) continue;
      if (metadata.kind === "room_copy") {
        for (const source of [row, row.reply]) {
          if (!source || source.archivedAuthorName !== undefined) continue;
          authors.add(source.userId);
          if (authors.size >= PROFILE_PAGE_SIZE) await readAuthors();
        }
      }
      for (const attachment of row.attachments) {
        const entry = byKey.get(JSON.stringify([row.seq, attachment.id]));
        if (entry && entry.attachment.sha256.toLowerCase() === attachment.sha256.toLowerCase()
          && entry.attachment.id === attachment.id && entry.attachment.name === attachment.name && entry.attachment.mediaType === attachment.mediaType && entry.attachment.size === attachment.size && entry.file.size === attachment.size) {
          inventory.push({ messageSeq: row.seq, attachment }); files.set(attachment.sha256.toLowerCase(), entry.file);
        }
      }
    }
    await readAuthors();
    const archive = await writeBackup({ ...metadata, retainedFiles: inventory }, snapshot.rows,
      async entry => { check(); return files.get(entry.attachment.sha256.toLowerCase())!; }, signal);
    check(); return archive;
  }

  private roomArchiveAction<T>(roomId: string | undefined, work: () => Promise<T>): Promise<T> {
    return this.action("room-backup", () => this.action(roomId ? `room:${roomId}` : "create-room", work, false), false);
  }

  exportRoomBackup = (roomId: string, includeFiles = true, signal?: AbortSignal): Promise<Blob> => this.roomArchiveAction(roomId, () => this.exportRoomArchive(roomId, includeFiles, signal));

  exportRoomCopy = (roomId: string, includeRoomInfo: boolean, includeFiles = true, signal?: AbortSignal): Promise<Blob> =>
    this.roomArchiveAction(roomId, () => this.exportRoomArchive(roomId, includeFiles, signal, { includeRoomInfo }));

  private async exportRoomArchive(roomId: string, includeFiles: boolean, surface?: AbortSignal, copy?: { includeRoomInfo: boolean }): Promise<Blob> {
    const owner = await this.backupOwner(roomId);
    const lifetime = this.abortWhenStale(owner.current);
    const signal = surface ? AbortSignal.any([surface, lifetime.signal]) : lifetime.signal;
    const current = () => { signal.throwIfAborted(); owner.current(); };
    let snapshot: BrowserRoomSnapshot | undefined;
    try {
      current();
      const retained = includeFiles ? await this.attachments.retained(roomId) : [];
      current();
      let metadata: Extract<BackupMetadata, { kind: "room" }>;
      if (owner.native) {
        const archive = await owner.native.snapshot(signal); current();
        if (!retained.length && !copy) return archive;
        let stage: BrowserRoomStage | undefined;
        try {
          const value = await readBackup(archive, {
            metadata: async value => {
              current();
              if (value.kind !== "room" || value.policy.id !== roomId || value.domainId !== this.view.state!.channel.id) throw new Error("invalid_backup");
              stage = await (await loadRoomHosting()).BrowserRoomHost.stage(roomDatabaseName(value.domainId, this.view.self!.id), JSON.stringify(value.policy));
            }, row: row => { current(); return stage!.append(row); }, content() {},
          });
          if (value.kind !== "room") throw new Error("invalid_backup");
          snapshot = stage; metadata = value;
        } catch (error) { await stage?.close(); throw error; }
      } else {
        snapshot = await owner.snapshot!(signal); current();
        metadata = { kind: "room", version: 4, domainId: this.view.state!.channel.id,
          policy: JSON.parse(snapshot.policy), retainedFiles: [] };
      }
      if (copy) {
        const { name, icon, picture, voiceBitrate, relayCapacity } = metadata.policy;
        return await this.writeRoomSnapshot(snapshot!, { kind: "room_copy", version: 2,
          roomInfo: copy.includeRoomInfo ? { name, icon, picture, voiceBitrate, relayCapacity } : undefined,
          authors: {}, retainedFiles: [] }, retained, current, signal);
      }
      if (metadata.policy.creatorId === this.view.self!.id && this.credential) metadata.ownCredential = { userId: this.view.self!.id, credential: this.credential };
      return await this.writeRoomSnapshot(snapshot!, metadata, retained, current, signal);
    } finally { lifetime.dispose(); await snapshot?.close(); }
  }

  private waitForState(ready: () => boolean): Promise<void> {
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); unsubscribe(); error ? reject(error) : resolve(); };
      const unsubscribe = this.subscribe(() => {
        if (ready()) finish(); else if (this.closed) finish(new Error("disconnected"));
      });
      const timer = setTimeout(() => finish(new Error("request_timeout")), 10000);
    });
  }

  private async admitBackupIdentity(metadata: RoomBackupMetadata): Promise<(() => void) | undefined> {
    if (metadata.policy.creatorId === this.view.self?.id) return;
    const check = this.sessionContext(), archived = metadata.ownCredential;
    if (!archived || archived.userId !== metadata.policy.creatorId) throw new Error("backup_identity_required");
    const response = await fetch("/prototype/channel/identity", { headers: { Authorization: `Bearer ${archived.credential}` }, cache: "no-store" });
    if (!response.ok) throw new Error("backup_identity_required");
    const identity = z.object({ domainId: z.string(), user: userSchema }).parse(await response.json()); check();
    if (identity.domainId !== metadata.domainId || identity.user.id !== archived.userId) throw new Error("backup_identity_required");
    const previous = { credential: this.credential, ownerBootstrap: this.ownerBootstrap, roomId: this.roomId,
      hash: location.hash };
    const rollback = () => {
      this.close(); this.credential = previous.credential;
      if (previous.credential) stored(credentialKey, previous.credential);
      this.ownerBootstrap = previous.ownerBootstrap; this.roomId = previous.roomId;
      if (typeof history !== "undefined") history.replaceState(null, "", location.pathname + location.search + previous.hash);
      this.start();
    };
    const generation = await this.connectBackupIdentity(metadata.domainId, archived.userId, { credential: archived.credential }, metadata.policy.id, rollback);
    if (generation !== this.identityGeneration) throw new Error("disconnected");
    if (typeof history !== "undefined") history.replaceState(null, "", location.pathname + location.search);
    return () => { if (generation === this.identityGeneration) rollback(); };
  }

  private async connectBackupIdentity(domainId: string, userId: string, identity: { credential?: string; ownerKey?: string },
    skipRoom?: string, onFailure = this.close): Promise<number> {
    this.close(); this.credential = identity.credential; this.roomId = "";
    this.ownerBootstrap = identity.ownerKey === undefined ? undefined : { key: identity.ownerKey };
    const generation = this.identityGeneration;
    const lifetime = this.captureLifetime.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        let waiting = true;
        abort = () => { waiting = false; reject(new Error("disconnected")); };
        lifetime.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => { waiting = false; reject(new Error("request_timeout")); }, 10000);
        this.connect(event => {
          if (!waiting) throw new Error("backup_identity_required");
          const actual = event.state.sessions.find(value => value.id === event.sessionId)?.userId;
          if (event.state.channel.id !== domainId || actual !== userId
            || (identity.ownerKey !== undefined && event.state.channel.ownerId !== userId)) {
            reject(new Error("backup_identity_required")); throw new Error("backup_identity_required");
          }
          waiting = false; resolve(); return skipRoom;
        });
      });
      lifetime.throwIfAborted();
      return generation;
    } catch (error) {
      if (generation === this.identityGeneration) onFailure();
      throw error;
    } finally {
      clearTimeout(timer);
      if (abort) lifetime.removeEventListener("abort", abort);
    }
  }

  private domainBackupOwner(): { current(): void; native: NativeDomainHosting } {
    const current = this.sessionContext();
    if (this.view.state!.channel.ownerId !== this.view.self!.id || !this.credential) throw new Error("forbidden");
    return { current, native: new NativeDomainHosting({ Authorization: `Bearer ${this.credential}` }) };
  }

  exportDomainBackup = (surface?: AbortSignal): Promise<Blob> => this.action("domain-backup", async () => {
    const owner = this.domainBackupOwner(), lifetime = this.captureLifetime.signal;
    const signal = surface ? AbortSignal.any([surface, lifetime]) : lifetime;
    const archive = await owner.native.snapshot(signal); signal.throwIfAborted(); owner.current();
    return archive;
  }, false);

  restoreDomainBackup = (archive: Blob): Promise<DomainSettings> => this.action("domain-backup", async () => {
    const owner = this.domainBackupOwner();
    const metadata = await readBackup(archive);
    owner.current();
    if (metadata.kind !== "domain") throw new Error("expected_domain_backup");
    this.close();
    const generation = this.identityGeneration;
    const canResume = () => generation === this.identityGeneration && this.closed && !this.socket;
    let committed = false;
    try {
      const domainId = await owner.native.restore(archive); committed = true;
      if (!canResume()) throw new Error("disconnected");
      if (domainId !== metadata.state.id) throw new Error("backup_identity_required");
      await this.connectBackupIdentity(domainId, metadata.state.ownerId, { ownerKey: metadata.ownerKey });
      const { name, icon } = this.view.state!.channel;
      return { name, icon };
    } catch (error) {
      const restored = error instanceof Error && error.message === "domain_restored_connection_failed";
      if (committed || restored) {
        if (!committed && canResume()) {
          await this.connectBackupIdentity(metadata.state.id, metadata.state.ownerId, { ownerKey: metadata.ownerKey }).catch(() => {});
        }
        throw new Error("domain_restored_connection_failed");
      }
      if (canResume()) this.start();
      throw error;
    }
  }, false);

  inspectRoomCopy = async (archive: Blob) => {
    const metadata = await readBackup(archive);
    if (metadata.kind !== "room_copy") throw new Error("expected_room_copy");
    return { settings: metadata.roomInfo ?? {}, retainedFileCount: metadata.retainedFiles.length };
  };

  importRoomCopy = (archive: Blob, settings: RoomSettings): Promise<{ roomId: string; cached: boolean }> => this.roomArchiveAction(undefined, async () => {
    const current = this.sessionContext(), state = this.view.state!, self = this.view.self!;
    if (state.channel.hostingMode === "hosted") return this.importHostedRoomCopy(archive, settings, current);
    const runtime = await loadRoomHosting();
    const policy = await runtime.createRoomPolicy({ ...settings, id: crypto.randomUUID(), creatorId: self.id });
    current();
    let stage: BrowserRoomStage | undefined, importer: BackupHistoryImport | undefined;
    let cancelReservation: (() => void) | undefined;
    const contents = new Map<string, File>();
    try {
      const metadata = await readBackup(archive, {
        metadata: async value => {
          current();
          if (value.kind !== "room_copy") throw new Error("expected_room_copy");
          importer = new runtime.CopyHistoryImport(JSON.stringify(value));
          stage = await runtime.BrowserRoomHost.stage(roomDatabaseName(state.channel.id, self.id), policy);
        },
        row: row => { current(); return stage!.append(JSON.parse(importer!.accept(JSON.stringify(row))) as BackupHistoryRow); },
        content: (digest, file) => { current(); contents.set(digest, file); },
      });
      current(); importer!.finish();
      if (metadata.kind !== "room_copy" || !stage) throw new Error("expected_room_copy");
      const { room, cancel } = await this.allocateRoom(settings);
      cancelReservation = cancel;
      current();
      return await this.installRoomHistory({ kind: "room", version: 4, domainId: state.channel.id,
        policy: { ...JSON.parse(policy), id: room.id }, retainedFiles: metadata.retainedFiles }, contents, { kind: "copy", stage });
    } catch (error) {
      if (!roomRestoreRecovery(error)) cancelReservation?.();
      throw error;
    } finally {
      importer?.free();
      await stage?.close().catch(() => {});
    }
  });

  private async importHostedRoomCopy(archive: Blob, settings: RoomSettings, current: () => void): Promise<{ roomId: string; cached: boolean }> {
    const credential = this.credential, sessionId = this.view.sessionId;
    if (!credential || !sessionId) throw new Error("disconnected");
    const command = createRoomCommand(settings, this.view.self!.id, this.view.state!.channel.hostingMode === "hosted");
    const { metadata, archive: writerArchive, contents } = await prepareHostedRoomArchive(archive, { kind: "room_copy", settings: command }, current);
    const hosted = new NativeRoomHosting("/prototype/channel/rooms", { Authorization: `Bearer ${credential}` });
    const room = await hosted.importCopy(writerArchive, command.room.creatorId, sessionId);
    try {
      current();
      await this.waitForState(() => this.view.state?.channel.rooms.some(candidate =>
        candidate.id === room.id && candidate.authorized && candidate.available && !!candidate.delivery) ?? false);
      current();
      this.browse(room.id);
      await this.readings.get(room.id)?.ready;
      current();
      const cached = await this.cacheRoomBackupFiles(room.id, metadata.retainedFiles, contents);
      current();
      return { roomId: room.id, cached };
    } catch {
      throw new RoomCreationInterrupted(room.id, true);
    }
  }

  restoreRoomBackup = (archive: Blob, roomId?: string): Promise<{ roomId: string; cached: boolean }> =>
    this.roomArchiveAction(roomId, () => this.restoreRoomArchive(archive, roomId));

  private async restoreRoomArchive(archive: Blob, roomId?: string): Promise<{ roomId: string; cached: boolean }> {
    const initial = this.sessionContext(), owner = roomId ? await this.backupOwner(roomId) : undefined;
    initial();
    if (this.view.state!.channel.hostingMode === "hosted") {
      if (!roomId || !owner) throw new Error("room_host_unavailable");
      const target = { kind: "room" as const, domainId: this.view.state!.channel.id, roomId };
      const prepared = await prepareHostedRoomArchive(archive, target, initial);
      owner.current();
      if (prepared.metadata.kind !== "room") throw new Error("invalid_backup");
      return this.installRoomHistory(prepared.metadata, prepared.contents, { kind: "restore", archive: prepared.archive, owner });
    }
    let stage: BrowserRoomStage | undefined;
    const contents = new Map<string, File>();
    try {
      const metadata = await readBackup(archive, {
        metadata: async value => {
          initial();
          if (value.kind !== "room" || value.domainId !== this.view.state!.channel.id || (roomId && value.policy.id !== roomId)) throw new Error("backup_room_mismatch");
          if (owner?.native) return;
          const runtime = await loadRoomHosting(); initial();
          stage = await runtime.BrowserRoomHost.stage(roomDatabaseName(value.domainId, value.policy.creatorId), JSON.stringify(value.policy));
        },
        row: row => {
          initial();
          if (stage) return stage.append(row);
          if (!validBackupSequence(row.seq)) throw new Error("invalid_backup_history");
        },
        content: (digest, file) => { initial(); contents.set(digest, file); },
      });
      initial(); owner?.current();
      if (metadata.kind !== "room") throw new Error("invalid_backup");
      return await this.installRoomHistory(metadata, contents, { kind: "restore", archive, stage, owner });
    } finally {
      await stage?.close().catch(() => {});
    }
  }

  private async installRoomHistory(metadata: RoomBackupMetadata, contents: ReadonlyMap<string, File>, source: RoomHistorySource): Promise<{ roomId: string; cached: boolean }> {
    const owner = source.kind === "restore" ? source.owner : undefined;
    const target = metadata.policy.id;
    if (!owner && this.view.state!.channel.rooms.some(room => room.id === target && room.available)) throw new Error("room_host_conflict");
    if (owner && metadata.policy.creatorId !== this.view.self!.id) throw new Error("backup_identity_required");
    let rollback: (() => void) | undefined, committed = false;
    try {
      if (source.kind === "restore") rollback = await this.admitBackupIdentity(metadata);
      const check = this.sessionContext();
      const app = this.app?.connected ? this.app : undefined;
      const native = owner?.native ?? (!owner && app ? { restore: (blob: Blob) => app.restoreRoom(blob) } : undefined);
      const previousDelivery = this.view.state?.channel.rooms.find(room => room.id === target)?.delivery;
      const oldBinding = previousDelivery?.bindingId;
      let expectedHost = owner?.native ? previousDelivery?.hostSessionId : this.view.sessionId;
      check(); owner?.current();
      if (native) {
        const archive = source.kind === "restore" ? source.archive : await writeBackup(metadata, source.stage.rows,
          async entry => contents.get(entry.attachment.sha256.toLowerCase())!);
        check(); owner?.current();
        if (!owner && (this.app !== app || !app?.connected)) throw new Error("app_disconnected");
        const restored = await native.restore(archive); committed = true; check();
        if (restored.id !== target) throw new Error("backup_room_mismatch");
        if (!owner && app) {
          const description = await app.describeHosting(); check();
          if (this.app !== app || !app.connected || !description.roomIds.includes(target)) throw new Error("app_disconnected");
          expectedHost = description.sessionId;
        }
      }
      else {
        const stage = source.stage;
        if (!stage) throw new Error("invalid_backup");
        await this.request({ type: "admit_room", room: roomSummarySchema.parse({ ...metadata.policy, hasPassword: metadata.policy.passwordHash != null }) });
        check(); owner?.current();
        // The transaction retires the durable writer. Keep the old host alive
        // until commit so a storage rollback needs no competing registration.
        await this.hosting.replace(target, async () => {
          const cancel = this.abortWhenStale(check);
          try {
            if (source.kind === "copy") await stage.createRoom(JSON.stringify(metadata.policy), cancel.signal);
            else await stage.replace(cancel.signal);
            committed = true;
            if (!owner) requestBrowserRoomPersistence();
          }
          finally { cancel.dispose(); }
        });
        const host = await (await browserRoomStorage(metadata.domainId, metadata.policy.creatorId)).openExisting(target);
        await this.hosting.register(target, host, check);
      }
      await this.waitForState(() => {
        const room = this.view.state?.channel.rooms.find(room => room.id === target);
        return !!room?.available && !!room.delivery && room.delivery.hostSessionId === expectedHost && room.delivery.bindingId !== oldBinding;
      });
      check();
      this.browse(target);
      await this.reading?.ready; check();
      const cached = await this.cacheRoomBackupFiles(target, metadata.retainedFiles, contents);
      check();
      return { roomId: target, cached };
    } catch (error) {
      if (committed) throw new Error("room_restored_connection_failed");
      if (roomRestoreRecovery(error)) throw error;
      rollback?.();
      if (error instanceof Error && error.message === "room_not_in_domain") throw new Error("backup_room_not_admitted");
      throw error;
    }
  }

  private cacheRoomBackupFiles(roomId: string, retainedFiles: RetainedBackupFile[], contents: ReadonlyMap<string, File>): Promise<boolean> {
    const entries = retainedFiles.map(({ messageSeq, attachment }) => ({
      key: { roomId, messageSeq, attachmentId: attachment.id },
      attachment,
      file: contents.get(attachment.sha256.toLowerCase())!,
    }));
    return this.attachments.restoreRetained(roomId, entries);
  }

  updateRoom = (roomId: string, settings: Partial<RoomSettings>, reportError = true): Promise<void> => this.action(`room:${roomId}`, () => this.request({ type: "update_room", roomId, ...settings }), reportError);
  setForwardingLimit = (forwardingLimit: number): void => {
    const { self, sessionId, connection } = this.view, state = this.roomSnapshot;
    if (!self || !sessionId || !state || !Number.isInteger(forwardingLimit) || forwardingLimit < -1 || forwardingLimit > MAX_RELAY_CAPACITY) return;
    const key = JSON.stringify([state.channel.id, self.id]);
    saveRoomPreferences({ forwardingLimitByIdentity: { ...readRoomPreferences().forwardingLimitByIdentity, [key]: forwardingLimit } });
    this.patch({ forwardingLimit });
    if (connection === "connected") this.applyForwarding(sessionId, state, self.id);
  };
  appRelayCapacity = async (signal?: AbortSignal): Promise<NativeRelayCapacity> => {
    signal?.throwIfAborted();
    const current = this.sessionContext(), app = this.app;
    if (!app?.connected) throw new Error("app_disconnected");
    const result = await app.relayCapacity(signal);
    current(); signal?.throwIfAborted();
    if (this.app !== app || !app.connected) throw new Error("app_disconnected");
    return result;
  };
  setAppRelayOverride = (previous: NativeRelayCapacity, capacity: number | null, reportError = true): Promise<NativeRelayCapacity> =>
    this.action("app-relay", async () => {
      const current = this.sessionContext(), app = this.app;
      if (!app?.connected) throw new Error("app_disconnected");
      const result = await app.setRelayCapacity(previous, capacity);
      current();
      if (this.app !== app || !app.connected || result.sessionId !== previous.sessionId) throw new Error("app_disconnected");
      return result;
    }, reportError);
  deleteRoom = (roomId: string, deleteData: boolean, localResult?: AbortSignal): Promise<{ dataRemoved: boolean }> => this.action(`delete:${roomId}`, async () => {
    const socket = this.socket;
    const hosted = this.view.state?.channel.hostingMode === "hosted";
    if (this.view.errorRoomId === roomId) this.clearError();
    let dataRemoved: boolean | undefined;
    try {
      await this.request({ type: "delete_room", roomId, deleteData }, event => {
        if (event.type !== "room_reply" || event.result.type !== "deleted" || typeof event.result.dataRemoved !== "boolean") throw new Error("invalid_response");
        dataRemoved = event.result.dataRemoved;
      });
      if (dataRemoved === undefined) throw new Error("invalid_response");
    } catch (error) {
      const failure = hosted && error instanceof Error && error.message === "storage_failed"
        ? new Error("hosted_room_deletion_failed") : error;
      if (this.socket === socket && (!localResult || localResult.aborted)) {
        this.patch({ error: failure instanceof Error ? failure.message : "operation_failed", errorRoomId: roomId });
      }
      throw failure;
    }
    if (this.roomId === roomId) this.browse("");
    if (deleteData && !dataRemoved && this.socket === socket && (!localResult || localResult.aborted))
      this.patch({ error: "room_data_removal_unconfirmed", errorRoomId: roomId });
    return { dataRemoved };
  }, false);

  setRoomVoiceBitrate = (roomId: string, voiceBitrate: number): Promise<void> => {
    if (!Number.isInteger(voiceBitrate)) return Promise.reject(new Error("invalid_audio_bitrate"));
    return this.updateRoom(roomId, { voiceBitrate });
  };
  enterRoom = (roomId: string, password: string): Promise<void> => this.action(`enter:${roomId}`, () => this.request({ type: "enter_room", roomId, password }), false);
  private roomInvitationURL(roomId: string, key: string): string {
    const url = new URL(location.pathname, this.invitationOrigin);
    url.hash = new URLSearchParams({ room: roomId, invite: key }).toString();
    return url.href;
  }
  getRoomInvite = async (roomId: string): Promise<RoomInvitationState> => {
    let invitation: RoomInvitationState | undefined;
    await this.request({ type: "get_room_invite", roomId }, event => {
      if (event.type !== "room_reply") throw new Error("invalid_response");
      const state = roomInvitationSchema.safeParse(event.result.invitation);
      if (!state.success) throw new Error("invalid_response");
      invitation = state.data.state === "available"
        ? { state: "available", url: this.roomInvitationURL(roomId, state.data.key) } : state.data;
    });
    if (!invitation) throw new Error("invalid_response");
    return invitation;
  };
  invitationPending = (roomId: string): boolean => {
    for (const request of this.requests.values()) if (request.kind === "room_invite" && request.roomId === roomId) return true;
    return false;
  };
  createRoomInvite = async (roomId: string): Promise<string> => {
    if (this.invitationPending(roomId)) throw new Error("operation_pending");
    let key: string | undefined;
    await this.request({ type: "room_invite", roomId }, event => {
      if (event.type !== "room_reply") throw new Error("invalid_response");
      const parsed = channelId.safeParse(event.result.key);
      if (!parsed.success) throw new Error("invalid_response");
      key = parsed.data;
    });
    if (!key) throw new Error("invalid_response");
    return this.roomInvitationURL(roomId, key);
  };
  revokeRoomAccess = (roomId: string, userId: string, reportError = true): Promise<void> => this.action(`revoke:${roomId}:${userId}`, () => this.request({ type: "revoke_room_access", roomId, userId }), reportError);
  watch = (publicationId: string, roomId?: string, signal?: AbortSignal, reportError: ReportError = true): Promise<void> => {
    const watch: ScreenWatch = {};
    const operation = this.action(`watch:${publicationId}`, async () => {
      if (signal?.aborted) throw new DOMException("Capture cancelled", "AbortError");
      this.watching.get(publicationId)?.retry?.controller.abort();
      this.watching.set(publicationId, watch);
      this.declinedSources.delete(publicationId);
      try {
        const app = this.app;
        const publication = this.view.state?.publications.find(value => value.id === publicationId);
        const remote = publication && this.view.self && publication.userId !== this.view.self.id;
        // Source location is independent of Native admission. Only assistance
        // waits for hosting readiness after the ordinary subscription.
        if (app?.connected && !remote && !this.view.localScreens.has(publicationId)) {
          watch.query = new AbortController();
          const lifetime = AbortSignal.any([watch.query.signal, this.captureLifetime.signal, ...(signal ? [signal] : [])]);
          const endpoint = await app.localEndpoint(lifetime).catch(error => {
            if (this.app === app && app.connected) throw error;
          });
          watch.query = undefined;
          lifetime.throwIfAborted();
          if (endpoint) this.rememberLocalEndpoint(app, endpoint);
          if (this.watching.get(publicationId) !== watch) throw new DOMException("Capture cancelled", "AbortError");
        }
        await this.request({ type: "subscribe", publicationId, enabled: true }, undefined, roomId);
        if (signal?.aborted || this.watching.get(publicationId) !== watch) throw new DOMException("Capture cancelled", "AbortError");
      } catch (error) {
        if (this.watching.get(publicationId) !== watch) throw new DOMException("Capture cancelled", "AbortError");
        if (!signal?.aborted && error instanceof Error && error.message === "disconnected") return;
        this.retireWatch(publicationId);
        this.refreshActivity();
        if (signal?.aborted) throw new DOMException("Capture cancelled", "AbortError");
        throw error;
      }
    }, reportError);
    watch.operation = operation;
    return operation.finally(() => { watch.operation = undefined; }).then(() => { void this.syncAppWatching(); });
  };
  private retireWatch(publicationId: string): void {
    this.input.close(publicationId);
    const watch = this.watching.get(publicationId);
    watch?.retry?.controller.abort();
    watch?.query?.abort();
    this.watching.delete(publicationId);
  }
  unwatch = async (publicationId: string): Promise<void> => {
    const watch = this.watching.get(publicationId);
    if (watch?.query) {
      this.retireWatch(publicationId);
      await watch.operation?.catch(() => {});
    }
    return this.action(`watch:${publicationId}`, async () => {
      this.retireWatch(publicationId);
      const roomId = this.view.state?.publications.find(value => value.id === publicationId)?.roomId;
      if (roomId) this.declinedSources.set(publicationId, roomId);
      this.refreshActivity();
      if (this.view.connection === "connected") await this.request({ type: "subscribe", publicationId, enabled: false });
    });
  };
  retryPicture = (publicationId: string, reportError: ReportError = true): Promise<void> => this.action(`retry-picture:${publicationId}`, async () => {
    const current = this.sessionContext();
    const publication = this.view.state?.publications.find(value => value.id === publicationId && value.kind === "screen");
    const watch = this.watching.get(publicationId);
    if (!publication || !watch || this.view.localScreens.has(publicationId)) throw new Error("publication_unavailable");
    if (watch.operation) throw new Error("operation_pending");
    const context = this.connectionContext(publication.roomId, publicationId);
    const controller = new AbortController();
    watch.retry = { controller, available: context.available };
    if (watch.playbackError !== undefined) {
      delete watch.playbackError;
      this.patch({});
    }
    const check = () => { controller.signal.throwIfAborted(); current(); context.current("publication"); };
    this.input.close(publicationId);
    let withdrawn = false;
    try {
      await this.request({ type: "subscribe", publicationId, enabled: false }, undefined, publication.roomId, { signal: controller.signal });
      withdrawn = true;
      check();
      // Withdrawal also retired the previous helper. Restore Browser viewing first.
      watch.helperSessionId = undefined;
      await this.request({ type: "subscribe", publicationId, enabled: true }, undefined, publication.roomId, { signal: controller.signal });
      check();
    } catch (error) {
      controller.signal.throwIfAborted();
      if (withdrawn && this.watching.get(publicationId) === watch) {
        this.retireWatch(publicationId);
        this.refreshActivity();
      }
      throw error;
    } finally {
      delete watch.retry;
      this.browseRooms();
    }
    void this.syncAppWatching();
  }, reportError);
  clearError = (): void => this.patch({ error: null });

  async publish(kind: "screen" | "voice", roomId: string, stream: MediaStream, { microphone, audio, profile, codec, camera, source, publicationId, signal }: { signal?: AbortSignal; microphone?: MicrophoneInput; audio?: HostAudio; profile?: QualityProfile; codec?: BrowserVideoCodecPreference; camera?: boolean; source?: ScreenSource; publicationId?: string } = {}): Promise<string> {
    const id = publicationId ?? crypto.randomUUID();
    const sourceProfile = kind === "screen" ? profile ?? this.view.quality : undefined;
    const capture = { roomId, kind, stream, microphone, audio, camera, admitted: false };
    this.local.set(id, capture);
    this.media.setLocal(id, stream, sourceProfile, codec);
    try {
      if (microphone && !microphone.stream.active) throw new Error("microphone_unavailable");
      await this.request({ type: "publish", publication: { id, roomId, kind,
        ...(sourceProfile ? { videoSettings: screenVideoSettings(sourceProfile), source: source ?? captureSource(stream.getVideoTracks()[0], camera) } : {}) } }, undefined, roomId, { signal });
      signal?.throwIfAborted();
      if (this.local.get(id) !== capture) throw new DOMException("Capture cancelled", "AbortError");
      const primary = kind === "screen" ? stream.getVideoTracks()[0] : stream.getAudioTracks()[0];
      if (primary?.readyState === "ended" || (microphone && !microphone.stream.active)) {
        this.send({ type: "unpublish", publicationId: id });
        throw new Error(kind === "screen" ? "capture_unavailable" : "microphone_unavailable");
      }
      capture.admitted = true;
      if (kind === "screen") this.observeScreen(id, stream);
      else primary?.addEventListener("ended", () => this.voice.captureEnded(id, stream), { once: true });
      return id;
    } catch (error) {
      if (this.local.get(id) === capture) {
        if (kind === "screen" && signal?.aborted) void this.retireScreenPublication(id).catch(() => {});
        else this.retireCapture(id);
      }
      throw error;
    }
  }

  private stage(roomId: string): Stage {
    let stage = this.stages.get(roomId);
    if (!stage) {
      stage = new Stage(roomId, id => this.local.has(id) || !!this.app?.screens.has(id), () => this.patch({}), {
        local: id => this.local.get(id), app: () => this.app,
        configure: (id, profile) => this.media.configureLocal(id, profile),
        publish: (id, roomId, profile) => this.request({ type: "publish", publication: { id, roomId, kind: "screen", videoSettings: screenVideoSettings(profile) } }),
        remember: this.setQuality, begin: () => this.beginActionFeedback(),
      });
      this.stages.set(roomId, stage);
    }
    return stage;
  }
  private screenStage(id: string): Stage | undefined {
    for (const stage of this.stages.values()) if (stage.screen?.id === id) return stage;
    return undefined;
  }
  private watchStage(id: string): Stage | undefined {
    for (const stage of this.stages.values()) if (stage.watch(id) || stage.candidate(id)) return stage;
    return undefined;
  }
  private watchPlayer(id: string): WatchPlayer | undefined { return this.watchStage(id)?.watch(id); }
  private pendingWatchPlayer(id: string): WatchPlayer | undefined { return this.watchStage(id)?.candidate(id); }
  private *watchPlayers(): IterableIterator<[string, WatchPlayer]> {
    for (const stage of this.stages.values()) yield* stage.watches();
  }
  private *pendingWatchPlayers(): IterableIterator<[string, WatchPlayer]> {
    for (const stage of this.stages.values()) yield* stage.candidates();
  }
  private *screenShares(): IterableIterator<[string, ScreenShare]> {
    for (const [roomId, stage] of this.stages) if (stage.screen) yield [roomId, stage.screen];
  }
  private selectSource(roomId: string): SourceSelection { return this.stage(roomId).selectSource(); }
  private ownedReplacementWatchId(selection?: SourceSelection): string | undefined {
    const id = selection?.replaceWatchId;
    return id && this.watchPlayer(id)?.owner ? id : undefined;
  }
  private finishSourceSelection(roomId: string, selection: SourceSelection): void {
    this.stages.get(roomId)?.finishSelection(selection);
  }
  private selectScreen(roomId: string): { share: ScreenShare; selection: SourceSelection; current(): boolean } {
    const stage = this.stage(roomId);
    let share = stage.screen;
    if (!share) {
      const local = [...this.local].find(([, capture]) => capture.kind === "screen" && capture.roomId === roomId);
      const id = local?.[0] ?? crypto.randomUUID();
      share = { id, profile: this.media.localProfile(id) ?? this.view.quality,
        codecMode: this.view.videoCodecMode, encodingExecution: this.view.encodingExecution,
        volume: { level: 1, muted: false }, microphone: { deviceId: "", volume: 1, voiceProcessing: true } };
    }
    if (this.view.pending.has(`source-microphone:${share.id}`)) throw new Error("operation_pending");
    return stage.selectScreen(share, { profile: this.view.quality, codecMode: this.view.videoCodecMode,
      encodingExecution: this.view.encodingExecution });
  }

  private forgetInactiveScreen(publicationId: string): void {
    for (const stage of this.stages.values()) stage.forgetInactiveScreen(publicationId);
  }

  private observeScreen(id: string, stream: MediaStream): void {
    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      // This source ended. A new picker, player or App input still owns its preparation.
      if (this.local.get(id)?.stream === stream) void this.retireScreenPublication(id).catch(() => {});
    }, { once: true });
  }

  sourceSelectionCommitting = (roomId: string): boolean => this.stages.get(roomId)?.sourceSelection?.committing ?? false;
  browserCapturePreparation = (roomId: string): "picker" | "preparing" | undefined => {
    const selection = this.stages.get(roomId)?.sourceSelection;
    const granted = selection?.browserCaptureGranted;
    return selection?.committing || granted === undefined ? undefined : granted ? "preparing" : "picker";
  };
  cancelScreenSelection = async (roomId: string): Promise<void> => {
    const share = this.stages.get(roomId)?.screen;
    const selection = this.stages.get(roomId)?.sourceSelection;
    if (selection?.committing) return;
    if (selection) this.finishSourceSelection(roomId, selection);
    if (!share || !selection && (!share.microphoneChange?.current() || this.local.has(share.id))) return;
    if (!selection) share.microphoneChange!.requested = undefined;
    // A ready OBS input may be waiting for this independent picker to close.
    if (!selection || this.app?.externalInput(share.id)?.state !== "prepared") await this.app?.cancelCapture(share.id);
    this.patch({});
  };

  startScreen = (roomId: string, source: BrowserCaptureSource = "browser", deviceId = "", reportError: ReportError = true): Promise<void> => this.action(`screen:${roomId}`, async () => {
    if (source === "camera" ? !navigator.mediaDevices?.getUserMedia : !navigator.mediaDevices?.getDisplayMedia) throw new Error("capture_unavailable");
    const { share, selection, current } = this.selectScreen(roomId);
    let context = this.local.get(share.id)?.audio?.outputGainAvailable ? null : HostAudio.activate();
    let candidate: MediaStream | undefined;
    let audio: HostAudio | undefined;
    const releaseCandidate = () => {
      void context?.close().catch(() => {});
      context = null;
      const unownedTracks = audio ? candidate?.getVideoTracks() : candidate?.getTracks();
      audio?.dispose();
      unownedTracks?.forEach(track => track.stop());
      audio = undefined;
      candidate = undefined;
    };
    selection.releaseBrowserCandidate = releaseCandidate;
    try {
      if (source === "browser") { selection.browserCaptureGranted = false; this.patch({}); }
      candidate = await captureBrowserSource(share.profile, source, deviceId, selection.controller.signal);
      if (!current()) throw new DOMException("Capture cancelled", "AbortError");
      const video = candidate.getVideoTracks()[0];
      const metadata = captureSource(video, source === "camera");
      if (!video || video.readyState !== "live") throw new Error("capture_unavailable");
      if (source === "browser") {
        selection.browserCaptureGranted = true;
        this.patch({});
        if (video.muted) await waitForDisplaySurface(video, selection.controller.signal);
      }
      const available = () => video.readyState === "live" && (source !== "browser" || !video.muted);
      let codec = share.codec;
      if (!codec) {
        const complete = debugOperation("capture", "codec-selection", { mode: share.codecMode });
        try {
          codec = share.codecMode === "auto"
            ? automaticVideoCodecPreference(await preferredVideoCodecForTrack(video, selection.controller.signal,
              screenContentHint(share.profile.degradationPreference, metadata.kind === "screen")))
            : manualVideoCodecPreference(share.codecMode);
          complete("selected", { codec });
        } catch (error) {
          complete(selection.controller.signal.aborted ? "cancelled" : "failed", {}, error);
          throw error;
        }
      }
      if (!current()) throw new DOMException("Capture cancelled", "AbortError");
      share.codec = codec;
      const previous = this.local.get(share.id);
      const retainedAudio = previous?.audio?.outputGainAvailable ? previous.audio : undefined;
      if (!retainedAudio) {
        const mixer = new HostAudio(candidate, source, () => {
          if (this.local.get(share.id)?.audio === mixer) this.patch({});
        });
        audio = mixer;
        audio.setVolume(share.volume.muted ? 0 : share.volume.level);
        candidate = audio.start(context);
        context = null;
        if (!audio.outputGainAvailable && audio.sourceAudioAvailable && !share.volume.muted
          && share.volume.level !== 0 && share.volume.level !== 1) throw new Error("source_audio_unavailable");
      }
      if (!current()) throw new DOMException("Capture cancelled", "AbortError");
      if (!available()) throw new Error("capture_unavailable");
      selection.committing = true;
      this.patch({});
      const app = this.app;
      if (previous || app?.hasCapture(share.id)) {
        const sessionId = this.view.sessionId;
        if (!sessionId) throw new Error("disconnected");
        const reportSource = (source = metadata) => this.request({ type: "publish", publication: {
          id: share.id, roomId, kind: "screen", videoSettings: screenVideoSettings(share.profile), source,
        } }, undefined, roomId, { signal: selection.controller.signal });
        if (previous) await this.request({ type: "transfer_source", publicationId: share.id, toSessionId: sessionId }, undefined, roomId, { signal: selection.controller.signal });
        else {
          try { await app!.transferSource(share.id, sessionId); }
          catch (error) {
            // Core may have transferred ownership before the App reply was lost.
            await this.request({ type: "unpublish", publicationId: share.id }, undefined, roomId).catch(() => {});
            throw error;
          }
        }
        if (!current()) {
          this.send({ type: "unpublish", publicationId: share.id });
          throw new DOMException("Capture cancelled", "AbortError");
        }
        if (previous ? !available() : video.readyState !== "live") {
          if (!previous) {
            // The Native transfer already made this Browser the publication owner.
            this.send({ type: "unpublish", publicationId: share.id });
            await this.stopScreen(share.id);
          }
          throw new Error("capture_unavailable");
        }
        if (previous) {
          // The same endpoint keeps its proven paths and old input until the room accepts the new source.
          await reportSource();
          if (!current()) {
            this.send({ type: "unpublish", publicationId: share.id });
            throw new DOMException("Capture cancelled", "AbortError");
          }
          if (!available()) {
            await reportSource(captureSource(previous.stream.getVideoTracks()[0], previous.camera));
            if (!current()) throw new DOMException("Capture cancelled", "AbortError");
            throw new Error("capture_unavailable");
          }
        }
        if (retainedAudio) candidate = retainedAudio.attach(candidate, source);
        else if (audio) candidate = audio.output(share.volume.muted ? 0 : share.volume.level);
        const mixed = retainedAudio ?? audio;
        const paused = share.paused = (previous ? share.paused : undefined)
          ?? this.view.state?.publications.find(publication => publication.id === share.id)?.paused ?? false;
        setMediaPaused(candidate, paused);
        if (mixed) setMediaPaused(mixed.sourceStream, paused);
        this.local.set(share.id, { roomId, kind: "screen", stream: candidate, audio: mixed, camera: source === "camera", admitted: true });
        this.media.setLocal(share.id, candidate, share.profile, codec, paused);
        this.observeScreen(share.id, candidate);
        candidate = undefined;
        audio = undefined;
        if (!retainedAudio) previous?.audio?.dispose();
        previous?.stream.getVideoTracks().forEach(track => track.stop());
        const reporting = !previous ? reportSource() : undefined;
        const stopping = !previous ? app!.stopCapture(share.id) : undefined;
        if (!previous) {
          const remoteControls = new Map(this.view.remoteControls);
          remoteControls.delete(share.id);
          this.patch({ remoteControls });
          this.retireWatch(share.id);
          this.refreshActivity();
        }
        const effects = await Promise.allSettled([reporting, stopping]);
        for (const effect of effects) if (effect.status === "rejected") throw effect.reason;
      } else {
        const stream = candidate;
        candidate = undefined; // publish owns failure cleanup from this point.
        const mixer = audio; audio = undefined;
        await this.publish("screen", roomId, stream, { audio: mixer, profile: share.profile, codec, camera: source === "camera", source: metadata, publicationId: share.id, signal: selection.controller.signal });
      }
      await this.finishScreenSelection(roomId, share.id);
      if (app?.externalInput(share.id)) {
        const stopping = app.stopCapture(share.id);
        this.retireWatch(share.id);
        this.refreshActivity();
        await stopping;
      }
    } finally {
      delete selection.releaseBrowserCandidate;
      releaseCandidate();
      this.finishSourceSelection(roomId, selection);
    }
  }, reportError);
  private retireWatchPlayer(id: string, reason?: string): void { this.watchStage(id)?.retireWatch(id, reason); }
  private async joinWatchAndSyncClock(id: string, player: WatchPlayer, mode: WatchMode): Promise<void> {
    player.mode = mode;
    this.declinedSources.delete(id);
    const start = performance.now();
    await this.request({ type: "join_watch", roomId: player.roomId, id, mode }, event => {
      if (!player.signal.aborted && event.type === "room_reply" && event.result.type === "watch_ready"
        && typeof event.result.serverTime === "number") player.calibrate(event.result.serverTime, start);
    }, player.roomId, { signal: player.signal });
    player.signal.throwIfAborted();
  }
  private hasJoiningWatchCandidate(id: string): boolean {
    const candidate = this.pendingWatchPlayer(id);
    return !!candidate?.mode && candidate !== this.watchPlayer(id);
  }
  resumeWatches = async (): Promise<void> => {
    if (this.view.connection !== "connected") return;
    await Promise.all([...this.watchPlayers()].map(async ([id, player]) => {
      // Once the candidate requests its mode, it owns the subscription until commit or cancellation.
      if (player.mode === null || player.signal.aborted || this.hasJoiningWatchCandidate(id)
        || this.waitingWatchPages.get(id)?.browser && this.view.pending.has(`watch-video:${id}`)) return;
      try {
        await this.joinWatchAndSyncClock(id, player, player.mode);
        if (player.owner && this.watchPlayer(id) === player) await this.reconcileWatchBytes(id, player);
        if (player.owner && this.watchPlayer(id) === player) await player.publish(true);
      }
      catch { /* Session recovery owns disconnection and authority retirement. */ }
    }));
  };
  private makeWatchPlayer(id: string, roomId: string, owner: boolean, media: WatchMedia): WatchPlayer {
    const player = new WatchPlayer(roomId, owner, media, () => this.patch({}), () => {
      if (this.watchPlayer(id) === player)
        void (owner ? this.stopWatchResource(id, "media-closed") : this.leaveWatchResource(id)).catch(() => {});
      else if (this.pendingWatchPlayer(id) === player) this.cancelWatchPage(id);
    });
    return player;
  }
  watchEmbed = (roomId: string): WatchMedia | undefined => this.stages.get(roomId)?.sourceSelection?.embed;
  prepareWatchEmbed = (roomId: string, rawURL: string, reportError = true): Promise<void> => this.action(`screen:${roomId}`, async () => {
    if (!canMoveWatchEmbed()) throw new Error("watch_media_unsupported");
    const embed = watchEmbed(rawURL);
    if (!embed) throw new Error("invalid_watch_url");
    const selection = this.selectSource(roomId);
    selection.embed = embed.provider === "youtube"
      ? new YouTubeMedia(embed.id, youtubeStartSeconds(rawURL)) : new PeerTubeMedia(embed.id);
    this.patch({});
  }, reportError);
  confirmWatchEmbed = (roomId: string, reportError = true): Promise<void> => this.action(`screen:${roomId}`, async () => {
    const selection = this.stages.get(roomId)?.sourceSelection, media = selection?.embed;
    if (!selection || !media) throw new Error("watch_source_unavailable");
    await media.ready(selection.controller.signal);
    await media.patch({ paused: true });
    selection.controller.signal.throwIfAborted();
    await this.commitWatch(roomId, { kind: "website", url: media.sourceURL }, media, selection);
  }, reportError);
  startWatch = (roomId: string, rawURL: string, reportError = true): Promise<void> => this.action(`screen:${roomId}`, async () => {
    const source = this.watchSource(rawURL);
    const selection = this.selectSource(roomId);
    const media = new HTMLVideoMedia(source.url, directWatchFormat(new URL(source.url)));
    await this.commitWatch(roomId, source, media, selection);
  }, reportError);
  private watchSource(rawURL: string): Extract<WatchSource, { kind: "media" }> {
    try { return watchSourceSchema.parse({ kind: "media", url: new URL(rawURL).href }) as Extract<WatchSource, { kind: "media" }>; }
    catch { throw new Error("invalid_watch_url"); }
  }
  prepareWatchPage = (roomId: string, rawURL: string, activityId?: string, reportError = true): Promise<void> => {
    if (activityId) return this.prepareWatchingPage(activityId, reportError);
    return this.action(`screen:${roomId}`, async () => {
      const url = this.watchSource(rawURL).url;
      const stage = this.stage(roomId);
      const selection = stage.selectSource();
      try {
        const app = await this.connectApp(selection.controller.signal);
        selection.controller.signal.throwIfAborted();
        await stage.openPage(selection, app, url);
        this.patch({});
      } catch (error) { stage.finishSelection(selection); throw error; }
    }, reportError);
  };
  watchPage = (roomId: string, activityId?: string): ReturnType<ChannelActions["watchPage"]> => {
    if (activityId) {
      const media = this.pendingWatchPlayer(activityId)?.media, page = media?.page;
      return page instanceof AppPage ? { pageId: page.id, url: page.url, candidates: page.candidates, activityId } : undefined;
    }
    const selection = this.stages.get(roomId)?.sourceSelection, page = selection?.page;
    return page ? { pageId: page.id, url: page.url, candidates: page.candidates, watchSources: selection?.watchSources } : undefined;
  };
  selectWatchPage = async (roomId: string, candidateId: string, activityId?: string, reportError = true, mode?: "choose-source" | "original-page"): Promise<boolean> => {
    if (activityId) { await this.selectWatchingPage(activityId, candidateId, reportError); return true; }
    return this.action(`screen:${roomId}`, async () => {
      const selection = this.stages.get(roomId)?.sourceSelection, page = selection?.page;
      const candidate = page?.candidates.find(value => value.id === candidateId);
      if (!selection || !page || !candidate) throw new Error("watch_page_unavailable");
      selection.discovery?.unsubscribe();
      if (mode === "original-page") {
        await this.commitOriginalPageWatch(roomId, page, selection, candidateId);
        return true;
      }
      if (selection.borrowed) {
        if (selection.pendingCandidateId && selection.pendingCandidateId !== candidateId) await page.stopMedia(selection.pendingCandidateId);
        selection.pendingCandidateId = candidateId;
      } else await page.select(candidateId, false);
      selection.controller.signal.throwIfAborted();
      const selected = page.candidates.find(value => value.id === candidateId);
      if (!selected) throw new Error("watch_page_unavailable");
      // Both opaque players and a failed direct URL retain explicit page-source choices.
      const watchSources: NonNullable<SourceSelection["watchSources"]> = selection.watchSources = { candidateId, choices: [], indexed: [], mpd: [] };
      this.patch({});
      const discover = async () => {
        await waitForWatchMedia({ read: () => page.read(selection.pendingCandidateId), listen: listener => page.listen(listener, selection.pendingCandidateId) }, selection.controller.signal);
        selection.controller.signal.throwIfAborted();
        const discovery = selection.discovery = observeWatchSources(page, selection.controller.signal, sources => {
          Object.assign(watchSources, sources);
          if (!sources.error) delete watchSources.error;
          this.patch({});
        }, selection.pendingCandidateId);
        await discovery.ready;
      };
      if (!selected.url || mode === "choose-source") { await discover(); return false; }
      try {
        await this.commitPortableWatch(roomId, page, selection, selected.url);
        return true;
      } catch (error) {
        if (this.stages.get(roomId)?.sourceSelection !== selection || selection.controller.signal.aborted) throw error;
        await discover();
        throw error;
      }
    }, reportError);
  };
  selectWatchBrowserSource = (roomId: string, choiceId: string | null, reportError = true): Promise<void> => this.action(`screen:${roomId}`, async () => {
    const selection = this.stages.get(roomId)?.sourceSelection, page = selection?.page;
    const watchSources = selection?.watchSources;
    if (!selection || !page || !watchSources || !page.candidates.some(value => value.id === watchSources.candidateId)) throw new Error("watch_page_unavailable");
    selection.controller.signal.throwIfAborted();
    const choice = choiceId === null ? undefined : watchSources.choices.find(value => value.id === choiceId);
    if (choiceId !== null && !choice) throw new Error("watch_page_unavailable");
    if (choice) await this.commitPortableWatch(roomId, page, selection, choice.displayURL, choice.format);
    else await this.commitOriginalPageWatch(roomId, page, selection, watchSources.candidateId);
  }, reportError);
  private async commitOriginalPageWatch(roomId: string, page: AppPage, selection: SourceSelection, candidateId: string): Promise<void> {
    const confirmPage = () => page.select(candidateId, true);
    if (!selection.borrowed) {
      await confirmPage();
      selection.controller.signal.throwIfAborted();
    }
    const url = page.candidatePageURL(candidateId);
    if (!url) throw new Error("watch_page_unavailable");
    const media = new AppPageMedia(page, candidateId, page.hold());
    await this.commitWatch(roomId, { kind: "website", url }, media, selection, undefined, selection.borrowed ? confirmPage : undefined);
  }
  private watchPageSource(page: AppPage, candidateId?: string, mediaUrl?: string): WatchSource {
    const url = page.candidatePageURL(candidateId);
    return { kind: "website", ...(url && { url }), ...(mediaUrl && { mediaUrl }) };
  }
  private async commitPortableWatch(roomId: string, page: AppPage, selection: SourceSelection, url: string, format?: WatchFormat): Promise<void> {
    const source = this.watchPageSource(page, selection.pendingCandidateId, url);
    const media = await preparePortableWatchMedia(page, url, selection.controller.signal, format, selection.pendingCandidateId);
    await this.commitWatch(roomId, source, media, selection);
  }
  selectWatchForwardSource = (roomId: string, choiceId: string, reportError = true): Promise<void> => this.action(`screen:${roomId}`, async () => {
    const selection = this.stages.get(roomId)?.sourceSelection, page = selection?.page;
    const choice = selection?.watchSources?.choices.find(value => value.id === choiceId);
    if (!selection || !page || !choice) throw new Error("watch_page_unavailable");
    const source = await page.prepareMedia(choiceId, selection.controller.signal, selection.pendingCandidateId);
    const mediaUrl = source.format === choice.format ? directForwardMediaURL(choice) : undefined;
    await this.commitPageSuppliedWatch(roomId, page, selection, source, mediaUrl);
  }, reportError);
  selectWatchIndexedSource = (roomId: string, videoId: string, audioId?: string, reportError = true): Promise<void> => this.action(`screen:${roomId}`, async () => {
    const selection = this.stages.get(roomId)?.sourceSelection, page = selection?.page;
    const sources = selection?.watchSources;
    if (!selection || !page || !sources || !page.candidates.some(value => value.id === sources.candidateId)) throw new Error("watch_page_unavailable");
    const video = sources.indexed.find(value => value.candidate.id === videoId)?.inspection;
    const audio = audioId ? sources.indexed.find(value => value.candidate.id === audioId)?.inspection : undefined;
    if (!video || audioId && !audio) throw new Error("watch_indexed_unsupported");
    const byteSource = await page.prepareIndexedMedia(indexedMediaSelection(video, audio), selection.controller.signal, selection.pendingCandidateId);
    await this.commitPageSuppliedWatch(roomId, page, selection, byteSource);
  }, reportError);
  inspectWatchMpdSource = (roomId: string, choiceId: string, signal: AbortSignal, activityId?: string): Promise<NativePageMpdCatalog> => this.action(activityId ? `watch-source:${activityId}` : `screen:${roomId}`, async () => {
    const selection = this.stages.get(roomId)?.sourceSelection, player = activityId ? this.watchPlayer(activityId) : undefined;
    const page = activityId ? player?.owner ? player.media.page : undefined : selection?.page;
    const sources = selection?.watchSources;
    if (!(page instanceof AppPage) || !activityId && !sources?.mpd.some(value => value.candidate.id === choiceId)) throw new Error("watch_page_unavailable");
    const lifetime = AbortSignal.any([signal, ...(!activityId && selection ? [selection.controller.signal] : [])]);
    const catalog = await page.inspectMpd(choiceId, lifetime, selection?.pendingCandidateId);
    lifetime.throwIfAborted();
    if (activityId ? this.watchPlayer(activityId) !== player : this.stages.get(roomId)?.sourceSelection !== selection) throw new DOMException("Cancelled", "AbortError");
    if (!activityId && sources) {
      const choice = sources.mpd.find(value => value.candidate.id === choiceId);
      if (!choice) throw new Error("watch_page_unavailable");
      for (const value of sources.mpd) { delete value.catalog; delete value.error; }
      choice.catalog = catalog; this.patch({});
    }
    return catalog;
  }, false);
  selectWatchMpdSource = (roomId: string, selected: NativePageMpdSelection, reportError = true): Promise<void> => this.action(`screen:${roomId}`, async () => {
    const selection = this.stages.get(roomId)?.sourceSelection, page = selection?.page;
    if (!selection || !page || !selection.watchSources?.mpd.some(choice => choice.catalog?.sourceId === selected.sourceId)) throw new Error("watch_page_unavailable");
    const byteSource = await page.prepareMpdMedia(selected, selection.controller.signal, selection.pendingCandidateId);
    await this.commitPageSuppliedWatch(roomId, page, selection, byteSource);
  }, reportError);
  private async commitPageSuppliedWatch(roomId: string, page: AppPage, selection: SourceSelection, byteSource: WatchByteSource, mediaUrl?: string): Promise<void> {
    const candidateId = selection.pendingCandidateId;
    const source = this.watchPageSource(page, candidateId, mediaUrl);
    const media = await preparePageSuppliedWatchMedia(page, byteSource, selection.controller.signal, candidateId);
    const confirmPage = candidateId ? async () => {
      await page.select(candidateId, false, byteSource.resourceId);
      delete selection.pendingCandidateId;
      await page.patch({ paused: true });
    } : undefined;
    await this.commitWatch(roomId, source, media, selection, byteSource, confirmPage);
  }
  focusWatch = async (id: string): Promise<void> => {
    const media = this.watchPlayer(id)?.media;
    await media?.page?.focus();
  };
  focusWatchPage = async (roomId: string, activityId?: string): Promise<void> => {
    if (activityId) await (this.pendingWatchPlayer(activityId)?.media.page?.focus() ?? this.focusWatch(activityId));
    else await this.stages.get(roomId)?.sourceSelection?.page?.focus();
  };
  watchMediaChoices = (id: string, signal: AbortSignal, onChange?: (sources: WatchMediaSources) => void): Promise<WatchMediaSources> => this.action(`watch-source:${id}`, async () => {
    const player = this.watchPlayer(id), media = player?.media;
    if (!player?.owner || !(media?.page instanceof AppPage) || media.retainedByteSource) throw new Error("watch_page_unavailable");
    return observeWatchSources(media.page, signal, sources => {
      if (this.watchPlayer(id) === player) onChange?.(sources);
    }).ready;
  }, false);
  private async reconcileWatchBytes(id: string, player: WatchPlayer): Promise<void> {
    const declaredSource = () => this.view.state?.watchActivities.find(activity => activity.id === id)?.byteSource;
    const declared = declaredSource(), page = player.media.page, socket = this.socket;
    if (!declared || !(page instanceof AppPage)) return;
    const key = `watch-source:${id}`;
    const current = () => this.socket === socket && this.watchPlayer(id) === player && sameWatchByteSource(declared, declaredSource());
    let actual: WatchByteSource | null;
    while (true) {
      actual = page.selectedCandidateId ? (await page.mediaSources()).byteSource : null;
      if (!current() || sameWatchByteSource(declared, actual)) return;
      if (!this.view.pending.has(key)) break;
      await this.waitForState(() => !current() || !this.view.pending.has(key));
      if (!current()) return;
    }
    await this.action(key, async () => {
      await this.request({ type: "set_watch_byte_source", roomId: player.roomId, id, byteSource: null },
        undefined, player.roomId, { signal: player.signal });
      if (actual && this.watchPlayer(id) === player && !player.media.retainedByteSource) await page.stopMedia();
    }, false);
  }
  setWatchByteSource = (id: string, choiceId: string | NativePageIndexedSelection | NativePageMpdSelection | null, signal = new AbortController().signal): Promise<void> => this.action(`watch-source:${id}`, async () => {
    const player = this.watchPlayer(id), media = player?.media;
    if (player?.owner && media?.retainedByteSource) {
      signal.throwIfAborted();
      if (choiceId !== null && choiceId !== media.retainedByteSource.resourceId) throw new Error("watch_page_unavailable");
      // Remote forwarding can stop without revoking the Host's still-used local reader.
      await this.request({ type: "set_watch_byte_source", roomId: player.roomId, id, byteSource: choiceId === null ? null : media.retainedByteSource }, undefined, player.roomId);
      return;
    }
    if (!player?.owner || !(media?.page instanceof AppPage)) throw new Error("watch_page_unavailable");
    const page = media.page;
    if (choiceId === null) {
      try { await this.request({ type: "set_watch_byte_source", roomId: player.roomId, id, byteSource: null }, undefined, player.roomId); }
      finally { await page.stopMedia(); }
      return;
    }
    if (this.view.state?.watchActivities.find(activity => activity.id === id)?.byteSource) throw new Error("watch_source_already_active");
    let byteSource: WatchByteSource;
    try {
      byteSource = typeof choiceId === "string" ? await page.prepareMedia(choiceId, signal) : "sourceId" in choiceId ? await page.prepareMpdMedia(choiceId, signal) : await page.prepareIndexedMedia(choiceId, signal);
      signal.throwIfAborted();
      if (this.watchPlayer(id) !== player) throw new DOMException("Cancelled", "AbortError");
      await this.request({ type: "set_watch_byte_source", roomId: player.roomId, id, byteSource }, undefined, player.roomId);
    } catch (error) {
      await page.stopMedia().catch(() => {});
      try { await this.request({ type: "set_watch_byte_source", roomId: player.roomId, id, byteSource: null }, undefined, player.roomId); }
      catch { /* The next welcome reconciles the actual reader with room authority. */ }
      throw error;
    }
  }, false);
  private retirePendingWatchPlayer(id: string): WatchPlayer | undefined { return this.watchStage(id)?.retireCandidate(id); }
  cancelWatchPage = (id: string): void => {
    if (this.watchPlayer(id) === this.pendingWatchPlayer(id)) return;
    const candidate = this.retirePendingWatchPlayer(id);
    if (!candidate?.mode || this.view.connection !== "connected") return;
    const mode = this.watchPlayer(id)?.mode ?? null;
    void this.request({ type: "join_watch", roomId: candidate.roomId, id, mode }).catch(() => {});
  };
  watchEmbedPreparation = (id: string): WatchMedia | undefined => {
    const candidate = this.pendingWatchPlayer(id);
    return candidate?.presentation.kind === "embed" ? candidate.media : undefined;
  };
  private prepareWatchingPage(id: string, reportError: boolean): Promise<void> {
    return this.action(`watch-video:${id}`, async () => {
      const activity = this.view.state?.watchActivities.find(value => value.id === id);
      if (!activity || activity.source.kind !== "website" || activity.sessionId === this.view.sessionId) throw new Error("watch_unavailable");
      if (activity.playback.timeline === "program") throw new Error("watch_live_timeline_unsupported");
      const url = originalWatchURL(activity.source);
      if (!url) throw new Error("watch_page_unavailable");
      const media = new AppPageMedia(async signal => {
        const app = await this.connectApp(signal);
        signal.throwIfAborted();
        return app.preparePage(url, () => this.patch({}), signal);
      });
      this.cancelWatchPage(id);
      const player = this.makeWatchPlayer(id, activity.roomId, false, media);
      this.stage(player.roomId).prepareWatch(id, player);
      this.patch({});
      try {
        await media.opening;
        if (this.pendingWatchPlayer(id) !== player) throw new DOMException("Cancelled", "AbortError");
        this.patch({});
      } catch (error) { if (this.pendingWatchPlayer(id) === player) this.cancelWatchPage(id); throw error; }
    }, reportError);
  }
  private selectWatchingPage(id: string, candidateId: string, reportError: boolean): Promise<void> {
    return this.action(`watch-video:${id}`, async () => {
      const player = this.pendingWatchPlayer(id), media = player?.media;
      const page = media?.page;
      if (!player || !(page instanceof AppPage) || !page.candidates.some(value => value.id === candidateId)) throw new Error("watch_page_unavailable");
      try {
        await page.select(candidateId, true);
        await player.ready();
        await this.joinWatchAndSyncClock(id, player, "direct");
        const activity = this.view.state?.watchActivities.find(activity => activity.id === id);
        if (!activity || this.pendingWatchPlayer(id) !== player) throw new DOMException("Cancelled", "AbortError");
        this.waitingWatchPages.delete(id);
        this.stage(player.roomId).confirmWatch(id, player);
        player.update(activity.playback);
        const state = this.view.state;
        this.patch(state && this.roomSnapshot
          ? { state: { ...state, ...this.projectWatches(this.roomSnapshot) } } : {});
        this.browseRooms();
      } catch (error) {
        if (this.pendingWatchPlayer(id) === player) this.cancelWatchPage(id);
        throw error;
      }
    }, reportError);
  }
  private async commitWatch(roomId: string, source: WatchSource, media: WatchMedia, selection: SourceSelection, byteSource?: WatchByteSource, confirmPage?: () => Promise<void>): Promise<void> {
    const current = () => this.stages.get(roomId)?.sourceSelection === selection;
    const id = crypto.randomUUID();
    const player = this.makeWatchPlayer(id, roomId, true, media);
    selection.watchCandidate = player;
    let committed = false;
    let startSocket: WebSocket | null = null;
    try {
      await player.ready(selection.controller.signal);
      const initial = await media.read();
      if (!current()) throw new DOMException("Cancelled", "AbortError");
      this.stage(player.roomId).useWatch(id, player);
      selection.committing = true;
      this.patch({});
      const start = performance.now();
      startSocket = this.socket;
      const replaceId = this.ownedReplacementWatchId(selection);
      await this.request({ type: "start_watch", roomId, id, source, ...(replaceId ? { replaceId } : {}), ...(byteSource ? { byteSource } : {}),
        playback: { timeline: initial.live ? "program" : "media", position: initial.position, paused: true, rate: initial.rate, anchorTime: 0 } }, event => {
        if (event.type === "room_reply" && event.result.type === "watch_ready" && typeof event.result.serverTime === "number")
          player.calibrate(event.result.serverTime, start);
      }, roomId);
      if (!current() || this.watchPlayer(id) !== player) throw new DOMException("Cancelled", "AbortError");
      const screen = this.stages.get(roomId)?.screen;
      if (screen && screen.id === selection.replaceScreenId && (this.local.has(screen.id) || this.app?.screens.has(screen.id))) {
        await this.stopScreen(screen.id, id);
      }
      let sourceUnavailable = false;
      try {
        await confirmPage?.();
      } catch (error) {
        if (!current() || this.watchPlayer(id) !== player || player.signal.aborted)
          throw new DOMException("Cancelled", "AbortError");
        const code = error instanceof Error ? error.message : "";
        if (!replaceId || !selection.borrowed || !(media instanceof AppPageMedia) || this.socket !== startSocket
          || (code !== "page_candidate_unavailable" && code !== "watch_source_unavailable" && player.error !== "watch_source_unavailable")) throw error;
        // The Room already committed this paused activity. Keep the page for another selection.
        player.sourceUnavailable({ ...initial, paused: true });
        sourceUnavailable = true;
      }
      if (!current() || this.watchPlayer(id) !== player) throw new DOMException("Cancelled", "AbortError");
      committed = true;
      player.mode = "direct";
      if (media instanceof PageSuppliedMedia) void media.page.hide().catch(() => {});
      this.activateWatchOwner(id, player);
      this.patch({});
      if (sourceUnavailable) {
        this.browseRooms();
        throw new Error("watch_source_unavailable");
      }
      if (media.presentation?.kind === "video") await player.play();
      else await player.publish(true);
      this.browseRooms();
      try { await media.waitForPresentation?.(selection.controller.signal); }
      catch {
        if (this.watchPlayer(id) === player) {
          player.error = "watch_media_failed";
          this.patch({});
        }
      }
    } finally {
      if (!committed) {
        if (this.watchPlayer(id) === player) this.retireWatchPlayer(id, "start-cancelled");
        else player.close();
        // Once submitted, this selection owns rollback. A replacement socket
        // reconciles orphaned activities from Welcome.
        if (!player.stopRequested && startSocket && this.socket === startSocket) this.send({ type: "stop_watch", roomId, id });
      }
      this.finishSourceSelection(roomId, selection);
    }
  }
  joinWatch = (id: string, mode: WatchMode = "direct", reportError: ReportError = true): Promise<void> => this.action(`watch-video:${id}`, async () => {
    const current = this.watchPlayer(id);
    if (current?.mode === mode && !current.error && current.presentation.kind !== "external") return;
    const activity = this.view.state?.watchActivities.find(value => value.id === id);
    if (!activity) throw new Error("watch_unavailable");
    if (mode === "peer") {
      const source = activity.byteSource;
      if (!source) throw new Error("watch_source_unavailable");
      await this.joinWatchMedia(id, createResourceWatchMedia(source, (resourceId, offset, length, signal) =>
        this.watchBytes.read(activity.roomId, id, source, resourceId, offset, length, signal),
      { hlsDeadlineOwner: "reader", timeline: activity.playback.timeline }), mode);
      return;
    }
    const url = activity.source.kind === "media" ? activity.source.url : activity.source.mediaUrl;
    if (url) {
      await this.joinWatchMedia(id, new HTMLVideoMedia(url, activity.source.kind === "media" ? directWatchFormat(new URL(url)) : undefined, activity.playback.timeline));
      return;
    }
    const embed = sharedWatchEmbed(activity.source);
    if (!embed) throw new Error(originalWatchURL(activity.source) ? "watch_page_required" : "watch_source_unavailable");
    if (!canWatchInBrowser(activity.source, current)) throw new Error("watch_media_unsupported");
    await this.joinWatchMedia(id, embed.provider === "youtube"
      ? new YouTubeMedia(embed.id, undefined, true) : new PeerTubeMedia(embed.id, true));
  }, reportError);
  private async joinWatchMedia(id: string, media: WatchMedia, mode: WatchMode = "direct"): Promise<void> {
    const activity = this.view.state?.watchActivities.find(value => value.id === id);
    if (!activity) { media.close(); throw new Error("watch_unavailable"); }
    const previous = this.watchPlayer(id);
    const player = this.makeWatchPlayer(id, activity.roomId, false, media);
    player.inheritListening(previous);
    if (previous?.presentation.kind === "external" && previous.mode === mode) {
      const embedded = player.presentation.kind === "embed";
      if (embedded) {
        this.stage(player.roomId).prepareWatch(id, player);
        this.patch({});
      }
      try {
        await player.ready(AbortSignal.any([previous.signal, player.signal]));
        previous.signal.throwIfAborted();
        player.signal.throwIfAborted();
        const current = this.view.state?.watchActivities.find(value => value.id === id);
        if (!current) throw new Error("watch_unavailable");
        player.mode = mode;
        player.inheritClock(previous);
        this.stage(player.roomId).useWatch(id, player);
        player.update(current.playback);
        this.patch({});
        if (embedded) {
          await media.waitForPresentation?.(player.signal).catch(() => {});
          if (this.pendingWatchPlayer(id) === player) {
            this.stage(player.roomId).finishWatchPreparation(id, player);
            this.patch({});
          }
        }
      } catch (error) {
        if (embedded && this.pendingWatchPlayer(id) === player) this.retirePendingWatchPlayer(id);
        else player.close();
        throw error;
      }
      return;
    }
    this.stage(player.roomId).useWatch(id, player);
    player.update(activity.playback);
    this.patch({});
    void player.ready().catch(error => {
      if (!player.signal.aborted && this.watchPlayer(id) === player) {
        player.error = error instanceof Error ? error.message : "watch_media_failed";
        this.patch({});
      }
    });
    try {
      await this.joinWatchAndSyncClock(id, player, mode);
      if (!this.waitingWatchPages.get(id)?.browser && this.waitingWatchPages.delete(id)) this.patch({});
      this.browseRooms();
    }
    catch (error) {
      if (!player.signal.aborted && this.watchPlayer(id) === player) this.retireWatchPlayer(id);
      this.patch({}); throw error;
    }
  }
  leaveWatch = (id: string, reportError: ReportError = true): Promise<void> =>
    this.action(`watch:${id}`, () => this.leaveWatchResource(id), reportError);
  private async leaveWatchResource(id: string): Promise<void> {
    const candidate = this.retirePendingWatchPlayer(id);
    const player = this.watchPlayer(id);
    const waiting = this.waitingWatchPages.get(id);
    if (player?.owner || (!waiting && !player && !candidate?.mode)) return;
    this.waitingWatchPages.delete(id);
    const roomId = player?.roomId ?? waiting?.roomId ?? candidate!.roomId;
    this.declinedSources.set(id, roomId);
    if (waiting) this.declinedSources.set(waiting.predecessor.id, roomId);
    this.retireWatchPlayer(id);
    this.refreshActivity();
    this.browseRooms();
    if (this.view.connection === "connected") {
      const predecessor = waiting?.predecessor;
      // The room may already have moved this handoff to a later successor this page has not seen.
      if (predecessor && !this.roomSnapshot?.watchSubscriptions.some(sub => sub.id === id)) {
        if (predecessor.kind === "watch") this.write({ type: "join_watch", roomId, id: predecessor.id, mode: null });
        else this.write({ type: "subscribe", publicationId: predecessor.id, enabled: false });
      }
      await this.request({ type: "join_watch", roomId, id, mode: null }, undefined, roomId);
    }
  }
  /** Tells the room this page will not follow a successor it named, so the room stops naming it. */
  private declineSuccessor(roomId: string, source: { kind: "watch" | "screen"; id: string }): void {
    if (this.declinedSources.has(source.id)) return;
    this.declinedSources.set(source.id, roomId);
    void this.request(source.kind === "watch" ? { type: "join_watch", roomId, id: source.id, mode: null }
      : { type: "subscribe", publicationId: source.id, enabled: false }, undefined, roomId).catch(() => {});
  }
  stopWatch = (id: string, reportError: ReportError = true): Promise<void> =>
    this.action(`stop:${id}`, () => this.stopWatchResource(id, "stop-requested"), reportError);
  private async stopWatchResource(id: string, reason: "stop-requested" | "provider-session-ended" | "media-closed" | "screen-replacement"): Promise<void> {
    const player = this.watchPlayer(id);
    if (!player?.owner) {
      if (player || reason !== "stop-requested" || this.view.connection !== "connected") return;
      const activity = this.roomSnapshot?.watchActivities.find(value => value.id === id && value.sessionId === this.view.sessionId);
      if (activity) await this.request({ type: "stop_watch", roomId: activity.roomId, id }, undefined, activity.roomId);
      return;
    }
    if (this.view.connection === "connected") player.stopRequested = true;
    this.retireWatchPlayer(id, reason);
    this.refreshActivity();
    this.browseRooms();
    if (this.view.connection === "connected") await this.request({ type: "stop_watch", roomId: player.roomId, id }, undefined, player.roomId);
  }
  private async finishScreenSelection(roomId: string, screenId: string): Promise<void> {
    const selection = this.stages.get(roomId)?.sourceSelection;
    const watchId = this.ownedReplacementWatchId(selection);
    if (watchId) {
      const local = this.local.get(screenId);
      const captureId = this.app?.captureId(screenId);
      try {
        await this.request({ type: "stop_watch", roomId, id: watchId, successorScreenId: screenId }, undefined, roomId);
      } catch (error) {
        if (this.stages.get(roomId)?.sourceSelection === selection && (local ? this.local.get(screenId) === local
          : captureId && this.app?.captureId(screenId) === captureId)) await this.stopScreen(screenId);
        throw error;
      }
      this.retireWatchPlayer(watchId, "screen-replacement");
      this.refreshActivity();
    }
  }

  private async previewCommittedCapture(roomId: string, id: string, current: () => boolean, signal: AbortSignal): Promise<void> {
    // Room confirmation replaces the shared video even if the local preview fails.
    const retirement = this.finishScreenSelection(roomId, id);
    const preview = this.watching.has(id) ? undefined : this.watch(id, roomId, signal);
    const results = await Promise.allSettled([retirement, preview]);
    if (!current()) throw new DOMException("Capture stopped", "AbortError");
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
  setWatchPlayback = (id: string, patch: Partial<Pick<WatchPlayback, "paused" | "position" | "rate">>): Promise<void> => {
    const player = this.watchPlayer(id);
    if (!player?.owner) return Promise.reject(new Error("not_watch_owner"));
    return player.serialize(async () => {
      if (this.watchPlayer(id) !== player) return;
      await player.editPlayback(patch);
    });
  };
  private activateWatchOwner(id: string, player: WatchPlayer): void {
    const page = player.media.page;
    if (page instanceof AppPage) {
      page.onSharePicker = () => {
        const activity = this.view.state?.watchActivities.find(value => value.id === id && value.sessionId === this.view.sessionId);
        if (!activity || this.watchPlayer(id) !== player || !player.owner || player.signal.aborted
          || this.stages.get(player.roomId)?.sourceSelection) return;
        this.stage(player.roomId).selectSource(page);
        this.patch({});
        window.dispatchEvent(new CustomEvent("piik-watch-source-picker", { detail: player.roomId }));
      };
      const reconcile = () => {
        if (this.watchPlayer(id) === player && this.view.connection === "connected")
          void this.reconcileWatchBytes(id, player).catch(() => {});
      };
      const release = page.listenMediaSources(reconcile);
      let previous: WatchByteSource | undefined;
      const publicationChanged = () => {
        const declared = this.view.state?.watchActivities.find(activity => activity.id === id)?.byteSource;
        if (previous === declared || (previous && sameWatchByteSource(previous, declared))) return;
        previous = declared;
        if (declared) reconcile();
      };
      const unsubscribe = this.subscribe(publicationChanged);
      player.signal.addEventListener("abort", () => { release(); unsubscribe(); }, { once: true });
      publicationChanged();
    }
    player.activate(async playback => {
      if (this.watchPlayer(id) === player && this.view.connection === "connected")
        await this.request({ type: "update_watch", roomId: player.roomId, id, playback }, undefined, player.roomId);
    });
  }
  resumeWatch = async (id: string): Promise<void> => {
    const player = this.watchPlayer(id);
    if (!player) return;
    const media = player.media;
    if (!player.owner || !player.error || !(media instanceof PageSuppliedMedia)) return player.resume();
    await this.action(`watch-video:${id}`, async () => {
      let next: WatchPlayer | undefined;
      try {
        const source = this.view.state?.watchActivities.find(value => value.id === id);
        if (!source) throw new Error("watch_unavailable");
        const replacement = media.retryCandidate(source.playback.timeline);
        next = this.makeWatchPlayer(id, player.roomId, true, replacement);
        await next.ready(player.signal);
        const activity = this.view.state?.watchActivities.find(value => value.id === id);
        if (!activity) throw new Error("watch_unavailable");
        next.inheritClock(player);
        next.inheritListening(player);
        await next.restorePlayback(activity.playback);
        player.signal.throwIfAborted();
        if (this.watchPlayer(id) !== player) throw new DOMException("Cancelled", "AbortError");
        media.transferPageTo(replacement);
        next.mode = player.mode;
        this.stage(next.roomId).useWatch(id, next);
        this.activateWatchOwner(id, next);
      } catch (error) {
        next?.close();
        if (this.watchPlayer(id) === player && !player.signal.aborted
          && !(error instanceof DOMException && error.name === "AbortError"))
          player.error = error instanceof Error ? error.message : "watch_media_failed";
        throw error;
      }
    }, false);
  };
  cameraPreviews = (signal: AbortSignal, publish: (sources: CameraPreview[]) => void): Promise<void> =>
    loadCameraPreviews(signal, publish, [...this.local.values()].find(capture => capture.camera
      && capture.stream.getVideoTracks().some(track => track.readyState === "live"))?.stream);
  nativeSources = async (signal?: AbortSignal): Promise<NativeCaptureSources> => {
    signal?.throwIfAborted();
    const app = await this.connectApp(signal);
    const sources = await app.sources(signal);
    if (this.app !== app || !app.connected || this.closed) throw new Error("app_context_changed");
    if (this.view.encodingExecution === "software" && !sources.softwareEncodingCodecs.length)
      this.patch({ encodingExecution: "auto" });
    return sources;
  };
  externalInput = (roomId: string) => {
    const share = this.stages.get(roomId)?.screen;
    const input = share && this.app?.externalInput(share.id);
    return input && { ...input, publicationId: share!.id };
  };
  cancelExternalScreen = (roomId: string): Promise<void> => {
    if (this.sourceSelectionCommitting(roomId)) return Promise.resolve();
    const share = this.stages.get(roomId)?.screen, app = this.app;
    const candidate = share && app?.externalInput(share.id);
    if (!share || !app || !candidate || candidate.state === "live") return Promise.resolve();
    return this.action(`stop:${share.id}`, async () => {
      await app.cancelExternalInput(share.id);
      this.forgetInactiveScreen(share.id);
      this.patch({});
    });
  };
  startExternalScreen = (roomId: string, reportError: ReportError = true): Promise<void> => this.action(`screen:${roomId}`, async () => {
    const { share, selection, current } = this.selectScreen(roomId);
    try {
      const app = await this.connectApp(selection.controller.signal);
      if (!current()) throw new DOMException("Input cancelled", "AbortError");
      await app.prepareExternalInput(share.id, roomId);
      if (!current()) throw new DOMException("Input cancelled", "AbortError");
      this.patch({});
    } finally { this.finishSourceSelection(roomId, selection); }
  }, reportError);
  private async commitExternalScreen(app: ChannelApp, event: Extract<NativeExternalInputState, { state: "prepared" | "live" }>): Promise<void> {
    const entry = [...this.screenShares()].find(([, share]) => share.id === event.publicationId);
    if (!entry) return;
    const [roomId, share] = entry;
    const input = app.externalInput(share.id);
    const prepared = () => this.app === app && this.stages.get(roomId)?.screen === share
      && app.externalInput(share.id) === input && input?.state === "prepared" && input.captureId === event.captureId
      && this.view.state?.channel.rooms.some(room => room.id === roomId && room.authorized && room.available);
    const busy = () => this.stages.get(roomId)?.sourceSelection || this.view.pending.has(`screen:${roomId}`);
    while (prepared() && busy()) {
      await new Promise<void>(resolve => {
        const unsubscribe = this.subscribe(() => {
          if (prepared() && busy()) return;
          unsubscribe();
          resolve();
        });
      });
    }
    if (!prepared()) return;
    return this.action(`screen:${roomId}`, async () => {
      const selection = this.selectSource(roomId);
      selection.committing = true;
      this.patch({});
      const current = () => this.app === app && this.stages.get(roomId)?.screen === share
        && this.stages.get(roomId)?.sourceSelection === selection
        && app.externalInput(share.id)?.captureId === event.captureId;
      try {
        try {
          if (this.local.has(share.id)) await this.request({ type: "transfer_source", publicationId: share.id, toSessionId: event.sessionId }, undefined, roomId);
          if (!current()) throw new DOMException("Input cancelled", "AbortError");
          await app.commitCapture(share.id, event.captureId);
        } catch (error) {
          if (current()) await app.cancelCapture(share.id).catch(() => {});
          throw error;
        }
        if (!current()) return;
        share.native = undefined;
        share.paused = undefined;
        share.codec = automaticVideoCodecPreference(event.codec);
        this.retireCapture(share.id);
        const remoteControls = new Map(this.view.remoteControls);
        remoteControls.delete(share.id);
        this.patch({ remoteControls });
        await this.previewCommittedCapture(roomId, share.id, current, selection.controller.signal);
      } finally { this.finishSourceSelection(roomId, selection); }
    });
  }
  nativePreview = (target: NativeCaptureTarget, signal?: AbortSignal): Promise<string | null> =>
    this.app?.preview(target, signal) ?? Promise.resolve(null);
  nativeCaptureRequest = (roomId: string) => this.app?.captureRequest(roomId);
  nativeCaptureSelection = (roomId: string) => {
    const share = this.stages.get(roomId)?.screen;
    return share?.native && { ...share.native, current: !this.local.has(share.id) && !!this.app?.screens.has(share.id) };
  };

  sourceMicrophone = (publicationId: string) => {
    const share = this.screenStage(publicationId)?.screen;
    if (!share) return undefined;
    const local = this.local.get(publicationId);
    const browser = local?.kind === "screen";
    const actual = browser ? { ...share.microphone, enabled: !!local.audio?.microphoneEnabled }
      : this.app?.sourceMicrophone(publicationId) ?? { enabled: false, deviceId: "", volume: 1 };
    return { ...actual, browser, canDisable: browser ? !!local.audio : !!this.app?.hasSourceAudioControl(publicationId),
      available: browser ? !!local.audio?.commentaryAvailable : !!this.app?.hasSourceAudioControl(publicationId),
      requested: share.microphoneChange?.current() ? share.microphoneChange.requested?.settings ?? actual : actual };
  };

  sourceMicrophones = (publicationId: string, signal?: AbortSignal) => this.local.get(publicationId)?.kind === "screen"
    ? browserCaptureDevices("audioinput") : this.app?.hasSourceAudioControl(publicationId) ? this.app.sourceMicrophones(signal) : Promise.resolve([]);

  setSourceMicrophone = (publicationId: string, settings: SourceMicrophoneSettings): Promise<void> => {
    const owner = [...this.screenShares()].find(([, share]) => share.id === publicationId);
    const share = owner?.[1];
    const actual = this.sourceMicrophone(publicationId);
    const local = this.local.get(publicationId), app = this.app;
    const stopping = settings.enabled === false && actual?.canDisable;
    if (!share || this.stages.get(owner![0])?.sourceSelection && !stopping || !actual?.available) return Promise.reject(new Error("microphone_unavailable"));
    const running = share.microphoneChange?.current() ? share.microphoneChange : undefined;
    if (running && !running.requested && !stopping) return running.promise;
    const next = { ...actual.requested, ...settings };
    if (!Number.isFinite(next.volume) || next.volume < 0 || next.volume > 2) return Promise.reject(new Error("invalid_audio_settings"));
    type Edit = NonNullable<ScreenShare["microphoneChange"]>;
    const request: NonNullable<Edit["requested"]> = { settings: next };
    const applyNative = ({ enabled, deviceId, volume }: SourceMicrophoneConfiguration) =>
      app!.setSourceMicrophone(publicationId, owner![0], { enabled, deviceId, volume });
    if (running) {
      running.requested = request;
      if (stopping && local?.audio) void local.audio.setMicrophone(false, share.microphone);
      else if (stopping && app) {
        // Start immediately to cancel Native preparation. The loop awaits this same request.
        request.started = applyNative(next);
        void request.started.catch(() => {});
      }
      this.patch({});
      return running.promise;
    }
    const captureId = app?.captureId(publicationId);
    if (!local && !captureId) return Promise.reject(new Error("microphone_unavailable"));
    const current = (): boolean => share.microphoneChange === edit && this.stages.get(owner![0])?.screen === share
      && (local ? this.local.get(publicationId) === local : this.app === app && app?.captureId(publicationId) === captureId);
    let settle!: (work: Promise<void>) => void;
    const promise = new Promise<void>(resolve => { settle = resolve; });
    const edit: Edit = share.microphoneChange = { current, requested: request, promise };
    const failed = this.beginActionFeedback();
    const apply = async () => {
      try {
        while (current()) {
          const requested = edit.requested;
          if (!requested) throw new DOMException("Capture cancelled", "AbortError");
          const wanted = requested.settings;
          try {
            if (local?.kind === "screen" && local.audio) {
              const input = { deviceId: wanted.deviceId, volume: wanted.volume,
                voiceProcessing: wanted.voiceProcessing ?? share.microphone.voiceProcessing };
              if (wanted.enabled !== local.audio.microphoneEnabled || wanted.enabled && (input.deviceId !== share.microphone.deviceId
                || input.voiceProcessing !== share.microphone.voiceProcessing)) await local.audio.setMicrophone(wanted.enabled, input);
              else {
                local.audio.microphoneVolume(input.volume);
                await Promise.resolve(); // Gain edits share the same latest-wanted operation.
              }
              if (!current()) throw new DOMException("Capture cancelled", "AbortError");
              share.microphone = input;
            } else {
              await (requested.started ?? applyNative(wanted));
              if (!current()) throw new DOMException("Capture cancelled", "AbortError");
            }
          } catch (error) {
            if (!current()) throw new DOMException("Capture cancelled", "AbortError");
            if (edit.requested && requested !== edit.requested) continue;
            throw error;
          }
          if (requested === edit.requested) return;
          this.patch({});
        }
        throw new DOMException("Capture cancelled", "AbortError");
      } catch (error) {
        failed(error);
        throw error;
      } finally {
        if (share.microphoneChange === edit) share.microphoneChange = undefined;
        this.patch({});
      }
    };
    settle(apply());
    return promise;
  };

  screenEncodingExecution = (publicationId: string) => this.screenStage(publicationId)?.screen?.encodingExecution;

  screenCodec = (publicationId: string) => {
    const share = this.screenStage(publicationId)?.screen;
    return share && { mode: share.codecMode, primary: share.codec?.primary };
  };

  screenQuality = (publicationId: string) => this.screenStage(publicationId)?.screenQuality;
  setScreenQuality = (publicationId: string, profile: QualityProfile): Promise<void> =>
    this.screenStage(publicationId)?.setScreenQuality(profile) ?? Promise.reject(new Error("capture_unavailable"));

  sourceAudio = (publicationId: string) => {
    const share = this.screenStage(publicationId)?.screen;
    if (!share) return undefined;
    const local = this.local.get(publicationId);
    const canMute = !!local?.audio?.outputGainAvailable || !!this.app?.hasSourceAudioControl(publicationId);
    if (!local && !canMute) return undefined;
    const sourceAudioAvailable = local ? !!local.audio?.sourceAudioAvailable : !!this.app?.hasSourceAudio(publicationId);
    const hasAudio = local ? !!local.audio?.audioAvailable : sourceAudioAvailable || !!this.app?.sourceMicrophone(publicationId)?.enabled;
    return { ...share.volume, bitrate: share.profile.maxAudioBitrate ?? 128_000,
      sourceAudioAvailable, hasAudio, available: hasAudio && (!local || !!local.audio?.outputGainAvailable), canMute };
  };

  setSourceAudio = (publicationId: string, settings: { bitrate?: number; level?: number; muted?: boolean }): Promise<void> => {
    const stage = this.screenStage(publicationId), share = stage?.screen;
    const local = this.local.get(publicationId);
    const stopping = settings.bitrate === undefined && (settings.muted === true || settings.level === 0) && !!local?.audio?.outputGainAvailable;
    const native = this.app?.hasSourceAudioControl(publicationId);
    if (!share || (stage.sourceSelection || stage.qualityPending) && !(settings.bitrate === undefined && (stopping || native)))
      return Promise.reject(new Error("capture_unavailable"));
    const volume = { level: settings.level ?? share.volume.level, muted: settings.muted ?? share.volume.muted };
    const profile = { ...share.profile, maxAudioBitrate: settings.bitrate ?? share.profile.maxAudioBitrate ?? 128_000 };
    if (!supportsCaptureProfile(profile) || !Number.isFinite(volume.level) || volume.level < 0 || volume.level > 2) return Promise.reject(new Error("invalid_audio_settings"));
    let appliedVolume = share.volume, appliedProfile = share.profile;
    share.profile = profile; share.volume = volume;
    if (stopping) local!.audio!.setVolume(0);
    this.patch({});
    if (share.audioChange) return share.audioChange;
    const current = () => stage.screen === share;
    share.audioChange = this.action(`source-audio:${publicationId}`, async () => {
      try {
        do {
          const volume = share.volume, profile = share.profile;
          const local = this.local.get(publicationId);
          try {
            if (local) {
              const gain = volume.muted ? 0 : volume.level;
              if (local.audio?.outputGainAvailable) local.audio.setVolume(gain);
              else if (gain !== (appliedVolume.muted ? 0 : appliedVolume.level)) throw new Error("source_audio_unavailable");
              appliedVolume = volume;
              await this.media.configureLocalAudio(publicationId, profile.maxAudioBitrate!);
              if (!current() || this.local.get(publicationId) !== local) throw new DOMException("Capture cancelled", "AbortError");
              appliedProfile = profile;
            }
            const app = this.app;
            if (app?.hasSourceAudioControl(publicationId)) {
              await app.setSourceAudio(publicationId, profile.maxAudioBitrate!, volume.muted ? 0 : volume.level);
              if (this.app !== app) throw new DOMException("Capture cancelled", "AbortError");
            } else if (!local) throw new Error("capture_unavailable");
          } catch (error) {
            if (!current()) throw new DOMException("Capture cancelled", "AbortError");
            if (volume !== share.volume) continue;
            // The Browser adopted this gain when it took over the publication.
            if (!local && this.local.has(publicationId)) return;
            throw error;
          }
          if (!current()) throw new DOMException("Capture cancelled", "AbortError");
          appliedVolume = volume; appliedProfile = profile;
          if (volume === share.volume) return;
        } while (current());
        throw new DOMException("Capture cancelled", "AbortError");
      } catch (error) {
        if (current()) {
          share.volume = appliedVolume;
          share.profile = { ...share.profile, maxAudioBitrate: appliedProfile.maxAudioBitrate };
          this.patch({});
        }
        throw error;
      }
    }).finally(() => { share.audioChange = undefined; this.patch({}); });
    return share.audioChange;
  };
  startNativeScreen = (roomId: string, { target, audio, excludeAudio, showCaptureBorder, renderEndpointId }: NativeCaptureSelection, reportError: ReportError = true): Promise<void> => this.action(`screen:${roomId}`, async () => {
    const { share, selection, current } = this.selectScreen(roomId);
    const signal = selection.controller.signal;
    const native = { target, audio, renderEndpointId, excludeAudio: target.kind === "display" ? excludeAudio : undefined, showCaptureBorder };
    let app: ChannelApp | undefined;
    let ownsPreparation = false;
    try {
      app = await this.connectApp(signal);
      if (!current()) throw new DOMException("Capture cancelled", "AbortError");
      const codecMode = share.codec?.primary ?? (share.codecMode === "auto"
        && app.supportsCaptureCodec("vp8") && !supportsH264Receive() ? "vp8" : share.codecMode);
      const preparing = app.prepareCapture(share.id, roomId, {
        ...native, excludeAudio: audio ? native.excludeAudio : undefined, renderEndpointId: audio ? renderEndpointId : undefined,
        profile: share.profile, codecMode, encodingExecution: share.encodingExecution, gain: share.volume.muted ? 0 : share.volume.level,
      });
      this.patch({});
      const prepared = await preparing;
      ownsPreparation = true;
      if (!current() || this.app !== app) throw new DOMException("Capture cancelled", "AbortError");
      selection.committing = true;
      this.patch({});
      if (this.local.has(share.id)) await this.request({ type: "transfer_source", publicationId: share.id, toSessionId: prepared.sessionId }, undefined, roomId);
      if (!current()) throw new DOMException("Capture cancelled", "AbortError");
      const replacesCapture = app.captureId(share.id) !== undefined;
      await app.commitCapture(share.id, prepared.captureId);
      ownsPreparation = false;
      if (!current()) throw new DOMException("Capture cancelled", "AbortError");
      share.native = native;
      share.paused = undefined;
      share.codec ??= share.codecMode === "auto" ? automaticVideoCodecPreference(prepared.codec) : manualVideoCodecPreference(prepared.codec);
      this.retireCapture(share.id);
      const remoteControls = new Map(this.view.remoteControls);
      if (replacesCapture) remoteControls.delete(share.id);
      this.patch({ remoteControls });
      await this.previewCommittedCapture(roomId, share.id, () => current() && this.app === app, signal);
    } catch (error) {
      if (ownsPreparation) await app?.cancelCapture(share.id).catch(() => {});
      throw error;
    } finally { this.finishSourceSelection(roomId, selection); }
  }, reportError);
  setScreenDirectLimit = async (publicationId: string, limit: number | null): Promise<void> => {
    const publication = this.view.state?.publications.find(value => value.id === publicationId && value.kind === "screen");
    if (!publication) throw new Error("publication_unavailable");
    if (this.view.connection !== "connected") throw new Error("disconnected");
    if (limit !== null && !Number.isInteger(limit)) throw new Error("invalid_relay_capacity");
    const key = "direct-limit:" + publicationId;
    if (this.local.get(publicationId)?.kind === "screen" && publication.sessionId === this.view.sessionId) {
      await this.action(key, () => this.request({ type: "set_screen_direct_limit", publicationId, limit }, undefined, publication.roomId), false);
    } else if (this.app?.screens.has(publicationId)) {
      await this.action(key, () => this.app!.setCaptureDirectLimit(publicationId, limit), false);
    } else throw new Error("not_publication_owner");
  };
  setScreenTitle = async (publicationId: string, title: string | null): Promise<void> => {
    const publication = this.view.state?.publications.find(value => value.id === publicationId && value.kind === "screen");
    if (!publication) throw new Error("publication_unavailable");
    if (this.view.connection !== "connected") throw new Error("disconnected");
    const normalized = title?.trim() || null;
    if (this.local.get(publicationId)?.kind === "screen" && publication.sessionId === this.view.sessionId) {
      await this.action(`title:${publicationId}`, () => this.request({ type: "set_title", publicationId, title: normalized }, undefined, publication.roomId), false);
    } else if (this.app?.screens.has(publicationId)) {
      await this.action(`title:${publicationId}`, () => this.app!.setCaptureTitle(publicationId, normalized), false);
    } else throw new Error("not_publication_owner");
  };
  setScreenPaused = async (publicationId: string, paused: boolean): Promise<void> => {
    const publication = this.view.state?.publications.find(value => value.id === publicationId && value.kind === "screen");
    if (!publication) throw new Error("publication_unavailable");
    if (this.local.get(publicationId)?.kind === "screen" && publication.sessionId === this.view.sessionId) {
      const local = this.local.get(publicationId)!, share = this.stages.get(publication.roomId)?.screen;
      if (share) share.paused = paused;
      setMediaPaused(local.stream, paused);
      if (local.audio) setMediaPaused(local.audio.sourceStream, paused);
      this.media.setLocalPaused(publicationId, paused);
      this.refreshActivity();
      if (this.view.connection !== "connected") return;
      const command = { type: "set_paused" as const, publicationId, paused };
      if (this.view.pending.has(`pause:${publicationId}`)) { this.send(command); return; }
      await this.action(`pause:${publicationId}`, async () => {
        try { await this.request(command, undefined, publication.roomId); }
        catch (error) { if (!(error instanceof Error) || error.message !== "disconnected") throw error; }
      });
    } else if (this.app?.screens.has(publicationId)) {
      if (this.view.connection !== "connected") throw new Error("disconnected");
      await this.action(`pause:${publicationId}`, () => this.app!.setCapturePaused(publicationId, paused));
    } else throw new Error("not_publication_owner");
  };
  stopScreen = (publicationId: string, successorWatchId?: string): Promise<void> => this.action(`stop:${publicationId}`, async () => {
    if (successorWatchId) {
      const local = this.local.get(publicationId);
      if (local) {
        await this.request({ type: "unpublish", publicationId, successorWatchId }, undefined, local.roomId);
        if (this.local.get(publicationId) !== local) throw new DOMException("Capture replaced", "AbortError");
        this.retireCapture(publicationId);
      } else {
        if (!this.app) throw new Error("capture_unavailable");
        await this.app.stopCapture(publicationId, successorWatchId);
      }
    }
    for (const stage of this.stages.values()) stage.stopScreen(publicationId);
    // stop_capture also retires a pending Native candidate for a Browser incumbent.
    if (successorWatchId) {
      this.retireWatch(publicationId);
      this.refreshActivity();
    } else await Promise.all([this.app?.stopCapture(publicationId), this.retireScreenPublication(publicationId)]);
  });

  private async retireScreenPublication(publicationId: string): Promise<void> {
    const browser = this.local.get(publicationId);
    if (browser) this.retireCapture(publicationId);
    this.retireWatch(publicationId);
    this.forgetInactiveScreen(publicationId);
    this.refreshActivity();
    if (browser && this.view.connection === "connected")
      await this.request({ type: "unpublish", publicationId }, undefined, browser.roomId);
  }

  joinVoice = this.voice.join;
  leaveVoice = this.voice.leave;
  setMuted = this.voice.setMuted;
  toggleVoiceShortcut = this.voice.toggleShortcut;
  setDeafened = this.voice.setDeafened;
  canUnmute = this.voice.canUnmute;
  voiceMicrophonePending = this.voice.microphonePending;
  voiceBusy = this.voice.busy;
  voiceActivity = this.voice.activity;
  setInputVolume = this.voice.setInputVolume;
  configureVoiceInput = this.voice.configureInput;
  setMicrophoneMode = this.voice.setMicrophoneMode;
  setActivationThreshold = this.voice.setActivationThreshold;
  talk = this.voice.talk;
  microphoneLevel = this.voice.inputLevel;
  microphones = () => browserCaptureDevices("audioinput");

  setListeningVolume = (volume: number): void => {
    this.patch({ listeningVolume: volume });
    saveRoomPreferences({ voiceListeningVolume: volume });
  };

  setVoiceVolume = (userId: string, volume: number): void => {
    if (!Number.isFinite(volume)) return;
    this.setVoicePlayback(userId, { volume: Math.min(2, Math.max(0, volume)) });
  };

  setVoiceMuted = (userId: string, muted: boolean): void => { this.setVoicePlayback(userId, { muted }); };

  private setVoicePlayback(userId: string, patch: Partial<{ volume: number; muted: boolean }>): void {
    if (!this.view.state?.users.some(user => user.id === userId)) return;
    const values = new Map(this.view.voicePlaybackByUser);
    const value = { volume: 1, muted: false, ...values.get(userId), ...patch };
    if (value.volume === 1 && !value.muted) values.delete(userId); else values.set(userId, value);
    this.patch({ voicePlaybackByUser: values });
  }

  reconnect = (): void => {
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    const old = this.socket;
    this.socket = null;
    old?.close();
    this.rejectRequests("disconnected");
    this.beginRecovery();
    this.connect();
  };

  joinAsNewIdentity = (): void => {
    this.close();
    this.connect(undefined, true);
  };

  private rejectRequests(message: string): void {
    for (const [requestId, request] of this.requests) { this.retireRequest(requestId); request.reject(new Error(message)); }
  }

  private releaseMedia(): void {
    this.forwardingBudget?.free();
    this.forwardingBudget = undefined;
    this.roomSnapshot = undefined;
    this.clearReadings();
    this.readingRooms.clear();
    this.captureLifetime.abort();
    this.captureLifetime = new AbortController();
    for (const stage of this.stages.values()) stage.close();
    this.stages.clear();
    this.waitingWatchPages.clear();
    this.declinedSources.clear();
    this.app?.stopCaptures();
    this.input.reset();
    this.attachments.reset();
    this.watchBytes.reset();
    for (const capture of this.local.values()) capture.audio?.dispose();
    this.media.reset();
    this.local.clear();
    this.localNativeEndpoints.clear();
    this.voice.close();
    for (const id of this.watching.keys()) this.retireWatch(id);
    this.signals = [];
  }

  private retireCapture(id: string): void {
    this.local.get(id)?.audio?.dispose();
    this.local.delete(id);
    this.media.removeLocal(id);
    this.voice.captureRetired(id);
  }

  private refreshActivity(): void {
    if (this.view.state) this.patch({ state: this.projectActivity(this.view.state) });
    this.input.update();
  }

  private projectActivity(state: ChannelSnapshot): ChannelSnapshot {
    const sessionId = this.view.sessionId;
    const subscriptions = state.subscriptions.filter(id => {
      const publication = state.publications.find(value => value.id === id);
      return publication?.kind === "voice" ? this.voice.joined(publication.roomId) : this.watching.has(id);
    });
    // Only authority updates retire leases and assign transports. Local stop
    // intent changes what this page presents, even while the host is unreachable.
    return {
      ...state,
      publications: state.publications.filter(publication => publication.sessionId !== sessionId || this.local.has(publication.id)
        || this.stages.get(publication.roomId)?.screen?.id === publication.id).map(publication => {
          const share = this.stages.get(publication.roomId)?.screen;
          return publication.kind === "screen" ? { ...publication,
            paused: this.local.has(publication.id) && share?.id === publication.id ? share.paused ?? publication.paused : publication.paused,
            audience: publication.audience.filter(viewer => viewer.sessionId !== sessionId || this.watching.has(publication.id)),
          } : publication;
        }),
      voice: this.voice.project(state.voice),
      ...this.projectWatches(state),
      subscriptions,
    };
  }

  private projectWatches(state: ChannelSnapshot) {
    const sessionId = this.view.sessionId;
    return {
      watchActivities: state.watchActivities.filter(activity => activity.sessionId !== sessionId || this.watchPlayer(activity.id))
        .map(activity => ({ ...activity, viewerSessionIds: activity.viewerSessionIds.filter(id => id !== sessionId || this.watchPlayer(activity.id)) })),
      watchSubscriptions: state.watchSubscriptions.filter(value => this.watchPlayer(value.id)?.mode === value.mode || value.mode === "direct" && this.waitingWatchPages.has(value.id)),
    };
  }

  private beginRecovery(): void {
    for (const { reader } of this.readings.values()) reader.disconnect();
    if (!this.view.sessionId || this.recoveryDeadline !== null) return;
    this.recoveryDeadline = setTimeout(() => {
      this.recoveryDeadline = null;
      this.releaseMedia();
      this.releaseHosts();
      this.patch({ sessionId: null, state: null, self: null, error: "session_expired" });
      // An in-flight Join can still name the session whose media just expired.
      if (this.socket) this.reconnect();
    }, session_recovery_ms());
  }

  private endRecovery(): void {
    if (this.recoveryDeadline !== null) clearTimeout(this.recoveryDeadline);
    this.recoveryDeadline = null;
  }

  close = (): void => {
    this.identityGeneration++;
    this.closeConnection();
  };

  private closeConnection(): void {
    this.releaseDebug?.(); this.releaseDebug = undefined;
    this.feedbackImports.clear();
    this.closed = true;
    this.feedbackAudio.close();
    this.endRecovery();
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    this.releaseHosts();
    this.write({ type: "leave" });
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.rejectRequests("closed");
    this.outgoingMessages.clear();
    this.releaseMedia();
    this.conversation.close();
    this.profileLoads.clear(); this.missingProfiles.clear();
    this.patch({ connection: "closed", state: null, sessionId: null, self: null, profiles: new Map() });
  }
}
