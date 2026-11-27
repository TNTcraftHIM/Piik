import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextParticipant } from '../node/text-participant';
import type { ChannelMessage } from '../../../src/client/channel/protocol';

type Conversation = Pick<TextParticipant, 'on' | 'off' | 'summary' | 'chat' | 'react' | 'history'>;

const sharingFaq = [
  '- **Share a screen.** Open the room, select **Start sharing**, and choose your source.',
  '- **No picture.** Ask the sharer to check their preview. Select **Retry picture** if it appears.',
  '- **No sound from a share.** Unmute the picture and ask the sharer to enable source audio if available.',
  '',
  '[Piik 3.0 test guide](https://github.com/TNTcraftHIM/Piik/blob/feat/channel-prototype/docs/guide/README.md)',
].join('\n');

/** One concrete handler; it owns its subscription, not the participant or room. */
export function attachSupportBot(participant: Conversation, report: (error: unknown) => void) {
  let stopped = false;
  const pending = new Set<Promise<void>>();
  const receive = (message: ChannelMessage) => {
    if (stopped) return;
    const userId = participant.summary().userId;
    if (!userId || message.userId === userId) return;

    const command = message.text.trim();
    const addressed = message.mentions?.some(mention => mention.userId === userId)
      || (message.reply?.notify && message.reply.userId === userId);
    if (!addressed && command !== '!help' && command !== '!help last') return;

    const work = (async () => {
      let target = message;
      let answer = sharingFaq;
      if (command === '!help last') {
        const page = await participant.history(message.seq, { parts: [] });
        if (stopped) return;
        const previous = page.messages.findLast(item => item.userId === message.userId
          && item.text.trim().length > 0 && !item.text.trim().startsWith('!'));
        target = previous ?? message;
        answer = previous
          ? 'For this report, which Piik version and sharing source did you use?'
          : 'Describe what happened first. I could not find an earlier report from you in recent messages.';
      } else if (command === '!help') {
        answer = [
          'Sharing support',
          '',
          'Reply with your Piik version, source type and the step that failed.',
          '',
          'Copy this template; omit passwords, invitation links and private screen contents:',
          '',
          '```text',
          'Version:',
          'Source: screen / camera / webpage',
          'Expected:',
          'Observed:',
          '```',
        ].join('\n');
      }
      await participant.chat(answer, { reply: { seq: target.seq, messageId: target.id, notify: true } });
      // One attempt: a denied/rate-limited reaction never retries the confirmed reply.
      if (command === '!help' && !stopped) await participant.react(message.seq, message.id, 'wave');
    })().catch(report);
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };
  participant.on('live', receive);
  return async () => {
    stopped = true;
    participant.off('live', receive);
    await Promise.allSettled([...pending]);
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    url: { type: 'string' }, origin: { type: 'string' }, room: { type: 'string' },
  } });
  if (!values.url || !values.origin || !values.room) throw new Error('Required: --url --origin --room (an authorized test room)');
  const participant = new TextParticipant({ url: values.url, origin: values.origin, roomId: values.room,
    name: 'Piika', credential: process.env.PIIK_TEXT_CREDENTIAL,
    admission: { password: process.env.PIIK_TEXT_ROOM_PASSWORD, inviteKey: process.env.PIIK_TEXT_INVITE_KEY } });
  const report = (error: unknown) => console.error(error instanceof Error ? error.message : 'support_operation_failed');
  participant.on('failure', report);
  const detach = attachSupportBot(participant, report);
  let stop!: () => void;
  const stopping = new Promise<void>(resolve => { stop = resolve; });
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const disconnected = once(participant, 'disconnected');
  try {
    const running = participant.connect().then(() => {
      console.log('Piika ready. Mention it for the sharing FAQ, send !help for a template, or send !help last to discuss your previous report.');
      return disconnected;
    });
    await Promise.race([stopping, running]);
  } finally {
    // Remove the handler before closing the shared client; pending requests reject on stop.
    const drained = detach();
    try { await participant.stop(); }
    finally {
      await drained;
      participant.off('failure', report);
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
    }
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  void main().catch(error => { console.error(error instanceof Error ? error.message : 'support_start_failed'); process.exitCode = 1; });
