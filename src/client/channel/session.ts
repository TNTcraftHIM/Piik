import { ChannelMedia } from "./media";
import { ChannelInput } from "./input";
import { ChannelConversation } from "./conversation";
import { eventSchema, type ChannelCommand, type ChannelEvent, type ChannelMessage, type ChannelReply, type ChannelSnapshot, type ConversationReply, type DomainSettings, type RoomSettings } from "./protocol";
import { ChannelAttachments, type DraftFile } from "./attachments";
import type { ChannelView, ScreenPresentation } from "./types";
import { loadRoomHosting, roomDatabaseName, type HostedRoom } from "./hosting";
import { ChannelApp, discoverChannelAppHealth, type NativeCaptureSources } from "./app-link";
import { isClientActivated } from "../lib/session";
import type { NativeCaptureTarget, RemoteStopShortcut } from "../native/wire";
import type { RemoteControlMode } from "../remote-control/protocol";
import { readRoomPreferences } from "../lib/room-preferences";

const credentialKey = "piik.channel.prototype.credential";
const nameKey = "piik.channel.prototype.name";

function stored(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch { return null; }
}

function mergeMessages(messages: ChannelMessage[]): ChannelMessage[] {
  return [...new Map(messages.map(message => [message.id, message])).values()]
    .sort((a, b) => a.seq - b.seq);
}

/** The live browser endpoint owns captures and reconnects; browsing owns neither. */
export class ChannelSession {
  private view: ChannelView = {
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
    roomId?: string; bindingId?: string; history?: ChannelMessage[];
    pendingSend?: Extract<ChannelCommand, { type: "chat" | "history" }>;
    resolve(): void; reject(error: Error): void; result?: (event: ChannelReply) => void; timer: ReturnType<typeof setTimeout>;
  }>();
  private hostedRooms = new Map<string, { host: HostedRoom; bindingId?: string }>();
  private app: ChannelApp | undefined;
  private hostCleanup: Promise<void> = Promise.resolve();
  private signals: Extract<ChannelCommand, { type: "signal" }>[] = [];
  private microphone: MediaStream | null = null;
  private microphoneRequest: Promise<MediaStream> | null = null;
  private voiceCaptures = new Map<string, string | null>();
  private watching = new Set<string>();
  private admittedPublications = new Set<string>();
  private historyChannel: string | null = null;
  private reading: { roomId: string; socket: WebSocket | null; ready: Promise<void> } | null = null;
  private outgoingMessages = new Map<string, { content: string; nonce: string }>();
  private captureEpoch = 0;
  private local = new Map<string, { roomId: string; kind: "screen" | "voice"; stream: MediaStream }>();
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
    }, (peer, ready) => this.attachments.peerState(peer, ready), peer => this.attachments.bulkClosed(peer),
    (pair, channel) => this.input.setChannel(pair, channel));
  readonly attachments = new ChannelAttachments(command => this.request(command), async (peer, kind, data, allowed) =>
    this.media.sendData(peer, kind, kind === "control" ? await this.conversation.fileFrame(data as string) : data, allowed));

  getSnapshot = (): ChannelView => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  stats = () => this.media.stats();
  screenPresentation = (flowId: string, stream: MediaStream, state: ScreenPresentation): void => this.media.screenPresentation(flowId, stream, state);

  private patch(patch: Partial<ChannelView>): void {
    const ownedScreens = new Set(this.app?.screens);
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

  private connect(): void {
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
        this.receive(result.data);
      } catch { this.patch({ error: "invalid_response" }); }
    };
    socket.onclose = () => {
      if (this.socket !== socket || this.closed) return;
      this.socket = null;
      this.rejectRequests("disconnected");
      this.patch({ connection: "reconnecting" });
      this.beginRecovery();
      this.retry = setTimeout(() => { this.retry = null; this.connect(); }, 1000);
    };
    socket.onerror = () => { /* The close event owns retry. */ };
  }

  private receive(event: ChannelEvent): void {
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
      void this.restoreHosts(event.sessionId).catch(error => {
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
      if (!state.publications.some(publication => publication.id === id)) this.retireCapture(id);
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
        void this.app.stopCapture(publication.id).catch(() => {});
      }
    }
    const visible = this.projectActivity(state);
    const sameChannel = this.historyChannel === state.channel.id;
    this.historyChannel = state.channel.id;
    const canRead = (id: string) => sameChannel && state.channel.rooms.some(room => room.id === id && room.authorized);
    for (const [id, request] of this.requests) if (request.bindingId
      && !state.channel.rooms.some(room => room.id === request.roomId && room.authorized
        && room.available && room.delivery?.bindingId === request.bindingId)) {
      clearTimeout(request.timer);
      this.requests.delete(id);
      request.reject(new Error("room_unavailable"));
    }
    for (const id of this.outgoingMessages.keys()) if (!canRead(id)) this.outgoingMessages.delete(id);
    this.patch({ state: visible, self: state.users.find(user => user.id === userId) ?? null,
      messagesByRoom: Object.fromEntries(Object.entries(this.view.messagesByRoom).filter(([id]) => canRead(id))),
      historyByRoom: Object.fromEntries(Object.entries(this.view.historyByRoom).filter(([id]) => canRead(id))),
    });
    if (this.reading && !state.channel.rooms.some(room => room.id === this.reading!.roomId && room.authorized && room.available)) this.reading = null;
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
    this.attachments.update(sessionId, state.files, state.channel.rooms);
    this.sendConversations();
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
    const conversation = command.type === "chat" || command.type === "history";
    if (conversation && reading && reading.roomId === roomId) await reading.ready;
    if (this.view.connection !== "connected") return Promise.reject(new Error("disconnected"));
    const room = this.view.state?.channel.rooms.find(room => room.id === roomId);
    const delivery = room?.delivery;
    if (conversation && (!room?.available || !delivery)) return Promise.reject(new Error("room_unavailable"));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(requestId); reject(new Error("request_timeout")); }, 10000);
      this.requests.set(requestId, { resolve, reject, timer, result, roomId,
        ...(conversation ? { bindingId: delivery!.bindingId, pendingSend: command, ...(command.type === "history" ? { history: [] } : {}) } : {}) });
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
    if (record.type === "live_message") {
      this.applyMessage(reply.roomId, record.message);
      return;
    }
    const request = this.requests.get(reply.requestId);
    if (!request || request.roomId !== reply.roomId || request.bindingId !== reply.bindingId) return;
    if (record.type === "history_message") {
      if (!request.history || request.history.length >= 100 || request.history.some(message => message.seq === record.message.seq)) {
        this.receive({ type: "error", requestId: reply.requestId, code: "incomplete_history" });
        return;
      }
      request.history.push(record.message);
      return;
    }
    if (record.type === "history_end" && request.history) {
      if (record.count !== request.history.length) {
        this.receive({ type: "error", requestId: reply.requestId, code: "incomplete_history" });
        return;
      }
      this.applyHistory(reply.roomId, request.history, record);
    } else if (record.type === "confirmed") {
      request.result?.(record);
      this.applyMessage(reply.roomId, record.message);
    }
    this.receive(record.type === "error" ? { type: "error", requestId: reply.requestId, code: record.code }
      : { type: "ack", requestId: reply.requestId });
  }

  private applyHistory(roomId: string, page: ChannelMessage[], result: Extract<ConversationReply["record"], { type: "history_end" }>): void {
    const state = this.view.state;
    if (!state?.channel.rooms.some(room => room.id === roomId && room.authorized)) return;
    const current = this.view.messagesByRoom[roomId] ?? [];
    const last = page.at(-1)?.seq ?? 0;
    const latest = result.before === null;
    const existing = latest ? current.filter(message => message.seq > last) : current;
    const merged = mergeMessages([...existing, ...page]
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
    this.patch({ messagesByRoom: { ...this.view.messagesByRoom,
      [roomId]: mergeMessages([...messages, message]).slice(-state.channel.historyWindow) } });
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

  inputShortcut = async (publicationId: string, key?: number): Promise<RemoteStopShortcut> => {
    const app = this.app, state = this.view.remoteControls.get(publicationId);
    if (!app?.screens.has(publicationId) || !state) throw new Error("input_unavailable");
    if (key === undefined) return { key: state.stopShortcut ?? readRoomPreferences().remoteStopKey, available: state.stopShortcut != null };
    const shortcut = await app.inputShortcut(publicationId, key);
    const current = this.view.remoteControls.get(publicationId);
    if (this.app === app && app.screens.has(publicationId) && current && shortcut.available && current.stopShortcut !== shortcut.key) {
      this.patch({ remoteControls: new Map(this.view.remoteControls).set(publicationId, { ...current, stopShortcut: shortcut.key }) });
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

  private async restoreHosts(sessionId: string): Promise<void> {
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

  private async action<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.view.pending.has(key)) throw new Error("operation_pending");
    this.patch({ pending: new Set([...this.view.pending, key]), error: null });
    try { return await work(); }
    catch (error) {
      const code = error instanceof DOMException ? error.name : error instanceof Error ? error.message : "operation_failed";
      if (code !== "AbortError") this.patch({ error: code });
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
    if (this.reading?.roomId !== roomId || this.reading.socket !== this.socket) this.reading = null;
    if (this.view.connection !== "connected") return;
    for (const room of this.view.state?.channel.rooms ?? []) {
      if (room.id !== roomId && (room.reading || room.id === previous) && room.authorized && room.available) {
        this.write({ type: "browse", roomId: room.id, active: false });
      }
    }
    if (this.view.state?.channel.rooms.some(room => room.id === roomId && room.authorized && room.available)) {
      if (this.reading) return;
      const reading = { roomId, socket: this.socket, ready: this.request({ type: "browse", roomId, active: true }) };
      this.reading = reading;
      void reading.ready.then(async () => {
        if (this.reading !== reading || this.socket !== reading.socket || this.roomId !== roomId) return;
        if (this.view.pending.has(`history:${roomId}`)) return;
        await this.action(`history:${roomId}`, () => this.request({ type: "history", roomId }).catch(error => {
          if (this.reading === reading && this.socket === reading.socket) throw error;
        }));
      }).catch(error => {
        if (this.reading === reading && this.socket === reading.socket && this.view.connection === "connected") {
          this.reading = null;
          this.patch({ error: error instanceof Error ? error.message : "operation_failed" });
        }
      });
    }
  };
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
  updateRoom = (roomId: string, settings: RoomSettings): Promise<void> => this.action(`room:${roomId}`, () => this.request({ type: "update_room", roomId, ...settings }));
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

  async publish(kind: "screen" | "voice", roomId: string, stream: MediaStream): Promise<string> {
    const id = crypto.randomUUID();
    this.local.set(id, { roomId, kind, stream });
    this.media.setLocal(id, stream);
    try {
      await this.request({ type: "publish", publication: { id, roomId, kind, muted: false } });
      const primary = kind === "screen" ? stream.getVideoTracks()[0] : stream.getAudioTracks()[0];
      if (primary?.readyState === "ended") {
        this.send({ type: "unpublish", publicationId: id });
        throw new Error(kind === "screen" ? "capture_unavailable" : "microphone_unavailable");
      }
      this.admittedPublications.add(id);
      if (kind === "screen") primary?.addEventListener("ended", () => { void this.stopScreen(id).catch(() => {}); }, { once: true });
      else primary?.addEventListener("ended", () => {
        if (this.local.get(id)?.stream !== stream) return;
        const voice = this.view.state?.voice.find(member => member.sessionId === this.view.sessionId && member.roomId === roomId);
        this.retireCapture(id);
        this.refreshActivity();
        this.send({ type: "unpublish", publicationId: id });
        if (voice) this.send({ type: "voice", roomId, joined: true, muted: true, deafened: voice.deafened });
      }, { once: true });
      return id;
    } catch (error) {
      this.local.delete(id);
      this.media.removeLocal(id);
      throw error;
    }
  }

  startScreen = (roomId: string): Promise<void> => this.action(`screen:${roomId}`, async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("capture_unavailable");
    const epoch = this.captureEpoch;
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true });
    if (epoch !== this.captureEpoch) { stream.getTracks().forEach(track => track.stop()); throw new Error("closed"); }
    await this.publish("screen", roomId, stream);
  });
  nativeSources = async (): Promise<NativeCaptureSources> => (await this.connectApp()).sources();
  nativeCaptureRequest = (roomId: string) => this.app?.captureRequest(roomId);
  startNativeScreen = (roomId: string, target: NativeCaptureTarget, audio = false): Promise<void> => this.action(`screen:${roomId}`, async () => {
    const epoch = this.captureEpoch;
    const app = await this.connectApp();
    if (epoch !== this.captureEpoch) throw new Error("closed");
    const id = crypto.randomUUID();
    const starting = app.startCapture(id, roomId, target, audio);
    this.patch({});
    await starting;
    this.patch({});
    try {
      if (epoch !== this.captureEpoch || this.app !== app) throw new Error("closed");
      // Native owns the source; this page previews it through the ordinary route.
      await this.watch(id, roomId);
    } catch (error) {
      await app.stopCapture(id).catch(() => {});
      throw error;
    }
  });
  stopScreen = (publicationId: string): Promise<void> => this.action(`stop:${publicationId}`, async () => {
    if (this.app?.screens.has(publicationId)) {
      this.watching.delete(publicationId);
      await this.app.stopCapture(publicationId);
      this.refreshActivity();
      return;
    }
    const roomId = this.local.get(publicationId)?.roomId ?? this.commandRoom({ type: "unpublish", publicationId });
    this.retireCapture(publicationId);
    this.refreshActivity();
    if (this.view.connection === "connected") await this.request({ type: "unpublish", publicationId }, undefined, roomId);
  });

  private async getMicrophone(): Promise<MediaStream> {
    if (this.microphone?.active) return this.microphone;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("microphone_unavailable");
    const epoch = this.captureEpoch;
    this.microphoneRequest ??= navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    try {
      const stream = await this.microphoneRequest;
      if (epoch !== this.captureEpoch) { stream.getTracks().forEach(track => track.stop()); throw new Error("closed"); }
      this.microphone = stream;
      return stream;
    }
    finally { this.microphoneRequest = null; }
  }

  joinVoice = (roomId: string, listenOnly = false, providedStream?: MediaStream): Promise<void> => this.action(`voice:${roomId}`, async () => {
    if (this.view.state?.voice.some(member => member.sessionId === this.view.sessionId && member.roomId === roomId)) return;
    let capture: MediaStream | null = null;
    if (!listenOnly) capture = providedStream ?? (await this.getMicrophone()).clone();
    this.voiceCaptures.set(roomId, null);
    try {
      await this.request({ type: "voice", roomId, joined: true, muted: listenOnly, deafened: false });
      if (capture) {
        const id = await this.publish("voice", roomId, capture);
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
      const stream = (await this.getMicrophone()).clone();
      const id = await this.publish("voice", roomId, stream);
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
    this.microphone?.getTracks().forEach(track => track.stop());
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
    this.captureEpoch += 1;
    this.app?.stopCaptures();
    this.input.reset();
    this.attachments.reset();
    this.media.reset();
    this.local.clear();
    this.admittedPublications.clear();
    this.voiceCaptures.clear();
    this.watching.clear();
    this.microphone?.getTracks().forEach(track => track.stop());
    this.microphone = null;
    this.signals = [];
  }

  private retireCapture(id: string): void {
    this.admittedPublications.delete(id);
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
      publications: state.publications.filter(publication => publication.sessionId !== sessionId || this.local.has(publication.id)),
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
