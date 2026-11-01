import { z } from "zod";
import { ChannelMedia } from "./media";
import { ChannelInput } from "./input";
import { ChannelConversation } from "./conversation";
import { eventSchema, userSchema, type ChannelCommand, type ChannelEvent, type ChannelMessage, type ChannelReply, type ChannelSnapshot, type ConversationReply, type DomainSettings, type MessageReactionSnapshot, type RoomSettings } from "./protocol";
import { ChannelAttachments, type DraftFile } from "./attachments";
import type { ChannelView, ScreenPresentation } from "./types";
import { loadRoomHosting, roomDatabaseName, type HostedRoom, type BrowserRoomSnapshot, type BrowserRoomStage } from "./hosting";
import { ChannelApp, discoverChannelAppHealth, type ChannelStopShortcut, type NativeCaptureSources } from "./app-link";
import { isClientActivated } from "../lib/session";
import type { NativeCaptureTarget } from "../native/wire";
import type { RemoteControlMode } from "../remote-control/protocol";
import { readRoomPreferences, saveRoomPreferences, type RoomPreferences } from "../lib/room-preferences";
import { MicrophoneInput } from "../media/microphone-input";
import { HostAudio } from "../media/host-audio";
import { readPreferredQuality, savePreferredQuality, supportsCaptureProfile, type QualityProfile } from "../media/quality";
import { audioInputConstraints } from "../media/audio-capture";
import { browserCaptureDevices } from "../media/capture-devices";
import { RoomInteractionSession } from "../lib/room-interactions";
import { createOpaqueId } from "../lib/opaque-id";
import { captureBrowserSource, type BrowserCaptureSource } from "../media/quality";
import { loadCameraPreviews, type CameraPreview } from "../media/camera-previews";
import { readBackup, writeBackup, type BackupMetadata, type RetainedBackupFile } from "./backup-archive";
import { NativeDomainHosting, NativeRoomHosting } from "./hosting-api";
import type { RetainedFile } from "./file-store";

const credentialKey = "piik.channel.prototype.credential";
const nameKey = "piik.channel.prototype.name";

interface MicrophoneRequest {
  context: AudioContext | null;
  input: MicrophoneInput | null;
  promise?: Promise<MicrophoneInput>;
}

interface ScreenShare { id: string; profile: QualityProfile; volume: { level: number; muted: boolean }; audioChange?: Promise<void>; selection?: object; native?: { target: NativeCaptureTarget; audio: boolean; excludeAudio?: NativeCaptureTarget } }

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
    interactionsByRoom: new Map(),
    voiceInput: readRoomPreferences().voiceInput,
    voicePlaybackByUser: new Map(),
    listeningVolume: readRoomPreferences().voiceListeningVolume,
    appConnected: false,
    ownedScreens: new Set(),
    state: null, sessionId: null, self: null, connection: "connecting", messagesByRoom: {}, historyByRoom: {},
    streams: new Map(), screenInputs: new Map(), inputChannels: new Map(), remoteControls: new Map(), error: null, inviteURL: null, pending: new Set(),
  };
  private listeners = new Set<() => void>();
  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private recoveryDeadline: ReturnType<typeof setTimeout> | null = null;
  private closed = true;
  private credential = stored(credentialKey) ?? undefined;
  private invitationOrigin = location.origin;
  private key = new URLSearchParams(location.hash.slice(1)).get("owner")
    ?? new URLSearchParams(location.hash.slice(1)).get("invite") ?? undefined;
  private invitedRoom = new URLSearchParams(location.hash.slice(1)).get("room") ?? undefined;
  private roomId: string | null = this.invitedRoom ?? null;
  private requests = new Map<string, {
    roomId?: string; bindingId?: string;
    history?: { before?: number; entries: Map<number, { message?: ChannelMessage; snapshot?: MessageReactionSnapshot }> };
    pendingSend?: Extract<ChannelCommand, { type: "chat" | "history" | "set_reaction" }>;
    resolve(): void; reject(error: Error): void; result?: (event: ChannelReply) => void; timer: ReturnType<typeof setTimeout>;
  }>();
  private hostedRooms = new Map<string, { host: HostedRoom; bindingId?: string }>();
  private app: ChannelApp | undefined;
  private hostCleanup: Promise<void> = Promise.resolve();
  private signals: Extract<ChannelCommand, { type: "signal" }>[] = [];
  private microphone: MicrophoneInput | null = null;
  private microphoneRequest: MicrophoneRequest | null = null;
  private voiceCaptures = new Map<string, string | null>();
  private watching = new Set<string>();
  private admittedPublications = new Set<string>();
  private historyChannel: string | null = null;
  private reading: { roomId: string; bindingId: string; socket: WebSocket | null; ready: Promise<void>;
    interaction?: RoomInteractionSession; interactionBinding?: string } | null = null;
  private outgoingMessages = new Map<string, { content: string; nonce: string }>();
  private captureEpoch = 0;
  private screenShares = new Map<string, ScreenShare>();
  private local = new Map<string, { roomId: string; kind: "screen" | "voice"; stream: MediaStream; microphone?: MicrophoneInput; audio?: HostAudio; profile?: QualityProfile; camera?: boolean }>();
  private conversation = new ChannelConversation({
    context: () => ({ sessionId: this.view.sessionId, state: this.view.state, connected: this.view.connection === "connected" }),
    host: roomId => this.hostedRooms.get(roomId)?.host,
    send: (peer, frame, allowed) => this.media.sendData(peer, "control", frame, allowed),
    file: (peer, control) => this.attachments.data(peer, "control", control),
    reply: reply => this.receiveConversation(reply),
  });
  private input = new ChannelInput({
    context: () => ({ sessionId: this.view.sessionId, state: this.view.state,
      connected: this.view.connection === "connected" && this.socket?.readyState === WebSocket.OPEN }),
    register: command => this.send(command),
    send: (peer, frame) => this.media.sendInput(peer, frame),
    changed: inputChannels => this.patch({ inputChannels }),
  });
  private media = new ChannelMedia(command => this.send(command), (streams, screenInputs) => this.patch({ streams, screenInputs }),
    (peer, kind, data) => {
      if (kind === "chunk") this.attachments.data(peer, kind, data);
      else void this.conversation.receive(peer, data as string).catch(() => {});
    }, (peer, ready) => { this.attachments.peerState(peer, ready); if (ready) this.syncInteractions(peer); }, peer => this.attachments.bulkClosed(peer),
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

  private patch(patch: Partial<ChannelView>): void {
    const ownedScreens = new Set(this.app?.screens);
    for (const share of this.screenShares.values()) ownedScreens.add(share.id);
    for (const [id, capture] of this.local) if (capture.kind === "screen") ownedScreens.add(id);
    const remoteControls = new Map([...(patch.remoteControls ?? this.view.remoteControls)].filter(([id]) => ownedScreens.has(id)));
    this.view = { ...this.view, ...patch, appConnected: this.app?.connected ?? false, ownedScreens, remoteControls };
    for (const listener of this.listeners) listener();
  }

  start = (): void => {
    if (!this.closed) return;
    this.closed = false;
    this.connect();
  };

  private connect(acceptWelcome?: (event: Extract<ChannelEvent, { type: "welcome" }>) => string | undefined): void {
    if (this.closed) return;
    const url = new URL("/prototype/channel", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.socket = socket;
    this.patch({ connection: this.view.sessionId ? "reconnecting" : "connecting" });
    socket.onopen = async () => {
      try {
        const signingKey = await this.conversation.initialize();
        if (this.socket !== socket || this.closed) return;
        this.write({ type: "join", signingKey, name: stored(nameKey) ?? "Guest", credential: this.credential, key: this.key, roomId: this.invitedRoom, sessionId: this.view.sessionId ?? undefined });
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
        const result = eventSchema.safeParse(JSON.parse(String(data)));
        if (!result.success) { console.warn("Invalid channel event", result.error); this.patch({ error: "invalid_response" }); return; }
        const skipRoom = result.data.type === "welcome" ? acceptWelcome?.(result.data) : undefined;
        if (result.data.type === "welcome") acceptWelcome = undefined;
        this.receive(result.data, skipRoom);
      } catch { this.patch({ error: "invalid_response" }); }
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
      stored(credentialKey, event.credential);
      this.invitationOrigin = event.invitationOrigin ?? location.origin;
      const invite = event.inviteKey ?? (!this.invitedRoom ? new URLSearchParams(location.hash.slice(1)).get("invite") : null);
      const inviteURL = new URL(location.pathname, this.invitationOrigin);
      if (invite) inviteURL.hash = new URLSearchParams({ invite }).toString();
      this.patch({ sessionId: event.sessionId, connection: "connected", error: null, inviteURL: invite ? inviteURL.href : null });
      this.applyState(event.state);
      if (isClientActivated()) void this.connectApp().catch(() => {});
      void this.restoreHosts(event.sessionId, skipRestoreRoom).catch(error => {
        if (!this.closed && this.view.sessionId === event.sessionId) this.patch({ error: error instanceof Error ? error.message : "storage_failed" });
      });
      if (resumed) {
        this.media.resync();
        this.attachments.resume();
        for (const publication of event.state.publications) {
          if (publication.sessionId === event.sessionId && !this.local.has(publication.id)) this.write({ type: "unpublish", publicationId: publication.id });
        }
        for (const member of event.state.voice) {
          if (member.sessionId === event.sessionId && !this.voiceCaptures.has(member.roomId)) this.write({ type: "voice", roomId: member.roomId, joined: false, muted: true, deafened: false });
          else if (member.sessionId === event.sessionId && this.voiceCaptures.get(member.roomId) === null && !member.muted) {
            this.write({ type: "voice", roomId: member.roomId, joined: true, muted: true, deafened: member.deafened });
          }
        }
        for (const id of event.state.subscriptions) {
          if (event.state.publications.some(publication => publication.id === id && publication.kind === "screen") && !this.watching.has(id)) {
            this.write({ type: "subscribe", publicationId: id, enabled: false });
          }
        }
      }
      this.reading = null;
      this.browse(this.roomId ?? event.state.channel.rooms[0]?.id ?? "");
      for (const command of this.signals.splice(0)) {
        if (event.state.pairs.some(pair => pair.id === command.pairId)) this.write(command);
      }
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
      else request.resolve();
    } else if (event.type === "state") this.applyState(event.state);
    else if (event.type === "room_invite") {
      if (event.requestId) this.requests.get(event.requestId)?.result?.(event);
    } else if (event.type === "signal") this.media.signal(event.pairId, event.payload);
    else if (event.type === "ack" || event.type === "error") {
      const request = event.requestId ? this.requests.get(event.requestId) : null;
      if (request && event.requestId) {
        clearTimeout(request.timer);
        this.requests.delete(event.requestId);
        if (event.type === "ack") request.resolve();
        else request.reject(new Error(event.code));
      } else if (event.type === "error") {
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
    const previousRooms = this.view.state?.channel.rooms;
    const userId = state.sessions.find(session => session.id === sessionId)?.userId;
    for (const id of this.admittedPublications) {
      if (!state.publications.some(publication => publication.id === id)) {
        const roomId = this.local.get(id)?.roomId;
        if (roomId && this.screenShares.get(roomId)?.id === id) this.screenShares.delete(roomId);
        this.retireCapture(id);
      }
    }
    for (const [roomId, publicationId] of this.voiceCaptures) {
      const voice = state.voice.find(member => member.sessionId === sessionId && member.roomId === roomId);
      const stream = publicationId ? this.local.get(publicationId)?.stream : undefined;
      if (voice && stream) stream.getAudioTracks().forEach(track => { track.enabled = !voice.muted; });
      if (!voice && !this.view.pending.has(`voice:${roomId}`)) {
        this.voiceCaptures.delete(roomId);
        if (publicationId) this.retireCapture(publicationId);
      }
    }
    for (const id of this.watching) {
      if (!state.publications.some(publication => publication.id === id) && !this.view.pending.has(`watch:${id}`)) this.watching.delete(id);
    }
    for (const publication of this.view.state?.publications ?? []) {
      if (this.app?.screens.has(publication.id) && !state.publications.some(value => value.id === publication.id)) {
        if (this.screenShares.get(publication.roomId)?.id === publication.id) this.screenShares.delete(publication.roomId);
        void this.app.stopCapture(publication.id).catch(() => {});
      }
    }
    const visible = this.projectActivity(state);
    const sameChannel = this.historyChannel === state.channel.id;
    if (!sameChannel) this.closeInteractions();
    this.historyChannel = state.channel.id;
    const canRead = (id: string) => sameChannel && state.channel.rooms.some(room => room.id === id && room.authorized);
    const freshBindings = new Set(state.channel.rooms.filter(room => room.delivery
      && previousRooms?.find(previous => previous.id === room.id)?.delivery?.bindingId !== room.delivery.bindingId).map(room => room.id));
    for (const [id, request] of this.requests) if (request.bindingId
      && !state.channel.rooms.some(room => room.id === request.roomId && room.authorized
        && room.available && room.delivery?.bindingId === request.bindingId)) {
      clearTimeout(request.timer);
      this.requests.delete(id);
      request.reject(new Error("room_unavailable"));
    }
    for (const id of this.outgoingMessages.keys()) if (!canRead(id)) this.outgoingMessages.delete(id);
    this.patch({ state: visible, self: state.users.find(user => user.id === userId) ?? null,
      voicePlaybackByUser: sameChannel ? new Map([...this.view.voicePlaybackByUser].filter(([id]) => state.users.some(user => user.id === id))) : new Map(),
      messagesByRoom: Object.fromEntries(Object.entries(this.view.messagesByRoom).filter(([id]) => canRead(id) && !freshBindings.has(id))),
      historyByRoom: Object.fromEntries(Object.entries(this.view.historyByRoom).filter(([id]) => canRead(id) && !freshBindings.has(id))),
    });
    if (this.reading && (!sameChannel || !state.channel.rooms.some(room => room.id === this.reading!.roomId
      && room.authorized && room.available && room.delivery?.bindingId === this.reading!.bindingId))) {
      this.closeInteractions(); this.reading = null;
    }
    if (this.view.connection === "connected") for (const room of state.channel.rooms) {
      if (room.available && previousRooms?.some(previous => previous.id === room.id && !previous.available)
        && this.voiceCaptures.get(room.id) === null && !this.view.pending.has(`voice:${room.id}`)) {
        for (const publication of state.publications) {
          if (publication.sessionId === sessionId && publication.roomId === room.id && publication.kind === "voice" && !this.local.has(publication.id)) {
            this.write({ type: "unpublish", publicationId: publication.id });
          }
        }
        const member = state.voice.find(member => member.sessionId === sessionId && member.roomId === room.id);
        if (member && !member.muted) this.write({ type: "voice", roomId: room.id, joined: true, muted: true, deafened: member.deafened });
      }
      if (room.id !== this.roomId && room.reading && room.authorized && room.available
        && previousRooms?.some(previous => previous.id === room.id && !previous.available)) {
        this.write({ type: "browse", roomId: room.id, active: false });
      }
    }
    this.media.update(sessionId, state);
    this.input.update();
    if (userId) this.attachments.update(sessionId, { domainId: state.channel.id, userId }, state.files, state.channel.rooms);
    else this.attachments.reset();
    this.sendConversations();
    if (this.roomId && freshBindings.has(this.roomId)) this.browse(this.roomId);
    this.syncInteractions();
    this.releaseUnusedMicrophone();
  }

  private write(command: ChannelCommand & { requestId?: string }): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(command));
  }

  private send(command: ChannelCommand): void {
    if (this.view.connection === "connected") this.write(command);
    else if (command.type === "signal" && this.signals.length < 256) this.signals.push(command);
  }

  private async request(command: ChannelCommand, result?: (event: ChannelReply) => void, roomId = this.commandRoom(command)): Promise<void> {
    const reading = this.reading;
    const conversation = command.type === "chat" || command.type === "history" || command.type === "set_reaction";
    if (conversation && reading && reading.roomId === roomId) await reading.ready;
    if (this.view.connection !== "connected") return Promise.reject(new Error("disconnected"));
    const room = this.view.state?.channel.rooms.find(room => room.id === roomId);
    const delivery = room?.delivery;
    if (conversation && (!room?.available || !delivery)) return Promise.reject(new Error("room_unavailable"));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(requestId); reject(new Error("request_timeout")); }, 10000);
      this.requests.set(requestId, { resolve, reject, timer, result, roomId,
        ...(delivery && (conversation || command.type === "browse") ? { bindingId: delivery.bindingId } : {}),
        ...(conversation ? { pendingSend: command,
          ...(command.type === "history" ? { history: { before: command.before, entries: new Map() } } : {}) } : {}) });
      if (conversation) this.sendConversations();
      else this.write({ ...command, requestId });
    });
  }

  private sendConversations(): void {
    if (this.view.connection !== "connected") return;
    for (const [requestId, request] of this.requests) {
      const command = request.pendingSend;
      if (!command) continue;
      const delivery = this.view.state?.channel.rooms.find(room => room.id === command.roomId)?.delivery;
      if (!delivery || (delivery.hostSessionId !== this.view.sessionId && !delivery.nextHops[delivery.hostSessionId])) continue;
      delete request.pendingSend;
      void this.conversation.send(command, requestId).catch(error => {
        if (!this.requests.delete(requestId)) return;
        clearTimeout(request.timer);
        request.reject(error instanceof Error ? error : new Error(String(error)));
      });
    }
  }

  private receiveConversation(reply: ConversationReply): void {
    const record = reply.record;
    if (record.type === "message_reactions" || record.type === "reaction_confirmed") {
      this.applyReactionSnapshot(reply.roomId, reply.bindingId, record.snapshot);
      if (record.type === "message_reactions") return;
    }
    const interaction = this.view.interactionsByRoom.get(reply.roomId);
    if (interaction && this.reading?.interactionBinding === reply.bindingId) {
      if (record.type === "interaction_ready") {
        interaction.setSupportedReactions(record.reactionIds);
        interaction.receive({ type: "room-interactions-ready", serverTime: record.serverTime });
        return;
      }
      if (record.type === "interaction") {
        const user = this.view.state?.users.find(user => user.id === record.senderUserId);
        if (user) interaction.receive({ type: "room-interaction", id: record.id, requestId: reply.requestId, occurredAt: record.occurredAt,
          sender: { peerId: user.id, displayName: user.name, role: "viewer" },
          payload: { kind: "reaction", reaction: record.reaction, ...(record.targetUserId ? { targetPeerId: record.targetUserId } : {}) } });
        return;
      }
      if (record.type === "error" && !this.requests.has(reply.requestId)) {
        if (!interaction.getSnapshot().ready) this.closeInteractions();
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
      const page = entries.map(({ message, snapshot }) => ({ ...message!, reactions: { revision: snapshot!.revision, choices: snapshot!.choices } }));
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
        ? { ...message, reactions: { revision: snapshot.revision, choices: snapshot.choices } } : message) } });
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
    // A bounded historical window stays put until its reader requests latest.
    if (this.view.historyByRoom[roomId]?.atLatest === false) return;
    const messages = this.view.messagesByRoom[roomId] ?? [];
    let projected: ChannelMessage = { ...message, reactions: { revision: 0, choices: {} } };
    for (const request of this.requests.values()) {
      const snapshot = request.roomId === roomId ? request.history?.entries.get(message.seq)?.snapshot : undefined;
      if (snapshot?.messageId === message.id) projected = mergeMessage(projected,
        { ...message, reactions: { revision: snapshot.revision, choices: snapshot.choices } });
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

  private async connectApp(): Promise<ChannelApp> {
    const state = this.view.state, self = this.view.self;
    if (!state || !self || !this.credential || this.closed) throw new Error("disconnected");
    if (!this.app) {
      const health = await discoverChannelAppHealth({ waitForPermission: false });
      if (!health) throw new Error("app_disconnected");
      if (this.closed || this.view.self?.id !== self.id || this.view.state?.channel.id !== state.channel.id) throw new Error("disconnected");
      if (!this.app) {
        const app = new ChannelApp(health, state.channel.id, self.id, this.credential, self.name, () => {
          if (this.app !== app) return;
          this.app = undefined;
          for (const [roomId, share] of this.screenShares) if (!this.local.has(share.id)) this.screenShares.delete(roomId);
          this.patch({ remoteControls: new Map() });
        }, () => {
          if (this.app === app) this.patch({ error: "capture_audio_failed" });
        }, (id, state) => {
          if (this.app === app) this.patch({ remoteControls: new Map(this.view.remoteControls).set(id, state) });
        });
        this.app = app;
      }
    }
    const app = this.app;
    await app.ready;
    if (this.app === app && !this.closed) this.patch({});
    return app;
  }

  activateApp = (): Promise<void> => this.action("app", async () => { await this.connectApp(); });

  inputPolicy = (publicationId: string, mode: RemoteControlMode, password?: string): Promise<void> =>
    this.action(`input:${publicationId}`, async () => {
      if (!this.app?.screens.has(publicationId)) throw new Error("capture_unavailable");
      await this.app.inputPolicy(publicationId, mode, password);
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
      await this.app.inputSimultaneous(publicationId, state.mode, enabled);
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
    for (const policy of policies) {
      const id = (JSON.parse(policy) as { id: string }).id;
      if (id === skipRoom) continue;
      let hosted = this.hostedRooms.get(id);
      if (!hosted) {
        const host = await storage.open(policy);
        if (this.view.sessionId !== sessionId || this.closed) { await host.close(); return; }
        hosted = { host };
        this.hostedRooms.set(id, hosted);
      }
      const room = await hosted.host.summary();
      if (this.hostedRooms.get(id) !== hosted || this.view.sessionId !== sessionId || this.closed) return;
      await this.request({ type: "host_register", room, resumeBinding: hosted.bindingId });
    }
  }

  private async action<T>(key: string, work: () => Promise<T>, reportError = true): Promise<T> {
    if (this.view.pending.has(key)) throw new Error("operation_pending");
    this.patch({ pending: new Set([...this.view.pending, key]), error: null });
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
    const previous = this.roomId;
    this.roomId = roomId;
    if (previous !== roomId) this.closeInteractions();
    if (this.reading?.roomId !== roomId || this.reading.socket !== this.socket) this.reading = null;
    if (this.view.connection !== "connected") return;
    for (const room of this.view.state?.channel.rooms ?? []) {
      if (room.id !== roomId && (room.reading || room.id === previous) && room.authorized && room.available) {
        this.write({ type: "browse", roomId: room.id, active: false });
      }
    }
    const room = this.view.state?.channel.rooms.find(room => room.id === roomId && room.authorized && room.available);
    if (room?.delivery) {
      if (this.reading) return;
      const reading = { roomId, bindingId: room.delivery.bindingId, socket: this.socket, ready: this.request({ type: "browse", roomId, active: true }) };
      this.reading = reading;
      void reading.ready.then(async () => {
        if (this.reading !== reading || this.socket !== reading.socket || this.roomId !== roomId) return;
        this.syncInteractions();
        if (this.view.pending.has(`history:${roomId}`)) return;
        await this.action(`history:${roomId}`, () => this.request({ type: "history", roomId }).catch(error => {
          if (this.reading === reading && this.socket === reading.socket) throw error;
        }));
      }).catch(error => {
        if (this.reading === reading && this.socket === reading.socket && this.view.connection === "connected") {
          this.closeInteractions();
          this.reading = null;
          this.patch({ error: error instanceof Error ? error.message : "operation_failed" });
        }
      });
    }
  };
  private closeInteractions(): void {
    for (const interaction of this.view.interactionsByRoom.values()) interaction.close();
    if (this.reading) { delete this.reading.interaction; delete this.reading.interactionBinding; }
    if (this.view.interactionsByRoom.size) this.patch({ interactionsByRoom: new Map() });
  }

  private syncInteractions(readyPeer?: string): void {
    const reading = this.reading;
    if (!reading) return;
    void reading.ready.then(() => {
      if (this.reading !== reading || this.socket !== reading.socket || this.view.connection !== "connected" || !this.view.self) return;
      const room = this.view.state?.channel.rooms.find(room => room.id === reading.roomId && room.authorized && room.available);
      const delivery = room?.delivery;
      if (!delivery) return;
      if (reading.interaction && reading.interactionBinding !== delivery.bindingId) this.closeInteractions();
      if (reading.interaction) {
        if (readyPeer && delivery.nextHops[delivery.hostSessionId] === readyPeer && !reading.interaction.getSnapshot().ready) {
          reading.interaction.authenticated(this.view.self.id);
        }
        return;
      }
      if (delivery.hostSessionId !== this.view.sessionId && !delivery.nextHops[delivery.hostSessionId]) return;
      const interaction = this.view.interactionsByRoom.get(reading.roomId) ?? new RoomInteractionSession(message => {
        const current = this.reading;
        if (current?.interaction !== interaction || this.view.connection !== "connected") return false;
        const command = message.type === "subscribe-room-interactions" ? { type: "interaction_ready" as const, roomId: current.roomId }
          : message.type === "send-room-interaction" && message.payload.kind === "reaction"
            ? { type: "interaction" as const, roomId: current.roomId, reaction: message.payload.reaction,
              ...(message.payload.targetPeerId ? { targetUserId: message.payload.targetPeerId } : {}) } : null;
        if (!command) return false;
        const requestId = message.type === "send-room-interaction" ? message.requestId : createOpaqueId();
        void this.conversation.send(command, requestId).catch(() => {
          if (this.reading !== current || current.interaction !== interaction) return;
          if (command.type === "interaction_ready") this.closeInteractions();
          else interaction.receive({ type: "room-interaction-rejected", requestId, reason: "busy" });
        });
        return true;
      });
      reading.interaction = interaction; reading.interactionBinding = delivery.bindingId;
      this.patch({ interactionsByRoom: new Map([[reading.roomId, interaction]]) });
      interaction.authenticated(this.view.self.id);
    }).catch(() => {});
  }
  acceptRoomInvitation = async (): Promise<string | null> => {
    const params = new URLSearchParams(location.hash.slice(1));
    const roomId = params.get("room"), key = params.get("invite");
    if (!roomId || !key) return null;
    this.key = key;
    this.invitedRoom = roomId;
    this.roomId = roomId;
    if (this.view.connection === "connected") {
      await this.action(`enter:${roomId}`, () => this.request({ type: "enter_room", roomId, inviteKey: key }));
    }
    return roomId;
  };
  sendMessage = (roomId: string, text: string, files: DraftFile[] = [], signal?: AbortSignal): Promise<void> => this.action(`chat:${roomId}`, async () => {
    if (files.length && !this.view.state?.channel.rooms.find(room => room.id === roomId)?.capabilities.attachments) throw new Error("attachments_unavailable");
    const sessionId = this.view.sessionId;
    const prepared = files.length ? await this.attachments.describe(files, signal) : [];
    if (this.closed || this.view.sessionId !== sessionId) throw new Error("disconnected");
    signal?.throwIfAborted();
    const attachments = prepared.map(file => file.attachment);
    const content = JSON.stringify({ text, attachments });
    const previous = this.outgoingMessages.get(roomId);
    const attempt = previous?.content === content ? previous : { content, nonce: crypto.randomUUID() };
    this.outgoingMessages.set(roomId, attempt);
    await this.request({ type: "chat", roomId, text, attachments, nonce: attempt.nonce }, event => {
      if (event.type === "confirmed") this.attachments.confirmed(roomId, event.message, prepared);
    });
    this.outgoingMessages.delete(roomId);
    if (this.view.historyByRoom[roomId]?.atLatest === false) void this.loadLatestHistory(roomId).catch(() => {});
  });
  setMessageReaction = (roomId: string, messageSeq: number, reaction: string, active: boolean): Promise<void> =>
    this.action(`reaction:${roomId}:${messageSeq}`, () => this.request({ type: "set_reaction", roomId, messageSeq, reaction, active }));
  loadHistory = (roomId: string): Promise<void> => this.action(`history:${roomId}`, () => this.request({ type: "history", roomId, before: this.view.historyByRoom[roomId]?.before }));
  loadLatestHistory = (roomId: string): Promise<void> => this.action(`history:${roomId}`, () => this.request({ type: "history", roomId }));
  renameSelf = (name: string): Promise<void> => this.action("rename", async () => {
    await this.request({ type: "set_name", name });
    stored(nameKey, name.trim());
  });
  updateDomain = (settings: DomainSettings): Promise<void> => this.action("domain", () => this.request({ type: "update_domain", ...settings }));
  createRoom = (settings: RoomSettings): Promise<string> => this.action("create-room", async () => {
    const app = this.app?.connected ? this.app : undefined;
    const state = this.view.state, self = this.view.self, sessionId = this.view.sessionId;
    if (!state || !self || !sessionId) throw new Error("disconnected");
    const runtime = await loadRoomHosting(), roomId = crypto.randomUUID();
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
    const room = await host.summary();
    if (this.hostedRooms.get(roomId)?.host !== host || this.view.sessionId !== sessionId || this.closed) throw new Error("disconnected");
    await this.request({ type: "host_register", room });
    await this.request({ type: "browse", roomId, active: true });
    return roomId;
  });
  private backupContext(): () => void {
    const { sessionId, self, state } = this.view, socket = this.socket;
    if (!sessionId || !self || !state || this.view.connection !== "connected") throw new Error("disconnected");
    return () => {
      if (this.closed || this.socket !== socket || this.view.connection !== "connected"
        || this.view.sessionId !== sessionId || this.view.self?.id !== self.id || this.view.state?.channel.id !== state.channel.id) throw new Error("disconnected");
    };
  }

  private async backupOwner(roomId: string) {
    const check = this.backupContext(), state = this.view.state!, self = this.view.self!;
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

  private async writeRoomSnapshot(snapshot: BrowserRoomSnapshot, metadata: Extract<BackupMetadata, { kind: "room" }>, retained: RetainedFile[], check: () => void): Promise<Blob> {
    const files = new Map<string, File>(), inventory: RetainedBackupFile[] = [];
    const byKey = new Map(retained.map(file => [JSON.stringify([file.key.messageSeq, file.key.attachmentId]), file]));
    for await (const row of snapshot.rows) {
      check();
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

  exportRoomBackup = (roomId: string): Promise<Blob> => this.action("room-backup", async () => {
    const owner = await this.backupOwner(roomId), retained = await this.attachments.retained(roomId); owner.current();
    let snapshot: BrowserRoomSnapshot | undefined;
    try {
      let metadata: Extract<BackupMetadata, { kind: "room" }>;
      if (owner.native) {
        const archive = await owner.native.snapshot(); owner.current();
        if (!retained.length) return archive;
        let stage: BrowserRoomStage | undefined;
        try {
          const value = await readBackup(archive, {
            metadata: async value => {
              owner.current();
              if (value.kind !== "room" || value.policy.id !== roomId || value.domainId !== this.view.state!.channel.id) throw new Error("invalid_backup");
              stage = await (await loadRoomHosting()).BrowserRoomHost.stage(roomDatabaseName(value.domainId, this.view.self!.id), JSON.stringify(value.policy));
            }, row: row => stage!.append(row), content() {},
          });
          if (value.kind !== "room") throw new Error("invalid_backup");
          snapshot = stage; metadata = value;
        } catch (error) { await stage?.close(); throw error; }
      } else {
        snapshot = await owner.snapshot!(); owner.current();
        metadata = { kind: "room", version: 1, domainId: this.view.state!.channel.id,
          policy: JSON.parse(snapshot.policy), retainedFiles: [] };
      }
      if (metadata.policy.creatorId === this.view.self!.id && this.credential) metadata.ownCredential = { userId: this.view.self!.id, credential: this.credential };
      return await this.writeRoomSnapshot(snapshot!, metadata, retained, owner.current);
    } finally { await snapshot?.close(); }
  }, false);

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

  private async retireRoom(roomId: string): Promise<void> {
    const own = this.view.state?.publications.filter(value => value.roomId === roomId && value.userId === this.view.self?.id && this.view.ownedScreens.has(value.id)) ?? [];
    for (const publication of own) await this.stopScreen(publication.id);
    for (const publication of this.view.state?.publications.filter(value => value.roomId === roomId && this.watching.has(value.id)) ?? []) await this.unwatch(publication.id);
    if (this.voiceCaptures.has(roomId)) await this.leaveVoice(roomId);
    if (this.reading?.roomId === roomId) { this.closeInteractions(); this.reading = null; }
  }

  private async admitBackupIdentity(metadata: Extract<BackupMetadata, { kind: "room" }>): Promise<(() => Promise<void>) | undefined> {
    if (metadata.policy.creatorId === this.view.self?.id) return;
    const check = this.backupContext(), archived = metadata.ownCredential;
    if (!archived || archived.userId !== metadata.policy.creatorId) throw new Error("backup_identity_required");
    const response = await fetch("/prototype/channel/identity", { headers: { Authorization: `Bearer ${archived.credential}` }, cache: "no-store" });
    if (!response.ok) throw new Error("backup_identity_required");
    const identity = z.object({ domainId: z.string(), user: userSchema }).parse(await response.json()); check();
    if (identity.domainId !== metadata.domainId || identity.user.id !== archived.userId) throw new Error("backup_identity_required");
    const previous = { credential: this.credential, key: this.key, invitedRoom: this.invitedRoom, roomId: this.roomId,
      hash: location.hash };
    const rollback = async () => {
      this.close(); this.credential = previous.credential;
      if (previous.credential) stored(credentialKey, previous.credential);
      this.key = previous.key; this.invitedRoom = previous.invitedRoom; this.roomId = previous.roomId;
      if (typeof history !== "undefined") history.replaceState(null, "", location.pathname + location.search + previous.hash);
      this.start();
    };
    try { await this.connectBackupIdentity(metadata.domainId, archived.userId, { credential: archived.credential }, metadata.policy.id); }
    catch (error) { await rollback(); throw error; }
    if (typeof history !== "undefined") history.replaceState(null, "", location.pathname + location.search);
    return rollback;
  }

  private async connectBackupIdentity(domainId: string, userId: string, identity: { credential?: string; key?: string }, skipRoom?: string): Promise<void> {
    this.close(); this.credential = identity.credential; this.key = identity.key; this.invitedRoom = undefined; this.roomId = null;
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
            || (identity.key !== undefined && event.state.channel.ownerId !== userId)) {
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
    const current = this.backupContext();
    if (this.view.state!.channel.ownerId !== this.view.self!.id || !this.credential) throw new Error("forbidden");
    return { current, native: new NativeDomainHosting({ Authorization: `Bearer ${this.credential}` }) };
  }

  exportDomainBackup = (): Promise<Blob> => this.action("domain-backup", async () => {
    const owner = this.domainBackupOwner(), archive = await owner.native.snapshot(); owner.current();
    return archive;
  }, false);

  restoreDomainBackup = (archive: Blob): Promise<void> => this.action("domain-backup", async () => {
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
      await this.connectBackupIdentity(domainId, metadata.state.ownerId, { key: metadata.ownerKey });
      if (typeof history !== "undefined") history.replaceState(null, "", location.pathname + location.search);
    } catch (error) {
      if (!committed) this.start();
      throw error;
    }
  }, false);

  restoreRoomBackup = (archive: Blob, roomId?: string): Promise<{ roomId: string; cached: boolean }> => this.action("room-backup", async () => {
    const initial = this.backupContext(), owner = roomId ? await this.backupOwner(roomId) : undefined;
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
      const check = this.backupContext(), target = metadata.policy.id;
      const app = this.app?.connected ? this.app : undefined;
      const native = owner?.native ?? (!roomId && app ? { restore: (blob: Blob) => app.restoreRoom(blob) } : undefined);
      const previousDelivery = this.view.state?.channel.rooms.find(room => room.id === target)?.delivery;
      const oldBinding = previousDelivery?.bindingId;
      let expectedHost = owner?.native ? previousDelivery?.hostSessionId : this.view.sessionId;
      await this.retireRoom(target); check(); owner?.current();
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
    } catch (error) { if (!committed) await rollback?.(); throw error; }
    finally { await stage?.close(); }
  }, false);

  updateRoom = (roomId: string, settings: RoomSettings): Promise<void> => this.action(`room:${roomId}`, () => this.request({ type: "update_room", roomId, ...settings }));

  setRoomVoiceBitrate = (roomId: string, voiceBitrate: number): Promise<void> => {
    const room = this.view.state?.channel.rooms.find(room => room.id === roomId);
    if (!room?.canManage) return Promise.reject(new Error("forbidden"));
    if (!Number.isInteger(voiceBitrate) || voiceBitrate < 6_000 || voiceBitrate > 320_000) return Promise.reject(new Error("invalid_audio_bitrate"));
    return this.updateRoom(roomId, { name: room.name, icon: room.icon, access: room.access, hidden: room.hidden, voiceBitrate });
  };
  enterRoom = (roomId: string, password: string): Promise<void> => this.action(`enter:${roomId}`, () => this.request({ type: "enter_room", roomId, password }));
  createRoomInvite = (roomId: string): Promise<string> => this.action(`invite:${roomId}`, async () => {
    let key: string | undefined;
    await this.request({ type: "room_invite", roomId }, event => { if (event.type === "room_invite") key = event.key; });
    if (!key) throw new Error("invalid_response");
    const url = new URL(location.pathname, this.invitationOrigin);
    url.hash = new URLSearchParams({ room: roomId, invite: key }).toString();
    return url.href;
  });
  revokeRoomAccess = (roomId: string, userId: string): Promise<void> => this.action(`revoke:${roomId}:${userId}`, () => this.request({ type: "revoke_room_access", roomId, userId }));
  setRoles = (userId: string, roles: string[]): Promise<void> => this.action(`roles:${userId}`, () => this.request({ type: "set_roles", userId, roles }));
  watch = (publicationId: string, roomId?: string): Promise<void> => this.action(`watch:${publicationId}`, async () => {
    this.watching.add(publicationId);
    try { await this.request({ type: "subscribe", publicationId, enabled: true }, undefined, roomId); }
    catch (error) { this.watching.delete(publicationId); this.refreshActivity(); throw error; }
  });
  unwatch = (publicationId: string): Promise<void> => this.action(`watch:${publicationId}`, async () => {
    this.watching.delete(publicationId);
    this.refreshActivity();
    if (this.view.connection === "connected") await this.request({ type: "subscribe", publicationId, enabled: false });
  });
  clearError = (): void => this.patch({ error: null });

  async publish(kind: "screen" | "voice", roomId: string, stream: MediaStream, { microphone, audio, profile, camera, publicationId }: { microphone?: MicrophoneInput; audio?: HostAudio; profile?: QualityProfile; camera?: boolean; publicationId?: string } = {}): Promise<string> {
    const id = publicationId ?? crypto.randomUUID();
    this.local.set(id, { roomId, kind, stream, microphone, audio, profile: kind === "screen" ? profile ?? this.view.quality : undefined, camera });
    this.media.setLocal(id, stream, kind === "screen" ? profile ?? this.view.quality : undefined);
    try {
      if (microphone && !microphone.stream.active) throw new Error("microphone_unavailable");
      await this.request({ type: "publish", publication: { id, roomId, kind, muted: false } });
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
      share = { id: local?.[0] ?? crypto.randomUUID(), profile: local?.[1].profile ?? this.view.quality, volume: { level: 1, muted: false } };
      this.screenShares.set(roomId, share);
    }
    if (this.view.pending.has(`source-audio:${share.id}`)) throw new Error("operation_pending");
    const selection = share.selection = {};
    const epoch = this.captureEpoch;
    const selected = share;
    return { share, current: () => epoch === this.captureEpoch && this.screenShares.get(roomId) === selected && selected.selection === selection };
  }

  private finishScreenSelection(roomId: string, share: ScreenShare): void {
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
    if (!share?.selection) return;
    this.finishScreenSelection(roomId, share);
    await this.app?.cancelCapture(share.id);
    this.patch({});
  };

  startScreen = (roomId: string, source: BrowserCaptureSource = "browser", deviceId = ""): Promise<void> => this.action(`screen:${roomId}`, async () => {
    if (source === "camera" ? !navigator.mediaDevices?.getUserMedia : !navigator.mediaDevices?.getDisplayMedia) throw new Error("capture_unavailable");
    const { share, current } = this.selectScreen(roomId);
    let candidate: MediaStream | undefined;
    let audio: HostAudio | undefined;
    try {
      candidate = await captureBrowserSource(share.profile, source, deviceId);
      if (candidate.getAudioTracks().some(track => track.readyState === "live")) {
        const mixer = new HostAudio(candidate, source, () => {
          if (this.local.get(share.id)?.audio === mixer) this.patch({});
        });
        audio = mixer;
        audio.setVolume(share.volume.muted ? 0 : share.volume.level);
        candidate = await audio.start();
        if (!audio.outputGainAvailable && (share.volume.muted || share.volume.level !== 1)) throw new Error("source_audio_unavailable");
      }
      if (!current()) throw new DOMException("Capture cancelled", "AbortError");
      if (candidate.getVideoTracks()[0]?.readyState !== "live") throw new Error("capture_unavailable");
      const previous = this.local.get(share.id);
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
        this.local.set(share.id, { roomId, kind: "screen", stream: candidate, audio, profile: share.profile, camera: source === "camera" });
        this.admittedPublications.add(share.id);
        this.media.setLocal(share.id, candidate, share.profile);
        this.observeScreen(share.id, candidate);
        candidate = undefined;
        audio = undefined;
        previous?.audio?.dispose();
        previous?.stream.getTracks().forEach(track => track.stop());
        if (!previous) {
          const stopping = app!.stopCapture(share.id);
          const remoteControls = new Map(this.view.remoteControls);
          remoteControls.delete(share.id);
          this.patch({ remoteControls });
          await stopping;
          this.watching.delete(share.id);
          this.refreshActivity();
        }
      } else {
        const stream = candidate;
        candidate = undefined; // publish owns failure cleanup from this point.
        const mixer = audio; audio = undefined;
        await this.publish("screen", roomId, stream, { audio: mixer, profile: share.profile, camera: source === "camera", publicationId: share.id });
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
  nativeCaptureSelection = (roomId: string) => this.screenShares.get(roomId)?.native;

  sourceAudio = (publicationId: string) => {
    const share = [...this.screenShares.values()].find(share => share.id === publicationId);
    if (!share) return undefined;
    return { ...share.volume, bitrate: share.profile.maxAudioBitrate ?? 128_000,
      available: this.local.has(publicationId)
        ? !!this.local.get(publicationId)?.audio?.outputGainAvailable && !!this.local.get(publicationId)?.audio?.sourceAudioAvailable
        : !!share.native?.audio && (this.app?.screens.has(publicationId) ?? false) };
  };

  setSourceAudio = (publicationId: string, settings: { bitrate?: number; level?: number; muted?: boolean }): Promise<void> => {
    const share = [...this.screenShares.values()].find(share => share.id === publicationId);
    if (!share || share.selection) return Promise.reject(new Error("capture_unavailable"));
    const volume = { level: settings.level ?? share.volume.level, muted: settings.muted ?? share.volume.muted };
    const profile = { ...share.profile, maxAudioBitrate: settings.bitrate ?? share.profile.maxAudioBitrate ?? 128_000 };
    if (!supportsCaptureProfile(profile) || !Number.isFinite(volume.level) || volume.level < 0 || volume.level > 2) return Promise.reject(new Error("invalid_audio_settings"));
    let appliedVolume = share.volume, appliedProfile = share.profile;
    share.profile = profile; share.volume = volume;
    this.patch({});
    if (share.audioChange) return share.audioChange;
    const current = () => [...this.screenShares.values()].includes(share);
    share.audioChange = this.action(`source-audio:${publicationId}`, async () => {
      try {
        do {
          const volume = share.volume, profile = share.profile;
          const local = this.local.get(publicationId);
          if (local) {
            if (!local.audio?.outputGainAvailable && (volume.level !== 1 || volume.muted)) throw new Error("source_audio_unavailable");
            local.audio?.setVolume(volume.muted ? 0 : volume.level);
            local.profile = profile;
            this.media.setLocal(publicationId, local.stream, profile);
          } else {
            const app = this.app;
            if (!app?.screens.has(publicationId)) throw new Error("capture_unavailable");
            await app.setSourceAudio(publicationId, profile.maxAudioBitrate!, volume.muted ? 0 : volume.level);
            if (this.app !== app) throw new DOMException("Capture cancelled", "AbortError");
          }
          if (!current()) throw new DOMException("Capture cancelled", "AbortError");
          appliedVolume = volume; appliedProfile = profile;
          if (volume === share.volume && profile === share.profile) return;
        } while (current());
        throw new DOMException("Capture cancelled", "AbortError");
      } catch (error) {
        if (current()) { share.volume = appliedVolume; share.profile = appliedProfile; this.patch({}); }
        throw error;
      }
    }).finally(() => { share.audioChange = undefined; this.patch({}); });
    return share.audioChange;
  };
  startNativeScreen = (roomId: string, target: NativeCaptureTarget, audio = false, excludeAudio?: NativeCaptureTarget): Promise<void> => this.action(`screen:${roomId}`, async () => {
    const { share, current } = this.selectScreen(roomId);
    share.native = { target, audio, excludeAudio: target.kind === "display" ? excludeAudio : undefined };
    let app: ChannelApp | undefined;
    try {
      app = await this.connectApp();
      if (!current()) throw new DOMException("Capture cancelled", "AbortError");
      const preparing = app.prepareCapture(share.id, roomId, target, audio, share.profile, audio ? share.native.excludeAudio : undefined, share.volume.muted ? 0 : share.volume.level);
      this.patch({});
      const prepared = await preparing;
      if (!current() || this.app !== app) throw new DOMException("Capture cancelled", "AbortError");
      if (this.local.has(share.id)) await this.request({ type: "transfer_source", publicationId: share.id, toSessionId: prepared.sessionId }, undefined, roomId);
      if (!current()) throw new DOMException("Capture cancelled", "AbortError");
      await app.commitCapture(share.id, prepared.captureId);
      if (!current()) throw new DOMException("Capture cancelled", "AbortError");
      this.retireCapture(share.id);
      this.patch({});
      // Native owns the source; this page previews it through the ordinary route.
      if (!this.watching.has(share.id)) await this.watch(share.id, roomId);
    } catch (error) {
      await app?.cancelCapture(share.id).catch(() => {});
      throw error;
    } finally { this.finishScreenSelection(roomId, share); }
  });
  stopScreen = (publicationId: string): Promise<void> => this.action(`stop:${publicationId}`, async () => {
    for (const [roomId, share] of this.screenShares) if (share.id === publicationId) this.screenShares.delete(roomId);
    const browser = this.local.get(publicationId);
    // stop_capture also retires a pending Native candidate for a Browser incumbent.
    const nativeStop = this.app?.stopCapture(publicationId);
    if (browser) this.retireCapture(publicationId);
    this.watching.delete(publicationId);
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
    const epoch = this.captureEpoch;
    // Resume during the gesture, before device permission consumes activation.
    const context = new AudioContext();
    const resumed = context.resume().then(() => true, () => false);
    const request: MicrophoneRequest = { context, input: null };
    request.promise = (async () => {
      let stream: MediaStream | undefined, input: MicrophoneInput | undefined;
      try {
        stream = await navigator.mediaDevices.getUserMedia(this.microphoneConstraints(this.view.voiceInput));
        if (epoch !== this.captureEpoch) throw new Error("closed");
        if (stream.getAudioTracks()[0]?.readyState !== "live") throw new Error("microphone_unavailable");
        const captured = input = new MicrophoneInput(stream, context, this.view.voiceInput.volume, () => {
          for (const [id, capture] of [...this.local]) if (capture.microphone === captured) this.voiceCaptureEnded(id, capture.stream);
          captured.close();
          if (this.microphone === captured) this.microphone = null;
        });
        request.input = captured;
        request.context = null;
        const started = await resumed;
        if (epoch !== this.captureEpoch) throw new Error("closed");
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

  configureVoiceInput = (settings: Partial<Pick<RoomPreferences["voiceInput"], "deviceId" | "voiceProcessing">>): Promise<void> => this.action("voice-input", async () => {
    const epoch = this.captureEpoch;
    if (this.microphoneRequest) await this.microphoneRequest.promise;
    if (epoch !== this.captureEpoch) throw new Error("closed");
    const voiceInput = { ...this.view.voiceInput, ...settings };
    const input = this.microphone;
    if (input) {
      let captured: MediaStream | undefined = await navigator.mediaDevices.getUserMedia(this.microphoneConstraints(voiceInput));
      try {
        if (epoch !== this.captureEpoch || this.microphone !== input) throw new Error("closed");
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
    if (this.view.state?.voice.some(member => member.sessionId === this.view.sessionId && member.roomId === roomId)) return;
    let capture: MediaStream | null = null;
    const microphone = !listenOnly && !providedStream ? await this.getMicrophone() : undefined;
    if (!listenOnly) capture = providedStream ?? microphone!.stream.clone();
    this.voiceCaptures.set(roomId, null);
    try {
      await this.request({ type: "voice", roomId, joined: true, muted: listenOnly, deafened: false });
      if (capture) {
        const id = await this.publish("voice", roomId, capture, { microphone });
        this.voiceCaptures.set(roomId, id);
      }
    } catch (error) {
      this.voiceCaptures.delete(roomId);
      capture?.getTracks().forEach(track => track.stop());
      this.releaseUnusedMicrophone();
      await this.request({ type: "voice", roomId, joined: false, muted: true, deafened: false }).catch(() => {});
      throw error;
    }
  });

  leaveVoice = (roomId: string): Promise<void> => this.action(`voice:${roomId}`, async () => {
    const id = this.voiceCaptures.get(roomId);
    this.voiceCaptures.delete(roomId);
    if (id) this.retireCapture(id);
    this.releaseUnusedMicrophone();
    this.refreshActivity();
    if (this.view.connection === "connected") await this.request({ type: "voice", roomId, joined: false, muted: true, deafened: false });
  });

  setMuted = (roomId: string, muted: boolean): Promise<void> => this.action(`voice:${roomId}`, async () => {
    const member = this.view.state?.voice.find(value => value.sessionId === this.view.sessionId && value.roomId === roomId);
    if (!member) return;
    if (!muted && !this.voiceCaptures.get(roomId)) {
      const microphone = await this.getMicrophone();
      const id = await this.publish("voice", roomId, microphone.stream.clone(), { microphone });
      this.voiceCaptures.set(roomId, id);
    }
    await this.request({ type: "voice", roomId, joined: true, muted, deafened: member.deafened });
    const id = this.voiceCaptures.get(roomId);
    if (id) this.local.get(id)?.stream.getAudioTracks().forEach(track => { track.enabled = !muted; });
  });

  setDeafened = (roomId: string, deafened: boolean): Promise<void> => this.action(`voice:${roomId}`, async () => {
    const member = this.view.state?.voice.find(value => value.sessionId === this.view.sessionId && value.roomId === roomId);
    if (member) await this.request({ type: "voice", roomId, joined: true, muted: member.muted, deafened });
  });

  private releaseUnusedMicrophone(): void {
    if ([...this.voiceCaptures.values()].some(Boolean) || [...this.view.pending].some(key => key.startsWith("voice:"))) return;
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
    this.captureEpoch += 1;
    this.screenShares.clear();
    this.app?.stopCaptures();
    this.input.reset();
    this.attachments.reset();
    for (const capture of this.local.values()) capture.audio?.dispose();
    this.media.reset();
    this.local.clear();
    this.admittedPublications.clear();
    this.voiceCaptures.clear();
    this.watching.clear();
    this.microphone?.close();
    this.microphone = null;
    this.microphoneRequest?.input?.close();
    void this.microphoneRequest?.context?.close().catch(() => {});
    if (this.microphoneRequest) this.microphoneRequest.context = null;
    this.signals = [];
  }

  private retireCapture(id: string): void {
    this.admittedPublications.delete(id);
    this.local.get(id)?.audio?.dispose();
    this.local.delete(id);
    this.media.removeLocal(id);
    for (const [roomId, publicationId] of this.voiceCaptures) {
      if (publicationId === id) this.voiceCaptures.set(roomId, null);
    }
  }

  private refreshActivity(): void {
    if (this.view.state) this.patch({ state: this.projectActivity(this.view.state) });
    this.input.update();
    this.releaseUnusedMicrophone();
  }

  private projectActivity(state: ChannelSnapshot): ChannelSnapshot {
    const sessionId = this.view.sessionId;
    // Only authority updates retire leases and assign transports. Local stop
    // intent changes what this page presents, even while the host is unreachable.
    return {
      ...state,
      publications: state.publications.filter(publication => publication.sessionId !== sessionId || this.local.has(publication.id)
        || this.screenShares.get(publication.roomId)?.id === publication.id),
      voice: state.voice.filter(member => member.sessionId !== sessionId || this.voiceCaptures.has(member.roomId)).map(member =>
        member.sessionId === sessionId && this.voiceCaptures.get(member.roomId) === null
          && ![...this.local.values()].some(capture => capture.kind === "voice" && capture.roomId === member.roomId)
          ? { ...member, muted: true } : member),
      subscriptions: state.subscriptions.filter(id => {
        const publication = state.publications.find(value => value.id === id);
        return publication?.kind === "voice" ? this.voiceCaptures.has(publication.roomId) : this.watching.has(id);
      }),
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
