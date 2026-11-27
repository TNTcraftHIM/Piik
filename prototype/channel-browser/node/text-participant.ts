// Internal Node text client; ordinary participant authority and Core conversation verification.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import type { MessageReactionSnapshot, ProfileUpdate, ReactionEvent, ReactionTarget } from '../../../src/client/channel/protocol';
import init, { SessionSigner, verify_conversation } from '../pkg/piik_channel_browser.js';
import { CHANNEL_PROTOCOL, CHANNEL_EVENT_BYTES, CHANNEL_SESSION_LIMIT, CHANNEL_ROOM_LIMIT, channelWelcomeSchema, eventSchema, requireConversationDelivery, roomSchema, createRoomCommand, snapshotSchema, type ChannelCommand, type ChannelEvent, type ConversationAddress, type ConversationReply, type ChannelMessage, type ChatOptions, type RoomSettings, type RoomSummary } from '../../../src/client/channel/protocol';
await init({ module_or_path: readFileSync(new URL('../pkg/piik_channel_browser_bg.wasm', import.meta.url)) });
type ConversationCommand = Extract<ChannelCommand, {
  type: 'chat' | 'history' | 'interaction_ready' | 'react' | 'delete_message';
}>;
export type TextHistoryPage = Omit<Extract<ConversationReply['record'], { type: 'history_page' }>, 'type'>;
export type TextReactionResult = {
  type: 'reaction';
  nonce: number;
  snapshot: MessageReactionSnapshot & { type: 'message' };
  event: (ReactionEvent & { target: Extract<ReactionTarget, { type: 'message' }> }) | null;
};

const conversationRoomSchema = roomSchema.pick({ id: true, authorized: true, available: true, reading: true })
  .extend({ delivery: roomSchema.shape.delivery.unwrap().pick({ hostSessionId: true, bindingId: true }).optional() });
const conversationStateSchema = z.object({
  channel: snapshotSchema.shape.channel.pick({ hostingMode: true })
    .extend({ rooms: z.array(conversationRoomSchema).max(CHANNEL_ROOM_LIMIT) }),
  sessions: z.array(snapshotSchema.shape.sessions.element.pick({ id: true, signingKey: true })).max(CHANNEL_SESSION_LIMIT),
});
const textWelcomeSchema = channelWelcomeSchema.extend({ state: conversationStateSchema,
  selfProfile: channelWelcomeSchema.shape.selfProfile.pick({ id: true }) });
const textStateSchema = z.object({ type: z.literal('state'), state: conversationStateSchema });
const eventHeaderSchema = z.object({ type: z.string(), protocol: z.unknown().optional() });
type TextEvent = ChannelEvent | z.infer<typeof textWelcomeSchema> | z.infer<typeof textStateSchema>;

function decodeTextEvent(raw: unknown, wireBytes: number): TextEvent | undefined {
  if (wireBytes > CHANNEL_EVENT_BYTES) throw new Error('Channel event exceeds frame limit');
  const header = eventHeaderSchema.parse(raw);
  switch (header.type) {
    case 'welcome':
      if (header.protocol !== CHANNEL_PROTOCOL) throw new Error('incompatible_protocol');
      return textWelcomeSchema.parse(raw);
    case 'state': return textStateSchema.parse(raw);
    case 'conversation': case 'room_created': case 'room_reply': case 'ack': case 'error': return eventSchema.parse(raw);
    // This participant neither installs media nor hosts rooms.
    default: return;
  }
}

export interface TextParticipantOptions {
  url: string;
  origin: string;
  roomId?: string;
  name?: string;
  credential?: string;
  admission?: { inviteKey?: string; password?: string };
}
type ConversationResult = 'confirmed' | 'history_page' | 'interaction_ready' | 'reaction' | 'message_deleted';
type Pending = {
  roomId?: string;
  expects: 'ack' | 'room_created' | ConversationResult;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
function expectsWriterResult(expects: Pending['expects']): boolean {
  return expects !== 'ack' && expects !== 'room_created';
}
/** Only socket/request I/O; the existing Core WASM signs and validates every room record. */
export type TextParticipantEvents = {
  credential: [credential: string];
  ready: [summary: ReturnType<TextParticipant['summary']>];
  state: [summary: ReturnType<TextParticipant['summary']>];
  failure: [error: Error];
  disconnected: [];
  confirmed: [message: ChannelMessage];
  live: [message: ChannelMessage];
};
export class TextParticipant extends EventEmitter<TextParticipantEvents> {
  private signer = new SessionSigner(randomBytes(32));
  private socket?: WebSocket;
  private credential?: string;
  private sessionId?: string;
  private userId?: string;
  private roomId?: string;
  private acceptBrowse?: () => void;
  private state?: z.infer<typeof conversationStateSchema>;
  private pending = new Map<string, Pending>();
  private reactionNonce = 0;
  private stopped = false;
  private stopping?: Promise<void>;
  constructor(private readonly options: TextParticipantOptions) {
    super();
    this.credential = options.credential;
  }

  async connect() {
    if (this.stopped)
      throw new Error('closed');
    if (this.socket)
      throw new Error('already_connected');
    const socket = this.socket = new WebSocket(this.options.url, { origin: this.options.origin, maxPayload: CHANNEL_EVENT_BYTES });
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false, welcomed = false;
        const settle = (error?: Error) => {
          if (settled)
            return;
          settled = true;
          clearTimeout(timer);
          socket.off('open', join);
          if (error)
            reject(error);
          else
            resolve();
        };
        const fail = (error: Error) => {
          settle(error);
          if (welcomed) {
            this.emit('failure', error);
            socket.terminate();
          }
        };
        const join = () => {
          try {
            this.write({ type: 'join', protocol: CHANNEL_PROTOCOL, canUsePeerTransport: false, name: this.options.name ?? '', credential: this.credential,
              sessionId: this.sessionId, signingKey: Array.from(this.signer.signing_key()) });
          }
          catch (error) {
            fail(error as Error);
          }
        };
        const timer = setTimeout(() => fail(new Error('welcome_timeout')), 10000);
        socket.once('open', join);
        socket.on('error', fail);
        socket.on('message', raw => {
          try {
            const event = decodeTextEvent(JSON.parse(raw.toString()), (raw as Buffer).byteLength);
            if (!event) return;
            if (!welcomed && event.type === 'error') throw new Error(event.code);
            this.receive(event);
            if (event.type === 'welcome') {
              welcomed = true;
              settle();
            }
          }
          catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        });
        socket.once('close', () => {
          this.socket = undefined;
          this.state = undefined;
          this.acceptBrowse = undefined;
          this.rejectPending();
          settle(new Error('disconnected'));
          socket.removeAllListeners();
          this.emit('disconnected');
        });
      });
      this.checkSocket(socket);
      const roomId = this.roomId ?? this.options.roomId;
      if (roomId !== undefined) await this.browse(roomId);
    } catch (error) {
      if (!this.stopped && this.socket === socket && socket.readyState !== WebSocket.CLOSED) {
        await new Promise<void>(resolve => {
          socket.once('close', () => resolve());
          socket.terminate();
        });
      }
      throw error;
    }
  }

  async createRoom(settings: RoomSettings): Promise<RoomSummary> {
    this.checkSocket(this.socket);
    if (!this.state || !this.userId) throw new Error('disconnected');
    if (this.state.channel.hostingMode !== 'hosted') throw new Error('room_writer_required');
    return await this.request(createRoomCommand(settings, this.userId, true), 'room_created') as RoomSummary;
  }

  async setProfile({ name, avatar }: ProfileUpdate): Promise<void> {
    this.checkSocket(this.socket);
    await this.request({ type: 'set_profile', name, avatar });
  }

  async browse(roomId: string): Promise<void> {
    const socket = this.socket;
    this.checkSocket(socket);
    if (!this.state) throw new Error('disconnected');
    if (this.roomId !== undefined && this.roomId !== roomId) throw new Error('room_already_selected');
    if (this.acceptBrowse) throw new Error('room_selection_pending');
    const accept = () => {
      this.checkSocket(socket);
      this.roomId = roomId;
      this.acceptBrowse = undefined;
      this.emit('ready', this.summary());
    };
    this.acceptBrowse = accept;
    try {
      const admission = this.options.admission;
      if (admission?.inviteKey !== undefined || admission?.password !== undefined)
        await this.request({ type: 'enter_room', roomId, ...admission });
      this.checkSocket(socket);
      await this.request({ type: 'browse', roomId, active: true }, 'ack', { accepted: accept });
      this.checkSocket(socket);
    } finally {
      if (this.acceptBrowse === accept) this.acceptBrowse = undefined;
    }
  }

  summary() {
    const room = this.state?.channel.rooms.find(room => room.id === this.roomId);
    return { userId: this.userId, sessionId: this.sessionId, roomId: this.roomId, available: room?.available ?? false,
      bindingId: room?.delivery?.bindingId ?? null, reading: room?.reading ?? false };
  }

  private checkSocket(socket?: WebSocket): void {
    if (this.stopped) throw new Error('closed');
    if (this.socket !== socket || socket?.readyState !== WebSocket.OPEN) throw new Error('disconnected');
  }

  private selectedRoomId(): string {
    if (this.stopped) throw new Error('closed');
    if (this.roomId === undefined) throw new Error('room_required');
    return this.roomId;
  }

  private write(command: ChannelCommand, requestId?: string) {
    if (this.socket?.readyState !== WebSocket.OPEN)
      throw new Error('disconnected');
    this.socket.send(JSON.stringify({ ...command, requestId }));
  }

  private request(command: ChannelCommand, expects: Pending['expects'] = 'ack',
    { requestId = randomUUID(), accepted }: { requestId?: string; accepted?: () => void } = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('request_timeout'));
      }, expectsWriterResult(expects) ? 30_000 : 10_000);
      const roomId = command.type === 'conversation' ? this.roomId : 'roomId' in command ? command.roomId : undefined;
      this.pending.set(requestId, { roomId, expects, reject, timer, resolve(value) {
        try { accepted?.(); resolve(value); }
        catch (error) { reject(error); }
      } });
      try {
        this.write(command, requestId);
      }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  private conversation(command: ConversationCommand, expects: ConversationResult) {
    this.checkSocket(this.socket);
    if (!this.state || !this.sessionId) throw new Error('disconnected');
    const delivery = requireConversationDelivery(this.state.channel.rooms.find(room => room.id === command.roomId));
    const requestId = randomUUID(), { roomId, ...body } = command;
    const packet = JSON.parse(this.signer.sign(this.sessionId, JSON.stringify({ roomId, bindingId: delivery.bindingId,
      sender: this.sessionId, recipient: delivery.hostSessionId, requestId, command: body })));
    return this.request({ type: 'conversation', packet }, expects, { requestId });
  }

  async chat(text: string, options: ChatOptions & { nonce?: string } = {}): Promise<ChannelMessage> {
    return await this.conversation({ type: 'chat', roomId: this.selectedRoomId(), text,
      nonce: options.nonce === undefined ? randomUUID() : options.nonce, attachments: [],
      ...(options.mentions && { mentions: options.mentions.map(({ userId, start, end }) => ({ userId, start, end })) }),
      ...(options.reply && { reply: { seq: options.reply.seq, messageId: options.reply.messageId, notify: options.reply.notify } }),
    }, 'confirmed') as ChannelMessage;
  }

  async history(before?: number): Promise<TextHistoryPage> {
    return await this.conversation({ type: 'history', roomId: this.selectedRoomId(), before }, 'history_page') as TextHistoryPage;
  }

  async deleteOwnMessage(message: ChannelMessage): Promise<void> {
    const roomId = this.selectedRoomId();
    if (!this.userId || message.userId !== this.userId) throw new Error('own_confirmed_message_required');
    const { seq, id } = message;
    const deleted = await this.conversation({ type: 'delete_message', roomId, messageSeq: seq, messageId: id }, 'message_deleted') as
      Extract<ConversationReply['record'], { type: 'message_deleted' }>;
    if (deleted.messageSeq !== seq) throw new Error('invalid_response');
  }

  async react(messageSeq: number, messageId: string, reaction: string): Promise<TextReactionResult> {
    const roomId = this.selectedRoomId();
    const socket = this.socket, session = this.sessionId, binding = this.summary().bindingId;
    const supported = await this.conversation({ type: 'interaction_ready', roomId }, 'interaction_ready') as
      Extract<ConversationReply['record'], { type: 'interaction_ready' }>;
    this.checkSocket(socket);
    if (this.sessionId !== session) throw new Error('disconnected');
    const delivery = requireConversationDelivery(this.state?.channel.rooms.find(room => room.id === roomId));
    if (delivery.bindingId !== binding) throw new Error('room_host_changed');
    if (!supported.reactionIds.includes(reaction)) throw new Error('unsupported_reaction');
    return await this.conversation({ type: 'react', roomId, reaction,
      target: { type: 'message', messageSeq, messageId }, nonce: ++this.reactionNonce }, 'reaction') as TextReactionResult;
  }

  private complete(id: string, value?: unknown, error?: Error) {
    const p = this.pending.get(id);
    if (!p)
      return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    error ? p.reject(error) : p.resolve(value);
  }
  private rejectPending() {
    for (const id of this.pending.keys()) this.complete(id, undefined, new Error('disconnected'));
  }

  private receive(event: TextEvent) {
    if (event.type === 'welcome') {
      this.credential = event.credential;
      this.emit('credential', event.credential);
      if (this.sessionId !== event.sessionId) this.reactionNonce = 0;
      this.sessionId = event.sessionId;
      this.userId = event.selfProfile.id;
      this.state = event.state;
      return;
    }
    if (event.type === 'state') {
      const previous = this.state?.channel.rooms.find(room => room.id === this.roomId)?.delivery?.bindingId;
      this.state = event.state;
      const room = this.state.channel.rooms.find(room => room.id === this.roomId);
      // All pending conversation records belong to the one selected room and its previous binding.
      if (!room?.authorized || !room.available || room.delivery?.bindingId !== previous) {
        for (const [id, pending] of this.pending) {
          if (expectsWriterResult(pending.expects))
            this.complete(id, undefined, new Error('room_unavailable'));
        }
      }
      // A restored Host has a fresh runtime: restate this participant's one reading intent.
      if (!this.stopped && room?.delivery && room.delivery.bindingId !== previous)
        void this.request({ type: 'browse', roomId: room.id, active: true }).catch(error => this.emit('failure', error));
      this.emit('state', this.summary());
      return;
    }
    if (event.type === 'error' && event.requestId) {
      this.complete(event.requestId, undefined, Error(event.code));
      return;
    }
    if (event.type === 'room_created' && event.requestId) {
      if (this.pending.get(event.requestId)?.expects === 'room_created')
        this.complete(event.requestId, event.room);
      return;
    }
    if (event.type === 'room_reply' && event.requestId) {
      const pending = this.pending.get(event.requestId);
      if (!pending || pending.roomId !== event.roomId) return;
      if (event.result.type === 'error')
        this.complete(event.requestId, undefined, Error(event.result.code));
      else if (expectsWriterResult(pending.expects)) return;
      else if (pending.expects === 'ack' && event.result.type === 'done')
        this.complete(event.requestId, event.result);
      else this.complete(event.requestId, undefined, Error('invalid_response'));
      return;
    }
    if (event.type === 'ack') {
      if (this.pending.get(event.requestId)?.expects === 'ack')
        this.complete(event.requestId);
      return;
    }
    if (event.type !== 'conversation' || !this.state || !this.sessionId)
      return;
    const reply = JSON.parse(verify_conversation(JSON.stringify(event.packet), this.sessionId, JSON.stringify(this.state))) as ConversationAddress | ConversationReply;
    if (reply.roomId !== this.roomId || !('record' in reply))
      throw new Error('invalid_conversation_sender');
    const record = reply.record;
    const pending = this.pending.get(reply.requestId);
    // A closing socket can still deliver the writer's receipt for an in-flight request.
    if (this.socket?.readyState !== WebSocket.OPEN && (!pending || record.type === 'live_message')) return;
    if (record.type === 'live_message') {
      this.emit('live', record.message);
      return;
    }
    if (record.type === 'message_reactions') return;
    if (pending && expectsWriterResult(pending.expects) && record.type !== pending.expects) {
      this.complete(reply.requestId, undefined, Error(record.type === 'error' ? record.code : 'invalid_response'));
      return;
    }
    if (record.type === 'reaction' && pending?.expects === 'reaction' &&
      (record.snapshot?.type !== 'message' || (record.event && record.event.target.type !== 'message'))) {
      this.complete(reply.requestId, undefined, new Error('invalid_response'));
      return;
    }
    if (record.type === pending?.expects && (record.type === 'interaction_ready' || record.type === 'reaction' || record.type === 'message_deleted'))
      this.complete(reply.requestId, record);
    if (record.type === 'history_page' && pending?.expects === 'history_page') {
      if (record.hasMore && !record.messages.length)
        this.complete(reply.requestId, undefined, new Error('incomplete_history'));
      else
        this.complete(reply.requestId, { messages: record.messages, hasMore: record.hasMore, oldestSeq: record.oldestSeq, before: record.before });
    }
    if (record.type === 'confirmed') {
      if (pending?.expects === 'confirmed') this.complete(reply.requestId, record.message);
      this.emit('confirmed', record.message);
    }
  }

  async reconnect() {
    const socket = this.socket;
    if (socket)
      await new Promise<void>(resolve => { socket.once('close', () => resolve()); socket.close(); });
    await this.connect();
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    return this.stopping = this.close();
  }

  private async close(): Promise<void> {
    const socket = this.socket;
    try {
      if (socket?.readyState === WebSocket.OPEN)
        await this.request({ type: 'leave' });
    }
    finally {
      if (socket && socket.readyState !== WebSocket.CLOSED)
        await new Promise<void>(resolve => { socket.once('close', () => resolve()); socket.terminate(); });
      this.signer.free();
    }
  }
}
