# Verification Status

Last updated: 2026-08-25

This ledger records evidence that still changes how current source or production
may be interpreted. Git and pull requests own routine completed checks.

## Current Production Identity

- Production runs exact application/runtime revision
  `af348ee1d508a3af02b18a7f46c461953798e19d`, release `af348ee`, wire
  `screener-v12`, from `/opt/screener/releases/af348ee`.
- Runtime tar SHA-256:
  `4922cc31d7caaad7c5412b1f2fe1d73f788d16d92386efad6eac358a97b8a78e`.
  The 39-file manifest SHA-256 is
  `5b397809b664b9a55885ac603df615b537bf51276e7274416820870956242d7d`.
- Public Browser asset `assets/index-BvuZY6Hc.js` is 488473 bytes with SHA-256
  `e8fc0500496ee101031a9cfebfcc22d3b69e66d2cac5e875448b56620dbb21c5`.
  Public `/healthz` returns 200. Release postflight found Screener, LiveKit,
  coturn, and nginx active with zero restarts.

## Completed Product Evidence

- Strict `screener-v12` rejects stale Browser/executable wires before room
  authority. Process-memory rooms, 24-hour dormant leases, restart loss,
  room-lived Viewer grants, `open | private` code entry, invitation-only private
  rooms, password entry, grant rotate/revoke, and `ROOM_NOT_FOUND` have passed
  source and production gates.
- Endpoint capacity `1/2/3`, default `2`, one active upstream, acyclicity,
  source reachability, deterministic parent order, exact candidate identity,
  first-decoded-frame commit, strictly newer rollback, bounded-gap resource
  accounting, SFU admission, and delete-plus-absence release have focused unit
  and controller coverage.
- Controlled Chrome routing proved direct prepare failure, rollback, SFU
  prepare, exact first-frame ready, SFU commit, and continuing UDP media without
  external ICE servers on Browser LiveKit PCs. This does not replace public
  heterogeneous-network recovery evidence.
- Chrome direct and Browser-relay VP8 measurements reached about 60 fps after
  stock bandwidth-estimation warm-up. Pinned LiveKit client `2.22.0` and server
  `1.13.5` separately proved native lower/higher screen-share representation
  selection with Dynacast and server send-side BWE.
- Direct, Browser-relay, and SFU paths advanced video plus screen audio at
  64/128/256 kbps ceilings and after source replacement. The old constant
  active-audio `1 kbps` display is closed. Exact SFU weak-network behavior after
  RED was disabled remains open.
- Browser SFU publisher/subscriber PCs use empty external ICE-server lists while
  ordinary peers retain deployment STUN. The reported Host/Viewer TUN conflict
  was closed by that isolation without adding TURN or TCP media.

## Current Source Evidence

- `af348ee` fixes Browser VP8 with `contentHint = "motion"`, reapplies the
  selected video profile after answer negotiation, leaves SFU representation
  construction to pinned LiveKit, keeps Dynacast/send-side BWE, disables
  AdaptiveStream, and disables SFU audio RED.
- The accepted `fix/viewer-page-lifecycle` candidate has focused coverage for
  page-resume decoded-stall rebaselining, current-frame presentation authority,
  and same-parent P2P manual rebuild. TypeScript and the client production build
  pass. It is not current source or production until its release is integrated.

## Open Physical Gates

### Route And Network

- Repeat direct, peer-relay, SFU, relay-ingress recovery with subtree retention,
  disconnect/capacity drain, and Pause/Resume on representative IPv4/IPv6,
  Wi-Fi/cellular, and Host/Viewer TUN/VPN networks.
- Verify all-UDP-blocked networks reach bounded explicit failure. No TURN,
  ICE/TCP, media TCP, TLS relay, NAT classification, port prediction, or TCP
  probe is authorized.
- Run the 20-Viewer public-network capacity/resource/endurance gate. Local or
  synthetic 1:20 control evidence does not establish target-network quality.

### Media Quality

- Measure real games at 720p30, 1080p30, and 1080p60 across weaker Hosts and
  actual Browser encoder implementations. Correlate capture, outbound, inbound,
  decode, CPU/GPU, and A/V timing.
- Verify pinned LiveKit default representation behavior on exact production
  under constrained and unconstrained subscribers without adding an application
  layer selector.
- Verify weak-network screen audio and A/V synchronization after RED was
  disabled, including concealment/FEC evidence where exposed.

### Lifecycle

- Desktop Host background/minimized capture remains unconfirmed. A short
  current-Chrome window-capture screening did not reproduce an immediate drop;
  a current-production real-game reproduction must separate Host page, captured
  surface, capture, encoder, path, and Viewer behavior.
- Android Chrome and iOS Safari still need autoplay, background audio,
  foreground video recovery, page reclamation, rotation, network migration, and
  assigned-relay survival tests. Web does not promise background video or relay
  execution after OS suspension.

## Interpretation Rules

- Configuration and loopback prove neither target-network quality nor hardware
  acceleration.
- Missing RTCStats fields are unknown, not zero.
- Current-path quality is diagnostic and cannot authorize active parent change.
- A Browser page lifecycle correction is recovery logic, not keepalive.
- Native, packaging, and broad UI work remain outside these gates until their
  TODO decisions are opened.
