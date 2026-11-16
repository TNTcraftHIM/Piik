import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import { attachSupportBot } from '../prototype/channel-browser/examples/support-bot';
import type { TextParticipant } from '../prototype/channel-browser/node/text-participant';

function fixture() {
  const client = Object.assign(new EventEmitter(), { summary: () => ({ userId: 'bot' }),
    chat: vi.fn(async () => ({ seq: 2 })), react: vi.fn(async () => ({})) });
  const report = vi.fn();
  const detach = attachSupportBot(client as unknown as TextParticipant, report);
  const send = (text: string, userId = 'friend') => client.emit('live', { seq: 1, text, userId });
  return { client, report, detach, send };
}

test('one live help message gets a quoted Markdown answer and one reaction; other events do not replay it', async () => {
  const { client, report, detach, send } = fixture();
  try {
    send('!help', 'bot'); send('hello');
    client.emit('confirmed', { seq: 1, text: '!help', userId: 'friend' });
    expect(client.chat).not.toHaveBeenCalled();
    send('!help');
    await vi.waitFor(() => expect(client.react).toHaveBeenCalledExactlyOnceWith(1, 'wave'));
    expect(client.chat).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('```text\nVersion:'), { reply: { seq: 1, notify: true } });
    expect(report).not.toHaveBeenCalled();
    await detach(); send('!help');
    expect(client.chat).toHaveBeenCalledTimes(1);
    expect(client.listenerCount('live')).toBe(0);
  } finally { await detach(); }
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
