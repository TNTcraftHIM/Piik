# Verification Status

Last updated: 2026-08-27

This ledger records evidence that still changes how current source or production
may be interpreted. Git and pull requests own routine completed checks.

## Current Production Identity

- Production runs exact application/runtime revision
  `73ed920a229bfc64c89b97045c00d6cd75216f3a`, release `73ed920`, wire
  `screener-v13`, from `/opt/screener/releases/73ed920`.
- Runtime tar SHA-256:
  `351053e497e8eee17956f4cec86305b05d805c80deb40b2cf4cd2668eaf08583`.
  The 41-file manifest SHA-256 is
  `bb993950a30a0b99b9b6185aa13777edcccbdcdaebdfb1b05b3c3499a1e78479`.
- Public Browser asset `assets/index-CaM3Pn5_.js` has SHA-256
  `3c64cd75a7d67716f7600465a1742b1c02f3b00e71a1039649604aaf6d08f816`.
  Public `/healthz` returns 200. Release postflight found Screener, LiveKit,
  coturn, and nginx active with zero restarts.

## Completed Product Evidence

- Strict `screener-v13` rejects stale Browser/executable wires before room
  authority. Lightweight and SQLite-stable rooms, 24-hour dormant leases,
  room-lived Viewer grants, `open | private` code entry, invitation-only private
  rooms, password entry, grant rotate/revoke, atomic room replacement and
  `ROOM_NOT_FOUND` have passed source gates. Production stable mode retained an
  exact Host authority across a controlled restart. A current-production
  restart also preserved the Host-owned capture and restored Viewer media
  without refreshing either page.
- Endpoint capacity `1/2/3`, default `2`, one active upstream, acyclicity,
  source reachability, deterministic parent order, exact candidate identity,
  transport-connected wake extension, first-decoded-frame commit, strictly newer
  rollback, bounded resource accounting, SFU admission, and delete-plus-absence
  release have focused unit and controller coverage.
- Controlled Chrome routing proved direct prepare failure, rollback, SFU
  prepare, exact first-frame ready, SFU commit, and continuing UDP media without
  external ICE servers on Browser LiveKit PCs. This does not replace public
  heterogeneous-network recovery evidence.
- Chrome direct and Browser-relay VP8 measurements reached about 60 fps after
  stock bandwidth-estimation warm-up. Pinned LiveKit client `2.22.0` and server
  `1.13.5` separately proved native lower/higher screen-share representation
  selection with Dynacast and server send-side BWE.
- Chromium 151's Windows backends and exact Chrome fake-monitor getDisplayMedia
  evidence close the measured Chrome VP8 path as software. Short local controls
  held 1080p30, while 1080p60 was primarily bandwidth-limited and spatially
  adapted. Edge and real-game contention remain open in realtime-quality research.
- The content-independent sender gate selected VP8 on the measured Chrome 151
  AMD path and H.264 on Chrome 153 NVIDIA with both moving and static shared
  content. Static content therefore no longer prevents a codec decision; these
  two local cohorts do not replace broader real-game/device acceptance.
- Direct, Browser-relay, and SFU paths advanced video plus screen audio at
  64/128/192 kbps ceilings and after source replacement. The old constant
  active-audio `1 kbps` display is closed. Exact SFU weak-network behavior after
  RED was disabled remains open.
- Browser SFU publisher/subscriber PCs use empty external ICE-server lists while
  ordinary peers retain deployment STUN. The reported Host/Viewer TUN conflict
  was closed by that isolation without adding TURN or TCP media.
- Password-KDF capacity now fails before room or SQLite mutation; route terminal
  identity comes from the controller; Host child creation is assignment-fenced;
  explicit SFU refresh has a typed failure path; Viewer access outcomes remain
  exact; and Host quality intent survives signaling interruption.

## Current Source Evidence

- Canonical source and production use the strict-v13 application tree deployed
  from `73ed920`. The adaptive H.264/VP8 sender
  decision with `contentHint = "motion"` reapplies the
  selected video profile after answer negotiation, leaves SFU representation
  construction to pinned LiveKit, keeps Dynacast/send-side BWE, disables
  AdaptiveStream, and disables SFU audio RED.
- The local `VP8 | Auto | H264` Host selector is locked to a share generation;
  Viewer relays remain Auto and no codec wire state, cache, parallel media or
  active-edge switching exists.
- Viewer page-resume decoded-stall rebaselining, current-frame presentation
  authority, hidden-page stall suppression, retryable failure reporting, native
  controls, and same-route manual reconnect are current source behavior. Mobile
  physical evidence remains open.
- The evidence-only quality shadow accepts only exact foreground presentation
  windows with decoded progress, keeps one bounded fresh aggregate per current
  child, and exposes it through the Host-only anonymous route snapshot. It does
  not change route facts, capacity, candidate order, SFU admission or reconcile.
- An isolated current-production direct-P2P control proved the strict-v13
  aggregate across bounded CDP loss pulses. Freeze response was non-linear and
  the longest all-drop cell crossed into route recovery, so the result validates
  collection but supplies no active threshold; exact evidence is recorded in
  [realtime quality research](./research/realtime-quality-adaptation.md#strict-v13-production-shadow-control).

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
