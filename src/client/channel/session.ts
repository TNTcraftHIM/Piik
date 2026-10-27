import { ChannelMedia } from "./media";
import { eventSchema, type ChannelCommand, type ChannelEvent, type ChannelReply, type ChannelSnapshot, type RoomSettings } from "./protocol";
import { ChannelAttachments } from "./attachments";
import type { ChannelView } from "./types";

const credentialKey = "piik.channel.prototype.credential";
const nameKey = "piik.channel.prototype.name";

function stored(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch { return null; }
}

/** The live browser endpoint owns captures and reconnects; browsing owns neither. */
export class ChannelSession {
  private view: ChannelView = {
    state: null, sessionId: null, self: null, connection: "connecting", messagesByRoom: {}, historyByRoom: {},
    streams: new Map(), error: null, inviteURL: null, pending: new Set(),
  };
  private listeners = new Set<() => void>();
  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private recoveryDeadline: ReturnType<typeof setTimeout> | null = null;
  private closed = true;
  private credential = stored(credentialKey) ?? undefined;
  private key = new URLSearchParams(location.hash.slice(1)).get("owner")
    ?? new URLSearchParams(location.hash.slice(1)).get("invite") ?? undefined;
  private invitedRoom = new URLSearchParams(location.hash.slice(1)).get("room") ?? undefined;
  private roomId: string | null = this.invitedRoom ?? null;
  private requests = new Map<string, { resolve(): void; reject(error: Error): void; result?: (event: ChannelReply) => void; timer: ReturnType<typeof setTimeout> }>();
  private signals: Extract<ChannelCommand, { type: "signal" }>[] = [];
  private microphone: MediaStream | null = null;
  private microphoneRequest: Promise<MediaStream> | null = null;
  private voiceCaptures = new Map<string, string | null>();
  private watching = new Set<string>();
  private admittedPublications = new Set<string>();
  private historyChannel: string | null = null;
  private outgoingMessages = new Map<string, { content: string; nonce: string }>();
  private captureEpoch = 0;
  private local = new Map<string, { roomId: string; kind: "screen" | "voice"; stream: MediaStream }>();
  private media = new ChannelMedia(command => this.send(command), streams => this.patch({ streams }));
  readonly attachments = new ChannelAttachments(() => this.credential);

  getSnapshot = (): ChannelView => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  stats = () => this.media.stats();

  private patch(patch: Partial<ChannelView>): void {
    this.view = { ...this.view, ...patch };
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
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.write({ type: "join", name: stored(nameKey) ?? "Guest", credential: this.credential, key: this.key, roomId: this.invitedRoom, sessionId: this.view.sessionId ?? undefined });
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
      this.credential = event.credential;
      stored(credentialKey, event.credential);
      const invite = event.inviteKey ?? (!this.invitedRoom ? new URLSearchParams(location.hash.slice(1)).get("invite") : null);
      const inviteURL = new URL(location.pathname, location.origin);
      if (invite) inviteURL.hash = new URLSearchParams({ invite }).toString();
      this.patch({ sessionId: event.sessionId, connection: "connected", error: null, inviteURL: invite ? inviteURL.href : null });
      this.applyState(event.state);
      if (resumed) {
        for (const publication of event.state.publications) {
          if (publication.sessionId === event.sessionId && !this.local.has(publication.id)) this.write({ type: "unpublish", publicationId: publication.id });
        }
        for (const member of event.state.voice) {
          if (member.sessionId === event.sessionId && !this.voiceCaptures.has(member.roomId)) this.write({ type: "voice", roomId: member.roomId, joined: false, muted: true, deafened: false });
        }
        for (const id of event.state.subscriptions) {
          if (event.state.publications.some(publication => publication.id === id && publication.kind === "screen") && !this.watching.has(id)) {
            this.write({ type: "subscribe", publicationId: id, enabled: false });
          }
        }
      }
      this.browse(this.roomId ?? event.state.channel.rooms[0]?.id ?? "");
      for (const command of this.signals.splice(0)) {
        if (event.state.pairs.some(pair => pair.id === command.pairId)) this.write(command);
      }
    } else if (event.type === "state") this.applyState(event.state);
    else if (event.type === "history") {
      const state = this.view.state;
      if (!state?.channel.rooms.some(room => room.id === event.roomId && room.authorized)) return;
      const existing = event.before === undefined ? [] : this.view.messagesByRoom[event.roomId] ?? [];
      const messages = [...new Map([...existing, ...event.messages].map(message => [message.id, message])).values()]
        .filter(message => event.oldestSeq !== null && message.seq >= event.oldestSeq)
        .sort((a, b) => a.seq - b.seq).slice(-state.channel.historyLimit);
      this.patch({ messagesByRoom: { ...this.view.messagesByRoom, [event.roomId]: messages },
        historyByRoom: { ...this.view.historyByRoom, [event.roomId]: { hasMore: event.hasMore, before: messages[0]?.seq } } });
    } else if (event.type === "message") {
      const state = this.view.state;
      if (!state?.channel.rooms.some(room => room.id === event.roomId && room.authorized)) return;
      const messages = this.view.messagesByRoom[event.roomId] ?? [];
      if (!messages.some(message => message.id === event.message.id)) {
        this.patch({ messagesByRoom: { ...this.view.messagesByRoom, [event.roomId]: [...messages, event.message].slice(-state.channel.historyLimit) } });
      }
    } else if (event.type === "room_created" || event.type === "room_invite") {
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
      if (!state.publications.some(publication => publication.id === id)) this.watching.delete(id);
    }
    // Server assignments own transports. Local stop intent owns what this page
    // presents and plays, including while the authority is temporarily unreachable.
    const visible: ChannelSnapshot = {
      ...state,
      publications: state.publications.filter(publication => publication.sessionId !== sessionId || this.local.has(publication.id)),
      voice: state.voice.filter(member => member.sessionId !== sessionId || this.voiceCaptures.has(member.roomId)),
      subscriptions: state.subscriptions.filter(id => {
        const publication = state.publications.find(value => value.id === id);
        return publication?.kind === "voice" ? this.voiceCaptures.has(publication.roomId) : this.watching.has(id);
      }),
    };
    const sameChannel = this.historyChannel === state.channel.id;
    this.historyChannel = state.channel.id;
    const canRead = (id: string) => sameChannel && state.channel.rooms.some(room => room.id === id && room.authorized);
    for (const id of this.outgoingMessages.keys()) if (!canRead(id)) this.outgoingMessages.delete(id);
    this.patch({ state: visible, self: state.users.find(user => user.id === userId) ?? null,
      messagesByRoom: Object.fromEntries(Object.entries(this.view.messagesByRoom).filter(([id]) => canRead(id))),
      historyByRoom: Object.fromEntries(Object.entries(this.view.historyByRoom).filter(([id]) => canRead(id))),
    });
    this.media.update(sessionId, state);
    this.releaseUnusedMicrophone();
  }

  private write(command: ChannelCommand & { requestId?: string }): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(command));
  }

  private send(command: ChannelCommand): void {
    if (this.view.connection === "connected") this.write(command);
    else if (command.type === "signal" && this.signals.length < 256) this.signals.push(command);
  }

  private request(command: ChannelCommand, result?: (event: ChannelReply) => void): Promise<void> {
    if (this.view.connection !== "connected") return Promise.reject(new Error("disconnected"));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(requestId); reject(new Error("request_timeout")); }, 10000);
      this.requests.set(requestId, { resolve, reject, timer, result });
      this.write({ ...command, requestId });
    });
  }

  private async action<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.view.pending.has(key)) throw new Error("operation_pending");
    this.patch({ pending: new Set([...this.view.pending, key]), error: null });
    try { return await work(); }
    catch (error) {
      const code = error instanceof DOMException ? error.name : error instanceof Error ? error.message : "operation_failed";
      this.patch({ error: code });
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
    if (this.view.connection === "connected" && this.view.state?.channel.rooms.some(room => room.id === roomId && room.authorized)) {
      this.write({ type: "browse", roomId });
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
  sendMessage = (roomId: string, text: string, attachments: string[] = []): Promise<void> => this.action(`chat:${roomId}`, async () => {
    const content = JSON.stringify({ text, attachments });
    const previous = this.outgoingMessages.get(roomId);
    const attempt = previous?.content === content ? previous : { content, nonce: crypto.randomUUID() };
    this.outgoingMessages.set(roomId, attempt);
    await this.request({ type: "chat", roomId, text, attachments, nonce: attempt.nonce });
    this.outgoingMessages.delete(roomId);
  });
  loadHistory = (roomId: string): Promise<void> => this.action(`history:${roomId}`, () => this.request({ type: "history", roomId, before: this.view.historyByRoom[roomId]?.before }));
  renameSelf = (name: string): Promise<void> => this.action("rename", async () => {
    await this.request({ type: "set_name", name });
    stored(nameKey, name.trim());
  });
  createRoom = (settings: RoomSettings): Promise<string> => this.action("create-room", async () => {
    let roomId: string | undefined;
    await this.request({ type: "create_room", ...settings }, event => { if (event.type === "room_created") roomId = event.roomId; });
    if (!roomId) throw new Error("invalid_response");
    return roomId;
  });
  updateRoom = (roomId: string, settings: RoomSettings): Promise<void> => this.action(`room:${roomId}`, () => this.request({ type: "update_room", roomId, ...settings }));
  enterRoom = (roomId: string, password: string): Promise<void> => this.action(`enter:${roomId}`, () => this.request({ type: "enter_room", roomId, password }));
  createRoomInvite = (roomId: string): Promise<string> => this.action(`invite:${roomId}`, async () => {
    let key: string | undefined;
    await this.request({ type: "room_invite", roomId }, event => { if (event.type === "room_invite") key = event.key; });
    if (!key) throw new Error("invalid_response");
    const url = new URL(location.pathname, location.origin);
    url.hash = new URLSearchParams({ room: roomId, invite: key }).toString();
    return url.href;
  });
  revokeRoomAccess = (roomId: string, userId: string): Promise<void> => this.action(`revoke:${roomId}:${userId}`, () => this.request({ type: "revoke_room_access", roomId, userId }));
  setRoles = (userId: string, roles: string[]): Promise<void> => this.action(`roles:${userId}`, () => this.request({ type: "set_roles", userId, roles }));
  watch = (publicationId: string): Promise<void> => this.action(`watch:${publicationId}`, async () => {
    this.watching.add(publicationId);
    try { await this.request({ type: "subscribe", publicationId, enabled: true }); }
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
      this.admittedPublications.add(id);
      if (kind === "screen") stream.getVideoTracks()[0]?.addEventListener("ended", () => { void this.stopScreen(id).catch(() => {}); }, { once: true });
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
  stopScreen = (publicationId: string): Promise<void> => this.action(`stop:${publicationId}`, async () => {
    this.retireCapture(publicationId);
    this.refreshActivity();
    if (this.view.connection === "connected") await this.request({ type: "unpublish", publicationId });
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
    if (this.view.state) this.applyState(this.view.state);
  }

  private beginRecovery(): void {
    if (!this.view.sessionId || this.recoveryDeadline !== null) return;
    this.recoveryDeadline = setTimeout(() => {
      this.recoveryDeadline = null;
      this.releaseMedia();
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
    this.write({ type: "leave" });
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.rejectRequests("closed");
    this.releaseMedia();
    this.patch({ connection: "closed", state: null, sessionId: null, self: null });
  };
}
