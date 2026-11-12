# Independent text participant

This Node example joins a Piik 3.0 site with its **own ordinary identity**,
reads a configured room's confirmed history, sends text and replies to new live
`!ping` messages. It demonstrates the existing signed conversation API in a
separate process. It uses the same participant authority as the room UI.

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
confirmation, then leave. Otherwise stdin sends text; `/reconnect` explicitly
reopens the socket with the same in-memory identity, and `/quit`, EOF or Ctrl+C
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

`TextParticipant` can also be imported. It exposes `connect`, `chat`, `history`,
`reconnect`, `stop`, and verified `live`/`confirmed` events; the example's `!ping`
behavior lives only in `main`. A fresh Host binding requires reissuing the existing
Browse reading intent. Host-offline sends fail rather than fabricate confirmation.
Reading history does not re-execute old commands; external side effects are not
promised exactly once. This client uses no media peers or database access.

Construct it with one options object:

```ts
const participant = new TextParticipant({
  url, origin, roomId, name: 'Build notices',
  credential, // Optional: this automation user's own saved credential.
  admission: { inviteKey: process.env.PIIK_TEXT_INVITE_KEY },
});
```

`admission` also accepts `password`. File I/O belongs to the CLI or your caller;
the transport accepts an initial `credential` and emits a `credential` event
with its Welcome value. Treat that event as a secret, not a status to print.

The Browser tsconfig deliberately excludes Node examples. Check this entry with
the repository's existing compiler and Node types, without changing Browser types:

```sh
npx tsc --ignoreConfig --noEmit --target es2022 --module esnext \
  --moduleResolution bundler --allowImportingTsExtensions --skipLibCheck \
  --strict --esModuleInterop --types node \
  prototype/channel-browser/examples/text-participant.ts
```
