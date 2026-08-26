# Current Status

Last updated: 2026-08-26

This is the current execution index. Git history owns completed timelines;
[verification status](./verification-status.md) owns evidence boundaries.

## Production

- `https://share.bonfire.icu` runs exact application/runtime revision
  `3037c0a8f0d16e0df791eb8e64003a7a6660d521`, release `3037c0a`, wire
  `screener-v12`, from `/opt/screener/releases/3037c0a`. The immutable runtime
  tar SHA-256 is
  `f84cb7f7acbfbd950ecfdac13da9a0d6e99a4c10eb221c6948ce81b47ce2b5f6`;
  its 41-file manifest SHA-256 is
  `e2fc8115c9cb7d6455027dc2af6f29229834774ed12de334832a8d53d6fc6262`.
- The served Browser entry references `assets/index-Y4pFjW_S.js`; the public
  asset SHA-256 is
  `a3df27613dfb10fb45297197afdf2500e2953c2b5330b13e5bb49eafdc3e1447`.
  Public `/healthz` returns 200. The release postflight found Screener, LiveKit,
  coturn, and nginx active with zero restarts.
- Production enables SQLite room authority at
  `/var/lib/screener/rooms.sqlite`; live participants, routes and media remain
  process-only. A controlled restart retained a temporary room's exact Host
  authority and normal room deletion removed it afterward. Lightweight mode
  remains available when `ROOM_DATABASE_PATH` is unset.
- Public media listeners remain STUN-only UDP 3478 and LiveKit UDP 7882. Web
  ingress is TCP 80/443; Node 8787 and LiveKit control/signaling 7880 are
  private. TURN, ICE/TCP, media TCP, TLS relay, port 5349, and relay ranges are
  disabled.
- Browser video uses the content-independent H.264 sender gate with VP8
  fallback, plus the locked pre-share `VP8 | Auto | H264` Host selector and
  resolved codec display. Video retains `contentHint = "motion"`; audio uses
  `music`. The SFU publisher uses the Host's one codec decision, leaves
  representation construction to pinned LiveKit,
  enables Dynacast, uses server send-side BWE, keeps AdaptiveStream disabled,
  and configures no external ICE servers on Browser SFU PCs.
- Screen audio provides live 64/128/192 kbps ceilings with 128 default. SFU
  publication uses stereo, DTX off, and RED off. Early autoplay presentation is
  gated by current media connection state.

## Current Source

- Canonical `main` contains the same application tree deployed from `3037c0a`.
  Optional SQLite stable authority, non-expiring local preferred code, atomic
  room replacement, graceful service-restart presentation and the Host codec
  selector are implemented; production selects stable storage.
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

1. Implement presentation-authoritative rendered freeze/pause evidence and the
   controller-owned shadow aggregate; collect production samples without active
   route changes.
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
