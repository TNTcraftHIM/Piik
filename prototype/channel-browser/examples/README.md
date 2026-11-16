# Independent text participant

This Node example joins a Piik 3.0 site with its **own ordinary identity**,
reads a configured room's confirmed history, sends text and replies to new live
`!ping` messages. It demonstrates the existing signed conversation API in a
separate process. It uses the same participant authority as the room UI.

This development example uses the generated WASM and site from the same source
revision. The [versioning contract](../../../docs/standards/versioning.md#public-compatibility-promise)
defines the future public API promise.

The example supports these operations:

| Consumer action | Existing owner and result |
| --- | --- |
| Join or reconnect with this process's own identity | Site admission issues/restores its credential; a new process uses a fresh session/signing key. |
| Enter a private room and subscribe | Existing invitation/password admission followed by `browse`; room rules decide access. |
| Read recent confirmed text | Signed `history` with no `before` cursor reads the latest bounded page, currently up to 50 messages / 256 KiB. It is not a complete room export. |
| Send a notification or conversational response | Signed `chat` with a fresh nonce and no attachments; success waits for the room Host's stored confirmation. |
| React to a confirmed message from a bot | `react` checks the Host's advertised reaction IDs, then sends the existing signed counted-message reaction. |
| Receive new messages and leave | Verified `live_message` events feed the CLI behavior; `leave` and socket retirement close the participant. |

The interactive `!ping` command sends plain-text `pong`; it does not create a
quoted reply. Typing `@name` is ordinary text here; the client methods below send
structured replies, mentions and message reactions through Core's commands.

Use only a site and room you own or have explicit permission to test. The room
parameter selects what this process does; the room's access rules determine
what its user can read or send. Never substitute another person's credential.
By default its newly issued identity credential stays in memory; restarting
the process creates another identity.

Install the repository dependencies and generate the current Browser WASM using
the [normal adapter build](../README.md). From the repository root:

```sh
node --import tsx prototype/channel-browser/examples/text-participant.ts \
  --url ws://127.0.0.1:8791/prototype/channel \
  --origin http://127.0.0.1:8790 --room YOUR_ROOM_ID
```

`--origin` must be an origin allowed by that site. Use `wss://` for a TLS site.
Add `--name "Build notices"` to name this independent participant. Add
`--message "Build finished"` to send one notification, wait for its Host
confirmation, then leave without answering `!ping`. Otherwise stdin sends text;
`/reconnect` explicitly reopens the socket with the same in-memory identity, and `/quit`, EOF or Ctrl+C
leaves. `/reconnect` also works after a lost connection. A failed interactive
command prints its error and keeps the prompt open for another command. There
is no background daemon, automatic reconnect or replay outbox.

For a private room, supply `PIIK_TEXT_INVITE_KEY` or `PIIK_TEXT_ROOM_PASSWORD`
through your local environment or secret manager. These are the existing room
invitation key and room password, respectively; neither is a site owner key.
When configured, the participant requests `enter_room` before Browse or history.
Without either value, it requests no admission shortcut and the room's normal
access checks still apply. Keep these secrets out of command arguments and logs.

To explicitly keep this participant's own identity, add
`--identity-file build/text-participant/identity.txt`. Create its private parent
directory first; `build/` is ignored by Git. Only a missing file starts a new
identity. The CLI saves the credential received in Welcome as one plain-text
line, using mode `0600` when creating the file. Protect that file using your OS's
permissions and keep a separate identity file for each site. Read, write and
credential errors fail the command rather than silently replacing the identity.
On a later process run, the saved credential restores the same user and room
grants; the new process creates a fresh session and signing key. No password,
invitation key, session ID or signing key is saved in that file.

For a Node bot or notifier, import `TextParticipant` from
`../node/text-participant`. The CLI uses that same internal client. Its current methods are `connect`, `chat`, `history`, `react`,
`reconnect`, `stop`, and verified `live`/`confirmed` events; the example's `!ping`
behavior lives only in `main`. A fresh Host binding requires reissuing the existing
Browse reading intent. Host-offline sends fail rather than fabricate confirmation.
Reading history does not re-execute old commands; external side effects are not
promised exactly once. This client uses no media peers or database access.

Construct it with one options object:

```ts
import { TextParticipant } from '../node/text-participant';

const participant = new TextParticipant({
  url, origin, roomId, name: 'Build notices',
  credential, // Optional: this automation user's own saved credential.
  admission: { inviteKey: process.env.PIIK_TEXT_INVITE_KEY },
});
```

`admission` also accepts `password`. File I/O belongs to the CLI or your caller;
the transport accepts an initial `credential` and emits a `credential` event
with its Welcome value. Treat that event as a secret, not a status to print.

`history()` returns `{ messages, hasMore, oldestSeq, before }` for the latest page.
Messages are ordered oldest to newest. While `hasMore` is true, pass the first
message's sequence to read the preceding page. `oldestSeq` is the room's oldest
retained sequence, **not the next-page cursor**; `before` is the upper bound of
the completed request (`null` for the latest page). Core returns `hasMore: false`
for an empty page, including when the requested bound precedes retained history.
History does not emit `live` events or execute conversational commands.

```ts
let page = await participant.history();
consume(page.messages);
while (page.hasMore) {
  page = await participant.history(page.messages[0].seq);
  consume(page.messages);
}
const confirmed = await participant.chat('@friend Build finished', {
  mentions: [{ userId: friendId, start: 0, end: 7 }],
  reply: { seq: originalMessage.seq, notify: true },
});
```

The optional chat argument uses the same `ChatOptions` as the room UI. Mention
ranges use UTF-16 offsets in the exact message text, including the `@` prefix.
The room host validates the mentions and resolves the reply from its history;
the returned confirmation contains the accepted reply details. `notify: false`
keeps a reply without requesting notification. The client still owns the message
nonce; these options cannot override the command, room, text or credentials.

`react(messageSeq, reaction)` adds one counted reaction to a confirmed message:

```ts
const result = await participant.react(confirmed.seq, 'heart');
if (result.snapshot?.type === 'message') consumeCounts(result.snapshot.counts);
```

Each call first asks the current room Host for `interaction_ready.reactionIds`.
An unadvertised reaction rejects with `unsupported_reaction`; a changed Host
binding requires another call. The response is the existing signed reaction
record, including its nonce, optional live event and count snapshot. Repeated
successful calls add counts; this is not a per-user toggle or vote. Core owns
the rate limit and accepted-nonce deduplication. A rejected call is not retried
automatically, and callers cannot choose the nonce. A repeated packet does not
add another count. Nonces continue when the same session reconnects and reset
when Welcome establishes a new session. The active socket, session, room access
and Host binding are checked again after the support reply.

Browse already establishes ordinary room reading. `interaction_ready` obtains
the Host's supported reactions under that same Read permission; it neither joins
voice/media nor grants a new role. No reaction capability cache survives a room
Host change. The client remains a text participant and does not host rooms.

A bot can combine an ordinary quoted reply with a message reaction. Attach this
handler instead of the CLI's plain `!ping` behavior:

```ts
participant.on('live', message => {
  if (message.userId === participant.summary().userId || message.text !== '!ping') return;
  void participant.chat('pong', { reply: { seq: message.seq, notify: true } })
    .then(() => participant.react(message.seq, 'wave'))
    .catch(error => console.error(error.message));
});
```

Only new verified live messages trigger the handler. Reading history does not
replay it; a declined reaction does not undo the already-confirmed reply.

## Support bot example

`support-bot.ts` runs a small consumer of the same Node client. A new `!help`
message from another user receives a quoted Markdown answer with a fenced text
template, followed by one `wave` reaction attempt on the incoming message.
The room Host confirms both operations. A declined or rate-limited reaction
does not resend the confirmed reply. It does not process history as commands.

From the repository root, after the same dependency/WASM setup above:

```sh
node --import tsx prototype/channel-browser/examples/support-bot.ts \
  --url ws://127.0.0.1:8791/prototype/channel \
  --origin http://127.0.0.1:8790 --room YOUR_ROOM_ID
```

Use only an explicitly authorized room. `PIIK_TEXT_CREDENTIAL` may supply this
bot's own saved credential; otherwise each process starts a new identity.
Private-room access uses `PIIK_TEXT_INVITE_KEY` or `PIIK_TEXT_ROOM_PASSWORD`.
This example does not save credentials, expose a webhook, or export messages to
another service. It needs no media peers, room hosting, or Bot-specific role.

Ctrl+C or SIGTERM removes the handler and closes the participant, then waits for
pending handler work to settle. A disconnect ends this example without automatic
reconnect or replay. `attachSupportBot` can also be imported; its returned async
cleanup removes its listener and drains work, while the caller retains ownership
of the participant connection. No module registry or plugin loader is involved.

The existing tooling tsconfig checks the Node client and examples during the normal
repository checks. Its retained test uses a loopback WebSocket fixture and the
real Core WASM signer/verifier, without starting an App or Server:

```sh
npx tsc -p scripts/tsconfig.json
npm test -- tests/text-participant.test.ts
```
The Node client separates socket/signing lifecycle from CLI file I/O and business
behavior. `chat` is send-with-confirmation; `live` carries verified new messages;
`stop` closes the participant. This internal entry uses Node `ws` and file-backed
WASM initialization. It is not a Browser SDK or a published stable API.

Its reader retains only the current session keys and room conversation facts;
unrelated media descriptions and non-text events are not installed or validated.
The summary reports identity, room availability, reading and host binding.
The shared Core verifier checks signatures, current
host/recipient and room authorization. Unknown signed conversation record types
remain rejected.
