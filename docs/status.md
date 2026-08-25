# Current Status

Last updated: 2026-08-25

This is the current execution index. Git history owns completed timelines;
[verification status](./verification-status.md) owns evidence boundaries.

## Production

- `https://share.bonfire.icu` runs exact application/runtime revision
  `af348ee1d508a3af02b18a7f46c461953798e19d`, release `af348ee`, wire
  `screener-v12`, from `/opt/screener/releases/af348ee`. The immutable runtime
  tar SHA-256 is
  `4922cc31d7caaad7c5412b1f2fe1d73f788d16d92386efad6eac358a97b8a78e`;
  its 39-file manifest SHA-256 is
  `5b397809b664b9a55885ac603df615b537bf51276e7274416820870956242d7d`.
- The served Browser entry references `assets/index-BvuZY6Hc.js`; the public
  asset is 488473 bytes with SHA-256
  `e8fc0500496ee101031a9cfebfcc22d3b69e66d2cac5e875448b56620dbb21c5`.
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
- Screen audio provides live 64/128/256 kbps ceilings with 128 default. SFU
  publication uses stereo, DTX off, and RED off. Early autoplay presentation is
  gated by current media connection state.

## Current Source

- Canonical root `main` is clean at the same exact `af348ee` revision as
  production. Auxiliary branches and worktrees do not supersede it.
- One event-driven controller owns the committed graph and one room-serial child
  operation. It uses exact candidate identity, first-decoded-frame commit,
  strict rollback revisions, direct-then-SFU total deadline, and typed endpoint
  plus SFU resource accounting. Healthy decoded edges remain sticky.
- WebRTC/LiveKit own media adaptation. Screener has no custom SFU layer list,
  quality score, layer selector, periodic rebalancing, or quality-driven parent
  change. P2P and SFU recover their current route before actual failure enters
  normal reassignment.
- The staged `fix/viewer-page-lifecycle` candidate is based on exact `af348ee`.
  It rebaselines Viewer decoded-stall timing after page resume, makes a new
  current-generation frame clear stale media recovery state, uses native Viewer
  video controls, removes Host preview controls, and makes manual P2P reconnect
  rebuild the same parent. It is accepted but not yet committed, merged, or
  deployed.

## Current Milestone

1. Integrate, validate, deploy, and postflight `fix/viewer-page-lifecycle`.
2. Finish representative public-network direct, peer-relay, SFU, recovery,
   Pause/Resume, screen-audio, real-game A/V, mobile lifecycle, and all-UDP-
   blocked acceptance without adding another transport or quality controller.

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
