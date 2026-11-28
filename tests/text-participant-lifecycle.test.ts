import { afterEach, expect, test, vi } from 'vitest';
import type { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { PRODUCT_VERSION } from "../src/client/channel/product-version";

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

test.each([
  [{ type: 'incompatible_version', major: PRODUCT_VERSION.major - 1 }, { update: 'domain' }],
  [{ type: 'incompatible_version', major: PRODUCT_VERSION.major + 1 }, { update: 'participant' }],
  [{ type: 'welcome', major: PRODUCT_VERSION.major + 1 }, { update: 'participant' }],
  [{ type: 'welcome', major: PRODUCT_VERSION.major }, { name: 'ZodError' }],
])('rejects an incompatible or malformed handshake %o before issuing credentials', async (header, expected) => {
  const { TextParticipant } = await import('../prototype/channel-browser/node/text-participant');
  const client = new TextParticipant({ url: 'ws://fixture.invalid', origin: 'http://fixture.invalid', name: 'Fixture' });
  const credential = vi.fn();
  client.on('credential', credential);
  const connected = client.connect(), socket = boundary.socket;
  socket.readyState = 1; socket.emit('open');
  socket.emit('message', Buffer.from(JSON.stringify({ ...PRODUCT_VERSION, ...header, credential: 'fixture' })));
  try {
    const rejected = expect(connected).rejects.toMatchObject(expected);
    await Promise.resolve();
    expect(credential).not.toHaveBeenCalled();
    expect(socket.terminate).toHaveBeenCalledOnce();
    socket.readyState = 3; socket.emit('close');
    await rejected;
  } finally {
    socket.readyState = 3; socket.emit('close');
    await client.stop();
  }
});


test('only Welcome or admission refusal can finish startup', async () => {
  const { TextParticipant } = await import('../prototype/channel-browser/node/text-participant');
  const client = new TextParticipant({ url: 'ws://fixture.invalid', origin: 'http://fixture.invalid' });
  const credential = vi.fn();
  client.on('credential', credential);
  const connecting = client.connect(), socket = boundary.socket;
  const receive = (event: object) => socket.emit('message', Buffer.from(JSON.stringify(event)));
  socket.readyState = 1; socket.emit('open');
  const rejected = expect(connecting).rejects.toThrow('invalid_credential');
  receive({ type: 'future_notification', requestId: 'future' });
  await Promise.resolve();
  expect(credential).not.toHaveBeenCalled();
  expect(socket.terminate).not.toHaveBeenCalled();
  receive({ type: 'error', code: 'invalid_credential' });
  await Promise.resolve();
  expect(socket.terminate).toHaveBeenCalledOnce();
  socket.readyState = 3; socket.emit('close');
  await rejected;
});

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
  receive({ type: 'welcome', ...PRODUCT_VERSION, credential: 'fixture-credential', sessionId: local, selfProfile: { id: user },
    state: { channel: { hostingMode: 'lightweight', rooms: [{ id: 'room', authorized: true, available: true, reading: true,
      delivery: { hostSessionId: host, bindingId: binding } }] }, sessions: [{ id: host, signingKey: Array(32).fill(0), ...PRODUCT_VERSION }] } });
  if (phase !== 'welcome') await Promise.resolve();
  if (phase === 'browse') {
    receive({ type: 'reply', requestId: socket.sent.at(-1)!.requestId, result: { type: 'done' } });
    await Promise.resolve();
  }
  const pending = socket.sent.at(-1)!;
  const stopping = client.stop();
  const leave = socket.sent.at(-1)!;
  if (phase !== 'welcome') receive({ type: 'reply', requestId: pending.requestId, result: { type: 'done' } });
  await Promise.resolve(); await Promise.resolve();
  // A successful late acknowledgement must not send the next handshake step after leave.
  const afterLeave = socket.sent.slice(socket.sent.indexOf(leave) + 1);
  receive({ type: 'reply', requestId: leave.requestId, result: { type: 'done' } });
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

test.each(['revoked', 'rebound'] as const)('a %s room retires signed requests while preserving pending browse', async change => {
  const { TextParticipant } = await import('../prototype/channel-browser/node/text-participant');
  vi.useFakeTimers();
  const [local, user, host, binding] = Array.from({ length: 4 }, () => randomUUID());
  const client = new TextParticipant({ url: 'ws://fixture.invalid', origin: 'http://fixture.invalid', name: 'Fixture', roomId: 'room' });
  const connected = client.connect(), socket = boundary.socket;
  const receive = (event: object) => socket.emit('message', Buffer.from(JSON.stringify(event)));
  const room = { id: 'room', authorized: true, available: true, reading: true, delivery: { hostSessionId: host, bindingId: binding } };
  const state = { channel: { hostingMode: 'lightweight', rooms: [room] }, sessions: [{ id: host, signingKey: Array(32).fill(0), ...PRODUCT_VERSION }] };
  socket.readyState = 1; socket.emit('open');
  receive({ type: 'welcome', ...PRODUCT_VERSION, credential: 'fixture', sessionId: local, selfProfile: { id: user }, state });
  await Promise.resolve();
  receive({ type: 'reply', requestId: socket.sent.at(-1)!.requestId, result: { type: 'done' } });
  await connected;

  const declined = client.browse(room.id);
  const declinedId = socket.sent.at(-1)!.requestId;
  receive({ type: 'reply', roomId: room.id, requestId: declinedId, result: { type: 'unknown' } });
  await expect(declined).rejects.toThrow('unknown_outcome');
  const confirmed = client.browse(room.id);
  receive({ type: 'reply', roomId: room.id, requestId: socket.sent.at(-1)!.requestId, result: { type: 'done' } });
  await confirmed;
  const history = client.history().catch((error: Error) => error.message);
  receive({ type: 'reply', roomId: 'other', requestId: socket.sent.at(-1)!.requestId,
    result: { type: 'error', code: 'room_busy' } });
  const observed = vi.fn();
  void history.then(observed);
  const browse = client.browse(room.id);
  const browseId = socket.sent.at(-1)!.requestId;
  room.reading = false;
  receive({ type: 'state', state });
  await vi.advanceTimersByTimeAsync(0);
  expect(observed).not.toHaveBeenCalled();

  const changedRoom = change === 'revoked'
    ? { ...room, authorized: false, delivery: undefined }
    : { ...room, delivery: { ...room.delivery, bindingId: randomUUID() } };
  receive({ type: 'state', state: { ...state, channel: { ...state.channel, rooms: [changedRoom] } } });
  await vi.advanceTimersByTimeAsync(0);
  expect(observed).toHaveBeenCalledExactlyOnceWith('room_unavailable');
  if (change === 'revoked') {
    receive({ type: 'reply', requestId: browseId, result: { type: 'error', code: 'room_access_required' } });
    await expect(browse).rejects.toThrow('room_access_required');

    const sent = socket.sent.length;
    // The writer remains online while the listed room withholds delivery.
    await expect(client.history()).rejects.toThrow(/^room_access_required$/);
    await expect(client.chat('private')).rejects.toThrow(/^room_access_required$/);

    // A hidden room is absent from this viewer's snapshot even while the host stays online.
    receive({ type: 'state', state: { ...state, channel: { ...state.channel, rooms: [] } } });
    await expect(client.history()).rejects.toThrow(/^room_unavailable$/);
    await expect(client.chat('private')).rejects.toThrow(/^room_unavailable$/);

    // A known reader can still see an authorized room during a host interruption.
    receive({ type: 'state', state: { ...state, channel: { ...state.channel, rooms: [{ ...room, available: false, delivery: undefined }] } } });
    await expect(client.history()).rejects.toThrow(/^room_host_offline$/);
    await expect(client.chat('offline')).rejects.toThrow(/^room_host_offline$/);
    expect(socket.sent).toHaveLength(sent);
  } else {
    receive({ type: 'reply', requestId: browseId, result: { type: 'done' } });
    await browse;
    receive({ type: 'reply', requestId: socket.sent.at(-1)!.requestId, result: { type: 'done' } });
  }
  const stopping = client.stop();
  receive({ type: 'reply', requestId: socket.sent.at(-1)!.requestId, result: { type: 'done' } });
  await vi.advanceTimersByTimeAsync(0);
  socket.readyState = 3; socket.emit('close'); await stopping;
  expect(vi.getTimerCount()).toBe(0);
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
  receive({ type: 'welcome', ...PRODUCT_VERSION, credential: 'fixture-credential', sessionId: local, selfProfile: { id: user },
    state: { channel: { hostingMode: 'lightweight', rooms: [{ id: 'room', authorized: true, available: true, reading: true,
      delivery: { hostSessionId: host, bindingId: binding } }] }, sessions: [{ id: host, signingKey: Array(32).fill(0), ...PRODUCT_VERSION }] } });
  await Promise.resolve();
  receive({ type: 'reply', requestId: socket.sent.at(-1)!.requestId, result: { type: 'done' } });
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
  receive({ type: 'reply', requestId: socket.sent.at(-1)!.requestId, result: { type: 'error', code: 'leave_failed' } });
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

test.each(['receipt-first', 'close-first'] as const)('browse readiness follows %s socket ordering', async order => {
  const { TextParticipant } = await import('../prototype/channel-browser/node/text-participant');
  vi.useFakeTimers();
  const [local, host, binding, user] = Array.from({ length: 4 }, () => randomUUID());
  const welcome = { type: 'welcome', ...PRODUCT_VERSION, credential: 'fixture-credential', sessionId: local, selfProfile: { id: user },
    state: { channel: { hostingMode: 'lightweight', rooms: [{ id: 'room', authorized: true, available: true, reading: true,
      delivery: { hostSessionId: host, bindingId: binding } }] }, sessions: [{ id: host, signingKey: Array(32).fill(0), ...PRODUCT_VERSION }] } };
  const client = new TextParticipant({ url: 'ws://fixture.invalid', origin: 'http://fixture.invalid', roomId: 'room', name: 'Fixture' });
  const ready = vi.fn(); client.on('ready', ready);
  const first = client.connect().catch(error => error as Error), old = boundary.socket;
  old.readyState = 1; old.emit('open'); old.emit('message', Buffer.from(JSON.stringify(welcome)));
  await Promise.resolve();
  const receipt = Buffer.from(JSON.stringify({ type: 'reply', requestId: old.sent.at(-1)!.requestId, result: { type: 'done' } }));
  if (order === 'receipt-first') old.emit('message', receipt);
  const oldReady = order === 'receipt-first' ? 1 : 0;
  expect(ready).toHaveBeenCalledTimes(oldReady);
  old.readyState = 3; old.emit('close');
  const replacing = client.reconnect(), next = boundary.socket;
  old.emit('message', receipt);
  const result = await first;
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toBe('disconnected');
  expect(ready).toHaveBeenCalledTimes(oldReady);
  next.readyState = 1; next.emit('open'); next.emit('message', Buffer.from(JSON.stringify(welcome)));
  await Promise.resolve();
  next.emit('message', Buffer.from(JSON.stringify({ type: 'reply', requestId: next.sent.at(-1)!.requestId, result: { type: 'done' } })));
  await replacing;
  expect(ready).toHaveBeenCalledTimes(oldReady + 1);
  const stopping = client.stop();
  next.emit('message', Buffer.from(JSON.stringify({ type: 'reply', requestId: next.sent.at(-1)!.requestId, result: { type: 'done' } })));
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
  receive({ type: 'welcome', ...PRODUCT_VERSION, credential: 'fixture-credential', sessionId, selfProfile: { id: userId },
    state: { channel: { hostingMode, rooms: [] }, sessions: [] } });
  await connected;
  const settings = { name: 'Fixture room', icon: 'couch', access: 'public', hidden: false } as const;
  const creation = client.createRoom(settings);
  if (hostingMode === 'lightweight') {
    await expect(creation).rejects.toThrow('room_writer_required');
    expect(socket.sent).toEqual([expect.objectContaining({ type: 'join', canUsePeerTransport: false })]);
  } else {
    const request = socket.sent.at(-1)!;
    expect(request).toMatchObject({ type: 'create_room', room: { ...settings, id: 'new', creatorId: userId, hasPassword: false } });
    const room = { ...request.room as object, id: 'assigned' };
    const observed = vi.fn();
    void creation.then(observed, observed);
    const failure = vi.fn(); client.on('failure', failure);
    receive({ type: 'future_notification', requestId: request.requestId });
    receive({ type: 'error', requestId: request.requestId, code: 'directory_storage_failed' });
    expect(failure).toHaveBeenCalledExactlyOnceWith(new Error('directory_storage_failed'));
    expect(socket.terminate).not.toHaveBeenCalled();
    receive({ type: 'reply', requestId: 'unrelated', result: { type: 'room_created', room } });
    await Promise.resolve(); await Promise.resolve();
    expect(observed).not.toHaveBeenCalled();
    receive({ type: 'reply', requestId: request.requestId, result: { type: 'room_created', room } });
    expect(await creation).toEqual(room);
    const ready = vi.fn(); client.on('ready', ready);
    const timedOut = expect(client.browse(room.id)).rejects.toThrow('request_timeout');
    const retiredId = socket.sent.at(-1)!.requestId;
    await vi.advanceTimersByTimeAsync(10_000);
    await timedOut;
    const browsing = client.browse(room.id);
    receive({ type: 'reply', requestId: retiredId, result: { type: 'done' } });
    expect(ready).not.toHaveBeenCalled();
    expect(client.summary()).toMatchObject({ roomId: undefined, reading: false });
    expect(socket.sent.at(-1)).toMatchObject({ type: 'browse', roomId: room.id, active: true });
    receive({ type: 'reply', requestId: socket.sent.at(-1)!.requestId, result: { type: 'done' } });
    await browsing;
    expect(ready).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ roomId: room.id, reading: false }));
  }
  const stopping = client.stop();
  receive({ type: 'reply', requestId: socket.sent.at(-1)!.requestId, result: { type: 'done' } });
  await Promise.resolve(); await Promise.resolve();
  socket.readyState = 3; socket.emit('close');
  await stopping;
  expect(vi.getTimerCount()).toBe(0);
});

test('failed initial browse retires the welcomed socket before connect rejects', async () => {
  const { TextParticipant } = await import('../prototype/channel-browser/node/text-participant');
  const client = new TextParticipant({ url: 'ws://fixture.invalid', origin: 'http://fixture.invalid', name: 'Fixture', roomId: 'missing' });
  const settled = vi.fn();
  const connected = client.connect().catch((error: Error) => { settled(); return error; });
  const socket = boundary.socket;
  const receive = (event: object) => socket.emit('message', Buffer.from(JSON.stringify(event)));
  socket.readyState = 1; socket.emit('open');
  receive({ type: 'welcome', ...PRODUCT_VERSION, credential: 'fixture', sessionId: randomUUID(),
    selfProfile: { id: randomUUID() }, state: { channel: { hostingMode: 'hosted', rooms: [] }, sessions: [] } });
  await Promise.resolve();
  receive({ type: 'reply', requestId: socket.sent.at(-1)!.requestId, result: { type: 'error', code: 'room_unavailable' } });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
  } finally {
    socket.readyState = 3; socket.emit('close');
    await client.stop();
  }
  expect(await connected).toMatchObject({ message: 'room_unavailable' });
  expect(socket.eventNames()).toEqual([]);
});
