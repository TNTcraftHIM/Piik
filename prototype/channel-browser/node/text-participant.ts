// Internal Node text client; ordinary participant authority and Core conversation verification.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import init, { SessionSigner, verify_conversation, verify_reply } from '../pkg/piik_channel_browser.js';
import { CHANNEL_PROTOCOL, CHANNEL_EVENT_BYTES, CHANNEL_SESSION_LIMIT, CHANNEL_ROOM_LIMIT, channelWelcomeSchema, eventSchema, roomSchema, snapshotSchema, type ChannelCommand, type ChannelEvent, type ConversationReply, type ChannelMessage, type ChatOptions } from '../../../src/client/channel/protocol';
await init({ module_or_path: readFileSync(new URL('../pkg/piik_channel_browser_bg.wasm', import.meta.url)) });
type ConversationCommand = Extract<ChannelCommand, {
  type: 'chat' | 'history' | 'interaction_ready' | 'react';
}>;
export type TextHistoryPage = Pick<Extract<ConversationReply['record'], { type: 'history_end' }>,
  'hasMore' | 'oldestSeq' | 'before'> & { messages: ChannelMessage[] };
export type TextReactionResult = Extract<ConversationReply['record'], { type: 'reaction' }>;

const conversationRoomSchema = roomSchema.pick({ id: true, authorized: true, available: true, reading: true })
  .extend({ delivery: roomSchema.shape.delivery.unwrap().pick({ hostSessionId: true, bindingId: true }).optional() });
const conversationStateSchema = z.object({
  channel: z.object({ rooms: z.array(conversationRoomSchema).max(CHANNEL_ROOM_LIMIT) }),
  sessions: z.array(snapshotSchema.shape.sessions.element.pick({ id: true, signingKey: true })).max(CHANNEL_SESSION_LIMIT),
});
const textWelcomeSchema = channelWelcomeSchema.extend({ state: conversationStateSchema,
  selfProfile: channelWelcomeSchema.shape.selfProfile.pick({ id: true }) });
const textStateSchema = z.object({ type: z.literal('state'), state: conversationStateSchema });
const eventTypeSchema = z.object({ type: z.string() });
type TextEvent = ChannelEvent | z.infer<typeof textWelcomeSchema> | z.infer<typeof textStateSchema>;

function decodeTextEvent(raw: unknown, wireBytes: number): TextEvent | undefined {
  if (wireBytes > CHANNEL_EVENT_BYTES) throw new Error('Channel event exceeds frame limit');
  switch (eventTypeSchema.parse(raw).type) {
    case 'welcome': return textWelcomeSchema.parse(raw);
    case 'state': return textStateSchema.parse(raw);
    case 'conversation': case 'room_reply': case 'ack': case 'error': return eventSchema.parse(raw);
    // This participant neither installs media nor hosts rooms.
    default: return;
  }
}

export interface TextParticipantOptions {
  url: string;
  origin: string;
  roomId: string;
  name: string;
  credential?: string;
  admission?: { inviteKey?: string; password?: string };
}
type Pending = {
  conversation: boolean;
  records: ChannelMessage[];
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
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
    const current = () => {
      if (this.stopped) throw new Error('closed');
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) throw new Error('disconnected');
    };
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
        if (welcomed)
          this.emit('failure', error);
        settle(error);
        socket.terminate();
      };
      const join = () => {
        try {
          this.write({ type: 'join', protocol: CHANNEL_PROTOCOL, name: this.options.name, credential: this.credential,
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
        this.rejectPending();
        settle(new Error('disconnected'));
        socket.removeAllListeners();
        this.emit('disconnected');
      });
    });
    current();
    const admission = this.options.admission;
    if (admission?.inviteKey !== undefined || admission?.password !== undefined)
      await this.request({ type: 'enter_room', roomId: this.options.roomId, ...admission });
    current();
    await this.request({ type: 'browse', roomId: this.options.roomId, active: true });
    current();
    this.emit('ready', this.summary());
  }
  summary() {
    const room = this.state?.channel.rooms.find(room => room.id === this.options.roomId);
    return { userId: this.userId, sessionId: this.sessionId, roomId: this.options.roomId, available: room?.available ?? false,
      bindingId: room?.delivery?.bindingId ?? null, reading: room?.reading ?? false };
  }

  private write(command: ChannelCommand, requestId?: string) {
    if (this.socket?.readyState !== WebSocket.OPEN)
      throw new Error('disconnected');
    this.socket.send(JSON.stringify({ ...command, requestId }));
  }

  private request(command: ChannelCommand, conversation = false, requestId = randomUUID()): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('request_timeout'));
      }, conversation ? 30_000 : 10_000);
      this.pending.set(requestId, { conversation, records: [], resolve, reject, timer });
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

  private conversation(command: ConversationCommand) {
    if (this.stopped)
      return Promise.reject(new Error('closed'));
    const delivery = this.state?.channel.rooms.find(room => room.id === this.options.roomId)?.delivery;
    if (!delivery || !this.sessionId)
      return Promise.reject(new Error('room_host_offline'));
    const requestId = randomUUID(), { roomId, ...body } = command;
    const packet = JSON.parse(this.signer.sign(this.sessionId, JSON.stringify({ roomId, bindingId: delivery.bindingId,
      sender: this.sessionId, recipient: delivery.hostSessionId, requestId, command: body })));
    return this.request({ type: 'conversation', packet }, true, requestId);
  }

  async chat(text: string, options: ChatOptions & { nonce?: string } = {}): Promise<ChannelMessage> {
    return await this.conversation({ type: 'chat', roomId: this.options.roomId, text,
      nonce: options.nonce === undefined ? randomUUID() : options.nonce, attachments: [],
      ...(options.mentions && { mentions: options.mentions.map(({ userId, start, end }) => ({ userId, start, end })) }),
      ...(options.reply && { reply: { seq: options.reply.seq, notify: options.reply.notify } }),
    }) as ChannelMessage;
  }

  async history(before?: number): Promise<TextHistoryPage> {
    return await this.conversation({ type: 'history', roomId: this.options.roomId, before }) as TextHistoryPage;
  }

  async react(messageSeq: number, reaction: string): Promise<TextReactionResult> {
    const socket = this.socket, session = this.sessionId, binding = this.summary().bindingId;
    const supported = await this.conversation({ type: 'interaction_ready', roomId: this.options.roomId }) as
      Extract<ConversationReply['record'], { type: 'interaction_ready' }>;
    if (this.socket !== socket || this.sessionId !== session) throw new Error('disconnected');
    const room = this.state?.channel.rooms.find(room => room.id === this.options.roomId);
    if (!room?.authorized) throw new Error('room_access_required');
    if (!room.available) throw new Error('room_host_offline');
    if (room.delivery?.bindingId !== binding) throw new Error('room_host_changed');
    if (!supported.reactionIds.includes(reaction)) throw new Error('unsupported_reaction');
    return await this.conversation({ type: 'react', roomId: this.options.roomId, reaction,
      target: { type: 'message', messageSeq }, nonce: ++this.reactionNonce }) as TextReactionResult;
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
      const previous = this.state?.channel.rooms.find(room => room.id === this.options.roomId)?.delivery?.bindingId;
      this.state = event.state;
      const room = this.state.channel.rooms.find(room => room.id === this.options.roomId);
      // A restored Host has a fresh runtime: restate this participant's one reading intent.
      if (room?.delivery && room.delivery.bindingId !== previous)
        void this.request({ type: 'browse', roomId: this.options.roomId, active: true }).catch(error => this.emit('failure', error));
      this.emit('state', this.summary());
      return;
    }
    if (event.type === 'error' && event.requestId) {
      this.complete(event.requestId, undefined, Error(event.code));
      return;
    }
    if (event.type === 'room_reply' && event.requestId) {
      this.complete(event.requestId, event.result, event.result.type === 'error' ? Error(event.result.code) : undefined);
      return;
    }
    if (event.type === 'ack') {
      if (!this.pending.get(event.requestId)?.conversation)
        this.complete(event.requestId);
      return;
    }
    if (event.type !== 'conversation' || !this.state || !this.sessionId)
      return;
    const address = JSON.parse(verify_conversation(JSON.stringify(event.packet), this.sessionId, JSON.stringify(this.state)));
    const room = this.state.channel.rooms.find(room => room.id === address.roomId);
    if (address.roomId !== this.options.roomId || address.sender !== room?.delivery?.hostSessionId)
      throw new Error('invalid_conversation_sender');
    const sender = this.state.sessions.find(session => session.id === address.sender)!;
    const reply = JSON.parse(verify_reply(JSON.stringify(event.packet), Uint8Array.from(sender.signingKey))) as ConversationReply;
    const record = reply.record;
    if (record.type === 'error') {
      this.complete(reply.requestId, undefined, Error(record.code));
      return;
    }
    if (record.type === 'interaction_ready' || record.type === 'reaction')
      this.complete(reply.requestId, record);
    if (record.type === 'history_message')
      this.pending.get(reply.requestId)?.records.push(record.message);
    if (record.type === 'history_end') {
      const messages = this.pending.get(reply.requestId)?.records;
      if (!messages) return;
      if (record.count !== messages.length || record.hasMore && !messages.length)
        this.complete(reply.requestId, undefined, new Error('incomplete_history'));
      else this.complete(reply.requestId, { messages, hasMore: record.hasMore, oldestSeq: record.oldestSeq, before: record.before });
    }
    if (record.type === 'confirmed') {
      this.complete(reply.requestId, record.message);
      this.emit('confirmed', record.message);
    }
    if (record.type === 'live_message')
      this.emit('live', record.message);
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
      this.state = undefined;
      this.rejectPending();
      this.signer.free();
    }
  }
}
