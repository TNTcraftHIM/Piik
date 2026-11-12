// Prototype ordinary test participant, NOT production room-scoped bot admission.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import init, { SessionSigner, verify_conversation, verify_reply } from '../pkg/piik_channel_browser.js';
import { CHANNEL_PROTOCOL, CHANNEL_EVENT_BYTES, ChannelEventDecoder, type ChannelCommand, type ChannelEvent, type ChannelSnapshot, type ConversationReply, type ChannelMessage } from '../../../src/client/channel/protocol';
await init({ module_or_path: readFileSync(new URL('../pkg/piik_channel_browser_bg.wasm', import.meta.url)) });
type ConversationCommand = Extract<ChannelCommand, {
  type: 'chat' | 'history';
}>;
type Pending = {
  conversation: boolean;
  records: ChannelMessage[];
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
/** Only socket/request I/O; the existing Core WASM signs and validates every room record. */
export class TextParticipant extends EventEmitter {
  private signer = new SessionSigner(randomBytes(32));
  private socket?: WebSocket;
  private credential?: string;
  private sessionId?: string;
  private userId?: string;
  private state?: ChannelSnapshot;
  private pending = new Map<string, Pending>();
  private decoder = new ChannelEventDecoder();
  private stopped = false;
  constructor(readonly url: string, readonly origin: string, readonly roomId: string, readonly name: string) {
    super();
  }

  async connect() {
    if (this.stopped)
      throw new Error('closed');
    if (this.socket)
      throw new Error('already_connected');
    this.decoder = new ChannelEventDecoder();
    const socket = this.socket = new WebSocket(this.url, { origin: this.origin, maxPayload: CHANNEL_EVENT_BYTES });
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
          this.write({ type: 'join', protocol: CHANNEL_PROTOCOL, name: this.name, credential: this.credential,
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
          const event = this.decoder.decode(JSON.parse(raw.toString()), (raw as Buffer).byteLength);
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
    await this.request({ type: 'browse', roomId: this.roomId, active: true });
    this.emit('ready', this.summary());
  }
  summary() {
    const room = this.state?.channel.rooms.find(room => room.id === this.roomId);
    return { userId: this.userId, sessionId: this.sessionId, roomId: this.roomId, available: room?.available ?? false,
      bindingId: room?.delivery?.bindingId ?? null, reading: room?.reading ?? false, pairs: this.state?.pairs.length ?? 0,
      publications: this.state?.publications.length ?? 0, voice: this.state?.voice.length ?? 0 };
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
    const delivery = this.state?.channel.rooms.find(room => room.id === this.roomId)?.delivery;
    if (!delivery || !this.sessionId)
      return Promise.reject(new Error('room_host_offline'));
    const requestId = randomUUID(), { roomId, ...body } = command;
    const packet = JSON.parse(this.signer.sign(this.sessionId, JSON.stringify({ roomId, bindingId: delivery.bindingId,
      sender: this.sessionId, recipient: delivery.hostSessionId, requestId, command: body })));
    return this.request({ type: 'conversation', packet }, true, requestId);
  }

  async chat(text: string): Promise<ChannelMessage> {
    return await this.conversation({ type: 'chat', roomId: this.roomId, text,
      nonce: randomUUID(), attachments: [] }) as ChannelMessage;
  }

  async history(): Promise<ChannelMessage[]> {
    return await this.conversation({ type: 'history', roomId: this.roomId }) as ChannelMessage[];
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

  private receive(event: ChannelEvent) {
    if (event.type === 'welcome') {
      this.credential = event.credential;
      this.sessionId = event.sessionId;
      this.userId = event.selfProfile.id;
      this.state = event.state;
      return;
    }
    if (event.type === 'state') {
      const previous = this.state?.channel.rooms.find(room => room.id === this.roomId)?.delivery?.bindingId;
      this.state = event.state;
      const room = this.state.channel.rooms.find(room => room.id === this.roomId);
      // A restored Host has a fresh runtime: restate this participant's one reading intent.
      if (room?.delivery && room.delivery.bindingId !== previous)
        void this.request({ type: 'browse', roomId: this.roomId, active: true }).catch(error => this.emit('failure', error));
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
    if (address.roomId !== this.roomId || address.sender !== room?.delivery?.hostSessionId)
      throw new Error('invalid_conversation_sender');
    const sender = this.state.sessions.find(session => session.id === address.sender)!;
    const reply = JSON.parse(verify_reply(JSON.stringify(event.packet), Uint8Array.from(sender.signingKey))) as ConversationReply;
    const record = reply.record;
    if (record.type === 'error') {
      this.complete(reply.requestId, undefined, Error(record.code));
      return;
    }
    if (record.type === 'history_message')
      this.pending.get(reply.requestId)?.records.push(record.message);
    if (record.type === 'history_end')
      this.complete(reply.requestId, this.pending.get(reply.requestId)?.records);
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

  async stop() {
    if (this.stopped)
      return;
    this.stopped = true;
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

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
      url: { type: 'string' }, origin: { type: 'string' }, room: { type: 'string' },
      name: { type: 'string', default: 'Independent text example' }, message: { type: 'string' },
    } });
  if (!values.url || !values.origin || !values.room)
    throw new Error('Required: --url ws://host/prototype/channel --origin http://host --room ROOM_ID');
  const participant = new TextParticipant(values.url, values.origin, values.room, values.name);
  const print = (message: ChannelMessage) => console.log(`${message.seq} ${message.userId}: ${message.text}`);
  participant.on('failure', error => console.error(error.message));
  participant.on('live', (message: ChannelMessage) => {
    print(message);
    // Business behavior belongs here, not in the verified transport receiver.
    if (message.userId !== participant.summary().userId && message.text === '!ping')
      void participant.chat('pong').catch(error => console.error(error.message));
  });
  try {
    await participant.connect();
    for (const message of await participant.history())
      print(message);
    if (values.message !== undefined) {
      print(await participant.chat(values.message));
      return;
    }
    console.log('Connected. Enter a message, /reconnect or /quit. Only new live !ping messages receive pong.');
    const input = createInterface({ input: process.stdin });
    const close = () => input.close();
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    try {
      for await (const line of input) {
        if (line === '/quit')
          break;
        try {
          if (line === '/reconnect')
            await participant.reconnect();
          else if (line.trim())
            print(await participant.chat(line));
        }
        catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
        }
      }
    }
    finally {
      input.close();
      process.off('SIGINT', close);
      process.off('SIGTERM', close);
    }
  }
  finally {
    await participant.stop();
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  void main().catch(error => { console.error(error.message); process.exitCode = 1; });
