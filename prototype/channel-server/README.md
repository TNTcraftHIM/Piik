# Channel prototype

An isolated Rust authority and the existing React interface, for evaluating a
channel-centred Piik. This is a local experiment, not a production server or a
replacement for the accepted 2.x protocol.

From the repository root, run in separate terminals:

```powershell
cargo run --manifest-path prototype/channel-server/Cargo.toml
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 8790
```

Open <http://127.0.0.1:8790/__channel-preview> in two browser tabs. Send messages,
switch rooms, leave a draft, and return. Other tabs receive messages through
the Rust WebSocket service. Each room has independent history and drafts;
browsing a different room does not move a microphone or screen capture.
Reopening a page restores the server's bounded history. Restarting the server
clears it. After a disconnect, the explicit reconnect action gets a new snapshot.

The microphone and screen controls perform real local Browser capture. They do
**not** send media to another participant. Capture permissions, mute, move,
stop, browser-ended tracks and page disposal have real resource lifecycles.
File exchange is deliberately absent until there is an authorised transfer owner.

## Design boundary

The [3.0 network and lifecycle proposal](../../docs/research/channel-network-design.md)
owns the next model and implementation order. It awaits owner discussion before
runtime changes. The following describes only the current executable prototype.

Use the [agreed vocabulary](../../docs/research/channel-network-design.md#terminology-and-roles)
for discussion: a channel contains rooms, and all participants are users whose
roles and activities can overlap. The three conversation containers in the
executable prototype still use the `channel` field and old channel labels; they
correspond to rooms in this design. The top-level channel is not yet modeled.

- One local service supplies these three conversation containers. Each WebSocket gets
  a server-issued, connection-scoped identity. All prototype participants have
  the same access to all three rooms; there are no private rooms or roles.
- Rust owns room history and message attribution. A connection cannot claim
  another sender. At most 20 active connections, 100 messages per room, 2,000
  Unicode characters per message, and a 128-event broadcast queue are retained.
  Slow consumers disconnect and recover by taking a fresh snapshot.
- The process binds only loopback and accepts the exact local UI Origin.
  Identity is **not authentication**. Hosted deployment requires the accepted
  admission/credential owner, room access and production transport limits.
- Selection, joined voice and picture publication are separate owners. A single
  local voice and a single local picture can remain attached to their original
  room while the user reads another room. Moving voice retains the same
  microphone stream and its mute setting;
  stopping picture does not leave voice or clear chat.
- Mapping each new room to a 2.x room could reuse its single-picture route
  controller, but current Host authority and picture publisher are coupled.
  That mapping alone cannot deliver arbitrary users sharing in a room.
  The linked proposal separates room access, publication and subscription,
  and identifies which 2.x route constraints need to change for multiple sources.
- Axum/Tokio own HTTP/WebSocket/runtime mechanics. This crate implements no media
  router, SFU, quality algorithm, NAT traversal, persistence or native adapter.
  Mature media components must be evaluated separately; a Rust client SDK is
  not a Rust replacement for the embedded server or native encoding pipeline.

## Checks

```powershell
cargo check --manifest-path prototype/channel-server/Cargo.toml
cargo test --manifest-path prototype/channel-server/Cargo.toml
node --test prototype/channel-server/check.mjs
npm run typecheck
```

The protocol check requires the prototype server. It exercises two live
WebSockets, sender identity, room-specific history on reconnect and rejection
of a spoofed sender. The Browser preview is development-only and excluded from
the production route. Rust dependencies are locked in this crate's Cargo.lock;
no dependencies were added to the production JavaScript application.
