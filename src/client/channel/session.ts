import { z } from "zod";
import { ChannelMedia } from "./media";
import { ChannelInput } from "./input";
import { ChannelConversation } from "./conversation";
import { selectedRoom } from "./navigation";
import { CHANNEL_PROTOCOL, CHANNEL_EVENT_BYTES, ChannelEventDecoder, channelTopologySchema, roomSummarySchema, userSchema, type ChannelCommand, type ChannelEvent, type ChannelMessage, type ChannelReply, type ChannelSnapshot, type ChannelTopology, type ConversationReply, type DomainSettings, type MessageReactionSnapshot, type RoomInvitationState, type RoomSettings, type RoomSummary, type ScreenSource } from "./protocol";
import { ChannelAttachments, type DraftFile } from "./attachments";
import type { ChannelView, ScreenPresentation, SourceMicrophoneConfiguration, SourceMicrophoneSettings } from "./types";
import { loadRoomHosting, roomDatabaseName, type HostedRoom, type BrowserRoomSnapshot, type BrowserRoomStage, type BackupHistoryImport, type BackupHistoryRow } from "./hosting";
import { ChannelApp, discoverChannelAppHealth, type ChannelStopShortcut, type NativeCaptureSources, type NativeConnectionMetrics } from "./app-link";
import { isClientActivated } from "../lib/app-launch";
import type { NativeCaptureTarget } from "../native/wire";
import type { RemoteControlMode } from "../remote-control/protocol";
import { readRoomPreferences, saveRoomPreferences, type RoomPreferences } from "../lib/room-preferences";
import { MicrophoneInput } from "../media/microphone-input";
import { acquireMediaStream } from "../media/capture-stream";
import { HostAudio, type CommentaryInput } from "../media/host-audio";
import { readPreferredQuality, savePreferredQuality, screenVideoSettings, supportsCaptureProfile, type QualityProfile } from "../media/quality";
import { audioInputConstraints } from "../media/audio-capture";
import { browserCaptureDevices } from "../media/capture-devices";
import { RoomInteractionSession, type RoomInteraction } from "../lib/room-interactions";
import { MAX_CHAT_CODE_POINTS, isThrow } from "../../shared/room-interactions";
import { FeedbackAudio } from "./feedback-audio";
import { createOpaqueId } from "../lib/opaque-id";
import { captureBrowserSource, setMediaPaused, type BrowserCaptureSource } from "../media/quality";
import { loadCameraPreviews, type CameraPreview } from "../media/camera-previews";
import { readBackup, writeBackup, type BackupMetadata, type RetainedBackupFile } from "./backup-archive";
import { NativeDomainHosting, NativeRoomHosting } from "./hosting-api";
import type { RetainedFile } from "./file-store";
import { automaticVideoCodecPreference, manualVideoCodecPreference, supportsH264Receive, type BrowserVideoCodecMode, type BrowserVideoCodecPreference } from "../webrtc/video-codec";
import { preferredVideoCodecForTrack } from "../webrtc/video-codec-preflight";

const credentialKey = "piik.channel.prototype.credential";
const nameKey = "piik.channel.prototype.name";

interface RoomReading {
  roomId: string;
  bindingId: string;
  socket: WebSocket | null;
  ready: Promise<void>;
  history?: Promise<void>;
  interaction?: RoomInteractionSession;
}

interface MicrophoneRequest {
  context: AudioContext | null;
  input: MicrophoneInput | null;
  promise?: Promise<MicrophoneInput>;
}

interface VoiceParticipation {
  publicationId: string | null;
  muted: boolean;
  deafened: boolean;
}

interface ScreenWatch {
  helperSessionId?: string;
  query?: AbortController;
  operation?: Promise<void>;
}

interface ScreenShare {
  id: string;
  paused?: boolean;
  profile: QualityProfile;
  codecMode: BrowserVideoCodecMode;
  codec?: BrowserVideoCodecPreference;
  volume: { level: number; muted: boolean };
  microphone: CommentaryInput;
  requestedMicrophone?: SourceMicrophoneConfiguration;
  microphoneChange?: Promise<void>;
  audioChange?: Promise<void>;
  requestedProfile?: QualityProfile;
  qualityChange?: Promise<void>;
  selection?: AbortController;
  native?: { target: NativeCaptureTarget; audio: boolean; excludeAudio?: NativeCaptureTarget; showCaptureBorder: boolean };
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

function stored(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch { return null; }
}

function mergeMessages(messages: ChannelMessage[]): ChannelMessage[] {
  const merged = new Map<string, ChannelMessage>();
  for (const message of messages) merged.set(message.id, mergeMessage(merged.get(message.id), message));
  return [...merged.values()].sort((a, b) => a.seq - b.seq);
}

function mergeMessage(previous: ChannelMessage | undefined, message: ChannelMessage): ChannelMessage {
  return previous?.reactions && (!message.reactions || previous.reactions.revision > message.reactions.revision)
    ? { ...message, reactions: previous.reactions } : message;
}

/** The live browser endpoint owns captures and reconnects; browsing owns neither. */
export class ChannelSession {
  private view: ChannelView = {
    quality: readPreferredQuality(),
    videoCodecMode: "auto",
    interactionsByRoom: new Map(),
    publicationReactions: new Map(),
    voiceInput: readRoomPreferences().voiceInput,
    voicePlaybackByUser: new Map(),
    listeningVolume: readRoomPreferences().voiceListeningVolume,
    feedbackSound: readRoomPreferences().feedbackSound,
    appConnected: false,
    ownedScreens: new Set(),
    localScreens: new Set(),
    state: null, sessionId: null, self: null, connection: "connecting", messagesByRoom: {}, historyByRoom: {},
    streams: new Map(), screenInputs: new Map(), inputChannels: new Map(), remoteControls: new Map(), error: null, siteURL: null, pending: new Set(),
  };
  private listeners = new Set<() => void>();
  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private recoveryDeadline: ReturnType<typeof setTimeout> | null = null;
  private closed = true;
  private feedbackAudio = new FeedbackAudio();
  private reactionNonce = 0;
  private credential = stored(credentialKey) ?? undefined;
  private invitationOrigin = location.origin;
  private ownerKey = new URLSearchParams(location.hash.slice(1)).get("owner") ?? undefined;
  private roomId = selectedRoom();
  private requests = new Map<string, {
    roomId?: string; bindingId?: string;
    history?: { before?: number; entries: Map<number, { message?: ChannelMessage; snapshot?: MessageReactionSnapshot }> };
    resolve(): void; reject(error: Error): void; result?: (event: ChannelReply) => void; timer: ReturnType<typeof setTimeout>;
  }>();
  private hostedRooms = new Map<string, { host: HostedRoom; bindingId?: string }>();
  private app: ChannelApp | undefined;
  private localNativeEndpoints = new Set<string>();
  private hostCleanup: Promise<void> = Promise.resolve();
  private signals: Extract<ChannelCommand, { type: "signal" }>[] = [];
  private microphone: MicrophoneInput | null = null;
  private microphoneRequest: MicrophoneRequest | null = null;
  private voiceParticipation = new Map<string, VoiceParticipation>();
  private watching = new Map<string, ScreenWatch>();
  private admittedPublications = new Set<string>();
  private historyChannel: string | null = null;
  private readings = new Map<string, RoomReading>();
  private get reading(): RoomReading | undefined { return this.readings.get(this.roomId); }
  private readingRooms = new Set<string>();
  private outgoingMessages = new Map<string, { content: string; nonce: string }>();
  private captureLifetime = new AbortController();
  private screenShares = new Map<string, ScreenShare>();
  private local = new Map<string, { roomId: string; kind: "screen" | "voice"; stream: MediaStream; microphone?: MicrophoneInput; audio?: HostAudio; profile?: QualityProfile; camera?: boolean }>();
  private conversation = new ChannelConversation({
    context: () => ({ sessionId: this.view.sessionId, state: this.view.state, connected: this.view.connection === "connected" }),
    host: roomId => this.hostedRooms.get(roomId)?.host,
    send: (packet, requestId) => {
      if (this.view.connection !== "connected" || this.socket?.readyState !== WebSocket.OPEN) throw new Error("disconnected");
      this.write({ type: "conversation", packet, requestId });
    },
    file: (peer, control) => this.attachments.data(peer, "control", control),
    reply: reply => this.receiveConversation(reply),
  });
  private input = new ChannelInput({
    context: () => ({ sessionId: this.view.sessionId, state: this.view.state,
      connected: this.view.connection === "connected" && this.socket?.readyState === WebSocket.OPEN }),
    register: command => this.request(command),
    send: (peer, frame) => this.media.sendInput(peer, frame),
    changed: inputChannels => this.patch({ inputChannels }),
  });
  private media = new ChannelMedia(command => this.send(command), (streams, screenInputs) => this.patch({ streams, screenInputs }),
    (peer, kind, data) => {
      if (kind === "chunk") this.attachments.data(peer, kind, data);
      else void this.conversation.receiveFile(peer, data as string).catch(() => {});
    }, (peer, ready) => this.attachments.peerState(peer, ready), peer => this.attachments.bulkClosed(peer),
    (pair, channel) => this.input.setChannel(pair, channel));
  readonly attachments = new ChannelAttachments(command => this.request(command), async (peer, kind, data, allowed) =>
    this.media.sendData(peer, kind, kind === "control" ? await this.conversation.fileFrame(data as string) : data, allowed));

  getSnapshot = (): ChannelView => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  stats = () => this.media.stats();
  screenPresentation = (flowId: string, stream: MediaStream, state: ScreenPresentation): void => this.media.screenPresentation(flowId, stream, state);
  setQuality = (profile: QualityProfile): void => {
    if (!supportsCaptureProfile(profile)) throw new Error("capture_quality_unsupported");
    savePreferredQuality(profile);
    this.patch({ quality: profile });
  };
  setVideoCodecMode = (videoCodecMode: BrowserVideoCodecMode): void => {
    this.patch({ videoCodecMode });
  };

  private patch(patch: Partial<ChannelView>): void {
    const ownedScreens = new Set(this.app?.screens);
    for (const share of this.screenShares.values()) ownedScreens.add(share.id);
    for (const [id, capture] of this.local) if (capture.kind === "screen") ownedScreens.add(id);
    const localScreens = new Set(ownedScreens);
    for (const publication of (patch.state ?? this.view.state)?.publications ?? []) {
      if (publication.kind === "screen" && this.localNativeEndpoints.has(publication.sessionId)) localScreens.add(publication.id);
    }
    const remoteControls = new Map([...(patch.remoteControls ?? this.view.remoteControls)].filter(([id]) => ownedScreens.has(id)));
    this.view = { ...this.view, ...patch, appConnected: this.app?.connected ?? false, ownedScreens, localScreens, remoteControls };
    for (const listener of this.listeners) listener();
  }

  start = (): void => {
    if (!this.closed) return;
    this.closed = false;
    this.feedbackAudio.configure(this.view.feedbackSound);
    this.connect();
  };

  setFeedbackSound = (patch: Partial<RoomPreferences["feedbackSound"]>): void => {
    const feedbackSound = { ...this.view.feedbackSound, ...patch };
    if (!Number.isFinite(feedbackSound.volume)) return;
    feedbackSound.volume = Math.min(1, Math.max(0, feedbackSound.volume));
    saveRoomPreferences({ feedbackSound });
    this.patch({ feedbackSound });
    this.feedbackAudio.configure(feedbackSound);
    if (feedbackSound.enabled) this.feedbackAudio.activate();
  };
  previewFeedbackSound = (): void => { this.feedbackAudio.preview(); };

  private playFeedback(roomId: string, event: RoomInteraction): void {
    const self = this.view.self?.id;
    if (this.closed || !self || !this.view.feedbackSound.enabled) return;
    if (event.payload.kind === "chat") {
      if (document.hidden && event.sender.peerId !== self) this.feedbackAudio.play("message");
      return;
    }
    if (document.hidden || !isThrow(event.payload.reaction)) return;
    const target = event.contentTarget;
    const recipient = target ? "messageSeq" in target
      ? this.view.messagesByRoom[roomId]?.find(message => message.seq === target.messageSeq)?.userId
      : this.view.state?.publications.find(source => source.id === target.publicationId)?.userId
      : event.payload.targetPeerId ?? event.sender.peerId;
    if (event.sender.peerId === self || recipient === self) this.feedbackAudio.play("throw");
  }

  private connect(acceptWelcome?: (event: Extract<ChannelEvent, { type: "welcome" }>) => string | undefined): void {
    if (this.closed) return;
    const url = new URL("/prototype/channel", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    const decoder = new ChannelEventDecoder();
    this.socket = socket;
    this.patch({ connection: this.view.sessionId ? "reconnecting" : "connecting" });
    socket.onopen = async () => {
      try {
        const signingKey = await this.conversation.initialize();
        if (this.socket !== socket || this.closed) return;
        this.write({ type: "join", protocol: CHANNEL_PROTOCOL, signingKey, name: stored(nameKey) ?? "Guest", credential: this.credential, ownerKey: this.ownerKey, sessionId: this.view.sessionId ?? undefined });
      } catch (error) {
        if (this.socket === socket && !this.closed) {
          this.close();
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
          this.close(); this.patch({ error: "incompatible_protocol" }); return;
        }
        const event = decoder.decode(raw, wireBytes);
        const skipRoom = event.type === "welcome" ? acceptWelcome?.(event) : undefined;
        if (event.type === "welcome") acceptWelcome = undefined;
        this.receive(event, skipRoom);
      } catch {
        this.patch({ error: "invalid_response" });
        // Later frames may omit pictures; recovery must start with a complete Welcome.
        socket.close();
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket || this.closed) return;
      this.socket = null;
      this.rejectRequests("disconnected");
      this.patch({ connection: "reconnecting" });
      this.beginRecovery();
      this.retry = setTimeout(() => { this.retry = null; this.connect(acceptWelcome); }, 1000);
    };
    socket.onerror = () => { /* The close event owns retry. */ };
  }

  private receive(event: ChannelEvent, skipRestoreRoom?: string): void {
    if (event.type === "welcome") {
      this.endRecovery();
      const resumed = this.view.sessionId === event.sessionId;
      if (this.view.sessionId && !resumed) this.releaseMedia();
      if (!resumed) this.releaseHosts();
      this.credential = event.credential;
      const saved = stored(credentialKey, event.credential) === event.credential;
      const parameters = new URLSearchParams(location.hash.slice(1));
      const owner = event.state.sessions.find(session => session.id === event.sessionId)?.userId === event.state.channel.ownerId;
      if (saved && owner && parameters.has("owner") && parameters.get("owner") === this.ownerKey && typeof history !== "undefined") {
        parameters.delete("owner");
        const hash = parameters.toString();
        try {
          history.replaceState(history.state, "", location.pathname + location.search + (hash ? `#${hash}` : ""));
          this.ownerKey = undefined;
        } catch { /* The saved credential still owns recovery if URL editing is unavailable. */ }
      }
      this.invitationOrigin = event.invitationOrigin ?? location.origin;
      this.patch({ sessionId: event.sessionId, connection: "connected", error: null, siteURL: this.siteURL() });
      this.readings.clear();
      for (const room of event.state.channel.rooms) if (room.reading) this.readingRooms.add(room.id);
      this.applyState(event.state);
      void this.syncAppWatching(resumed);
      void this.resumeApp();
      void this.restoreHosts(event.sessionId, skipRestoreRoom).catch(error => {
        if (!this.closed && this.view.sessionId === event.sessionId) this.patch({ error: error instanceof Error ? error.message : "storage_failed" });
      });
      if (resumed) {
        this.media.resync();
        this.attachments.resume();
        for (const publication of event.state.publications) {
          if (publication.sessionId === event.sessionId && !this.local.has(publication.id)) this.write({ type: "unpublish", publicationId: publication.id });
          const share = this.screenShares.get(publication.roomId);
          if (publication.kind === "screen" && this.local.has(publication.id) && share?.id === publication.id
            && share.paused !== undefined && share.paused !== publication.paused)
            this.write({ type: "set_paused", publicationId: publication.id, paused: share.paused });
        }
        for (const member of event.state.voice) {
          if (member.sessionId === event.sessionId && !this.voiceParticipation.has(member.roomId)) this.write({ type: "voice", roomId: member.roomId, joined: false, muted: true, deafened: false });
          else if (member.sessionId === event.sessionId) {
            const intent = this.voiceParticipation.get(member.roomId)!;
            if (member.muted !== intent.muted || member.deafened !== intent.deafened)
              this.write({ type: "voice", roomId: member.roomId, joined: true, muted: intent.muted, deafened: intent.deafened });
          }
        }
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
    } else if (event.type === "host_bound") {
      const hosted = this.hostedRooms.get(event.roomId), socket = this.socket;
      if (!hosted) return;
      hosted.bindingId = event.bindingId;
      // bind and later dispatch share this host's existing serialized storage turn.
      void hosted.host.bind(event.bindingId).catch(error => {
        if (this.hostedRooms.get(event.roomId) === hosted && hosted.bindingId === event.bindingId && this.socket === socket) {
          this.hostedRooms.delete(event.roomId);
          this.write({ type: "host_stop", roomId: event.roomId, bindingId: event.bindingId });
          this.hostCleanup = Promise.all([this.hostCleanup, hosted.host.close()]).then(() => {});
          this.patch({ error: error instanceof Error ? error.message : "room_host_failed" });
        }
      });
    } else if (event.type === "host_input") {
      const hosted = this.hostedRooms.get(event.roomId), socket = this.socket;
      if (!hosted || hosted.bindingId !== event.input.bindingId) return;
      const binding = hosted.bindingId;
      void hosted.host.dispatch(event.input).then(output => {
        if (this.hostedRooms.get(event.roomId) === hosted && hosted.bindingId === binding && this.socket === socket) {
          const result = (output as { reply?: { result?: { type?: string; dataRemoved?: boolean } } }).reply?.result;
          if (result?.type === "deleted" && result.dataRemoved === true) {
            this.hostedRooms.delete(event.roomId);
            this.hostCleanup = Promise.all([this.hostCleanup, hosted.host.close()]).then(() => {});
          }
          this.write({ type: "host_output", roomId: event.roomId, output });
        }
      }).catch(error => {
        if (this.hostedRooms.get(event.roomId) === hosted && hosted.bindingId === binding && this.socket === socket) {
          this.patch({ error: error instanceof Error ? error.message : "room_host_failed" });
        }
      });
    } else if (event.type === "room_reply") {
      const request = event.requestId ? this.requests.get(event.requestId) : undefined;
      if (!request || request.roomId !== event.roomId || !event.requestId) return;
      clearTimeout(request.timer);
      this.requests.delete(event.requestId);
      if (event.result.type === "error") request.reject(new Error(event.result.code ?? "operation_failed"));
      else {
        try { request.result?.(event); request.resolve(); }
        catch (error) { request.reject(error instanceof Error ? error : new Error("invalid_response")); }
      }
    } else if (event.type === "room_created") {
      const request = event.requestId ? this.requests.get(event.requestId) : undefined;
      if (!request || !event.requestId) return;
      clearTimeout(request.timer); this.requests.delete(event.requestId);
      try { request.result?.(event); request.resolve(); }
      catch (error) { request.reject(error instanceof Error ? error : new Error("invalid_response")); }
    } else if (event.type === "state") this.applyState(event.state);
    else if (event.type === "room_invite" || event.type === "room_invite_state") {
      if (event.requestId) {
        const request = this.requests.get(event.requestId);
        if (request?.roomId === event.roomId) request.result?.(event);
      }
    } else if (event.type === "signal") this.media.signal(event.pairId, event.payload);
    else if (event.type === "ack" || event.type === "error") {
      const request = event.requestId ? this.requests.get(event.requestId) : null;
      if (request && event.requestId) {
        clearTimeout(request.timer);
        this.requests.delete(event.requestId);
        if (event.type === "ack") request.resolve();
        else request.reject(new Error(event.code));
      } else if (event.type === "error" && !event.requestId) {
        if (event.code === "incompatible_protocol") {
          this.close(); this.patch({ error: event.code }); return;
        }
          this.patch({ error: event.code });
        if (!this.view.sessionId) {
          this.closed = true;
          this.socket?.close();
          this.patch({ connection: "closed" });
        }
      }
    }
  }

  private applyState(state: ChannelSnapshot): void {
    const sessionId = this.view.sessionId;
    if (!sessionId) return;
    for (const id of this.localNativeEndpoints) if (!state.sessions.some(endpoint => endpoint.id === id)) this.localNativeEndpoints.delete(id);
    const previousRooms = this.view.state?.channel.rooms;
    const userId = state.sessions.find(session => session.id === sessionId)?.userId;
    for (const id of this.admittedPublications) {
      if (!state.publications.some(publication => publication.id === id)) {
        const roomId = this.local.get(id)?.roomId;
        if (roomId && this.screenShares.get(roomId)?.id === id) this.screenShares.delete(roomId);
        this.retireCapture(id);
      }
    }
    for (const [roomId, intent] of this.voiceParticipation) {
      const voice = state.voice.find(member => member.sessionId === sessionId && member.roomId === roomId);
      const { publicationId } = intent;
      const stream = publicationId ? this.local.get(publicationId)?.stream : undefined;
      if (voice && stream) stream.getAudioTracks().forEach(track => { track.enabled = !intent.muted; });
      if (!voice && !this.view.pending.has(`voice:${roomId}`)) {
        this.voiceParticipation.delete(roomId);
        if (publicationId) this.retireCapture(publicationId);
      }
    }
    for (const publication of state.publications) if (publication.kind === "screen") {
      const local = this.local.get(publication.id);
      if (local) {
        const paused = this.screenShares.get(publication.roomId)?.paused ?? publication.paused;
        setMediaPaused(local.stream, paused);
        if (local.audio) setMediaPaused(local.audio.sourceStream, paused);
      }
    }
    for (const [id, watch] of this.watching) {
      if (!state.publications.some(publication => publication.id === id) && (watch.query || !this.view.pending.has(`watch:${id}`))) this.retireWatch(id);
    }
    const visible = this.projectActivity(state);
    const sameChannel = this.historyChannel === state.channel.id;
    if (!sameChannel) { this.closeInteractions(); this.readings.clear(); }
    this.historyChannel = state.channel.id;
    const canRead = (id: string) => sameChannel && state.channel.rooms.some(room => room.id === id && room.authorized);
    const freshBindings = new Set(state.channel.rooms.filter(room => room.delivery
      && previousRooms?.find(previous => previous.id === room.id)?.delivery?.bindingId !== room.delivery.bindingId).map(room => room.id));
    for (const id of freshBindings) this.closeInteraction(id);
    for (const [id, request] of this.requests) if (request.bindingId
      && !state.channel.rooms.some(room => room.id === request.roomId && room.authorized
        && room.available && room.delivery?.bindingId === request.bindingId)) {
      clearTimeout(request.timer);
      this.requests.delete(id);
      request.reject(new Error("room_unavailable"));
    }
    for (const id of this.outgoingMessages.keys()) if (!canRead(id)) this.outgoingMessages.delete(id);
    this.patch({ state: visible, self: state.users.find(user => user.id === userId) ?? null,
      siteURL: this.siteURL(),
      voicePlaybackByUser: sameChannel ? new Map([...this.view.voicePlaybackByUser].filter(([id]) => state.users.some(user => user.id === id))) : new Map(),
      messagesByRoom: Object.fromEntries(Object.entries(this.view.messagesByRoom).filter(([id]) => canRead(id) && !freshBindings.has(id))),
      publicationReactions: new Map([...this.view.publicationReactions].filter(([id]) => state.publications.some(publication => publication.id === id
        && canRead(publication.roomId) && !freshBindings.has(publication.roomId)))),
      historyByRoom: Object.fromEntries(Object.entries(this.view.historyByRoom).filter(([id]) => canRead(id) && !freshBindings.has(id))),
    });
    for (const [id, hosted] of this.hostedRooms) if (!state.channel.rooms.some(room => room.id === id)) {
      this.hostedRooms.delete(id);
      this.hostCleanup = Promise.all([this.hostCleanup, hosted.host.close()]).then(() => {});
    }
    if (this.view.connection === "connected") for (const room of state.channel.rooms) {
      if (room.available && previousRooms?.some(previous => previous.id === room.id && !previous.available)
        && this.voiceParticipation.get(room.id)?.publicationId === null && !this.view.pending.has(`voice:${room.id}`)) {
        for (const publication of state.publications) {
          if (publication.sessionId === sessionId && publication.roomId === room.id && publication.kind === "voice" && !this.local.has(publication.id)) {
            this.write({ type: "unpublish", publicationId: publication.id });
          }
        }
        const member = state.voice.find(member => member.sessionId === sessionId && member.roomId === room.id);
        const intent = this.voiceParticipation.get(room.id)!;
        if (member && (member.muted !== intent.muted || member.deafened !== intent.deafened))
          this.write({ type: "voice", roomId: room.id, joined: true, muted: intent.muted, deafened: intent.deafened });
      }
      if (room.id !== this.roomId && room.reading && room.authorized && room.available
        && previousRooms?.some(previous => previous.id === room.id && !previous.available)) {
        this.readingRooms.add(room.id);
      }
    }
    this.media.update(sessionId, state);
    this.input.update();
    if (userId) this.attachments.update(sessionId, { domainId: state.channel.id, userId }, state.files, state.channel.rooms, state.pairs);
    else this.attachments.reset();
    this.browseRooms();
    this.releaseUnusedMicrophone();
  }

  private siteURL(): string {
    return new URL(location.pathname, this.invitationOrigin).href;
  }

  private write(command: ChannelCommand & { requestId?: string }): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(command));
  }

  private send(command: ChannelCommand): void {
    if (this.view.connection === "connected") this.write(command);
    else if (command.type === "signal" && this.signals.length < 256) this.signals.push(command);
  }

  private async request(command: ChannelCommand, result?: (event: ChannelReply) => void, roomId = this.commandRoom(command), signal?: AbortSignal): Promise<void> {
    const reading = roomId ? this.readings.get(roomId) : undefined;
    const conversation = command.type === "chat" || command.type === "history" || command.type === "react";
    if (conversation && reading && reading.roomId === roomId) await reading.ready;
    signal?.throwIfAborted();
    if (this.view.connection !== "connected") return Promise.reject(new Error("disconnected"));
    const room = this.view.state?.channel.rooms.find(room => room.id === roomId);
    const delivery = room?.delivery;
    if (conversation && (!room?.available || !delivery)) return Promise.reject(new Error("room_unavailable"));
    const requestId = crypto.randomUUID();
    const abort = () => {
      const request = this.requests.get(requestId);
      if (!request) return;
      clearTimeout(request.timer); this.requests.delete(requestId);
      request.reject(signal?.reason instanceof Error ? signal.reason : new DOMException("Read cancelled", "AbortError"));
    };
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(requestId); reject(new Error("request_timeout")); }, 10000);
      this.requests.set(requestId, { resolve, reject, timer, result, roomId,
        ...(delivery && (conversation || command.type === "browse" || command.type === "room_topology") ? { bindingId: delivery.bindingId } : {}),
        ...(command.type === "history" ? { history: { before: command.before, entries: new Map() } } : {}) });
      signal?.addEventListener("abort", abort, { once: true });
      if (conversation) void this.conversation.send(command, requestId).catch(error => {
        if (!this.requests.delete(requestId)) return;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
      else {
        if (command.type === "browse" && command.active) this.readingRooms.add(command.roomId);
        this.write({ ...command, requestId });
      }
    }).finally(() => signal?.removeEventListener("abort", abort));
  }

  private receiveConversation(reply: ConversationReply): void {
    const record = reply.record;
    if (record.type === "message_reactions") {
      this.applyReactionSnapshot(reply.roomId, reply.bindingId, record.snapshot);
      return;
    }
    const interaction = this.view.interactionsByRoom.get(reply.roomId);
    if (interaction && this.readings.get(reply.roomId)?.bindingId === reply.bindingId) {
      if (record.type === "interaction_ready") {
        interaction.setSupportedReactions(record.reactionIds);
        interaction.receive({ type: "room-interactions-ready", serverTime: record.serverTime });
        for (const snapshot of record.publicationReactions) this.applyPublicationReactionSnapshot(reply.roomId, snapshot);
        return;
      }
      if (record.type === "reaction") {
        if (record.snapshot?.type === "message") this.applyReactionSnapshot(reply.roomId, reply.bindingId, record.snapshot);
        else if (record.snapshot?.type === "publication") this.applyPublicationReactionSnapshot(reply.roomId, record.snapshot);
        const event = record.event;
        const user = event && this.view.state?.users.find(user => user.id === event.senderUserId);
        if (event && user) interaction.receive({ type: "room-interaction", id: event.id, requestId: reply.requestId, occurredAt: event.occurredAt,
          sender: { peerId: user.id, displayName: user.name, role: "viewer" },
          payload: { kind: "reaction", reaction: event.reaction as import("../../shared/room-interactions").ReactionId,
            ...(event.target.type === "person" ? { targetPeerId: event.target.userId } : {}) },
          ...(event.target.type === "message" ? { contentTarget: { messageSeq: event.target.messageSeq } }
            : event.target.type === "publication" ? { contentTarget: { publicationId: event.target.publicationId } } : {}) });
        if (!event) interaction.confirm(reply.requestId, record.nonce);
        return;
      }
      if (record.type === "error" && !this.requests.has(reply.requestId)) {
        if (!interaction.getSnapshot().ready) this.closeInteraction(reply.roomId);
        else interaction.receive({ type: "room-interaction-rejected", requestId: reply.requestId,
          reason: record.code === "rate_limited" ? "rate-limited" : record.code === "target_unavailable" ? "target-unavailable" : "busy" });
        return;
      }
    }
    if (record.type === "live_message") {
      this.applyMessage(reply.roomId, record.message);
      return;
    }
    const request = this.requests.get(reply.requestId);
    if (!request || request.roomId !== reply.roomId || request.bindingId !== reply.bindingId) return;
    if (record.type === "history_message") {
      const entries = request.history?.entries, entry = entries?.get(record.message.seq);
      if (!entries || entry?.message || (!entry && entries.size >= 100)
        || (entry?.snapshot && entry.snapshot.messageId !== record.message.id)) {
        this.receive({ type: "error", requestId: reply.requestId, code: "incomplete_history" });
        return;
      }
      entries.set(record.message.seq, { ...entry, message: record.message });
      return;
    }
    if (record.type === "history_end" && request.history) {
      const entries = [...request.history.entries.values()].filter(entry => entry.message);
      if (record.count !== entries.length || entries.some(entry => !entry.snapshot)) {
        this.receive({ type: "error", requestId: reply.requestId, code: "incomplete_history" });
        return;
      }
      const page = entries.map(({ message, snapshot }) => ({ ...message!, reactions: { revision: snapshot!.revision, counts: snapshot!.counts } }));
      this.applyHistory(reply.roomId, page.sort((a, b) => a.seq - b.seq), record);
    } else if (record.type === "confirmed") {
      request.result?.(record);
      this.applyMessage(reply.roomId, record.message);
    }
    this.receive(record.type === "error" ? { type: "error", requestId: reply.requestId, code: record.code }
      : { type: "ack", requestId: reply.requestId });
  }

  private applyReactionSnapshot(roomId: string, bindingId: string, snapshot: MessageReactionSnapshot): void {
    const state = this.view.state;
    if (!state?.channel.rooms.some(room => room.id === roomId && room.authorized && room.delivery?.bindingId === bindingId)) return;
    for (const [requestId, request] of this.requests) {
      if (request.roomId !== roomId || request.bindingId !== bindingId || !request.history
        || (request.history.before !== undefined && snapshot.messageSeq >= request.history.before)) continue;
      const entries = request.history.entries, entry = entries.get(snapshot.messageSeq);
      if ((!entry && entries.size >= 100) || (entry?.message && entry.message.id !== snapshot.messageId)) {
        this.receive({ type: "error", requestId, code: "incomplete_history" });
        continue;
      }
      if (!entry?.snapshot || entry.snapshot.revision < snapshot.revision) entries.set(snapshot.messageSeq, { ...entry, snapshot });
    }
    const messages = this.view.messagesByRoom[roomId];
    if (!messages?.some(message => message.id === snapshot.messageId && message.seq === snapshot.messageSeq
      && (!message.reactions || message.reactions.revision < snapshot.revision))) return;
    this.patch({ messagesByRoom: { ...this.view.messagesByRoom, [roomId]: messages.map(message =>
      message.id === snapshot.messageId && message.seq === snapshot.messageSeq
        ? { ...message, reactions: { revision: snapshot.revision, counts: snapshot.counts } } : message) } });
  }

  private applyPublicationReactionSnapshot(roomId: string, snapshot: import("./protocol").PublicationReactionSnapshot): void {
    if (!this.view.state?.publications.some(publication => publication.id === snapshot.publicationId && publication.roomId === roomId)) return;
    const previous = this.view.publicationReactions.get(snapshot.publicationId);
    if (previous && previous.revision >= snapshot.revision) return;
    this.patch({ publicationReactions: new Map(this.view.publicationReactions).set(snapshot.publicationId, snapshot) });
  }

  private applyHistory(roomId: string, page: ChannelMessage[], result: Extract<ConversationReply["record"], { type: "history_end" }>): void {
    const state = this.view.state;
    if (!state?.channel.rooms.some(room => room.id === roomId && room.authorized)) return;
    const current = this.view.messagesByRoom[roomId] ?? [];
    const last = page.at(-1)?.seq ?? 0;
    const latest = result.before === null;
    const existing = latest ? current.filter(message => message.seq > last) : current;
    const projected = page.map(message => mergeMessage(current.find(previous => previous.id === message.id), message));
    const merged = mergeMessages([...existing, ...projected]
      .filter(message => result.oldestSeq === null || message.seq >= result.oldestSeq));
    const messages = latest ? merged.slice(-state.channel.historyWindow) : merged.slice(0, state.channel.historyWindow);
    const atLatest = latest || ((this.view.historyByRoom[roomId]?.atLatest ?? true) && merged.length <= state.channel.historyWindow);
    this.patch({ messagesByRoom: { ...this.view.messagesByRoom, [roomId]: messages },
      historyByRoom: { ...this.view.historyByRoom, [roomId]: { hasMore: result.hasMore, before: messages[0]?.seq, atLatest } } });
  }

  private applyMessage(roomId: string, message: ChannelMessage): void {
    const state = this.view.state;
    if (!state?.channel.rooms.some(room => room.id === roomId && room.authorized)) return;
    const sender = state.users.find(user => user.id === message.userId);
    if (sender) {
      const points = Array.from(message.text.replace(/\s+/gu, " ").normalize("NFC").trim());
      const text = points.length > MAX_CHAT_CODE_POINTS ? `${points.slice(0, MAX_CHAT_CODE_POINTS - 1).join("")}…` : points.join("");
      this.view.interactionsByRoom.get(roomId)?.receiveConfirmedChat({
        type: "room-interaction", id: message.id, requestId: message.id, occurredAt: message.time,
        sender: { peerId: sender.id, displayName: sender.name, role: "viewer" }, payload: { kind: "chat", text },
      });
    }
    // A bounded historical window stays put until its reader requests latest.
    if (this.view.historyByRoom[roomId]?.atLatest === false) return;
    const messages = this.view.messagesByRoom[roomId] ?? [];
    let projected: ChannelMessage = { ...message, reactions: { revision: 0, counts: {} } };
    for (const request of this.requests.values()) {
      const snapshot = request.roomId === roomId ? request.history?.entries.get(message.seq)?.snapshot : undefined;
      if (snapshot?.messageId === message.id) projected = mergeMessage(projected,
        { ...message, reactions: { revision: snapshot.revision, counts: snapshot.counts } });
    }
    this.patch({ messagesByRoom: { ...this.view.messagesByRoom,
      [roomId]: mergeMessages([...messages, projected]).slice(-state.channel.historyWindow) } });
  }

  private commandRoom(command: ChannelCommand): string | undefined {
    if ("roomId" in command) return command.roomId;
    if (command.type === "publish") return command.publication.roomId;
    if ("publicationId" in command) return this.view.state?.publications.find(value => value.id === command.publicationId)?.roomId;
    return undefined;
  }

  private releaseHosts(): void {
    const hosts = [...this.hostedRooms.values()];
    this.hostedRooms.clear();
    const app = this.app;
    this.app = undefined;
    app?.close();
    this.hostCleanup = Promise.all([this.hostCleanup, ...hosts.map(value => value.host.close())]).then(() => {});
  }

  resumeApp = async (): Promise<void> => {
    if (this.closed || this.view.connection !== "connected" || !isClientActivated()) return;
    try { await this.connectApp(); }
    catch { /* Passive return leaves permission and errors with the explicit App action. */ }
  };

  private async connectApp(): Promise<ChannelApp> {
    const state = this.view.state, self = this.view.self;
    if (!state || !self || !this.credential || this.closed) throw new Error("disconnected");
    if (!this.app) {
      if (this.view.connection !== "connected") throw new Error("disconnected");
      const health = await discoverChannelAppHealth({ waitForPermission: false });
      if (!health) throw new Error("app_disconnected");
      if (this.closed || this.view.connection !== "connected" || this.view.self?.id !== self.id
          || this.view.state?.channel.id !== state.channel.id) throw new Error("disconnected");
      if (!this.app) {
        const app = new ChannelApp(health, state.channel.id, self.id, this.credential, self.name, () => {
          if (this.app !== app) return;
          this.app = undefined;
          for (const [roomId, share] of this.screenShares) if (!this.local.has(share.id)) this.screenShares.delete(roomId);
          this.patch({ remoteControls: new Map() });
          void this.syncAppWatching();
        }, (id, error) => {
          if (this.app !== app) return;
          if (!app.screens.has(id)) for (const [roomId, share] of this.screenShares) {
            if (share.id === id && !share.selection && !this.local.has(id)) this.screenShares.delete(roomId);
          }
          this.patch(error ? { error } : {});
        }, (id, state) => {
          if (this.app === app) this.patch({ remoteControls: new Map(this.view.remoteControls).set(id, state) });
        }, () => {
          if (this.app === app) this.patch({});
        });
        this.app = app;
      }
    }
    const app = this.app;
    await app.ready;
    if (this.app === app && !this.closed) {
      this.patch({});
      void this.syncAppWatching();
    }
    return app;
  }

  activateApp = (): Promise<void> => this.action("app", async () => { await this.connectApp(); });

  private rememberLocalEndpoint(app: ChannelApp, sessionId: string): void {
    if (this.app !== app || !app.connected || this.closed || this.localNativeEndpoints.has(sessionId)
      || !this.view.state?.sessions.some(endpoint => endpoint.id === sessionId)) return;
    // This is a source-location fact, not a capture grant. Another page's
    // capture can outlive our App control socket; only endpoint retirement clears it.
    this.localNativeEndpoints.add(sessionId);
    this.patch({});
  }

  private async syncAppWatching(resync = false): Promise<void> {
    if (this.closed || this.view.connection !== "connected") return;
    const watches = [...this.watching].filter(([id]) => !this.local.has(id) && !this.view.pending.has(`watch:${id}`));
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
      if (this.watching.get(publicationId) !== watch
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
    });

  inputDecide = (publicationId: string, requestId: string, allow: boolean): Promise<void> =>
    this.action(`input:${publicationId}:${requestId}`, async () => {
      const request = this.view.remoteControls.get(publicationId)?.requests.find(request => request.id === requestId);
      if (!this.app?.screens.has(publicationId) || !request) throw new Error("input_unavailable");
      await this.app.inputDecide(publicationId, request.peerId, request.id, allow);
    });

  inputSimultaneous = (publicationId: string, enabled: boolean): Promise<void> =>
    this.action(`input:${publicationId}`, async () => {
      const state = this.view.remoteControls.get(publicationId);
      if (!this.app?.screens.has(publicationId) || !state) throw new Error("input_unavailable");
      await this.app.inputPolicy(publicationId, { mode: state.mode, simultaneous: enabled });
    });

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

  private async browserStorage(channelId: string, userId: string) {
    const runtime = await loadRoomHosting(), database = roomDatabaseName(channelId, userId);
    return {
      storedPolicies: () => runtime.BrowserRoomHost.storedPolicies(database),
      open: (policy: string) => runtime.BrowserRoomHost.open(database, policy),
    };
  }

  private async restoreHosts(sessionId: string, skipRoom?: string): Promise<void> {
    if (typeof indexedDB === "undefined") return;
    await this.hostCleanup;
    if (this.view.sessionId !== sessionId || this.closed) return;
    const state = this.view.state, self = this.view.self;
    if (!state || !self) return;
    const storage = await this.browserStorage(state.channel.id, self.id);
    const policies = await storage.storedPolicies();
    if (this.view.sessionId !== sessionId || this.closed) return;
    const retained = new Set(policies.map(policy => (JSON.parse(policy) as { id: string }).id));
    for (const [id, hosted] of this.hostedRooms) if (!retained.has(id)) {
      this.hostedRooms.delete(id);
      await hosted.host.close();
    }
    for (const policy of policies) {
      const id = (JSON.parse(policy) as { id: string }).id;
      if (id === skipRoom) continue;
      if (!this.view.state?.channel.rooms.some(room => room.id === id && room.creatorId === self.id)) continue;
      let hosted = this.hostedRooms.get(id);
      if (!hosted) {
        const host = await storage.open(policy);
        if (this.view.sessionId !== sessionId || this.closed) { await host.close(); return; }
        hosted = { host };
        this.hostedRooms.set(id, hosted);
      }
      const room = await hosted.host.summary();
      if (this.hostedRooms.get(id) !== hosted || this.view.sessionId !== sessionId || this.closed) return;
      try { await this.request({ type: "host_register", room, resumeBinding: hosted.bindingId }); }
      catch (error) {
        if (!(error instanceof Error) || !["room_not_in_domain", "room_already_hosted"].includes(error.message)) throw error;
        if (this.hostedRooms.get(id) === hosted) this.hostedRooms.delete(id);
        await hosted.host.close();
      }
    }
    for (const room of this.view.state?.channel.rooms ?? []) {
      if (room.delivery?.hostSessionId === sessionId && !this.hostedRooms.has(room.id)) {
        this.write({ type: "host_stop", roomId: room.id, bindingId: room.delivery.bindingId });
      }
    }
  }

  private async action<T>(key: string, work: () => Promise<T>, reportError = true): Promise<T> {
    if (this.view.pending.has(key)) throw new Error("operation_pending");
    this.patch({ pending: new Set([...this.view.pending, key]), ...(reportError ? { error: null } : {}) });
    try { return await work(); }
    catch (error) {
      const code = error instanceof DOMException ? error.name : error instanceof Error ? error.message : "operation_failed";
      if (reportError && code !== "AbortError") this.patch({ error: code });
      throw error;
    } finally {
      const pending = new Set(this.view.pending);
      pending.delete(key);
      this.patch({ pending });
      this.releaseUnusedMicrophone();
    }
  }

  browse = (roomId: string): void => {
    this.roomId = roomId;
    const wanted = this.wantedReadings();
    for (const id of this.view.interactionsByRoom.keys()) if (!wanted.has(id)) this.closeInteraction(id);
    this.browseRooms();
  };

  private wantedReadings(): Set<string> {
    const state = this.view.state;
    const rooms = new Set(this.roomId ? [this.roomId] : []);
    for (const publication of state?.publications ?? []) {
      if (publication.kind === "screen" && (this.view.ownedScreens.has(publication.id) || state?.subscriptions.includes(publication.id))) {
        rooms.add(publication.roomId);
      }
    }
    return rooms;
  }

  private browseRooms(): void {
    if (this.view.connection !== "connected") return;
    const wanted = this.wantedReadings();
    for (const [id, reading] of this.readings) {
      const room = this.view.state?.channel.rooms.find(room => room.id === id);
      if (reading.socket !== this.socket || !room?.authorized || !room.available || room.delivery?.bindingId !== reading.bindingId) {
        this.closeInteraction(id); this.readings.delete(id);
      }
    }
    for (const id of wanted) {
      const room = this.view.state?.channel.rooms.find(room => room.id === id && room.authorized && room.available);
      if (!room?.delivery) continue;
      let reading = this.readings.get(id);
      if (!reading) {
        const capacity = readRoomPreferences().relayCapacityByRoom[`${this.view.state!.channel.id}/${id}`];
        reading = { roomId: id, bindingId: room.delivery.bindingId, socket: this.socket,
          ready: this.request({ type: "browse", roomId: id, active: true, ...(capacity !== undefined ? { relayCapacity: capacity } : {}) }) };
        this.readings.set(id, reading);
      }
      const current = reading;
      void current.ready.then(() => {
        if (this.readings.get(id) !== current || this.socket !== current.socket || !this.wantedReadings().has(id)) return;
        this.retireReadings();
        this.syncRoomReading(current);
        if (this.roomId !== id || current.history || this.view.pending.has(`history:${id}`)) return;
        current.history = this.action(`history:${id}`, () => this.request({ type: "history", roomId: id }).catch(error => {
          if (this.readings.get(id) === current && this.socket === current.socket) throw error;
        }));
        void current.history.catch(() => {});
      }, error => {
        if (this.readings.get(id) === current && this.socket === current.socket && this.view.connection === "connected") {
          this.closeInteraction(id); this.readings.delete(id);
          this.retireReadings();
          this.patch({ error: error instanceof Error ? error.message : "operation_failed" });
        }
      });
    }
    if (!this.reading) this.retireReadings();
  }

  private retireReadings(): void {
    const keep = this.wantedReadings();
    for (const id of this.view.interactionsByRoom.keys()) if (!keep.has(id)) this.closeInteraction(id);
    for (const [id] of this.readings) if (!keep.has(id)) {
      this.closeInteraction(id); this.readings.delete(id);
    }
    for (const id of this.readingRooms) {
      if (keep.has(id) && this.readings.has(id)) continue;
      const room = this.view.state?.channel.rooms.find(room => room.id === id);
      if (room?.authorized && !room.available) continue;
      if (room?.authorized) this.write({ type: "browse", roomId: id, active: false });
      this.readingRooms.delete(id);
    }
  }
  private closeInteraction(roomId: string): void {
    this.view.interactionsByRoom.get(roomId)?.close();
    const reading = this.readings.get(roomId);
    if (reading) delete reading.interaction;
    const interactionsByRoom = new Map(this.view.interactionsByRoom);
    if (interactionsByRoom.delete(roomId)) this.patch({ interactionsByRoom });
  }
  private closeInteractions(): void {
    for (const id of this.view.interactionsByRoom.keys()) this.closeInteraction(id);
  }

  private syncRoomReading(reading: RoomReading): void {
    void reading.ready.then(() => {
      if (this.readings.get(reading.roomId) !== reading || this.socket !== reading.socket || this.view.connection !== "connected" || !this.view.self) return;
      const room = this.view.state?.channel.rooms.find(room => room.id === reading.roomId && room.authorized && room.available);
      const delivery = room?.delivery;
      if (!delivery) return;
      if (reading.interaction) return;
      const interaction = this.view.interactionsByRoom.get(reading.roomId) ?? new RoomInteractionSession(message => {
        const current = this.readings.get(reading.roomId);
        if (current?.interaction !== interaction || this.view.connection !== "connected") return false;
        const nonce = message.type === "send-room-interaction" ? message.nonce ?? ++this.reactionNonce : undefined;
        const command = message.type === "subscribe-room-interactions" ? { type: "interaction_ready" as const, roomId: current.roomId }
          : message.payload.kind === "reaction" ? { type: "react" as const, roomId: current.roomId, reaction: message.payload.reaction, nonce: nonce!,
            target: message.contentTarget ? ("messageSeq" in message.contentTarget
              ? { type: "message" as const, messageSeq: message.contentTarget.messageSeq }
              : { type: "publication" as const, publicationId: message.contentTarget.publicationId })
              : { type: "person" as const, userId: message.payload.targetPeerId ?? this.view.self!.id } } : null;
        if (!command) return false;
        const requestId = message.type === "send-room-interaction" ? message.requestId : createOpaqueId();
        void this.conversation.send(command, requestId).catch(() => {
          if (this.readings.get(reading.roomId) !== current || current.interaction !== interaction) return;
          if (command.type === "interaction_ready") this.closeInteraction(reading.roomId);
          else interaction.receive({ type: "room-interaction-rejected", requestId, reason: "busy" });
        });
        return nonce === undefined ? true : { nonce };
      }, Date.now, undefined, event => this.playFeedback(reading.roomId, event));
      reading.interaction = interaction;
      this.patch({ interactionsByRoom: new Map([...this.view.interactionsByRoom, [reading.roomId, interaction]]) });
      interaction.authenticated(this.view.self.id);
    }).catch(() => {});
  }
  acceptInvitation = async (): Promise<string | null> => {
    const params = new URLSearchParams(location.hash.slice(1));
    const roomId = params.get("room"), key = params.get("invite");
    if (!key) return roomId || null;
    if (!roomId) return null;
    if (this.view.connection === "connected") await this.action(`enter:${roomId}`, () => this.request({ type: "enter_room", roomId, inviteKey: key }));
    return roomId;
  };
  sendMessage = (roomId: string, text: string, files: DraftFile[] = [], signal?: AbortSignal): Promise<void> => this.action(`chat:${roomId}`, async () => {
    if (files.length && !this.view.state?.channel.rooms.find(room => room.id === roomId)?.capabilities.attachments) throw new Error("attachments_unavailable");
    const sessionId = this.view.sessionId;
    const prepared = files.length ? await this.attachments.describe(files, signal) : [];
    if (this.closed || this.view.sessionId !== sessionId) throw new Error("disconnected");
    signal?.throwIfAborted();
    const attachments = prepared.map(file => file.attachment);
    const inlineImages = Object.fromEntries(prepared.flatMap(file => file.inlineImage ? [[file.id, file.inlineImage]] : []));
    const content = JSON.stringify({ text, attachments, inlineImages });
    const previous = this.outgoingMessages.get(roomId);
    const attempt = previous?.content === content ? previous : { content, nonce: crypto.randomUUID() };
    this.outgoingMessages.set(roomId, attempt);
    await this.request({ type: "chat", roomId, text, attachments, inlineImages, nonce: attempt.nonce }, event => {
      if (event.type === "confirmed") this.attachments.confirmed(roomId, event.message, prepared);
    });
    this.outgoingMessages.delete(roomId);
    if (this.view.historyByRoom[roomId]?.atLatest === false) void this.loadLatestHistory(roomId).catch(() => {});
  });
  loadHistory = (roomId: string): Promise<void> => this.requestHistory(roomId, this.view.historyByRoom[roomId]?.before);
  loadLatestHistory = (roomId: string): Promise<void> => this.requestHistory(roomId);
  private requestHistory(roomId: string, before?: number): Promise<void> {
    const reading = this.reading?.roomId === roomId ? this.reading : null;
    const pending = this.view.pending.has(`history:${roomId}`);
    const loading = this.action(`history:${roomId}`, () => this.request({ type: "history", roomId, ...(before !== undefined ? { before } : {}) }));
    if (reading && !pending) reading.history = loading;
    return loading;
  }
  updateProfile = ({ name, avatar }: { name: string; avatar: string | null }): Promise<void> => this.action("profile", async () => {
    await this.request({ type: "set_profile", name, avatar });
    stored(nameKey, name.trim());
  }, false);
  updateDomain = (settings: DomainSettings, reportError = true): Promise<void> => this.action("domain", () => this.request({ type: "update_domain", ...settings }), reportError);
  createRoom = (settings: RoomSettings, reportError = true): Promise<string> => this.action("create-room", async () => {
    const app = this.app?.connected ? this.app : undefined;
    const state = this.view.state, self = this.view.self, sessionId = this.view.sessionId;
    if (!state || !self || !sessionId) throw new Error("disconnected");
    const current = this.sessionContext();
    let room: RoomSummary | undefined;
    await this.request({ type: "create_room", room: roomSummarySchema.parse({ ...settings, id: "new", creatorId: self.id,
      hasPassword: settings.access === "private" && Boolean(settings.password) }) }, event => {
      if (event.type === "room_created") room = event.room;
    });
    current();
    if (!room) throw new Error("invalid_response");
    const runtime = await loadRoomHosting(), roomId = room.id;
    const policy = await runtime.createRoomPolicy({ ...settings, id: roomId, creatorId: self.id });
    if (app) {
      const room = await app.open(policy);
      if (this.view.sessionId !== sessionId || this.closed) throw new Error("disconnected");
      await this.request({ type: "browse", roomId: room.id, active: true });
      return room.id;
    }
    const storage = await this.browserStorage(state.channel.id, self.id);
    const host = await storage.open(policy);
    if (this.view.sessionId !== sessionId || this.closed) { await host.close(); throw new Error("disconnected"); }
    this.hostedRooms.set(roomId, { host });
    const summary = await host.summary();
    if (this.hostedRooms.get(roomId)?.host !== host || this.view.sessionId !== sessionId || this.closed) throw new Error("disconnected");
    await this.request({ type: "host_register", room: summary });
    await this.request({ type: "browse", roomId, active: true });
    return roomId;
  }, reportError);
  private sessionContext(): () => void {
    const { sessionId, self, state } = this.view, socket = this.socket;
    if (!sessionId || !self || !state || this.view.connection !== "connected") throw new Error("disconnected");
    return () => {
      if (this.closed || this.socket !== socket || this.view.connection !== "connected"
        || this.view.sessionId !== sessionId || this.view.self?.id !== self.id || this.view.state?.channel.id !== state.channel.id) throw new Error("disconnected");
    };
  }

  private connectionContext(roomId: string, publicationId?: string) {
    const selection = this.roomId;
    const room = this.view.state?.channel.rooms.find(room => room.id === roomId);
    if (!room?.authorized || !room.available || !room.delivery) throw new Error("room_unavailable");
    const bindingId = room.delivery.bindingId;
    const publication = publicationId ? this.view.state?.publications.find(value => value.id === publicationId
      && value.roomId === roomId && value.kind === "screen") : undefined;
    if (publicationId && !publication) throw new Error("publication_unavailable");
    return { bindingId, sourceSessionId: publication?.sessionId, current: () => {
      const actual = this.view.state?.channel.rooms.find(room => room.id === roomId);
      if (this.roomId !== selection || !actual?.authorized || !actual.available || actual.delivery?.bindingId !== bindingId
        || (publicationId && !this.view.state?.publications.some(value => value.id === publicationId
          && value.roomId === roomId && value.sessionId === publication?.sessionId && value.kind === "screen"))) throw new Error("room_context_changed");
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
    }, roomId, signal);
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
    const current = () => {
      check();
      const next = this.view.state?.channel.rooms.find(room => room.id === roomId)?.delivery;
      if (next?.bindingId !== delivery.bindingId || next.hostSessionId !== delivery.hostSessionId) throw new Error("room_host_conflict");
    };
    const hosted = this.hostedRooms.get(roomId);
    if (hosted && delivery.hostSessionId === this.view.sessionId && hosted.bindingId === delivery.bindingId) {
      return { current, snapshot: () => hosted.host.snapshot() };
    }
    const app = this.app?.connected ? this.app : undefined;
    if (app) {
      const description = await app.describeHosting().catch(() => undefined); current();
      if (description && this.app === app && app.connected && description.sessionId === delivery.hostSessionId && description.roomIds.includes(roomId)) {
        return { current: () => { current(); if (this.app !== app || !app.connected) throw new Error("app_disconnected"); },
          native: { snapshot: () => app.snapshotRoom(roomId), restore: (blob: Blob) => app.restoreRoom(blob) } };
      }
    }
    if (state.channel.ownerId === self.id && this.credential) {
      const native = new NativeRoomHosting("/prototype/channel/rooms", { Authorization: `Bearer ${this.credential}` }, "/prototype/channel/hosting");
      const description = await native.describe().catch(() => undefined); current();
      if (description && description.sessionId === delivery.hostSessionId && description.roomIds.includes(roomId)) {
        return { current, native: { snapshot: () => native.snapshot(roomId), restore: (blob: Blob) => native.restore(blob) } };
      }
    }
    throw new Error("room_host_unavailable");
  }

  roomBackupAvailable = async (roomId: string): Promise<boolean> => {
    try { await this.backupOwner(roomId); return true; } catch { return false; }
  };

  private async writeRoomSnapshot(snapshot: BrowserRoomSnapshot, metadata: Exclude<BackupMetadata, { kind: "domain" }>, retained: RetainedFile[], check: () => void): Promise<Blob> {
    const files = new Map<string, File>(), inventory: RetainedBackupFile[] = [];
    const byKey = new Map(retained.map(file => [JSON.stringify([file.key.messageSeq, file.key.attachmentId]), file]));
    for await (const row of snapshot.rows) {
      check();
      if (metadata.kind === "room_copy" && !row.archivedAuthorName) {
        const name = this.view.state!.users.find(user => user.id === row.userId)?.name;
        if (name) metadata.authors[row.userId] = name;
      }
      for (const attachment of row.attachments) {
        const entry = byKey.get(JSON.stringify([row.seq, attachment.id]));
        if (entry && entry.attachment.sha256.toLowerCase() === attachment.sha256.toLowerCase()
          && entry.attachment.id === attachment.id && entry.attachment.name === attachment.name && entry.attachment.mediaType === attachment.mediaType && entry.attachment.size === attachment.size && entry.file.size === attachment.size) {
          inventory.push({ messageSeq: row.seq, attachment }); files.set(attachment.sha256.toLowerCase(), entry.file);
        }
      }
    }
    const archive = await writeBackup({ ...metadata, retainedFiles: inventory }, snapshot.rows,
      async entry => { check(); return files.get(entry.attachment.sha256.toLowerCase())!; });
    check(); return archive;
  }

  exportRoomBackup = (roomId: string): Promise<Blob> => this.action("room-backup", () => this.exportRoomArchive(roomId), false);

  exportRoomCopy = (roomId: string, includeRoomInfo: boolean): Promise<Blob> =>
    this.action("room-backup", () => this.exportRoomArchive(roomId, { includeRoomInfo }), false);

  private async exportRoomArchive(roomId: string, copy?: { includeRoomInfo: boolean }): Promise<Blob> {
    const owner = await this.backupOwner(roomId), retained = await this.attachments.retained(roomId); owner.current();
    let snapshot: BrowserRoomSnapshot | undefined;
    try {
      let metadata: Extract<BackupMetadata, { kind: "room" }>;
      if (owner.native) {
        const archive = await owner.native.snapshot(); owner.current();
        if (!retained.length && !copy) return archive;
        let stage: BrowserRoomStage | undefined;
        try {
          const value = await readBackup(archive, {
            metadata: async value => {
              owner.current();
              if (value.kind !== "room" || value.policy.id !== roomId || value.domainId !== this.view.state!.channel.id) throw new Error("invalid_backup");
              metadata = value;
              stage = await (await loadRoomHosting()).BrowserRoomHost.stage(roomDatabaseName(value.domainId, this.view.self!.id), JSON.stringify(value.policy));
            }, row: row => stage!.append(row), content(digest, file) {
              for (const entry of metadata.retainedFiles.filter(entry => entry.attachment.sha256.toLowerCase() === digest)) {
                retained.push({ key: { roomId, messageSeq: entry.messageSeq, attachmentId: entry.attachment.id }, attachment: entry.attachment, file });
              }
            },
          });
          if (value.kind !== "room") throw new Error("invalid_backup");
          snapshot = stage; metadata = value;
        } catch (error) { await stage?.close(); throw error; }
      } else {
        snapshot = await owner.snapshot!(); owner.current();
        metadata = { kind: "room", version: 2, domainId: this.view.state!.channel.id,
          policy: JSON.parse(snapshot.policy), retainedFiles: [] };
      }
      if (copy) {
        const { name, icon, voiceBitrate, relayCapacity } = metadata.policy;
        return await this.writeRoomSnapshot(snapshot!, { kind: "room_copy", version: 1,
          roomInfo: copy.includeRoomInfo ? { name, icon, voiceBitrate, relayCapacity } : undefined,
          authors: {}, retainedFiles: [] }, retained, owner.current);
      }
      if (metadata.policy.creatorId === this.view.self!.id && this.credential) metadata.ownCredential = { userId: this.view.self!.id, credential: this.credential };
      return await this.writeRoomSnapshot(snapshot!, metadata, retained, owner.current);
    } finally { await snapshot?.close(); }
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

  private async admitBackupIdentity(metadata: Extract<BackupMetadata, { kind: "room" }>): Promise<(() => Promise<void>) | undefined> {
    if (metadata.policy.creatorId === this.view.self?.id) return;
    const check = this.sessionContext(), archived = metadata.ownCredential;
    if (!archived || archived.userId !== metadata.policy.creatorId) throw new Error("backup_identity_required");
    const response = await fetch("/prototype/channel/identity", { headers: { Authorization: `Bearer ${archived.credential}` }, cache: "no-store" });
    if (!response.ok) throw new Error("backup_identity_required");
    const identity = z.object({ domainId: z.string(), user: userSchema }).parse(await response.json()); check();
    if (identity.domainId !== metadata.domainId || identity.user.id !== archived.userId) throw new Error("backup_identity_required");
    const previous = { credential: this.credential, ownerKey: this.ownerKey, roomId: this.roomId,
      hash: location.hash };
    const rollback = async () => {
      this.close(); this.credential = previous.credential;
      if (previous.credential) stored(credentialKey, previous.credential);
      this.ownerKey = previous.ownerKey; this.roomId = previous.roomId;
      if (typeof history !== "undefined") history.replaceState(null, "", location.pathname + location.search + previous.hash);
      this.start();
    };
    try { await this.connectBackupIdentity(metadata.domainId, archived.userId, { credential: archived.credential }, metadata.policy.id); }
    catch (error) { await rollback(); throw error; }
    if (typeof history !== "undefined") history.replaceState(null, "", location.pathname + location.search);
    return rollback;
  }

  private async connectBackupIdentity(domainId: string, userId: string, identity: { credential?: string; ownerKey?: string }, skipRoom?: string): Promise<void> {
    this.close(); this.credential = identity.credential; this.ownerKey = identity.ownerKey; this.roomId = "";
    this.closed = false;
    let socket: WebSocket | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        let waiting = true;
        const timer = setTimeout(() => { waiting = false; reject(new Error("request_timeout")); }, 10000);
        this.connect(event => {
          if (!waiting) throw new Error("backup_identity_required");
          const actual = event.state.sessions.find(value => value.id === event.sessionId)?.userId;
          if (event.state.channel.id !== domainId || actual !== userId
            || (identity.ownerKey !== undefined && event.state.channel.ownerId !== userId)) {
            clearTimeout(timer); reject(new Error("backup_identity_required")); throw new Error("backup_identity_required");
          }
          waiting = false; clearTimeout(timer); resolve(); return skipRoom;
        });
        socket = this.socket;
      });
    } catch (error) {
      if (this.socket === socket) this.close();
      throw error;
    }
  }

  private domainBackupOwner(): { current(): void; native: NativeDomainHosting } {
    const current = this.sessionContext();
    if (this.view.state!.channel.ownerId !== this.view.self!.id || !this.credential) throw new Error("forbidden");
    return { current, native: new NativeDomainHosting({ Authorization: `Bearer ${this.credential}` }) };
  }

  exportDomainBackup = (): Promise<Blob> => this.action("domain-backup", async () => {
    const owner = this.domainBackupOwner(), archive = await owner.native.snapshot(); owner.current();
    return archive;
  }, false);

  restoreDomainBackup = (archive: Blob): Promise<DomainSettings> => this.action("domain-backup", async () => {
    const owner = this.domainBackupOwner();
    const metadata = await readBackup(archive, { metadata(value) {
      if (value.kind !== "domain") throw new Error("expected_domain_backup");
    }, row() {}, content() {} });
    owner.current();
    if (metadata.kind !== "domain") throw new Error("expected_domain_backup");
    this.close();
    let committed = false;
    try {
      const domainId = await owner.native.restore(archive); committed = true;
      if (!this.closed || this.socket) throw new Error("disconnected");
      if (domainId !== metadata.state.id) throw new Error("backup_identity_required");
      await this.connectBackupIdentity(domainId, metadata.state.ownerId, { ownerKey: metadata.ownerKey });
      if (typeof history !== "undefined") history.replaceState(null, "", location.pathname + location.search);
      const { name, icon } = this.view.state!.channel;
      return { name, icon };
    } catch (error) {
      const restored = error instanceof Error && error.message === "domain_restored_connection_failed";
      if (committed || restored) {
        if (!committed && this.closed && !this.socket) {
          await this.connectBackupIdentity(metadata.state.id, metadata.state.ownerId, { ownerKey: metadata.ownerKey }).catch(() => {});
        }
        throw new Error("domain_restored_connection_failed");
      }
      this.start();
      throw error;
    }
  }, false);

  inspectRoomCopy = async (archive: Blob) => {
    const metadata = await readBackup(archive);
    if (metadata.kind !== "room_copy") throw new Error("expected_room_copy");
    return metadata.roomInfo ?? {};
  };

  importRoomCopy = (archive: Blob, settings: RoomSettings): Promise<{ roomId: string; cached: boolean }> => this.action("room-backup", async () => {
    const current = this.sessionContext(), state = this.view.state!, self = this.view.self!;
    const runtime = await loadRoomHosting();
    const policy = await runtime.createRoomPolicy({ ...settings, id: crypto.randomUUID(), creatorId: self.id });
    current();
    let stage: BrowserRoomStage | undefined, importer: BackupHistoryImport | undefined, converted: Blob;
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
        content: (digest, file) => { contents.set(digest, file); },
      });
      current(); importer!.finish();
      if (metadata.kind !== "room_copy") throw new Error("expected_room_copy");
      converted = await writeBackup({ kind: "room", version: 2, domainId: state.channel.id,
        policy: JSON.parse(policy), retainedFiles: metadata.retainedFiles }, stage!.rows,
        async entry => contents.get(entry.attachment.sha256.toLowerCase())!);
      current();
    } finally { importer?.free(); await stage?.close(); }
    return this.restoreRoomArchive(converted);
  }, false);

  restoreRoomBackup = (archive: Blob, roomId?: string): Promise<{ roomId: string; cached: boolean }> =>
    this.action("room-backup", () => this.restoreRoomArchive(archive, roomId), false);

  private async restoreRoomArchive(archive: Blob, roomId?: string): Promise<{ roomId: string; cached: boolean }> {
    const initial = this.sessionContext(), owner = roomId ? await this.backupOwner(roomId) : undefined;
    let stage: BrowserRoomStage | undefined, rollback: (() => Promise<void>) | undefined, committed = false;
    const contents = new Map<string, File>();
    try {
      const metadata = await readBackup(archive, {
        metadata: async value => {
          initial();
          if (value.kind !== "room" || value.domainId !== this.view.state!.channel.id || (roomId && value.policy.id !== roomId)) throw new Error("backup_room_mismatch");
          const runtime = await loadRoomHosting(); initial();
          stage = await runtime.BrowserRoomHost.stage(roomDatabaseName(value.domainId, value.policy.creatorId), JSON.stringify(value.policy));
        }, row: row => stage!.append(row), content: (digest, file) => { contents.set(digest, file); },
      });
      initial(); owner?.current();
      if (metadata.kind !== "room" || !stage) throw new Error("invalid_backup");
      if (!roomId && this.view.state!.channel.rooms.some(room => room.id === metadata.policy.id && room.available)) throw new Error("room_host_conflict");
      if (roomId && metadata.policy.creatorId !== this.view.self!.id) throw new Error("backup_identity_required");
      rollback = await this.admitBackupIdentity(metadata);
      const admission = this.sessionContext();
      if (!this.view.state!.channel.rooms.some(room => room.id === metadata.policy.id)) {
        await this.request({ type: "admit_room", room: roomSummarySchema.parse({ ...metadata.policy, hasPassword: metadata.policy.passwordHash != null }) });
        admission();
      }
      const check = this.sessionContext(), target = metadata.policy.id;
      const app = this.app?.connected ? this.app : undefined;
      const native = owner?.native ?? (!roomId && app ? { restore: (blob: Blob) => app.restoreRoom(blob) } : undefined);
      const previousDelivery = this.view.state?.channel.rooms.find(room => room.id === target)?.delivery;
      const oldBinding = previousDelivery?.bindingId;
      let expectedHost = owner?.native ? previousDelivery?.hostSessionId : this.view.sessionId;
      check(); owner?.current();
      if (native) {
        if (!owner && this.app !== app) throw new Error("app_disconnected");
        const restored = await native.restore(archive); committed = true; check();
        if (restored.id !== target) throw new Error("backup_room_mismatch");
        if (!owner && app) {
          const description = await app.describeHosting(); check();
          if (this.app !== app || !app.connected || !description.roomIds.includes(target)) throw new Error("app_disconnected");
          expectedHost = description.sessionId;
        }
      }
      else {
        const hosted = this.hostedRooms.get(target);
        // The transaction retires the durable writer. Keep the old host alive
        // until commit so a storage rollback needs no competing registration.
        const cancel = new AbortController();
        const unsubscribe = this.subscribe(() => { try { check(); } catch { cancel.abort(); } });
        try { check(); await stage.replace(cancel.signal); committed = true; }
        finally { unsubscribe(); }
        if (hosted && this.hostedRooms.get(target) === hosted) {
          this.hostedRooms.delete(target);
          if (hosted.bindingId) this.write({ type: "host_stop", roomId: target, bindingId: hosted.bindingId });
          await hosted.host.close();
        }
        const host = await (await this.browserStorage(metadata.domainId, metadata.policy.creatorId)).open(stage.policy);
        try { check(); } catch (error) { await host.close(); throw error; }
        this.hostedRooms.set(target, { host });
        await this.request({ type: "host_register", room: await host.summary() });
      }
      await this.waitForState(() => {
        const room = this.view.state?.channel.rooms.find(room => room.id === target);
        return !!room?.available && !!room.delivery && room.delivery.hostSessionId === expectedHost && room.delivery.bindingId !== oldBinding;
      });
      check();
      this.browse(target);
      await this.reading?.ready; check();
      const entries = metadata.retainedFiles.map(value => ({ key: { roomId: target, messageSeq: value.messageSeq, attachmentId: value.attachment.id },
        attachment: value.attachment, file: contents.get(value.attachment.sha256.toLowerCase())! }));
      const cached = await this.attachments.restoreRetained(target, entries);
      return { roomId: target, cached };
    } catch (error) {
      if (committed || error instanceof Error && error.message === "room_restored_connection_failed") {
        throw new Error("room_restored_connection_failed");
      }
      await rollback?.();
      throw error;
    }
    finally { await stage?.close(); }
  }

  updateRoom = (roomId: string, settings: RoomSettings, reportError = true): Promise<void> => this.action(`room:${roomId}`, () => this.request({ type: "update_room", roomId, ...settings }), reportError);
  setRelayOverride = (roomId: string, capacity: number | null, reportError = true): Promise<void> => this.action(`relay:${roomId}`, async () => {
    const current = this.sessionContext();
    const key = `${this.view.state!.channel.id}/${roomId}`;
    await this.request({ type: "relay_capacity", roomId, capacity });
    current();
    const relayCapacityByRoom = { ...readRoomPreferences().relayCapacityByRoom };
    if (capacity === null) delete relayCapacityByRoom[key];
    else relayCapacityByRoom[key] = capacity;
    saveRoomPreferences({ relayCapacityByRoom });
  }, reportError);
  deleteRoom = (roomId: string, deleteData: boolean, reportError = true): Promise<{ dataRemoved: boolean }> => this.action(`delete:${roomId}`, async () => {
    let dataRemoved: boolean | undefined;
    await this.request({ type: "delete_room", roomId, deleteData }, event => {
      if (event.type !== "room_reply" || event.result.type !== "deleted" || typeof event.result.dataRemoved !== "boolean") throw new Error("invalid_response");
      dataRemoved = event.result.dataRemoved;
    });
    if (dataRemoved === undefined) throw new Error("invalid_response");
    if (this.roomId === roomId) this.browse("");
    return { dataRemoved };
  }, reportError);

  setRoomVoiceBitrate = (roomId: string, voiceBitrate: number): Promise<void> => {
    const room = this.view.state?.channel.rooms.find(room => room.id === roomId);
    if (!room?.canManage) return Promise.reject(new Error("forbidden"));
    if (!Number.isInteger(voiceBitrate) || voiceBitrate < 6_000 || voiceBitrate > 320_000) return Promise.reject(new Error("invalid_audio_bitrate"));
    return this.updateRoom(roomId, { name: room.name, icon: room.icon, access: room.access, hidden: room.hidden, voiceBitrate });
  };
  enterRoom = (roomId: string, password: string): Promise<void> => this.action(`enter:${roomId}`, () => this.request({ type: "enter_room", roomId, password }));
  private roomInvitationURL(roomId: string, key: string): string {
    const url = new URL(location.pathname, this.invitationOrigin);
    url.hash = new URLSearchParams({ room: roomId, invite: key }).toString();
    return url.href;
  }
  getRoomInvite = async (roomId: string): Promise<RoomInvitationState> => {
    let invitation: RoomInvitationState | undefined;
    await this.request({ type: "get_room_invite", roomId }, event => {
      if (event.type === "room_invite_state") invitation = event.invitation.state === "available"
        ? { state: "available", url: this.roomInvitationURL(roomId, event.invitation.key) } : event.invitation;
    });
    if (!invitation) throw new Error("invalid_response");
    return invitation;
  };
  createRoomInvite = (roomId: string, reportError = true): Promise<string> => this.action(`invite:${roomId}`, async () => {
    let key: string | undefined;
    await this.request({ type: "room_invite", roomId }, event => { if (event.type === "room_invite") key = event.key; });
    if (!key) throw new Error("invalid_response");
    return this.roomInvitationURL(roomId, key);
  }, reportError);
  revokeRoomAccess = (roomId: string, userId: string, reportError = true): Promise<void> => this.action(`revoke:${roomId}:${userId}`, () => this.request({ type: "revoke_room_access", roomId, userId }), reportError);
  watch = (publicationId: string, roomId?: string, signal?: AbortSignal): Promise<void> => {
    const watch: ScreenWatch = {};
    let describedApp: ChannelApp | undefined;
    const operation = this.action(`watch:${publicationId}`, async () => {
      if (signal?.aborted) throw new DOMException("Capture cancelled", "AbortError");
      this.watching.set(publicationId, watch);
      try {
        const app = this.app;
        if (app?.connected && !this.view.localScreens.has(publicationId)) {
          watch.query = new AbortController();
          const lifetime = AbortSignal.any([watch.query.signal, this.captureLifetime.signal, ...(signal ? [signal] : [])]);
          const description = await app.describeHosting(lifetime).catch(() => undefined);
          watch.query = undefined;
          lifetime.throwIfAborted();
          if (description && this.app === app && app.connected) {
            this.rememberLocalEndpoint(app, description.sessionId);
            watch.helperSessionId = description.sessionId;
            describedApp = app;
          }
          if (!this.watching.has(publicationId)) return;
        }
        await this.request({ type: "subscribe", publicationId, enabled: true, helperSessionId: watch.helperSessionId }, undefined, roomId);
        if (signal?.aborted) throw new DOMException("Capture cancelled", "AbortError");
      } catch (error) {
        if (!signal?.aborted && error instanceof Error && error.message === "disconnected") return;
        this.retireWatch(publicationId);
        this.refreshActivity();
        if (signal?.aborted) throw new DOMException("Capture cancelled", "AbortError");
        throw error;
      }
    });
    watch.operation = operation;
    return operation.finally(() => { watch.operation = undefined; }).then(() => {
      if (this.app !== describedApp || !describedApp?.connected) void this.syncAppWatching();
    });
  };
  private retireWatch(publicationId: string): void {
    this.watching.get(publicationId)?.query?.abort();
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
      this.refreshActivity();
      if (this.view.connection === "connected") await this.request({ type: "subscribe", publicationId, enabled: false });
    });
  };
  clearError = (): void => this.patch({ error: null });

  async publish(kind: "screen" | "voice", roomId: string, stream: MediaStream, { microphone, audio, profile, codec, camera, source, publicationId }: { microphone?: MicrophoneInput; audio?: HostAudio; profile?: QualityProfile; codec?: BrowserVideoCodecPreference; camera?: boolean; source?: ScreenSource; publicationId?: string } = {}): Promise<string> {
    const id = publicationId ?? crypto.randomUUID();
    const sourceProfile = kind === "screen" ? profile ?? this.view.quality : undefined;
    this.local.set(id, { roomId, kind, stream, microphone, audio, profile: sourceProfile, camera });
    this.media.setLocal(id, stream, sourceProfile, codec);
    try {
      if (microphone && !microphone.stream.active) throw new Error("microphone_unavailable");
      await this.request({ type: "publish", publication: { id, roomId, kind,
        ...(sourceProfile ? { videoSettings: screenVideoSettings(sourceProfile), source: source ?? captureSource(stream.getVideoTracks()[0], camera) } : {}) } });
      const primary = kind === "screen" ? stream.getVideoTracks()[0] : stream.getAudioTracks()[0];
      if (primary?.readyState === "ended" || (microphone && !microphone.stream.active)) {
        this.send({ type: "unpublish", publicationId: id });
        throw new Error(kind === "screen" ? "capture_unavailable" : "microphone_unavailable");
      }
      this.admittedPublications.add(id);
      if (kind === "screen") this.observeScreen(id, stream);
      else primary?.addEventListener("ended", () => this.voiceCaptureEnded(id, stream), { once: true });
      return id;
    } catch (error) {
      audio?.dispose();
      this.local.delete(id);
      this.media.removeLocal(id);
      throw error;
    }
  }

  private selectScreen(roomId: string): { share: ScreenShare; current(): boolean } {
    let share = this.screenShares.get(roomId);
    if (!share) {
      const local = [...this.local].find(([, capture]) => capture.kind === "screen" && capture.roomId === roomId);
      share = { id: local?.[0] ?? crypto.randomUUID(), profile: local?.[1].profile ?? this.view.quality,
        codecMode: this.view.videoCodecMode,
        volume: { level: 1, muted: false }, microphone: { deviceId: "", volume: 1, voiceProcessing: true } };
      this.screenShares.set(roomId, share);
    }
    if (share.audioChange || share.qualityChange || this.view.pending.has(`source-microphone:${share.id}`)) throw new Error("operation_pending");
    share.selection?.abort();
    const selection = share.selection = new AbortController();
    const selected = share;
    return { share, current: () => this.screenShares.get(roomId) === selected && selected.selection === selection };
  }

  private finishScreenSelection(roomId: string, share: ScreenShare): void {
    share.selection?.abort();
    share.selection = undefined;
    if (!this.local.has(share.id) && !this.app?.screens.has(share.id) && this.screenShares.get(roomId) === share) this.screenShares.delete(roomId);
  }

  private observeScreen(id: string, stream: MediaStream): void {
    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      if (this.local.get(id)?.stream === stream) void this.stopScreen(id).catch(() => {});
    }, { once: true });
  }

  cancelScreenSelection = async (roomId: string): Promise<void> => {
    const share = this.screenShares.get(roomId);
    if (!share || !share.selection && (!share.microphoneChange || this.local.has(share.id))) return;
    if (share.selection) this.finishScreenSelection(roomId, share);
    else share.requestedMicrophone = undefined;
    await this.app?.cancelCapture(share.id);
    this.patch({});
  };

  startScreen = (roomId: string, source: BrowserCaptureSource = "browser", deviceId = ""): Promise<void> => this.action(`screen:${roomId}`, async () => {
    if (source === "camera" ? !navigator.mediaDevices?.getUserMedia : !navigator.mediaDevices?.getDisplayMedia) throw new Error("capture_unavailable");
    const { share, current } = this.selectScreen(roomId);
    let candidate: MediaStream | undefined;
    let audio: HostAudio | undefined;
    try {
      candidate = await captureBrowserSource(share.profile, source, deviceId, share.selection!.signal);
      if (!current()) throw new DOMException("Capture cancelled", "AbortError");
      const video = candidate.getVideoTracks()[0];
      const metadata = captureSource(video, source === "camera");
      if (!video || video.readyState !== "live") throw new Error("capture_unavailable");
      const codec = share.codec ?? (share.codecMode === "auto"
        ? automaticVideoCodecPreference(await preferredVideoCodecForTrack(video, share.selection!.signal))
        : manualVideoCodecPreference(share.codecMode));
      if (!current()) throw new DOMException("Capture cancelled", "AbortError");
      share.codec = codec;
      const previous = this.local.get(share.id);
      const retainedAudio = previous?.audio;
      if (!retainedAudio) {
        const mixer = new HostAudio(candidate, source, () => {
          if (this.local.get(share.id)?.audio === mixer) this.patch({});
        });
        audio = mixer;
        audio.setVolume(share.volume.muted ? 0 : share.volume.level);
        candidate = await audio.start();
        if (!audio.outputGainAvailable && audio.sourceAudioAvailable && (share.volume.muted || share.volume.level !== 1)) throw new Error("source_audio_unavailable");
      }
      if (!current()) throw new DOMException("Capture cancelled", "AbortError");
      if (candidate.getVideoTracks()[0]?.readyState !== "live") throw new Error("capture_unavailable");
      const app = this.app;
      if (previous || app?.screens.has(share.id)) {
        const sessionId = this.view.sessionId;
        if (!sessionId) throw new Error("disconnected");
        if (previous) await this.request({ type: "transfer_source", publicationId: share.id, toSessionId: sessionId }, undefined, roomId);
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
        if (candidate.getVideoTracks()[0]?.readyState !== "live") {
          if (!previous) {
            // The Native transfer already made this Browser the publication owner.
            this.send({ type: "unpublish", publicationId: share.id });
            await this.stopScreen(share.id);
          }
          throw new Error("capture_unavailable");
        }
        if (retainedAudio) candidate = retainedAudio.attach(candidate, source);
        const mixed = retainedAudio ?? audio;
        const paused = share.paused = (previous ? share.paused : undefined)
          ?? this.view.state?.publications.find(publication => publication.id === share.id)?.paused ?? false;
        setMediaPaused(candidate, paused);
        if (mixed) setMediaPaused(mixed.sourceStream, paused);
        this.local.set(share.id, { roomId, kind: "screen", stream: candidate, audio: mixed, profile: share.profile, camera: source === "camera" });
        this.admittedPublications.add(share.id);
        this.media.setLocal(share.id, candidate, share.profile, codec, paused);
        this.observeScreen(share.id, candidate);
        candidate = undefined;
        audio = undefined;
        previous?.stream.getVideoTracks().forEach(track => track.stop());
        const reporting = this.request({ type: "publish", publication: {
          id: share.id, roomId, kind: "screen", videoSettings: screenVideoSettings(share.profile), source: metadata,
        } }, undefined, roomId);
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
        await this.publish("screen", roomId, stream, { audio: mixer, profile: share.profile, codec, camera: source === "camera", source: metadata, publicationId: share.id });
      }
    } finally {
      audio?.dispose();
      candidate?.getTracks().forEach(track => track.stop());
      this.finishScreenSelection(roomId, share);
    }
  });
  cameraPreviews = (signal: AbortSignal, publish: (sources: CameraPreview[]) => void): Promise<void> =>
    loadCameraPreviews(signal, publish, [...this.local.values()].find(capture => capture.camera
      && capture.stream.getVideoTracks().some(track => track.readyState === "live"))?.stream);
  nativeSources = async (): Promise<NativeCaptureSources> => (await this.connectApp()).sources();
  nativePreview = (target: NativeCaptureTarget, signal?: AbortSignal): Promise<string | null> =>
    this.app?.preview(target, signal) ?? Promise.resolve(null);
  nativeCaptureRequest = (roomId: string) => this.app?.captureRequest(roomId);
  nativeCaptureSelection = (roomId: string) => {
    const share = this.screenShares.get(roomId);
    return share?.native && { ...share.native, current: !this.local.has(share.id) && !!this.app?.screens.has(share.id) };
  };

  sourceMicrophone = (publicationId: string) => {
    const share = [...this.screenShares.values()].find(share => share.id === publicationId);
    if (!share) return undefined;
    const local = this.local.get(publicationId);
    const browser = local?.kind === "screen";
    const actual = browser ? { ...share.microphone, enabled: !!local.audio?.microphoneEnabled }
      : this.app?.sourceMicrophone(publicationId) ?? { enabled: false, deviceId: "", volume: 1 };
    return { ...actual, browser, canDisable: browser ? !!local.audio : !!this.app?.connected && this.app.screens.has(publicationId),
      available: browser ? !!local.audio?.commentaryAvailable : !!this.app?.screens.has(publicationId),
      requested: share.requestedMicrophone ?? actual };
  };

  sourceMicrophones = (publicationId: string) => this.local.get(publicationId)?.kind === "screen"
    ? browserCaptureDevices("audioinput") : this.app?.screens.has(publicationId) ? this.app.sourceMicrophones() : Promise.resolve([]);

  setSourceMicrophone = (publicationId: string, settings: SourceMicrophoneSettings): Promise<void> => {
    const owner = [...this.screenShares].find(([, share]) => share.id === publicationId);
    const share = owner?.[1];
    const actual = this.sourceMicrophone(publicationId);
    const local = this.local.get(publicationId), app = this.app;
    const stopping = settings.enabled === false && actual?.canDisable;
    if (!share || share.selection && !stopping || !actual?.available) return Promise.reject(new Error("microphone_unavailable"));
    if (share.microphoneChange && !share.requestedMicrophone && !stopping) return share.microphoneChange;
    const next = { ...actual.requested, ...settings };
    if (!Number.isFinite(next.volume) || next.volume < 0 || next.volume > 2) return Promise.reject(new Error("invalid_audio_settings"));
    share.requestedMicrophone = next;
    if (stopping && local?.audio) void local.audio.setMicrophone(false, share.microphone);
    else if (stopping && share.microphoneChange && app) {
      // The existing Native microphone owner cancels its own pending input on off.
      void app.setSourceMicrophone(publicationId, owner![0], { enabled: false, deviceId: next.deviceId, volume: next.volume })
        .catch(error => {
          if (this.screenShares.get(owner![0]) === share && this.app === app)
            this.patch({ error: error instanceof Error ? error.message : "microphone_unavailable" });
        });
    }
    this.patch({});
    if (share.microphoneChange) return share.microphoneChange;
    const current = () => [...this.screenShares.values()].includes(share)
      && (local ? this.local.get(publicationId) === local : this.app === app && !!app?.screens.has(publicationId));
    share.microphoneChange = this.action(`source-microphone:${publicationId}`, async () => {
      do {
        const wanted = share.requestedMicrophone;
        if (!wanted) throw new DOMException("Capture cancelled", "AbortError");
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
            await app!.setSourceMicrophone(publicationId, owner![0], {
              enabled: wanted.enabled, deviceId: wanted.deviceId, volume: wanted.volume,
            });
            if (!current()) throw new DOMException("Capture cancelled", "AbortError");
          }
        } catch (error) {
          if (current() && share.requestedMicrophone && wanted !== share.requestedMicrophone) continue;
          throw error;
        }
        this.patch({});
        if (wanted === share.requestedMicrophone) return;
      } while (current());
      throw new DOMException("Capture cancelled", "AbortError");
    }).finally(() => { share.microphoneChange = undefined; share.requestedMicrophone = undefined; this.patch({}); });
    return share.microphoneChange;
  };

  screenCodecMode = (publicationId: string) => [...this.screenShares.values()].find(share => share.id === publicationId)?.codecMode;

  screenQuality = (publicationId: string) => {
    const share = [...this.screenShares.values()].find(share => share.id === publicationId);
    return share ? { applied: share.profile, requested: share.requestedProfile ?? share.profile } : undefined;
  };

  setScreenQuality = (publicationId: string, requested: QualityProfile): Promise<void> => {
    const share = [...this.screenShares.values()].find(share => share.id === publicationId);
    if (!share || share.selection || share.audioChange) return Promise.reject(new Error("capture_unavailable"));
    const profile = { ...requested, maxAudioBitrate: share.profile.maxAudioBitrate };
    if (!supportsCaptureProfile(profile)) return Promise.reject(new Error("capture_quality_unsupported"));
    share.requestedProfile = profile;
    this.patch({});
    if (share.qualityChange) return share.qualityChange;
    const current = () => [...this.screenShares.values()].includes(share);
    share.qualityChange = this.action(`quality:${publicationId}`, async () => {
      do {
        const profile = share.requestedProfile!;
        try {
          const local = this.local.get(publicationId);
          if (local) {
            const previous = share.profile;
            await this.media.configureLocal(publicationId, profile);
            if (!current() || this.local.get(publicationId) !== local) throw new DOMException("Capture cancelled", "AbortError");
            try {
              await this.request({ type: "publish", publication: { id: publicationId, roomId: local.roomId, kind: "screen",
                videoSettings: screenVideoSettings(profile) } });
            } catch (error) {
              if (current() && this.local.get(publicationId) === local) await this.media.configureLocal(publicationId, previous);
              throw error;
            }
            if (!current() || this.local.get(publicationId) !== local) throw new DOMException("Capture cancelled", "AbortError");
            local.profile = profile;
          } else {
            const app = this.app;
            if (!app?.screens.has(publicationId)) throw new Error("capture_unavailable");
            await app.setCaptureQuality(publicationId, profile);
            if (this.app !== app) throw new DOMException("Capture cancelled", "AbortError");
          }
        } catch (error) {
          if (current() && share.requestedProfile !== profile) continue;
          throw error;
        }
        if (!current()) throw new DOMException("Capture cancelled", "AbortError");
        share.profile = profile;
        this.patch({});
        if (share.requestedProfile === profile) { this.setQuality(profile); return; }
      } while (current());
      throw new DOMException("Capture cancelled", "AbortError");
    }).finally(() => { share.qualityChange = undefined; share.requestedProfile = undefined; this.patch({}); });
    return share.qualityChange;
  };

  sourceAudio = (publicationId: string) => {
    const share = [...this.screenShares.values()].find(share => share.id === publicationId);
    if (!share) return undefined;
    const local = this.local.get(publicationId);
    const hasAudio = local ? !!local.audio?.audioAvailable
      : !!this.app?.hasSourceAudio(publicationId) || !!this.app?.sourceMicrophone(publicationId)?.enabled;
    const canMute = !!local?.audio?.outputGainAvailable || !!this.app?.hasSourceAudioControl(publicationId);
    return { ...share.volume, bitrate: share.profile.maxAudioBitrate ?? 128_000,
      hasAudio, available: hasAudio && (!local || !!local.audio?.outputGainAvailable), canMute };
  };

  setSourceAudio = (publicationId: string, settings: { bitrate?: number; level?: number; muted?: boolean }): Promise<void> => {
    const share = [...this.screenShares.values()].find(share => share.id === publicationId);
    const local = this.local.get(publicationId);
    const stopping = settings.bitrate === undefined && (settings.muted === true || settings.level === 0) && !!local?.audio?.outputGainAvailable;
    const native = this.app?.hasSourceAudioControl(publicationId);
    if (!share || (share.selection || share.qualityChange) && !(settings.bitrate === undefined && (stopping || native)))
      return Promise.reject(new Error("capture_unavailable"));
    const volume = { level: settings.level ?? share.volume.level, muted: settings.muted ?? share.volume.muted };
    const profile = { ...share.profile, maxAudioBitrate: settings.bitrate ?? share.profile.maxAudioBitrate ?? 128_000 };
    if (!supportsCaptureProfile(profile) || !Number.isFinite(volume.level) || volume.level < 0 || volume.level > 2) return Promise.reject(new Error("invalid_audio_settings"));
    let appliedVolume = share.volume, appliedProfile = share.profile;
    share.profile = profile; share.volume = volume;
    if (stopping) local!.audio!.setVolume(0);
    this.patch({});
    if (share.audioChange) return share.audioChange;
    const current = () => [...this.screenShares.values()].includes(share);
    share.audioChange = this.action(`source-audio:${publicationId}`, async () => {
      try {
        do {
          const volume = share.volume, profile = share.profile;
          const local = this.local.get(publicationId);
          try {
            if (local) {
              if (!local.audio?.outputGainAvailable && (volume.level !== 1 || volume.muted)) throw new Error("source_audio_unavailable");
              local.audio?.setVolume(volume.muted ? 0 : volume.level);
              appliedVolume = volume;
              if (local.profile?.maxAudioBitrate !== profile.maxAudioBitrate) {
                local.profile = { ...local.profile!, maxAudioBitrate: profile.maxAudioBitrate };
                this.media.setLocal(publicationId, local.stream, local.profile, share.codec);
                appliedProfile = profile;
              }
            }
            const app = this.app;
            if (app?.hasSourceAudioControl(publicationId)) {
              await app.setSourceAudio(publicationId, profile.maxAudioBitrate!, volume.muted ? 0 : volume.level);
              if (this.app !== app) throw new DOMException("Capture cancelled", "AbortError");
            } else if (!local) throw new Error("capture_unavailable");
          } catch (error) {
            if (current() && (volume !== share.volume || profile !== share.profile)) continue;
            throw error;
          }
          if (!current()) throw new DOMException("Capture cancelled", "AbortError");
          appliedVolume = volume; appliedProfile = profile;
          if (volume === share.volume && profile === share.profile) return;
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
  startNativeScreen = (roomId: string, target: NativeCaptureTarget, audio = false, excludeAudio?: NativeCaptureTarget, showCaptureBorder = false): Promise<void> => this.action(`screen:${roomId}`, async () => {
    const { share, current } = this.selectScreen(roomId);
    const signal = share.selection!.signal;
    const native = { target, audio, excludeAudio: target.kind === "display" ? excludeAudio : undefined, showCaptureBorder };
    let app: ChannelApp | undefined;
    let committed = false;
    try {
      app = await this.connectApp();
      if (!current()) throw new DOMException("Capture cancelled", "AbortError");
      const codecMode = share.codec?.primary ?? (share.codecMode === "auto"
        && app.supportsCaptureCodec("vp8") && !supportsH264Receive() ? "vp8" : share.codecMode);
      const preparing = app.prepareCapture(share.id, roomId, target, audio, share.profile, codecMode,
        audio ? native.excludeAudio : undefined, share.volume.muted ? 0 : share.volume.level, showCaptureBorder);
      this.patch({});
      const prepared = await preparing;
      if (!current() || this.app !== app) throw new DOMException("Capture cancelled", "AbortError");
      this.patch({});
      if (this.local.has(share.id)) await this.request({ type: "transfer_source", publicationId: share.id, toSessionId: prepared.sessionId }, undefined, roomId);
      if (!current()) throw new DOMException("Capture cancelled", "AbortError");
      await app.commitCapture(share.id, prepared.captureId);
      committed = true;
      if (!current()) throw new DOMException("Capture cancelled", "AbortError");
      share.native = native;
      share.paused = undefined;
      share.codec ??= share.codecMode === "auto" ? automaticVideoCodecPreference(prepared.codec) : manualVideoCodecPreference(prepared.codec);
      this.retireCapture(share.id);
      this.patch({});
      // Native owns the source; this page previews it through the ordinary route.
      if (!this.watching.has(share.id)) await this.watch(share.id, roomId, signal);
    } catch (error) {
      if (!committed) await app?.cancelCapture(share.id).catch(() => {});
      throw error;
    } finally { this.finishScreenSelection(roomId, share); }
  });
  setScreenTitle = async (publicationId: string, title: string | null): Promise<void> => {
    const publication = this.view.state?.publications.find(value => value.id === publicationId && value.kind === "screen");
    if (!publication) throw new Error("publication_unavailable");
    if (this.view.connection !== "connected") throw new Error("disconnected");
    const normalized = title?.trim() || null;
    if (normalized && normalized.length > 64) throw new Error("invalid_title");
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
      const local = this.local.get(publicationId)!, share = this.screenShares.get(publication.roomId);
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
  stopScreen = (publicationId: string): Promise<void> => this.action(`stop:${publicationId}`, async () => {
    for (const [roomId, share] of this.screenShares) if (share.id === publicationId) {
      share.selection?.abort();
      this.screenShares.delete(roomId);
    }
    const browser = this.local.get(publicationId);
    // stop_capture also retires a pending Native candidate for a Browser incumbent.
    const nativeStop = this.app?.stopCapture(publicationId);
    if (browser) this.retireCapture(publicationId);
    this.retireWatch(publicationId);
    this.refreshActivity();
    await Promise.all([nativeStop, browser && this.view.connection === "connected"
      ? this.request({ type: "unpublish", publicationId }, undefined, browser.roomId) : undefined]);
  });

  private voiceCaptureEnded(id: string, stream: MediaStream): void {
    const capture = this.local.get(id);
    if (capture?.stream !== stream) return;
    const roomId = capture.roomId;
    const voice = this.view.state?.voice.find(member => member.sessionId === this.view.sessionId && member.roomId === roomId);
    this.retireCapture(id);
    this.refreshActivity();
    this.send({ type: "unpublish", publicationId: id });
    if (voice) this.send({ type: "voice", roomId, joined: true, muted: true, deafened: voice.deafened });
  }

  private async getMicrophone(): Promise<MicrophoneInput> {
    if (this.microphone?.stream.active) return this.microphone;
    if (this.microphoneRequest) return this.microphoneRequest.promise!;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("microphone_unavailable");
    const signal = this.captureLifetime.signal;
    // Resume during the gesture, before device permission consumes activation.
    const context = new AudioContext();
    const resumed = context.resume().then(() => true, () => false);
    const request: MicrophoneRequest = { context, input: null };
    request.promise = (async () => {
      let stream: MediaStream | undefined, input: MicrophoneInput | undefined;
      try {
        stream = await this.captureVoiceMicrophone(this.view.voiceInput, signal);
        signal.throwIfAborted();
        if (stream.getAudioTracks()[0]?.readyState !== "live") throw new Error("microphone_unavailable");
        const captured = input = new MicrophoneInput(stream, context, this.view.voiceInput.volume, () => {
          for (const [id, capture] of [...this.local]) if (capture.microphone === captured) this.voiceCaptureEnded(id, capture.stream);
          captured.close();
          if (this.microphone === captured) this.microphone = null;
        });
        request.input = captured;
        request.context = null;
        const started = await resumed;
        signal.throwIfAborted();
        if (!started || !captured.stream.active) throw new Error("microphone_unavailable");
        captured.volume(this.view.voiceInput.volume);
        this.microphone = captured;
        request.input = null;
        return captured;
      } catch (error) {
        if (input) input.close();
        else stream?.getTracks().forEach(track => track.stop());
        void request.context?.close().catch(() => {});
        request.context = null;
        throw error;
      }
    })().finally(() => { if (this.microphoneRequest === request) this.microphoneRequest = null; });
    this.microphoneRequest = request;
    return request.promise;
  }

  setInputVolume = (volume: number): void => {
    this.microphone?.volume(volume);
    this.microphoneRequest?.input?.volume(volume);
    const voiceInput = { ...this.view.voiceInput, volume };
    this.patch({ voiceInput });
    saveRoomPreferences({ voiceInput });
  };

  microphones = () => browserCaptureDevices("audioinput");

  private microphoneConstraints(settings: RoomPreferences["voiceInput"]): MediaStreamConstraints {
    return { audio: { ...audioInputConstraints(settings.voiceProcessing),
      ...(settings.deviceId ? { deviceId: { exact: settings.deviceId } } : {}) }, video: false };
  }

  private captureVoiceMicrophone(settings: RoomPreferences["voiceInput"], signal: AbortSignal): Promise<MediaStream> {
    return acquireMediaStream(() => navigator.mediaDevices.getUserMedia(this.microphoneConstraints(settings)), signal).catch(error => {
      if (error instanceof DOMException && error.name === "NotAllowedError") throw new Error("voice_microphone_permission_denied");
      throw error;
    });
  }

  configureVoiceInput = (settings: Partial<Pick<RoomPreferences["voiceInput"], "deviceId" | "voiceProcessing">>): Promise<void> => this.action("voice-input", async () => {
    const signal = this.captureLifetime.signal;
    if (this.microphoneRequest) await this.microphoneRequest.promise;
    signal.throwIfAborted();
    const voiceInput = { ...this.view.voiceInput, ...settings };
    const input = this.microphone;
    if (input) {
      let captured: MediaStream | undefined = await this.captureVoiceMicrophone(voiceInput, input.signal);
      try {
        signal.throwIfAborted();
        if (this.microphone !== input) throw new DOMException("Microphone capture cancelled", "AbortError");
        input.replace(captured);
        captured = undefined;
      } finally { captured?.getTracks().forEach(track => track.stop()); }
    }
    const applied = { ...voiceInput, volume: this.view.voiceInput.volume };
    this.patch({ voiceInput: applied });
    saveRoomPreferences({ voiceInput: applied });
  });

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

  joinVoice = (roomId: string, listenOnly = false, providedStream?: MediaStream): Promise<void> => this.action(`voice:${roomId}`, async () => {
    if (this.voiceParticipation.has(roomId)) return;
    const intent: VoiceParticipation = { publicationId: null, muted: listenOnly, deafened: false };
    this.voiceParticipation.set(roomId, intent);
    let capture: MediaStream | null = null;
    try {
      const microphone = !listenOnly && !providedStream ? await this.getMicrophone() : undefined;
      if (!listenOnly) capture = providedStream ?? microphone!.stream.clone();
      if (this.voiceParticipation.get(roomId) !== intent) throw new DOMException("Voice left", "AbortError");
      await this.request({ type: "voice", roomId, joined: true, muted: intent.muted, deafened: intent.deafened });
      if (this.voiceParticipation.get(roomId) !== intent) throw new DOMException("Voice left", "AbortError");
      if (capture && !intent.muted) {
        const id = intent.publicationId = crypto.randomUUID();
        await this.publish("voice", roomId, capture, { microphone, publicationId: id });
        if (this.voiceParticipation.get(roomId) !== intent) throw new DOMException("Voice left", "AbortError");
        capture.getAudioTracks().forEach(track => { track.enabled = !intent.muted; });
      } else {
        capture?.getTracks().forEach(track => track.stop());
      }
    } catch (error) {
      const left = this.voiceParticipation.get(roomId) !== intent;
      if (!left) this.voiceParticipation.delete(roomId);
      if (intent.publicationId) this.retireCapture(intent.publicationId);
      capture?.getTracks().forEach(track => track.stop());
      this.releaseUnusedMicrophone();
      if (left) throw new DOMException("Voice left", "AbortError");
      await this.request({ type: "voice", roomId, joined: false, muted: true, deafened: false }).catch(() => {});
      throw error;
    }
  });

  leaveVoice = (roomId: string): Promise<void> => {
    const id = this.voiceParticipation.get(roomId)?.publicationId;
    this.voiceParticipation.delete(roomId);
    if (id) this.retireCapture(id);
    this.releaseUnusedMicrophone();
    this.refreshActivity();
    return this.syncVoiceParticipation(roomId);
  };

  canUnmute = (roomId: string): boolean => {
    const intent = this.voiceParticipation.get(roomId);
    const room = this.view.state?.channel.rooms.find(room => room.id === roomId);
    if (!intent || !room?.authorized) return false;
    const stream = intent.publicationId ? this.local.get(intent.publicationId)?.stream : undefined;
    return !!stream?.getAudioTracks().some(track => track.readyState === "live")
      || this.view.connection === "connected" && room.available && !this.view.pending.has(`voice:${roomId}`);
  };

  voiceActivity = async (roomId: string, localOnly = false): Promise<ReadonlyMap<string, number>> => {
    const sessionId = this.view.sessionId;
    const intent = this.voiceParticipation.get(roomId);
    if (!sessionId || !intent || !this.view.state?.channel.rooms.some(room => room.id === roomId && room.authorized)) return new Map();
    const levels = new Map(localOnly ? [] : await this.media.voiceActivity(roomId));
    if (this.view.sessionId !== sessionId || this.voiceParticipation.get(roomId) !== intent
      || !this.view.state?.channel.rooms.some(room => room.id === roomId && room.authorized)) return new Map();
    for (const id of levels.keys()) if (id === sessionId || intent.deafened
      || !this.view.state.voice.some(voice => voice.roomId === roomId && voice.sessionId === id && !voice.muted)) levels.delete(id);
    const capture = intent.publicationId ? this.local.get(intent.publicationId) : undefined;
    if (!intent.muted && capture?.roomId === roomId && capture.kind === "voice" && capture.microphone
      && capture.stream.getAudioTracks().some(track => track.readyState === "live" && track.enabled)) {
      levels.set(sessionId, capture.microphone.level());
    }
    return levels;
  };

  setMuted = (roomId: string, muted: boolean): Promise<void> => {
    const intent = this.voiceParticipation.get(roomId);
    if (!intent) return Promise.resolve();
    if (!muted && !this.canUnmute(roomId)) return Promise.reject(new Error("capture_unavailable"));
    intent.muted = muted;
    const stream = intent.publicationId ? this.local.get(intent.publicationId)?.stream : undefined;
    stream?.getAudioTracks().forEach(track => { track.enabled = !muted; });
    this.refreshActivity();
    if (!muted && !stream) return this.action(`voice:${roomId}`, async () => {
      let capture: MediaStream | undefined;
      try {
        const microphone = await this.getMicrophone();
        if (this.voiceParticipation.get(roomId) !== intent || intent.muted) return;
        capture = microphone.stream.clone();
        const id = intent.publicationId = crypto.randomUUID();
        await this.publish("voice", roomId, capture, { microphone, publicationId: id });
        if (this.voiceParticipation.get(roomId) !== intent) throw new DOMException("Voice left", "AbortError");
        capture.getAudioTracks().forEach(track => { track.enabled = !intent.muted; });
        await this.request({ type: "voice", roomId, joined: true, muted: intent.muted, deafened: intent.deafened });
      } catch (error) {
        const left = this.voiceParticipation.get(roomId) !== intent;
        if (intent.publicationId) this.retireCapture(intent.publicationId);
        capture?.getTracks().forEach(track => track.stop());
        if (!left) { intent.publicationId = null; intent.muted = true; }
        this.refreshActivity();
        if (left) throw new DOMException("Voice left", "AbortError");
        throw error;
      }
    });
    return this.syncVoiceParticipation(roomId);
  };

  setDeafened = (roomId: string, deafened: boolean): Promise<void> => {
    const intent = this.voiceParticipation.get(roomId);
    if (!intent) return Promise.resolve();
    intent.deafened = deafened;
    this.refreshActivity();
    return this.syncVoiceParticipation(roomId);
  };

  private syncVoiceParticipation(roomId: string): Promise<void> {
    const intent = this.voiceParticipation.get(roomId);
    const command = { type: "voice" as const, roomId, joined: !!intent, muted: intent?.muted ?? true, deafened: intent?.deafened ?? false };
    if (this.view.connection !== "connected") return Promise.resolve();
    if (this.view.pending.has(`voice:${roomId}`)) {
      // Local intent can stop a source while an earlier authority reply is pending.
      this.send(command);
      return Promise.resolve();
    }
    return this.action(`voice:${roomId}`, async () => {
      try { await this.request(command); }
      catch (error) { if (!(error instanceof Error) || error.message !== "disconnected") throw error; }
    });
  }

  private releaseUnusedMicrophone(): void {
    if ([...this.voiceParticipation.values()].some(intent => intent.publicationId) || [...this.view.pending].some(key => key.startsWith("voice:"))) return;
    this.microphone?.close();
    this.microphone = null;
  }

  reconnect = (): void => {
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    const old = this.socket;
    this.socket = null;
    old?.close();
    this.rejectRequests("disconnected");
    this.beginRecovery();
    this.closed = false;
    this.connect();
  };

  private rejectRequests(message: string): void {
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(new Error(message)); }
    this.requests.clear();
  }

  private releaseMedia(): void {
    this.closeInteractions();
    this.readings.clear();
    this.readingRooms.clear();
    const request = this.microphoneRequest;
    this.microphoneRequest = null;
    this.captureLifetime.abort();
    this.captureLifetime = new AbortController();
    for (const share of this.screenShares.values()) share.selection?.abort();
    this.screenShares.clear();
    this.app?.stopCaptures();
    this.input.reset();
    this.attachments.reset();
    for (const capture of this.local.values()) capture.audio?.dispose();
    this.media.reset();
    this.local.clear();
    this.admittedPublications.clear();
    this.localNativeEndpoints.clear();
    this.voiceParticipation.clear();
    for (const id of this.watching.keys()) this.retireWatch(id);
    this.microphone?.close();
    this.microphone = null;
    request?.input?.close();
    void request?.context?.close().catch(() => {});
    if (request) request.context = null;
    this.signals = [];
  }

  private retireCapture(id: string): void {
    this.admittedPublications.delete(id);
    this.local.get(id)?.audio?.dispose();
    this.local.delete(id);
    this.media.removeLocal(id);
    for (const intent of this.voiceParticipation.values()) {
      if (intent.publicationId === id) { intent.publicationId = null; intent.muted = true; }
    }
  }

  private refreshActivity(): void {
    if (this.view.state) this.patch({ state: this.projectActivity(this.view.state) });
    this.input.update();
    this.releaseUnusedMicrophone();
  }

  private projectActivity(state: ChannelSnapshot): ChannelSnapshot {
    const sessionId = this.view.sessionId;
    const subscriptions = state.subscriptions.filter(id => {
      const publication = state.publications.find(value => value.id === id);
      return publication?.kind === "voice" ? this.voiceParticipation.has(publication.roomId) : this.watching.has(id);
    });
    // Only authority updates retire leases and assign transports. Local stop
    // intent changes what this page presents, even while the host is unreachable.
    return {
      ...state,
      publications: state.publications.filter(publication => publication.sessionId !== sessionId || this.local.has(publication.id)
        || this.screenShares.get(publication.roomId)?.id === publication.id).map(publication => {
          const share = this.screenShares.get(publication.roomId);
          return publication.kind === "screen" && this.local.has(publication.id) && share?.id === publication.id
            ? { ...publication, paused: share.paused ?? publication.paused } : publication;
        }),
      voice: state.voice.filter(member => member.sessionId !== sessionId || this.voiceParticipation.has(member.roomId)).map(member =>
        member.sessionId === sessionId && this.voiceParticipation.has(member.roomId)
          ? { ...member, muted: this.voiceParticipation.get(member.roomId)!.muted, deafened: this.voiceParticipation.get(member.roomId)!.deafened } : member),
      subscriptions,
      failedSubscriptions: state.failedSubscriptions.filter(id => subscriptions.includes(id)),
    };
  }

  private beginRecovery(): void {
    for (const interaction of this.view.interactionsByRoom.values()) interaction.disconnected();
    if (!this.view.sessionId || this.recoveryDeadline !== null) return;
    this.recoveryDeadline = setTimeout(() => {
      this.recoveryDeadline = null;
      this.releaseMedia();
      this.releaseHosts();
      this.patch({ sessionId: null, state: null, self: null, error: "session_expired" });
    }, 20000);
  }

  private endRecovery(): void {
    if (this.recoveryDeadline !== null) clearTimeout(this.recoveryDeadline);
    this.recoveryDeadline = null;
  }

  close = (): void => {
    this.closed = true;
    this.feedbackAudio.close();
    this.endRecovery();
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    for (const [roomId, hosted] of this.hostedRooms) if (hosted.bindingId) this.write({ type: "host_stop", roomId, bindingId: hosted.bindingId });
    this.releaseHosts();
    this.write({ type: "leave" });
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.rejectRequests("closed");
    this.releaseMedia();
    this.conversation.close();
    this.patch({ connection: "closed", state: null, sessionId: null, self: null });
  };
}
