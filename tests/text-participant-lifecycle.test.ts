import { afterEach, expect, test, vi } from 'vitest';
import type { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { CHANNEL_PROTOCOL } from '../src/client/channel/protocol';

const boundary = vi.hoisted(() => ({ socket: undefined as unknown as EventEmitter & {
  sent: Record<string, unknown>[]; readyState: number; terminate: ReturnType<typeof vi.fn>;
} }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: class Socket extends EventEmitter {
    static OPEN = 1; static CLOSED = 3;
    readyState = 0;
    sent: Record<string, unknown>[] = [];
    terminate = vi.fn(() => { this.readyState = 2; });
    constructor() { super(); boundary.socket = this; }
    send(value: string) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 2; }
  } };
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test.each(['welcome', 'admission', 'browse'] as const)('stop fences the pending %s continuation before it can subscribe or announce ready', async phase => {
  const { TextParticipant } = await import('../prototype/channel-browser/node/text-participant');
  vi.useFakeTimers();
  const [local, host, binding, user] = Array.from({ length: 4 }, () => randomUUID());
  const client = new TextParticipant({ url: 'ws://fixture.invalid', origin: 'http://fixture.invalid', roomId: 'room', name: 'Fixture',
    admission: { password: 'owned-fixture' } });
  const ready = vi.fn(); client.on('ready', ready);
  const connected = client.connect().catch(error => error as Error), socket = boundary.socket;
  const receive = (event: object) => socket.emit('message', Buffer.from(JSON.stringify(event)));
  socket.readyState = 1; socket.emit('open');
  receive({ type: 'welcome', protocol: CHANNEL_PROTOCOL, credential: 'fixture-credential', sessionId: local, selfProfile: { id: user },
    state: { channel: { hostingMode: 'lightweight', rooms: [{ id: 'room', authorized: true, available: true, reading: true,
      delivery: { hostSessionId: host, bindingId: binding } }] }, sessions: [{ id: host, signingKey: Array(32).fill(0) }] } });
  if (phase !== 'welcome') await Promise.resolve();
  if (phase === 'browse') {
    receive({ type: 'ack', requestId: socket.sent.at(-1)!.requestId });
    await Promise.resolve();
  }
  const pending = socket.sent.at(-1)!;
  const stopping = client.stop();
  const leave = socket.sent.at(-1)!;
  if (phase !== 'welcome') receive({ type: 'ack', requestId: pending.requestId });
  await Promise.resolve(); await Promise.resolve();
  // A successful late acknowledgement must not send the next handshake step after leave.
  const afterLeave = socket.sent.slice(socket.sent.indexOf(leave) + 1);
  receive({ type: 'ack', requestId: leave.requestId });
  await Promise.resolve(); await Promise.resolve();
  socket.readyState = 3; socket.emit('close');
  await stopping;
  const result = await connected;
  expect(afterLeave).toEqual([]);
  expect(ready).not.toHaveBeenCalled();
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toBe('closed');
  expect(vi.getTimerCount()).toBe(0);
  expect(socket.eventNames()).toEqual([]);
});

test('concurrent stop callers await the same leave and socket retirement, including its failure', async () => {
  const { TextParticipant } = await import('../prototype/channel-browser/node/text-participant');
  const { SessionSigner } = await import('../prototype/channel-browser/pkg/piik_channel_browser.js');
  vi.useFakeTimers();
  const free = vi.spyOn(SessionSigner.prototype, 'free');
  const [local, host, binding, user] = Array.from({ length: 4 }, () => randomUUID());
  const client = new TextParticipant({ url: 'ws://fixture.invalid', origin: 'http://fixture.invalid', roomId: 'room', name: 'Fixture' });
  const connected = client.connect(), socket = boundary.socket;
  const receive = (event: object) => socket.emit('message', Buffer.from(JSON.stringify(event)));
  socket.readyState = 1; socket.emit('open');
  receive({ type: 'welcome', protocol: CHANNEL_PROTOCOL, credential: 'fixture-credential', sessionId: local, selfProfile: { id: user },
    state: { channel: { hostingMode: 'lightweight', rooms: [{ id: 'room', authorized: true, available: true, reading: true,
      delivery: { hostSessionId: host, bindingId: binding } }] }, sessions: [{ id: host, signingKey: Array(32).fill(0) }] } });
  await Promise.resolve();
  receive({ type: 'ack', requestId: socket.sent.at(-1)!.requestId });
  await connected;
  const history = client.history();
  const historyResult = history.catch(error => error as Error);
  const first = client.stop(), second = client.stop();
  const firstResult = first.catch(error => error as Error);
  const secondResult = second.catch(error => error as Error);
  let finished = false;
  void second.finally(() => { finished = true; }).catch(() => {});
  await Promise.resolve();
  const finishedBeforeLeave = finished;
  receive({ type: 'error', code: 'leave_failed', requestId: socket.sent.at(-1)!.requestId });
  await Promise.resolve(); await Promise.resolve();
  const finishedBeforeClose = finished, freedBeforeClose = free.mock.calls.length;
  socket.readyState = 3; socket.emit('close');
  const results = await Promise.all([firstResult, secondResult, historyResult]);
  expect(results.map(result => result instanceof Error ? result.message : result)).toEqual(['leave_failed', 'leave_failed', 'disconnected']);
  expect(finishedBeforeLeave).toBe(false);
  expect(finishedBeforeClose).toBe(false);
  expect(freedBeforeClose).toBe(0);
  expect(socket.sent.filter(command => command.type === 'leave')).toHaveLength(1);
  expect(socket.terminate).toHaveBeenCalledOnce();
  expect(finished).toBe(true);
  expect(free).toHaveBeenCalledOnce();
  expect(socket.eventNames()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  await expect(client.chat('after close')).rejects.toThrow('closed');
});

test('a completed old browse cannot announce readiness for a replacement socket', async () => {
  const { TextParticipant } = await import('../prototype/channel-browser/node/text-participant');
  vi.useFakeTimers();
  const [local, host, binding, user] = Array.from({ length: 4 }, () => randomUUID());
  const welcome = { type: 'welcome', protocol: CHANNEL_PROTOCOL, credential: 'fixture-credential', sessionId: local, selfProfile: { id: user },
    state: { channel: { hostingMode: 'lightweight', rooms: [{ id: 'room', authorized: true, available: true, reading: true,
      delivery: { hostSessionId: host, bindingId: binding } }] }, sessions: [{ id: host, signingKey: Array(32).fill(0) }] } };
  const client = new TextParticipant({ url: 'ws://fixture.invalid', origin: 'http://fixture.invalid', roomId: 'room', name: 'Fixture' });
  const ready = vi.fn(); client.on('ready', ready);
  const first = client.connect().catch(error => error as Error), old = boundary.socket;
  old.readyState = 1; old.emit('open'); old.emit('message', Buffer.from(JSON.stringify(welcome)));
  await Promise.resolve();
  old.emit('message', Buffer.from(JSON.stringify({ type: 'ack', requestId: old.sent.at(-1)!.requestId })));
  old.readyState = 3; old.emit('close');
  const replacing = client.reconnect(), next = boundary.socket;
  const result = await first;
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toBe('disconnected');
  expect(ready).not.toHaveBeenCalled();
  next.readyState = 1; next.emit('open'); next.emit('message', Buffer.from(JSON.stringify(welcome)));
  await Promise.resolve();
  next.emit('message', Buffer.from(JSON.stringify({ type: 'ack', requestId: next.sent.at(-1)!.requestId })));
  await replacing;
  expect(ready).toHaveBeenCalledOnce();
  const stopping = client.stop();
  next.emit('message', Buffer.from(JSON.stringify({ type: 'ack', requestId: next.sent.at(-1)!.requestId })));
  await Promise.resolve(); await Promise.resolve();
  next.readyState = 3; next.emit('close'); await stopping;
  expect(vi.getTimerCount()).toBe(0);
});

test.each(['hosted', 'lightweight'] as const)('Node room creation respects %s writer placement', async hostingMode => {
  const { TextParticipant } = await import('../prototype/channel-browser/node/text-participant');
  vi.useFakeTimers();
  const [sessionId, userId] = Array.from({ length: 2 }, () => randomUUID());
  const client = new TextParticipant({ url: 'ws://fixture.invalid', origin: 'http://fixture.invalid', name: 'Fixture' });
  const connected = client.connect(), socket = boundary.socket;
  const receive = (event: object) => socket.emit('message', Buffer.from(JSON.stringify(event)));
  socket.readyState = 1; socket.emit('open');
  receive({ type: 'welcome', protocol: CHANNEL_PROTOCOL, credential: 'fixture-credential', sessionId, selfProfile: { id: userId },
    state: { channel: { hostingMode, rooms: [] }, sessions: [] } });
  await connected;
  const settings = { name: 'Fixture room', icon: 'couch', access: 'public', hidden: false } as const;
  const creation = client.createRoom(settings);
  if (hostingMode === 'lightweight') {
    await expect(creation).rejects.toThrow('room_writer_required');
    expect(socket.sent.map(command => command.type)).toEqual(['join']);
  } else {
    const request = socket.sent.at(-1)!;
    expect(request).toMatchObject({ type: 'create_room', room: { ...settings, id: 'new', creatorId: userId, hasPassword: false } });
    const room = { ...request.room as object, id: 'assigned' };
    const observed = vi.fn();
    void creation.then(observed, observed);
    receive({ type: 'ack', requestId: request.requestId });
    receive({ type: 'room_created', room, requestId: 'unrelated' });
    await Promise.resolve(); await Promise.resolve();
    expect(observed).not.toHaveBeenCalled();
    receive({ type: 'room_created', room, requestId: request.requestId });
    expect(await creation).toEqual(room);
    const browsing = client.browse(room.id);
    expect(socket.sent.at(-1)).toMatchObject({ type: 'browse', roomId: room.id, active: true });
    receive({ type: 'ack', requestId: socket.sent.at(-1)!.requestId });
    await browsing;
  }
  const stopping = client.stop();
  receive({ type: 'ack', requestId: socket.sent.at(-1)!.requestId });
  await Promise.resolve(); await Promise.resolve();
  socket.readyState = 3; socket.emit('close');
  await stopping;
  expect(vi.getTimerCount()).toBe(0);
});
