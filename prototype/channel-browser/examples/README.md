# Independent text participant

This Node example joins a Piik 3.0 site with its **own ordinary test identity**,
reads a configured room's confirmed history, sends text and replies to new live
`!ping` messages. It demonstrates the existing signed conversation API in a
separate process. It is not a production Bot service or a public SDK.

Use only a site and room you own or have explicit permission to test. The room
parameter is client intent, **not a server-enforced authorization scope**. The
ordinary identity has normal participant authority; issuer, strict room-scoped
admission and independent Bot credential revocation are not implemented. Never
substitute another person's credential. Its newly issued identity credential
stays in this process's memory; restarting the process creates another identity.

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
leaves. There is no background daemon, automatic reconnect or replay outbox.

`TextParticipant` can also be imported. It exposes `connect`, `chat`, `history`,
`reconnect`, `stop`, and verified `live`/`confirmed` events; the example's `!ping`
behavior lives only in `main`. A fresh Host binding requires reissuing the existing
Browse reading intent. Host-offline sends fail rather than fabricate confirmation.
Reading history does not re-execute old commands; external side effects are not
promised exactly once. This client uses no media peers or database access.

The Browser tsconfig deliberately excludes Node examples. Check this entry with
the repository's existing compiler and Node types, without changing Browser types:

```sh
npx tsc --ignoreConfig --noEmit --target es2022 --module esnext \
  --moduleResolution bundler --allowImportingTsExtensions --skipLibCheck \
  --strict --esModuleInterop --types node \
  prototype/channel-browser/examples/text-participant.ts
```
