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
    state: { channel: { rooms: [{ id: 'room', authorized: true, available: true, reading: true,
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
