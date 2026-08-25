# Current Status

Last updated: 2026-08-26

This is the current execution index. Git history owns completed timelines;
[verification status](./verification-status.md) owns evidence boundaries.

## Production

- `https://share.bonfire.icu` runs exact application/runtime revision
  `d8307a36b69a11a9264657363966c175d6d36c0d`, release `d8307a3`, wire
  `screener-v12`, from `/opt/screener/releases/d8307a3`. The immutable runtime
  tar SHA-256 is
  `dd9f3e919663c71294976a18b8bbd2f02f15c999849ba168564bcf52d6de0eef`;
  its 39-file manifest SHA-256 is
  `f20005e50376e5cd8caea79acfba0c7e2733fa52e9fa5324c450efa4cf3a4592`.
- The served Browser entry references `assets/index-rzD5Vq8B.js`; the public
  asset is 492366 bytes with SHA-256
  `5a2beb0ef73abfd0dae15903532e47723bc401f2a58a75f33317240f9a0f6a07`.
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
- Screen audio provides live 64/128/192 kbps ceilings with 128 default. SFU
  publication uses stereo, DTX off, and RED off. Early autoplay presentation is
  gated by current media connection state.

## Current Source

- Canonical root `main` is clean and its application/runtime tree matches exact
  production revision `d8307a3`. Auxiliary branches and worktrees do not
  supersede it.
- One event-driven controller owns the committed graph and one room-serial child
  operation. Initial direct acquisition uses a five-second foreground window;
  exact transport-connected progress may retain that candidate through the
  total deadline, while first decoded frame remains the only commit proof. SFU
  provides working media before finite background direct convergence. Healthy
  decoded edges remain sticky.
- WebRTC/LiveKit own media adaptation. Screener has no custom SFU layer list,
  quality score, layer selector, periodic rebalancing, or quality-driven parent
  change. P2P and SFU recover their current route before actual failure enters
  normal reassignment.
- Viewer page resume rebaselines decoded-stall timing, a new current-generation
  frame clears stale media recovery state, native Viewer video controls own local
  playback, Host preview is control-free, and manual reconnect stays on the
  current P2P parent or SFU subscription.

## Current Milestone

1. Measure the current VP8 game-load performance bottleneck on supported Browser
   Hosts; the exact Windows Chrome 151 boundary is indexed by realtime-quality
   research.
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
