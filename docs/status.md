# Current Status

Last updated: 2026-08-25

This is the current execution index. Git history owns completed timelines;
[verification status](./verification-status.md) owns evidence boundaries.

## Production

- `https://share.bonfire.icu` runs exact application/runtime revision
  `4f46d9ebc4fe11a6648749f2b8b447eb83041fd5`, release `4f46d9e`, wire
  `screener-v12`, from `/opt/screener/releases/4f46d9e`. The immutable runtime
  tar SHA-256 is
  `a832fd401955f9913e8ac03857851b302c49f8eef7b049c39d21a214586227d2`;
  its 39-file manifest SHA-256 is
  `47050583ff4a7e691339bc4087f95e704c242625a2ec92ff2d5166cf3c6eca7c`.
- The served Browser entry references `assets/index-kQCZyrsd.js`; the public
  asset is 486071 bytes with SHA-256
  `28b706a88085ff411b70eee8865fad53406b7679020cfe3fd0fa47e5091792e9`.
  Public `/healthz` returns 200. The release postflight found Screener, LiveKit,
  coturn, and nginx active with zero restarts.
- Production uses process-memory four-digit rooms, a 24-hour dormant lease,
  room-lived 22-character grants, `open | private` code entry, one Host plus 20
  Viewers, endpoint copy cap `2`, and no SQLite runtime.
- Public media listeners remain STUN-only UDP 3478 and LiveKit UDP 7882. Web
  ingress is TCP 80/443; Node 8787 and LiveKit control/signaling 7880 are
  private. TURN, ICE/TCP, media TCP, TLS relay, port 5349, and relay ranges are
  disabled.
- Browser video is fixed VP8 with `contentHint = "motion"`; audio uses `music`.
  The SFU publisher leaves representation construction to pinned LiveKit,
  enables Dynacast, uses server send-side BWE, keeps AdaptiveStream disabled,
  and configures no external ICE servers on Browser SFU PCs.
- Screen audio provides live 96/128/192 kbps ceilings with 96 default. SFU
  publication uses stereo, DTX off, and RED off. Early autoplay presentation is
  gated by current media connection state.

## Current Source

- Canonical root `main` is clean and its application/runtime tree matches exact
  production revision `4f46d9e`. Auxiliary branches and worktrees do not
  supersede it.
- One event-driven controller owns the committed graph and one room-serial child
  operation. It uses exact candidate identity, first-decoded-frame commit,
  strict rollback revisions, direct-then-SFU total deadline, and typed endpoint
  plus SFU resource accounting. Healthy decoded edges remain sticky.
- WebRTC/LiveKit own media adaptation. Screener has no custom SFU layer list,
  quality score, layer selector, periodic rebalancing, or quality-driven parent
  change. P2P and SFU recover their current route before actual failure enters
  normal reassignment.
- Viewer page resume rebaselines decoded-stall timing, a new current-generation
  frame clears stale media recovery state, native Viewer video controls own local
  playback, Host preview is control-free, and manual reconnect stays on the
  current P2P parent or SFU subscription.

## Current Milestone

1. Measure Browser VP8 hardware use and the current game-load performance
   bottleneck on supported Chrome/Edge platforms.
2. Finish the Android Chrome and iOS Safari Viewer lifecycle matrix.
3. Finish representative public-network direct, peer-relay, SFU, recovery,
   Pause/Resume, screen-audio, real-game A/V, and all-UDP-blocked acceptance
   without adding another transport or quality controller.

## Active Boundaries

- Desktop Host background capture remains unconfirmed. The current-browser
  screening did not reproduce a Host-page drop; accepted Viewer lifecycle work
  prevents frozen JavaScript wall time from becoming an immediate route failure
  but is not capture keepalive.
- Current-path quality is diagnostic. High loss, RTT, jitter, low bitrate,
  resolution, FPS, or freeze counters do not trigger relay abdication or parent
  switching.
- Native/executable senders, shared encode, distribution packages, broad UI
  polish, bilingual support, and repository-wide simplification are outside the
  current release.

## Current Hold

No source or deployment P0 is open. Representative real-network and mobile
physical evidence remains required before route acceptance is complete.
