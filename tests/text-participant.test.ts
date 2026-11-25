import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { WebSocketServer } from 'ws';
import { CHANNEL_PROTOCOL, snapshotSchema, type ChannelMessage } from '../src/client/channel/protocol';

test('Node text conversation ignores unrelated media descriptions and retains signed delivery checks', async () => {
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
          channel: { id: randomUUID(), name: 'Fixture', icon: 'couch', ownerId: owner, roomCreationPolicy: 'ordinary', hostingMode: 'lightweight', historyWindow: 100, userCount: 2, managedRoomIds: [],
            rooms: [{ id: 'room', name: 'Room', icon: 'couch', creatorId: owner, access: 'public', hidden: false,
              hasPassword: false, authorized: true, canManage: false, available: true, reading: true,
              participantSessionIds: [local], lastMessageSeq: 1, fileActivity: [], capabilities: { attachments: true },
              delivery: { hostSessionId: host, bindingId: binding } }] },
          users: [{ id: user, name: 'Text fixture', version: '0'.repeat(64) }],
          sessions: [{ id: local, userId: user, online: true, signingKey: command.signingKey },
            { id: host, userId: owner, online: true, signingKey: [...signer.signing_key()] }],
          publications: [], voice: [], subscriptions: [], watchActivities: [], watchSubscriptions: [], watchBytes: [],
          files: [], pairs: [], iceServers: [],
        });
        const textState = { ...state, watchActivities: [{ id: randomUUID(), roomId: 'room', userId: user,
          sessionId: host, source: { kind: 'media', url: 'https://example.invalid/owned.mp4' },
          playback: { timeline: 'future-timeline', position: 0, paused: true, rate: 1, anchorTime: 0 }, viewerSessionIds: [] }] };
        socket.send(JSON.stringify({ type: 'welcome', protocol: CHANNEL_PROTOCOL, credential: 'fixture-credential',
          sessionId: local, selfProfile: { ...state.users[0], avatar: null }, state: textState }));
        socket.send(JSON.stringify({ type: 'state', state: textState }));
        socket.send(JSON.stringify({ type: 'signal', payload: { futureMediaSignal: true } }));
        socket.on('message', raw => {
          try {
            const event = JSON.parse(raw.toString());
            if (event.type !== 'conversation') return;
            const address = JSON.parse(rust.verify_conversation(JSON.stringify(event.packet), host, JSON.stringify(textState)));
            const request = JSON.parse(event.packet.payload);
            const reply = (record: object) => socket.send(JSON.stringify({ type: 'conversation', packet: JSON.parse(signer.sign(host,
              JSON.stringify({ ...address, sender: host, recipient: local, record }))) }));
            if (request.command.type === 'history') {
              reply({ type: 'history_message', message });
              reply({ type: 'history_end', count: 1, hasMore: false, oldestSeq: 1, before: null });
            } else if (request.command.type === 'delete_message') {
              expect(request.command).toEqual({ type: 'delete_message', messageSeq: message.seq, messageId: message.id });
              socket.send(JSON.stringify({ type: 'ack', requestId: address.requestId }));
              reply({ type: 'message_deleted', messageSeq: message.seq });
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
    expect(client.summary()).toMatchObject({ userId: user, roomId: 'room', available: true, reading: true, bindingId: binding });
    expect(await client.history()).toEqual({ messages: [message], hasMore: false, oldestSeq: 1, before: null });
    expect(live).toEqual([]);
    const delivered = once(client, 'live');
    const confirmed = await client.chat('notice');
    expect(confirmed).toMatchObject({ text: 'notice' });
    await delivered;
    expect(live).toEqual([{ ...message, text: 'live' }]);
    await expect(client.deleteOwnMessage({ ...confirmed, userId: owner })).rejects.toThrow('own_confirmed_message_required');
    await client.deleteOwnMessage(confirmed);
    await client.stop();
    expect(commands).toEqual(['join', 'browse', 'conversation', 'conversation', 'conversation', 'leave']);
    expect(errors).toEqual([]);
  } finally {
    await client.stop();
    signer.free();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('a rejected room selection can be retried without exposing or mixing unconfirmed rooms', async () => {
  const { TextParticipant } = await import('../prototype/channel-browser/node/text-participant');
  const [sessionId, userId] = Array.from({ length: 2 }, () => randomUUID());
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback port');
  const origin = 'http://127.0.0.1:' + address.port;
  const client = new TextParticipant({ url: origin.replace('http:', 'ws:') + '/prototype/channel', origin, name: 'Text fixture' });
  const ready: ReturnType<typeof client.summary>[] = [];
  client.on('ready', summary => ready.push(summary));
  const state = (reading: boolean) => ({ channel: { hostingMode: 'hosted',
    rooms: [{ id: 'valid', authorized: true, available: true, reading }] }, sessions: [] });
  server.on('connection', socket => socket.on('message', raw => {
    const command = JSON.parse(raw.toString());
    if (command.type === 'join') {
      socket.send(JSON.stringify({ type: 'welcome', protocol: CHANNEL_PROTOCOL, credential: 'fixture-credential',
        sessionId, selfProfile: { id: userId }, state: state(false) }));
    } else if (command.type === 'browse' && command.roomId === 'missing') {
      socket.send(JSON.stringify({ type: 'error', code: 'room_unavailable', requestId: command.requestId }));
    } else if (command.type === 'browse' && command.roomId === 'valid') {
      socket.send(JSON.stringify({ type: 'state', state: state(true) }));
      socket.send(JSON.stringify({ type: 'ack', requestId: command.requestId }));
    } else if (command.type === 'leave') {
      socket.send(JSON.stringify({ type: 'ack', requestId: command.requestId }));
    }
  }));
  try {
    await client.connect();
    await expect(client.browse('missing')).rejects.toThrow('room_unavailable');
    expect(client.summary()).toMatchObject({ roomId: undefined, reading: false });
    expect(ready).toEqual([]);

    const browsing = client.browse('valid');
    expect(client.summary()).toMatchObject({ roomId: undefined, reading: false });
    await expect(client.browse('other')).rejects.toThrow('room_selection_pending');
    await browsing;
    expect(ready).toMatchObject([{ roomId: 'valid', reading: true }]);
    await expect(client.browse('other')).rejects.toThrow('room_already_selected');

    await client.reconnect();
    expect(ready).toMatchObject([{ roomId: 'valid', reading: true }, { roomId: 'valid', reading: true }]);
  } finally {
    await client.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('narrow conversation verification keeps authority required and signed records closed', async () => {
  const rust = await import('../prototype/channel-browser/pkg/piik_channel_browser.js');
  await rust.default({ module_or_path: await readFile('prototype/channel-browser/pkg/piik_channel_browser_bg.wasm') });
  const [host, local, binding] = Array.from({ length: 3 }, () => randomUUID());
  const signer = new rust.SessionSigner(randomBytes(32));
  const other = new rust.SessionSigner(randomBytes(32));
  const address = { roomId: 'room', bindingId: binding, sender: host, recipient: local, requestId: 'reply' };
  const state = { channel: { rooms: [{ id: 'room', authorized: true, available: true,
    delivery: { hostSessionId: host, bindingId: binding } }] }, sessions: [{ id: host, signingKey: [...signer.signing_key()] }] };
  const record = { type: 'history_end', count: 0, hasMore: false, oldestSeq: null, before: null };
  const packet = (change = {}) => signer.sign(host, JSON.stringify({ ...address, ...change, record }));
  const verify = (value: string, view: unknown = state) => rust.verify_conversation(value, local, JSON.stringify(view));
  try {
    expect(JSON.parse(verify(packet()))).toEqual({ ...address, record });
    const altered = { ...JSON.parse(packet()), payload: JSON.stringify({ ...address, requestId: 'changed', record }) };
    expect(() => verify(JSON.stringify(altered))).toThrow();
    const hostedHere = { ...state, channel: { rooms: [{ ...state.channel.rooms[0], delivery: { hostSessionId: local, bindingId: binding } }] } };
    expect(() => verify(packet(), hostedHere)).toThrow();
    const nullRecord = signer.sign(host, JSON.stringify({ ...address, record: null }));
    expect(() => verify(nullRecord)).toThrow();
    expect(() => verify(packet(), { ...state, sessions: [{ id: host, signingKey: [...other.signing_key()] }] })).toThrow();
    expect(() => verify(packet({ bindingId: randomUUID() }))).toThrow();
    expect(() => verify(packet({ recipient: randomUUID() }))).toThrow();
    for (const authorized of [false, undefined, 'true']) {
      expect(() => verify(packet(), { ...state, channel: { rooms: [{ ...state.channel.rooms[0], authorized }] } })).toThrow();
    }
    expect(() => verify(packet(), { ...state, sessions: [{ id: host }] })).toThrow();
    const futureRecord = signer.sign(host, JSON.stringify({ ...address, record: { type: 'future-conversation-record' } }));
    expect(() => verify(futureRecord)).toThrow();
  } finally { signer.free(); other.free(); }
});

test('text pagination, replies and mentions use signed Core commands and host confirmations', async () => {
  const rust = await import('../prototype/channel-browser/pkg/piik_channel_browser.js');
  await rust.default({ module_or_path: await readFile('prototype/channel-browser/pkg/piik_channel_browser_bg.wasm') });
  const { TextParticipant } = await import('../prototype/channel-browser/node/text-participant');
  const [host, local, user, owner, binding] = Array.from({ length: 5 }, () => randomUUID());
  const signer = new rust.SessionSigner(randomBytes(32));
  const room = new rust.RoomHost(rust.create_room_policy(JSON.stringify({ id: 'room', name: 'Room', icon: 'couch',
    creatorId: owner, access: 'public', hidden: false, password: null })));
  const pageSize = rust.history_page_size();
  const messages = Array.from({ length: pageSize + 1 }, (_, index) => {
    const seq = index + 1;
    return { id: randomUUID(), seq, userId: owner, text: `message ${seq}`, time: seq, attachments: [] };
  });
  const overflowBefore = messages.length + 1;
  let malformedPage: 'count' | 'empty-more' | undefined;
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback port');
  const client = new TextParticipant({ url: `ws://127.0.0.1:${address.port}`, origin: 'http://127.0.0.1', roomId: 'room', name: 'Text fixture' });
  const received: Record<string, unknown>[] = [], errors: unknown[] = [], live: ChannelMessage[] = [];
  client.on('live', message => live.push(message));
  server.on('connection', socket => socket.on('message', raw => {
    try {
      const command = JSON.parse(raw.toString());
      if (command.type === 'join') {
        room.dispatch(JSON.stringify({ now: 1, bindingId: binding, channelOwnerId: owner, hostSessionId: host, revision: 1,
          endpoints: { [local]: { member: { userId: user }, signingKey: command.signingKey, connected: true, canUsePeerTransport: false } }, action: { type: 'sync' } }));
        room.finish();
        socket.send(JSON.stringify({ type: 'welcome', protocol: CHANNEL_PROTOCOL, credential: 'fixture-credential', sessionId: local,
          selfProfile: { id: user }, state: { channel: { hostingMode: 'lightweight', rooms: [{ id: 'room', authorized: true, available: true, reading: true,
            delivery: { hostSessionId: host, bindingId: binding } }] }, sessions: [{ id: host, signingKey: [...signer.signing_key()] }] } }));
      } else if (command.type === 'conversation') {
        const request = JSON.parse(command.packet.payload);
        received.push(request.command);
        const prepared = JSON.parse(room.prepare_peer(JSON.stringify(command.packet), 10n));
        let result = prepared.work;
        if (result.Ok?.type === 'history') {
          const work = result.Ok.value;
          if (work.type === 'read') {
            const page = new rust.HistoryPage();
            for (const message of messages.filter(message => work.before == null || message.seq < work.before).slice(-pageSize).reverse())
              page.push(JSON.stringify({ ...message, reactions: { revision: 0, counts: {} } }));
            result = { Ok: { type: 'history', value: JSON.parse(page.finish(1n, work.before == null ? undefined : BigInt(work.before))) } };
          } else {
            try {
              const confirmation = JSON.parse(rust.prepare_confirmation(JSON.stringify(work.draft), JSON.stringify({ type: 'new',
                lastSeq: messages.length, reply: messages.find(message => message.seq === work.draft.reply?.seq) })));
              result = { Ok: { type: 'history', value: confirmation } };
            } catch (error) { result = { Err: String(error) }; }
          }
        }
        const { replies } = JSON.parse(room.finish_peer(JSON.stringify(prepared.address), JSON.stringify(result)));
        for (const reply of replies) {
          if (reply.record.type === 'history_end') {
            if (request.command.before === overflowBefore)
              reply.record = { type: 'history_message', message: messages[0] };
            else if (malformedPage === 'count') reply.record.count++;
            else if (malformedPage === 'empty-more') reply.record.hasMore = true;
          }
          socket.send(JSON.stringify({ type: 'conversation', packet: JSON.parse(signer.sign(host, JSON.stringify(reply))) }));
        }
      } else socket.send(JSON.stringify({ type: 'ack', requestId: command.requestId }));
    } catch (error) { errors.push(error); socket.terminate(); }
  }));
  try {
    await client.connect();
    const latestPage = await client.history();
    let page = latestPage;
    expect(page).toMatchObject({ hasMore: true, oldestSeq: 1, before: null });
    expect(page.messages.map(message => message.seq)).toEqual(messages.slice(1).map(message => message.seq));
    const sequences = page.messages.map(message => message.seq);
    let pages = 1;
    while (page.hasMore) {
      page = await client.history(page.messages[0].seq);
      sequences.unshift(...page.messages.map(message => message.seq));
      pages++;
    }
    expect(pages).toBe(2);
    expect(sequences).toEqual(messages.map(message => message.seq));
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(page).toMatchObject({ hasMore: false, oldestSeq: 1, before: 2 });
    expect(await client.history(1)).toEqual({ messages: [], hasMore: false, oldestSeq: 1, before: 1 });
    const options = { mentions: [{ userId: owner, start: 0, end: 7, extra: 'discard' }],
      reply: { seq: 2, messageId: messages[1].id, notify: true, extra: 'discard' }, nonce: 'caller-send', text: 'override', extra: 'discard' };
    const confirmed = await client.chat('@friend hi', options);
    expect(confirmed).toMatchObject({ userId: user, text: '@friend hi', mentions: [{ userId: owner, start: 0, end: 7 }],
      reply: { seq: 2, userId: owner, text: 'message 2', notify: true } });
    expect(received[1]).toEqual({ type: 'history', before: 2 });
    expect(received[3]).toEqual({ type: 'chat', text: '@friend hi', attachments: [], nonce: expect.any(String),
      mentions: [{ userId: owner, start: 0, end: 7 }], reply: { seq: 2, messageId: messages[1].id, notify: true } });
    expect(received[3].nonce).toBe(options.nonce);
    await expect(client.chat('plain', { mentions: [{ userId: owner, start: 0, end: 5 }] })).rejects.toThrow('invalid_mentions');
    await expect(client.chat('reply', { reply: { seq: 99, messageId: randomUUID(), notify: false } })).rejects.toThrow('message_unavailable');
    const oversized = client.history(overflowBefore).catch(error => error as Error);
    expect(await client.history()).toEqual(latestPage);
    expect(await Promise.race([oversized, Promise.resolve('still pending')])).toMatchObject({ message: 'incomplete_history' });
    malformedPage = 'count';
    await expect(client.history(2)).rejects.toThrow('incomplete_history');
    malformedPage = 'empty-more';
    await expect(client.history(1)).rejects.toThrow('incomplete_history');
    expect(live).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await client.stop(); room.free(); signer.free();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('text retries keep one nonce across a lost confirmation and sign the current host binding', async () => {
  const rust = await import('../prototype/channel-browser/pkg/piik_channel_browser.js');
  await rust.default({ module_or_path: await readFile('prototype/channel-browser/pkg/piik_channel_browser_bg.wasm') });
  const { TextParticipant } = await import('../prototype/channel-browser/node/text-participant');
  const [host, local, user, owner] = Array.from({ length: 4 }, () => randomUUID());
  const signer = new rust.SessionSigner(randomBytes(32));
  const policy = rust.create_room_policy(JSON.stringify({ id: 'room', name: 'Room', icon: 'couch',
    creatorId: owner, access: 'public', hidden: false, password: null }));
  let room: InstanceType<typeof rust.RoomHost> | undefined, binding: string, loseConfirmation = true;
  let original: ChannelMessage | undefined;
  // The fixture supplies stored rows; Core owns validation, confirmations and live records.
  const stored = new Map<string, string>(), broadcasts: ChannelMessage[] = [], errors: unknown[] = [];
  const attempts: { requestId: string; bindingId: string; nonce: string }[] = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback port');
  const client = new TextParticipant({ url: `ws://127.0.0.1:${address.port}`, origin: 'http://127.0.0.1', roomId: 'room', name: 'Retry fixture' });
  server.on('connection', socket => socket.on('message', raw => {
    try {
      const command = JSON.parse(raw.toString());
      if (command.type === 'join') {
        room?.free(); room = new rust.RoomHost(policy); binding = randomUUID();
        room.dispatch(JSON.stringify({ now: 1, bindingId: binding, channelOwnerId: owner, hostSessionId: host, revision: 1,
          endpoints: { [local]: { member: { userId: user }, signingKey: command.signingKey, connected: true, canUsePeerTransport: false } }, action: { type: 'sync' } }));
        room.finish();
        socket.send(JSON.stringify({ type: 'welcome', protocol: CHANNEL_PROTOCOL, credential: 'fixture-credential', sessionId: local,
          selfProfile: { id: user }, state: { channel: { hostingMode: 'lightweight', rooms: [{ id: 'room', authorized: true, available: true, reading: true,
            delivery: { hostSessionId: host, bindingId: binding } }] }, sessions: [{ id: host, signingKey: [...signer.signing_key()] }] } }));
      } else if (command.type === 'conversation') {
        const request = JSON.parse(command.packet.payload);
        attempts.push({ requestId: request.requestId, bindingId: request.bindingId, nonce: request.command.nonce });
        const prepared = JSON.parse(room!.prepare_peer(JSON.stringify(command.packet), 10n));
        let result = prepared.work;
        if (result.Ok?.type === 'history') {
          const work = result.Ok.value, key = JSON.stringify([work.roomId, work.draft.userId, work.draft.nonce]);
          const previous = stored.get(key);
          const confirmation = JSON.parse(rust.prepare_confirmation(JSON.stringify(work.draft), JSON.stringify(previous
            ? { type: 'existing', message: JSON.parse(previous) } : { type: 'new', lastSeq: stored.size })));
          if (confirmation.inserted) stored.set(key, JSON.stringify(confirmation.message));
          result = { Ok: { type: 'history', value: confirmation } };
        }
        const { replies } = JSON.parse(room!.finish_peer(JSON.stringify(prepared.address), JSON.stringify(result)));
        for (const reply of replies) {
          const broadcast = JSON.parse(rust.conversation_broadcast(JSON.stringify(reply.record)));
          if (broadcast?.type === 'live_message') broadcasts.push(broadcast.message);
          if (reply.record.type === 'confirmed') original ??= reply.record.message;
        }
        if (loseConfirmation) { loseConfirmation = false; socket.terminate(); }
        else for (const reply of replies) socket.send(JSON.stringify({ type: 'conversation',
          packet: JSON.parse(signer.sign(host, JSON.stringify(reply))) }));
      } else socket.send(JSON.stringify({ type: 'ack', requestId: command.requestId }));
    } catch (error) { errors.push(error); socket.terminate(); }
  }));
  try {
    await client.connect();
    const nonce = randomUUID();
    await expect(client.chat('one business send', { nonce })).rejects.toThrow('disconnected');
    expect(stored.size).toBe(1);
    await client.reconnect();
    expect(await client.chat('one business send', { nonce })).toEqual(original);
    expect(attempts.slice(0, 2).map(attempt => attempt.nonce)).toEqual([nonce, nonce]);
    expect(attempts[1].requestId).not.toBe(attempts[0].requestId);
    expect(attempts[1].bindingId).not.toBe(attempts[0].bindingId);
    expect(stored.size).toBe(1);
    expect(broadcasts).toEqual([original]);
    const first = await client.chat('ordinary new send'), second = await client.chat('ordinary new send');
    expect(first.id).not.toBe(second.id);
    expect(attempts[2].nonce).not.toBe(attempts[3].nonce);
    for (const invalid of ['', 'n'.repeat(129)])
      await expect(client.chat('invalid nonce', { nonce: invalid })).rejects.toThrow('invalid_message');
    expect(stored.size).toBe(3);
    expect(broadcasts).toHaveLength(3);
    expect(errors).toEqual([]);
  } finally {
    await client.stop(); room?.free(); signer.free();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('text message reactions use advertised support and Core counted-history nonce semantics', async () => {
  const rust = await import('../prototype/channel-browser/pkg/piik_channel_browser.js');
  await rust.default({ module_or_path: await readFile('prototype/channel-browser/pkg/piik_channel_browser_bg.wasm') });
  const { TextParticipant } = await import('../prototype/channel-browser/node/text-participant');
  const [host, user, owner] = Array.from({ length: 3 }, () => randomUUID());
  let local = randomUUID(), binding = randomUUID(), revision = 0;
  const signer = new rust.SessionSigner(randomBytes(32));
  const room = new rust.RoomHost(rust.create_room_policy(JSON.stringify({ id: 'room', name: 'Room', icon: 'couch',
    creatorId: owner, access: 'public', hidden: false, password: null })));
  const message = { id: randomUUID(), seq: 1, userId: owner, text: 'react here', time: 1, attachments: [] };
  let stored = { ...message, reactions: { revision: 0, counts: {} as Record<string, number> } };
  let now = 1000, advertise = true;
  let transition: 'binding' | 'revoked' | undefined;
  const state = () => ({ channel: { hostingMode: 'lightweight', rooms: [{ id: 'room', authorized: true, available: true, reading: true,
    delivery: { hostSessionId: host, bindingId: binding } }] }, sessions: [{ id: host, signingKey: [...signer.signing_key()] }] });
  const historySnapshots: unknown[] = [], received: Record<string, unknown>[] = [], errors: unknown[] = [];
  const reactPackets: unknown[] = [];
  const process = (packet: unknown) => {
    const prepared = JSON.parse(room.prepare_peer(JSON.stringify(packet), BigInt(now)));
    let result = prepared.work;
    if (result.Ok?.type === 'history') {
      const work = result.Ok.value;
      if (work.type === 'react') {
        const confirmation = JSON.parse(rust.reaction_result(JSON.stringify(work), JSON.stringify(stored)));
        stored = { ...stored, reactions: { revision: confirmation.snapshot.revision, counts: confirmation.snapshot.counts } };
        result = { Ok: { type: 'history', value: confirmation } };
      } else {
        const page = new rust.HistoryPage(); page.push(JSON.stringify(stored));
        result = { Ok: { type: 'history', value: JSON.parse(page.finish(1n)) } };
      }
    }
    const { replies } = JSON.parse(room.finish_peer(JSON.stringify(prepared.address), JSON.stringify(result)));
    return replies as Array<{ record: Record<string, any> }>;
  };
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback port');
  const client = new TextParticipant({ url: `ws://127.0.0.1:${address.port}`, origin: 'http://127.0.0.1', roomId: 'room', name: 'Text fixture' });
  server.on('connection', socket => socket.on('message', raw => {
    try {
      const command = JSON.parse(raw.toString());
      if (command.type === 'join') {
        room.dispatch(JSON.stringify({ now: 1, bindingId: binding, channelOwnerId: owner, hostSessionId: host, revision: ++revision,
          endpoints: { [local]: { member: { userId: user }, signingKey: command.signingKey, connected: true, canUsePeerTransport: false } }, action: { type: 'sync' } }));
        room.finish();
        socket.send(JSON.stringify({ type: 'welcome', protocol: CHANNEL_PROTOCOL, credential: 'fixture-credential', sessionId: local,
          selfProfile: { id: user }, state: state() }));
      } else if (command.type === 'conversation') {
        const request = JSON.parse(command.packet.payload);
        received.push(request.command);
        if (request.command.type === 'react') reactPackets.push(command.packet);
        const replies = process(command.packet);
        for (const reply of replies) {
          if (reply.record.type === 'interaction_ready' && !advertise) reply.record.reactionIds = [];
          if (reply.record.type === 'message_reactions') historySnapshots.push(reply.record.snapshot);
          socket.send(JSON.stringify({ type: 'conversation', packet: JSON.parse(signer.sign(host, JSON.stringify(reply))) }));
          if (reply.record.type === 'interaction_ready' && transition) {
            if (transition === 'binding') binding = randomUUID();
            const changed = state();
            if (transition === 'revoked') changed.channel.rooms[0].authorized = false;
            socket.send(JSON.stringify({ type: 'state', state: changed }));
            transition = undefined;
          }
        }
      } else socket.send(JSON.stringify({ type: 'ack', requestId: command.requestId }));
    } catch (error) { errors.push(error); socket.terminate(); }
  }));
  try {
    await client.connect();
    await expect(client.react(1, message.id, 'not-advertised')).rejects.toThrow('unsupported_reaction');
    expect(reactPackets).toHaveLength(0);
    advertise = false;
    await expect(client.react(1, message.id, 'heart')).rejects.toThrow('unsupported_reaction');
    expect(reactPackets).toHaveLength(0);
    advertise = true;
    const first = await client.react(1, message.id, 'heart');
    expect(first.snapshot.messageId).toBe(message.id);
    expect(first.event?.target.messageId).toBe(message.id);
    expect(first).toMatchObject({ type: 'reaction', nonce: 1, event: { senderUserId: user, reaction: 'heart' },
      snapshot: { type: 'message', messageSeq: 1, revision: 1, counts: { heart: 1 } } });
    expect(process(reactPackets[0])[0].record).toMatchObject({ nonce: 1, event: null, snapshot: { revision: 1, counts: { heart: 1 } } });
    await expect(client.react(1, message.id, 'heart')).rejects.toThrow('rate_limited');
    expect(stored.reactions).toEqual({ revision: 1, counts: { heart: 1 } });
    now += 1000;
    expect(await client.react(1, message.id, 'heart')).toMatchObject({ nonce: 3, snapshot: { revision: 2, counts: { heart: 2 } } });
    await client.reconnect(); now += 1000;
    expect(await client.react(1, message.id, 'heart')).toMatchObject({ nonce: 4, snapshot: { counts: { heart: 3 } } });
    local = randomUUID();
    await client.reconnect(); now += 1000;
    expect(await client.react(1, message.id, 'heart')).toMatchObject({ nonce: 1, snapshot: { counts: { heart: 4 } } });
    expect((await client.history()).messages).toEqual([message]);
    expect(historySnapshots).toContainEqual({ messageId: message.id, messageSeq: 1, revision: 4, counts: { heart: 4 } });
    transition = 'revoked';
    await expect(client.react(1, message.id, 'heart')).rejects.toThrow('room_access_required');
    await client.reconnect();
    transition = 'binding';
    await expect(client.react(1, message.id, 'heart')).rejects.toThrow('room_host_changed');
    expect(received.filter(command => command.type === 'react').map(command => command.nonce)).toEqual([1, 2, 3, 4, 1]);
    expect(received.every(command => ['interaction_ready', 'react', 'history'].includes(command.type as string))).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await client.stop(); room.free(); signer.free();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
