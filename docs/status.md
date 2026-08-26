# Current Status

Last updated: 2026-08-26

This is the current execution index. Git history owns completed timelines;
[verification status](./verification-status.md) owns evidence boundaries.

## Production

- `https://share.bonfire.icu` runs exact application/runtime revision
  `55511773b2f9118802440fdec90ad06080b19772`, release `5551177`, wire
  `screener-v12`, from `/opt/screener/releases/5551177`. The immutable runtime
  tar SHA-256 is
  `3688b348fd8757e19fc1acb5523d2ecc90aa3553a30cd3a640e0a9a011e696e3`;
  its 39-file manifest SHA-256 is
  `279fb808ccff21c0fa07d0ff7f7afddc1d33de09446ca8446489e4970ee6d8d5`.
- The served Browser entry references `assets/index-uQk7n3NE.js`; the public
  asset is 500228 bytes with SHA-256
  `14012100209475b3fc8851774a1985b3fb17de18a1f80e6fb0c0cf773dcfe0ff`.
  Public `/healthz` returns 200. The release postflight found Screener, LiveKit,
  coturn, and nginx active with zero restarts.
- Production uses process-memory four-digit rooms, a 24-hour dormant lease,
  room-lived 22-character grants, `open | private` code entry, one Host plus 20
  Viewers, endpoint copy cap `2`, and no SQLite runtime.
- Public media listeners remain STUN-only UDP 3478 and LiveKit UDP 7882. Web
  ingress is TCP 80/443; Node 8787 and LiveKit control/signaling 7880 are
  private. TURN, ICE/TCP, media TCP, TLS relay, port 5349, and relay ranges are
  disabled.
- Browser video uses the content-independent H.264 sender gate with VP8
  fallback and retains `contentHint = "motion"`; audio uses `music`. The SFU
  publisher uses the Host's one codec decision, leaves representation
  construction to pinned LiveKit,
  enables Dynacast, uses server send-side BWE, keeps AdaptiveStream disabled,
  and configures no external ICE servers on Browser SFU PCs.
- Screen audio provides live 64/128/192 kbps ceilings with 128 default. SFU
  publication uses stereo, DTX off, and RED off. Early autoplay presentation is
  gated by current media connection state.

## Current Source

- Canonical `main` integrated the production-tested adaptive H.264 application at
  merge `636e0ac`. Production remains exact runtime `5551177`; their application
  trees match while production room storage remains process memory.
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
- Viewer hidden/freeze/pagehide suppress decoded-stall routing authority;
  visible/resume/pageshow rebaseline and rearm current-frame proof. SFU
  pagehide no longer triggers LiveKit's automatic disconnect. Native Viewer
  controls still own playback, and manual reconnect stays on the current route.

## Current Milestone

1. Implement and verify optional SQLite stable room authority; lightweight mode
   remains default in config, while production activation follows as a separate
   persistent-state deployment with recovery.
2. Remove the client preferred-room expiry/renewal timer, add atomic room
   replacement, and add the locked pre-share `VP8 | Auto | H264` Host selector
   with resolved codec display.
3. Finish the Android Chrome and iOS Safari Viewer lifecycle matrix.
4. Finish representative public-network direct, peer-relay, SFU, recovery,
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
