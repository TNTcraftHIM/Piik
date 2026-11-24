# Piik text participant for Node.js

This package is for internal Piik 3.0 beta testing. Use the matching Piik site
build. The API can change between betas. The package carries the Core WASM and
its JavaScript adapter, and initializes them from the installed package.

Run `npm install /path/to/piik-text-participant-<version>.tgz` in your Node 24
project. Import from `piik-text-participant` in an ESM module. TypeScript callers
can use the included declarations with the normal Node type definitions
(`npm install -D @types/node`).

Set `PIIK_TEXT_URL` to the site's full WebSocket URL (usually
`wss://your-site/prototype/channel`) and `PIIK_TEXT_ORIGIN` to the origin the
site accepts. Run each workflow with its own ordinary participant account.
`PIIK_TEXT_CREDENTIAL` can restore that participant's saved identity. If you
persist new credentials from the `credential` event, treat them as secrets.

## Reply in an authorized room

Set `PIIK_TEXT_ROOM` to the target room ID. For existing private admission,
provide `PIIK_TEXT_INVITE_KEY` or `PIIK_TEXT_ROOM_PASSWORD` when needed.

```js
import { once } from 'node:events';
import { TextParticipant } from 'piik-text-participant';

const bot = new TextParticipant({
  url: process.env.PIIK_TEXT_URL,
  origin: process.env.PIIK_TEXT_ORIGIN,
  roomId: process.env.PIIK_TEXT_ROOM,
  name: 'Sharing support',
  credential: process.env.PIIK_TEXT_CREDENTIAL,
  admission: {
    inviteKey: process.env.PIIK_TEXT_INVITE_KEY,
    password: process.env.PIIK_TEXT_ROOM_PASSWORD,
  },
});

const report = error => console.error(error.message);
const onMessage = message => {
  if (message.text.trim() !== '!help' || message.userId === bot.summary().userId) return;
  void bot.chat('Share your Piik version and the step that failed.', {
    reply: { seq: message.seq, messageId: message.id, notify: true },
  }).catch(report);
};
bot.on('failure', report).on('live', onMessage);

let requestStop;
const stopping = new Promise(resolve => { requestStop = resolve; });
process.once('SIGINT', requestStop);
process.once('SIGTERM', requestStop);
const disconnected = once(bot, 'disconnected');
try {
  const running = bot.connect().then(() => disconnected);
  await Promise.race([stopping, running]);
} finally {
  bot.off('live', onMessage);
  process.off('SIGINT', requestStop);
  process.off('SIGTERM', requestStop);
  try { await bot.stop(); }
  finally { bot.off('failure', report); }
}
```

## Create a room, post and delete

Use a hosted site that permits this participant to create rooms. Lightweight
sites require a Browser or App room writer and return `room_writer_required`.

```js
import { TextParticipant } from 'piik-text-participant';

const bot = new TextParticipant({
  url: process.env.PIIK_TEXT_URL,
  origin: process.env.PIIK_TEXT_ORIGIN,
  credential: process.env.PIIK_TEXT_CREDENTIAL,
  name: 'Build notices',
});
try {
  await bot.connect();
  const room = await bot.createRoom({ name: 'Build notices', icon: 'couch', access: 'public', hidden: false });
  await bot.browse(room.id);
  const sent = await bot.chat('Build finished');
  await bot.deleteOwnMessage(sent);
} finally {
  await bot.stop();
}
```

## Update the participant profile

After connecting, call `setProfile()` to update your display name or avatar
on this site. The constructor's `name` initializes a new identity.
When restoring an existing credential, the site keeps the saved profile.

```js
import { readFile } from 'node:fs/promises';

const png = await readFile('support-avatar.png');
await bot.setProfile({ name: 'Piika', avatar: `data:image/png;base64,${png.toString('base64')}` });
await bot.setProfile({ name: 'Piika Support' }); // Keep the avatar.
await bot.setProfile({ avatar: null }); // Clear the avatar.
```

Omitted fields keep their saved values. The promise resolves after the site's
acknowledgement and rejects if the site rejects the update.
Avatars use PNG or WebP data URLs. The complete URL can contain at most 24 KiB.

## Events and commands

- `ready` follows successful room Browse. With no `roomId`, `connect()`
  establishes the site session and the caller selects a room with `browse()`.
- `live` delivers new verified room messages. `history(before?)` reads a
  bounded retained page. Use the first message's sequence for the preceding
  page when `hasMore` is true.
- `confirmed` reports the Host's receipt for this participant's send, including
  a retained receipt returned on retry. `chat()` resolves to the same message.
  `deleteOwnMessage()` takes a confirmed message authored by the caller and
  waits for the signed deletion receipt.
- `react(seq, messageId, reaction)` returns the nonce, confirmed message counts
  in `snapshot.counts` and a message-targeted event. A repeated nonce yields
  the count snapshot with a null event.
- `failure` reports a connection failure after Welcome. Command failures
  reject their own promises. `disconnected` signals socket retirement.
  `reconnect()` explicitly resumes the same instance's identity and room
  intent. `stop()` closes the participant and frees its signing resources.

Attach a `live` listener once per participant. It stays registered across
`reconnect()`. Messages sent during a disconnection can be read with
`history()`. Only fresh broadcasts trigger the listener when browsing resumes.
An embedding application removes its own listener with `off('live', onMessage)`.

If a send times out after the Host commits it, the caller can explicitly
retry with the same `chat` nonce and original content as long as the original
confirmation is retained. History and reconnect do not execute earlier commands.
