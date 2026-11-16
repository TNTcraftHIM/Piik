import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { WebSocketServer } from 'ws';
import { CHANNEL_PROTOCOL, snapshotSchema, type ChannelMessage } from '../src/client/channel/protocol';

test('ordinary Node text client uses signed history, confirmed sends and live messages without media', async () => {
  const rust = await import('../prototype/channel-browser/pkg/piik_channel_browser.js');
  await rust.default({ module_or_path: await readFile('prototype/channel-browser/pkg/piik_channel_browser_bg.wasm') });
  const { TextParticipant } = await import('../prototype/channel-browser/node/text-participant');
  const [host, local, user, owner, binding] = Array.from({ length: 5 }, () => randomUUID());
  const signer = new rust.SessionSigner(randomBytes(32));
  const message = { id: randomUUID(), seq: 1, userId: user, text: 'fixture', time: 1, attachments: [] };
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback port');
  const client = new TextParticipant({ url: `ws://127.0.0.1:${address.port}/prototype/channel`,
    origin: 'http://127.0.0.1', roomId: 'room', name: 'Text fixture' });
  const commands: string[] = [], live: ChannelMessage[] = [], errors: unknown[] = [];
  client.on('live', value => live.push(value));
  server.on('connection', socket => socket.on('message', raw => {
    try {
      const command = JSON.parse(raw.toString()); commands.push(command.type);
      if (command.type === 'join') {
        expect(command.protocol).toBe(CHANNEL_PROTOCOL);
        expect(command).not.toHaveProperty('ownerKey');
        const state = snapshotSchema.parse({
          channel: { id: randomUUID(), name: 'Fixture', icon: 'couch', ownerId: owner, historyWindow: 100, userCount: 2,
            rooms: [{ id: 'room', name: 'Room', icon: 'couch', creatorId: owner, access: 'public', hidden: false,
              hasPassword: false, authorized: true, canManage: false, available: true, reading: true,
              participantSessionIds: [local], lastMessageSeq: 1, realtimeSessionIds: [], capabilities: { attachments: true },
              delivery: { hostSessionId: host, bindingId: binding, nextHops: {} } }] },
          users: [{ id: user, name: 'Text fixture', version: '0'.repeat(64) }],
          sessions: [{ id: local, userId: user, online: true, signingKey: command.signingKey },
            { id: host, userId: owner, online: true, signingKey: [...signer.signing_key()] }],
          publications: [], voice: [], subscriptions: [], watchActivities: [], watchSubscriptions: [], watchBytes: [],
          failedSubscriptions: [], files: [], pairs: [], iceServers: [],
        });
        socket.send(JSON.stringify({ type: 'welcome', protocol: CHANNEL_PROTOCOL, credential: 'fixture-credential',
          sessionId: local, selfProfile: { ...state.users[0], avatar: null }, state }));
        socket.on('message', raw => {
          try {
            const event = JSON.parse(raw.toString());
            if (event.type !== 'conversation') return;
            const address = JSON.parse(rust.verify_conversation(JSON.stringify(event.packet), host, JSON.stringify(state)));
            const request = JSON.parse(event.packet.payload);
            const reply = (record: object) => socket.send(JSON.stringify({ type: 'conversation', packet: JSON.parse(signer.sign(host,
              JSON.stringify({ ...address, sender: host, recipient: local, record }))) }));
            if (request.command.type === 'history') {
              reply({ type: 'history_message', message });
              reply({ type: 'history_end', count: 1, hasMore: false, oldestSeq: 1, before: null });
            } else {
              expect(request.command).toMatchObject({ type: 'chat', text: 'notice', attachments: [] });
              reply({ type: 'confirmed', message: { ...message, text: 'notice' }, inserted: true });
              reply({ type: 'live_message', message: { ...message, text: 'live' } });
            }
          } catch (error) { errors.push(error); socket.terminate(); }
        });
      } else if (command.type !== 'conversation') socket.send(JSON.stringify({ type: 'ack', requestId: command.requestId }));
    } catch (error) { errors.push(error); socket.terminate(); }
  }));
  try {
    await client.connect();
    expect(client.summary()).toMatchObject({ userId: user, pairs: 0, publications: 0, voice: 0 });
    expect(await client.history()).toEqual([message]);
    expect(live).toEqual([]);
    const delivered = once(client, 'live');
    expect(await client.chat('notice')).toMatchObject({ text: 'notice' });
    await delivered;
    expect(live).toEqual([{ ...message, text: 'live' }]);
    await client.stop();
    expect(commands).toEqual(['join', 'browse', 'conversation', 'conversation', 'leave']);
    expect(errors).toEqual([]);
  } finally {
    await client.stop();
    signer.free();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
