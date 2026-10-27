# Channel prototype

A Rust channel coordinator with Piik's shared React interface and real Browser
WebRTC media. It runs separately from the production 2.x App and Server.

## Run

From the repository root, use two terminals:

```powershell
cargo run --manifest-path prototype/channel-server/Cargo.toml
node node_modules/vite/bin/vite.js --config prototype/channel-server/vite.config.ts
```

Open the **owner URL printed by Rust**. It contains the private owner key; keep
that URL for yourself. Use **Invite** in the interface to copy a member link.
Open that link in another browser or browser profile for a separate user. Tabs
in the same profile share a saved user identity but have independent live sessions.
The coordinator and preview bind to loopback on ports 8791 and 8790 respectively.

## Try it

1. Open the user list beside the room actions to change your name. Send a
   message, browse another room and return: each room has its own history and draft.
2. Have two users share their screens. Select either picture or watch both.
   The channel owner does not need to be a sharer.
3. Join voice, or choose listen-only without opening a microphone. Each room
   keeps its own mute and listening controls. Browsing another room leaves an
   existing call or share running, with its destination visible in the interface.
4. Stop your own share while watching someone else. Other publications and any
   forwarding you provide for them continue independently.
5. Reconnect one browser. Its live session and media survive a signaling outage
   of up to 20 seconds. A longer outage releases its captures and peer connections.

Chat fills the room until a screen is opened. Watched screens then take the main
area, with chat alongside; narrow windows stack them. Chat can be tucked away
without leaving the conversation. Voice controls stay at the bottom, and the
room selector there chooses which joined call to control. User roles are edited
from the user list rather than shown throughout the room.

Screen capture requires a desktop browser with `getDisplayMedia`. The browser
chooses the source and permissions. Remote audio offers a Play action when the
browser requires a user gesture. Local screen previews are muted.

## Owners and limits

- A channel contains rooms. All participants are users; owner status, multiple
  roles and concurrent sharing/watching/forwarding are separate.
- Rust owns admission, role grants, the room directory, chat history, publication
  authorization and independent route plans. Browser endpoints own capture,
  WebRTC transports, playback and local resource retirement.
- The Rust `Authority` library owns those decisions and returns ordered effects
  for specific connections. The Axum adapter delivers them and owns sockets,
  queues and clocks. Build the library with `--no-default-features` to exclude
  the HTTP runtime when integrating another entry point.
- Member links admit users; server-issued credentials preserve their identity.
  Resume additionally checks the live session's ownership. The owner can assign
  roles; an owner or moderator can create a room. This first slice has public
  rooms within the admitted channel, not private-room overrides.
- Each publication first connects to two subscribers, then uses ready subscribers
  as bounded relays. Healthy paths stay in place. Compatible publications share
  a physical peer connection; ending one removes its tracks rather than closing
  the other publications' connection. Relay failure reassigns affected branches.
- Browser relays receive and re-encode media through WebRTC. This proves routing
  and lifecycle behavior; encoded-packet forwarding belongs to the later Native
  and SFU integration. Browser WebRTC owns ICE and congestion control.
- History retains 100 messages per room; messages allow 2,000 Unicode characters.
  This temporary instance admits at most 20 live endpoints, 64 user identities,
  32 rooms and 80 publications. These are prototype resource bounds, not a fixed
  bandwidth allowance shared among rooms. Restarting Rust clears the channel.

This slice does not include Native App linkage, SFU fallback, files, persistent
channels, federation or coordinator handoff. The
[network and lifecycle design](../../docs/research/channel-network-design.md)
owns those later stages. Routing plans currently run in Rust at the coordinator;
media forwarding is distributed among the Browser endpoints.

## Checks

```powershell
cargo test --manifest-path prototype/channel-server/Cargo.toml
cargo test --manifest-path prototype/channel-server/Cargo.toml --no-default-features --lib
npm run typecheck
node --test prototype/channel-server/check.mjs
node prototype/channel-server/browser-acceptance.mjs
node prototype/channel-server/browser-acceptance.mjs --lifecycle
```

The two live checks need the running service and local test keys in their
environment; their source lists the variable names. The Browser check uses five
isolated sessions and generated moving-picture/audio tracks, actual peer
connections and receiver statistics. Generated captures replace only the system
picker. They do not replace the coordinator, negotiation, routing or playback.
The preview route and test hook are development-only. No production frontend
dependencies were added.
