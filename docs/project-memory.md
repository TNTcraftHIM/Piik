# Project Memory

Last updated: 2026-08-27

## Current Product Truth

- Screener is private, low-latency game screen sharing for one Host and up to
  `20` authenticated Viewers, not a public broadcast service.
- Web Host, Viewer, and Browser relay are the current delivery surface. Native
  capture, shared encoding, and distributable server/local packages remain
  later work.
- Rooms use one bounded authority model: random free `1000..9999` code, default
  24-hour dormant lease, active sharing never expires, exact Host token resume,
  and Viewer activity never renews. `ROOM_DATABASE_PATH` absent is the default
  lightweight process-memory mode; configured is the optional SQLite stable
  mode that persists only room authority across application restart. Production
  enables stable mode; live participants, routes and media remain process-only.
- Every room has one 128-bit/22-character Viewer grant bound to that exact room
  incarnation and independent `open | private` code entry. Private without a
  password is invitation-only; adding a password also permits matching code
  entry. Reclamation, explicit replacement, lightweight restart, rotate, or
  revoke ends the grant; stable restart retains its digest and generation.
  Missing codes return `ROOM_NOT_FOUND` without a password prompt.
- Host creation preferences, raw ownership token and one non-expiring preferred
  code stay local to the Host browser. Server authority stores only
  digests/verifiers, optionally in SQLite stable mode, and never uses IP, UA,
  device, or browser fingerprint as identity.

## Media And Routing

- Media stays automatic and distributed. Ordinary peer ICE is STUN-only and
  direct/peer UDP is preferred. The only application fallback is the dedicated
  LiveKit SFU over UDP; Screener configures no TURN, ICE/TCP, media TCP, or
  TLS-relayed media.
- Browser LiveKit publisher/subscriber PCs use no external ICE server and retain
  LiveKit-signaled UDP candidates. Deployment STUN remains available to ordinary
  peers and LiveKit server-side public-IP discovery.
- Every non-server endpoint uses one server-authoritative steady outbound copy
  cap: default `2`, configurable only as `1`, `2`, or `3`. A peer child or the
  Host publication consumes one slot; upstream receive is free; SFU subscriber
  egress uses separate server admission.
- One room controller owns one committed acyclic source-reachable graph, one
  event-driven reconciliation loop, and at most one room-serial child operation.
  The operation owns one deterministic candidate list/cursor, one current
  candidate and reservations, one fact version, and one total deadline.
- Candidate filtering enforces current authority, reachability, acyclicity,
  capacity, transition slots, and server admission. Eligible P2P parents are
  ordered by resulting depth, remaining capacity, a stable child-parent hash,
  join order, and peer identity.
- A candidate commits only after the exact child decodes its first new video
  frame. Exact direct transport-connected progress may retain the candidate
  through the total deadline but cannot commit. Failure releases resources,
  broadcasts a strictly newer rollback revision, advances the cursor without
  resetting the deadline, and preserves unaffected healthy branches. SFU-backed
  Viewers keep working media while finite direct candidates converge in
  background round-robin. A relay with bad ingress reparents itself while
  retaining its subtree.
- Healthy decoded routes remain sticky. There is no periodic rebalancing,
  quality score, all-pairs probing, parent blacklist, NAT classification, port
  prediction, or independent depth cap. Quality evidence cannot prove an
  unconnected parent would be better.
- P2P and SFU first use their framework reconnect behavior. P2P recovery tries
  the same parent, and SFU recovery rebuilds the same publication/subscription.
  Manual media reconnect also stays on the current exact route. Only actual
  recovery exhaustion, hard failure, non-paused decoded-frame stall, parent
  departure, or capacity invalidation enters route reassignment.
- Active-path WebRTC/LiveKit sampling owns one exact-route decoded-progress
  deadline. Route/connection change or new progress resets it; authoritative
  pause suppresses it. Page resume rebaselines frozen wall-clock time before
  another no-progress sample can fail a route.

## Media Quality

- Canonical source and production run one sender-scoped actual-sender preflight
  with a deterministic moving probe track sized to the current share target, so
  captured-content motion cannot decide encoder capability. Proved senders prefer
  H.264 with native VP8 fallback, while failed/inconclusive senders remain
  VP8-only. The Host UI provides a local pre-share `VP8 | Auto | H264` selector
  with Auto default; it locks while sharing, is not persisted, and creates no
  codec wire/state or active-edge switching. Viewer relays remain Auto.
  Display video uses `contentHint = "motion"` and display audio uses
  `contentHint = "music"`.
- Windows Chrome 151 uses software VP8 and exposes no Web control for selecting
  NVENC, AMF, QSV, a GPU, or an MFT. Edge, non-Windows paths, and real-game CPU
  contention remain evidence-specific.
- Recommended profiles remain exactly `720p30`, `1080p30`, and `1080p60`, with
  `1080p30` default. `480p` is only an advanced `854x480` resolution choice;
  advanced FPS and bitrate remain independent.
- WebRTC owns direct/peer media adaptation. The Host reapplies the selected video
  profile after answer negotiation; no periodic application controller exists.
- The production SFU publisher uses the Host's H.264/VP8 decision and selected
  ceiling but no backup codec or custom simulcast layers. Pinned LiveKit defaults own
  representations, Dynacast owns aggregate
  demand, and server send-side BWE owns subscriber forwarding. AdaptiveStream
  stays disabled because any Viewer may relay its received track.
- Screen audio requests capture by default and offers live 64/128/192 kbps
  sender ceilings with 128 default. Peer answers request Opus stereo with a
  192 kbps receive maximum. SFU publication uses stereo, DTX off, and RED off;
  disabling RED accepts reduced burst-loss resilience in exchange for bounded
  publisher traffic.
- Configured resolution, FPS, bitrate, preference, codec, and audio ceiling are
  requests or ceilings. Sender readback and RTCStats are the observable truth.

## Presentation And Lifecycle

- Viewer presentation is revision/generation-fenced and keeps the stage stable
  until a current-generation composited frame. A new current frame clears stale
  media `connecting/reconnecting` presentation; old callbacks cannot prove a
  new route.
- Viewer local play/pause, volume, mute, and fullscreen are owned by native video
  controls on one persistent media element. Host preview is a muted, control-free
  view of the capture stream; only explicit Host actions pause or stop sharing.
- Viewer hidden/freeze/pagehide suppress application decoded-stall authority;
  visible/resume/pageshow rebaseline and rearm current-frame proof. SFU pagehide
  does not make LiveKit actively disconnect, while SDK freeze behavior, playback,
  background audio, page reclamation, and relay survival remain physical gates.
- Hiding or unfocusing the Host page pauses only the local preview element.
  Browser/OS capture and background behavior remain platform capabilities; no
  fake keepalive, silent media, Wake Lock, or timer loop is a product mechanism.

## Current Source And Production

- Canonical source uses the evidence-only strict `screener-v13` quality shadow;
  production remains strict `screener-v12` until the atomic application release.
  Both retain adaptive H.264/VP8 selection, the local Host codec override and
  optional SQLite room authority. Exact identities are indexed by
  [status](./status.md).
- Strict v13 rejects old Browser pages before room authority. Its bounded
  current-edge aggregate adds no active route decision until annotated
  production shadow evidence establishes an accepted policy.
- Production uses SQLite-backed random rooms, 20-Viewer admission, endpoint cap `2`,
  fixed 9,000-publication ingress and `9000 * 20` subscription egress admission,
  STUN UDP 3478, LiveKit media UDP 7882, and Web TCP 80/443. Node 8787 and
  LiveKit 7880 remain private.
- Exact artifact and service state are owned by [deployment](./deployment.md)
  and indexed by [status](./status.md). Physical evidence boundaries are owned
  by [verification status](./verification-status.md).

## Current Priority

1. Deploy the evidence-only strict `screener-v13` quality shadow and collect
   annotated production samples.
2. Complete the mobile Viewer lifecycle matrix and representative real-network
   route/media acceptance.

Quality-driven parent selection, Native sender work, distribution packages,
whole-product UI/bilingual polish, and repository-wide simplification remain
later decisions in [the TODO ledger](./todo.md).

## Working Rules

- Generic authority and scope follow the repo-tracked
  [`stop-that-shit` skill](../.agents/skills/stop-that-shit/SKILL.md).
- Canonical `main` and the current truth owners override old branches,
  worktrees, handoff text, and chat summaries.
- Preserve unique or dirty candidates until integration and reference/reparse
  audits prove cleanup is safe.
