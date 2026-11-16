// CLI behavior and identity-file storage belong to this consumer.
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextParticipant } from '../node/text-participant';
import type { ChannelMessage } from '../../../src/client/channel/protocol';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
      url: { type: 'string' }, origin: { type: 'string' }, room: { type: 'string' },
      name: { type: 'string', default: 'Independent text example' }, message: { type: 'string' },
      'identity-file': { type: 'string' },
    } });
  if (!values.url || !values.origin || !values.room)
    throw new Error('Required: --url ws://host/prototype/channel --origin http://host --room ROOM_ID');
  const identityFile = values['identity-file'];
  if (identityFile === '') throw new Error('identity_file_path_required');
  let credential: string | undefined;
  if (identityFile) {
    try { credential = readFileSync(identityFile, 'utf8').trim(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('identity_file_read_failed');
    }
    if (credential === '') throw new Error('identity_file_empty');
  }
  const participant = new TextParticipant({ url: values.url, origin: values.origin, roomId: values.room, name: values.name,
    credential, admission: { inviteKey: process.env.PIIK_TEXT_INVITE_KEY, password: process.env.PIIK_TEXT_ROOM_PASSWORD } });
  if (identityFile) participant.on('credential', (current: string) => {
    if (credential === current) return;
    try { writeFileSync(identityFile, `${current}\n`, { mode: 0o600 }); }
    catch { throw new Error('identity_file_write_failed'); }
    credential = current;
  });
  const print = (message: ChannelMessage) => console.log(`${message.seq} ${message.userId}: ${message.text}`);
  participant.on('failure', error => console.error(error.message));
  participant.on('live', (message: ChannelMessage) => {
    print(message);
    // Business behavior belongs here, not in the verified transport receiver.
    if (values.message === undefined && message.userId !== participant.summary().userId && message.text === '!ping')
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
