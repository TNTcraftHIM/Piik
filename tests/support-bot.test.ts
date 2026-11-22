import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import { attachSupportBot } from '../prototype/channel-browser/examples/support-bot';
import type { TextParticipant } from '../prototype/channel-browser/node/text-participant';

function fixture() {
  const client = Object.assign(new EventEmitter(), { summary: () => ({ userId: 'bot' }),
    history: vi.fn(async (_before: number) => ({ messages: [] as { seq: number; id: string; text: string; userId: string }[] })),
    chat: vi.fn(async () => ({ seq: 2 })), react: vi.fn(async () => ({})) });
  const report = vi.fn();
  const detach = attachSupportBot(client as unknown as TextParticipant, report);
  const send = (text: string, userId = 'friend') => client.emit('live', { id: "help-message", seq: 1, text, userId });
  return { client, report, detach, send };
}

test('one live help message gets a quoted Markdown answer and one reaction; other events do not replay it', async () => {
  const { client, report, detach, send } = fixture();
  try {
    send('!help', 'bot'); send('hello');
    client.emit('confirmed', { id: "help-message", seq: 1, text: '!help', userId: 'friend' });
    expect(client.chat).not.toHaveBeenCalled();
    send('!help');
    await vi.waitFor(() => expect(client.react).toHaveBeenCalledExactlyOnceWith(1, 'help-message', 'wave'));
    expect(client.chat).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('```text\nVersion:'), { reply: { messageId: "help-message", seq: 1, notify: true } });
    expect(report).not.toHaveBeenCalled();
    await detach(); send('!help');
    expect(client.chat).toHaveBeenCalledTimes(1);
    expect(client.listenerCount('live')).toBe(0);
  } finally { await detach(); }
});

test('a fresh help command quotes the latest report from its author in the preceding page', async () => {
  const { client, detach, send } = fixture();
  client.history.mockResolvedValue({ messages: [
    { seq: 1, id: 'first', userId: 'friend', text: 'First report' },
    { seq: 2, id: 'second', userId: 'friend', text: 'My camera is missing' },
    { seq: 3, id: 'other', userId: 'other', text: 'My microphone is missing' },
    { seq: 4, id: 'command', userId: 'friend', text: '!help' },
  ] });
  try {
    send('!help last', 'bot');
    client.emit('live', { seq: 5, id: 'new', userId: 'friend', text: '!help last' });
    await vi.waitFor(() => expect(client.chat).toHaveBeenCalledOnce());
    expect(client.history).toHaveBeenCalledExactlyOnceWith(5);
    expect(client.chat).toHaveBeenCalledWith(expect.any(String), { reply: { seq: 2, messageId: 'second', notify: true } });
    expect(client.react).not.toHaveBeenCalled();
  } finally { await detach(); }
});

test('detaching during a history read prevents the delayed answer', async () => {
  const { client, detach, send } = fixture();
  let complete!: (page: { messages: [] }) => void;
  client.history.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  send('!help last');
  const drained = detach();
  complete({ messages: [] });
  await drained;
  expect(client.chat).not.toHaveBeenCalled();
});

test('reaction rejection does not resend the confirmed reply', async () => {
  const { client, report, detach, send } = fixture();
  client.react.mockRejectedValueOnce(new Error('unsupported_reaction'));
  try {
    send('!help');
    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
    expect(client.chat).toHaveBeenCalledTimes(1);
    expect(client.react).toHaveBeenCalledTimes(1);
  } finally { await detach(); }
});

test('detaching during a pending reply prevents a subsequent reaction', async () => {
  const { client, detach, send } = fixture();
  let complete!: (value: { seq: number }) => void;
  client.chat.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  send('!help');
  const drained = detach();
  complete({ seq: 2 }); await drained;
  expect(client.react).not.toHaveBeenCalled();
  expect(client.listenerCount('live')).toBe(0);
});
