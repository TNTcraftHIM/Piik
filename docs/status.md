# Current Status

Last updated: 2026-08-27

This is the current execution index. Git history owns completed timelines;
[verification status](./verification-status.md) owns evidence boundaries.

## Production

- `https://share.bonfire.icu` runs exact application/runtime revision
  `267e07340ba9ec85c1082d58da89b289b12c3726`, release `267e073`, wire
  `screener-v12`, from `/opt/screener/releases/267e073`. The immutable runtime
  tar SHA-256 is
  `6a04af6390fa44e0667e3d1a730c665c6a2401f51872f3168044d70133515481`;
  its 41-file manifest SHA-256 is
  `14e0b509397f822394a53110f17993dc625e80df4eca654dfa2bc817854928c8`.
- The served Browser entry references `assets/index-lKEEgpx8.js`; the public
  asset SHA-256 is
  `5f9ec937138d66220e727c01913cff85a9e82b9a8a1816c5a4dbd3d508e37369`.
  Public `/healthz` returns 200. The release postflight found Screener, LiveKit,
  coturn, and nginx active with zero restarts.
- Production enables SQLite room authority at
  `/var/lib/screener/rooms.sqlite`; live participants, routes and media remain
  process-only. A controlled restart retained the room authority and Host-owned
  capture while the Viewer rebuilt media without a page refresh. Lightweight
  mode remains available when `ROOM_DATABASE_PATH` is unset and reacquires a
  room rather than persisting the old authority.
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

- Canonical `main` contains the same application tree deployed from `267e073`.
  Optional SQLite stable authority, non-expiring local preferred code, atomic
  room replacement and the Host codec selector are implemented; production
  selects stable storage. Graceful restart, crash, timeout and network loss use
  one reconnect state. LiveKit room teardown cannot stop Host-owned capture.
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

1. Implement presentation-authoritative freeze/pause evidence with decoded
   progress and the controller-owned shadow aggregate; collect production
   samples without active route changes. This integration atomically replaces
   current v12 with accepted strict `screener-v13`.
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

No source or deployment P0/P1 is open. Representative real-network and mobile
physical evidence remains required before route acceptance is complete.
